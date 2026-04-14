"""
SOP Trainer AI — FastAPI Server
Wraps the pipeline.py functions as an HTTP API and persists results to Supabase.
"""

import asyncio
import hashlib
import os
import shutil
import tempfile
import traceback
from pathlib import Path

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from pipeline import (
    extract_audio,
    transcribe_audio,
    extract_keyframes,
    extract_step_frames,
    select_best_frame,
    synthesise_sop,
    get_video_duration,
    review_sop_steps,
)

# Optional supabase-py — install with: pip install supabase
try:
    from supabase import create_client, Client as SupabaseClient
    SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
    SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    supabase: SupabaseClient | None = (
        create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        if SUPABASE_URL and SUPABASE_SERVICE_KEY
        else None
    )
except ImportError:
    supabase = None

app = FastAPI(title="SOP Trainer AI", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", os.environ.get("FRONTEND_URL", "")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TriggerRequest(BaseModel):
    video_id: str
    storage_path: str


class EmployeeLoginRequest(BaseModel):
    pin: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _set_status(
    video_id: str,
    status: str,
    error_message: str | None = None,
    current_stage: str | None = None,
    progress_percent: int | None = None,
) -> None:
    """Set a terminal status (done / error) on a video record."""
    if supabase is None:
        return
    payload: dict = {"status": status}
    if error_message is not None:
        payload["error_message"] = error_message
    if current_stage is not None:
        payload["current_stage"] = current_stage
    if progress_percent is not None:
        payload["progress_percent"] = progress_percent
    supabase.table("videos").update(payload).eq("id", video_id).execute()


def _report_stage(video_id: str, stage: str, progress_percent: int) -> None:
    """Report the current pipeline stage and progress (0-100) to the DB."""
    if supabase is None:
        return
    supabase.table("videos").update({
        "status": "processing",
        "current_stage": stage,
        "progress_percent": progress_percent,
    }).eq("id", video_id).execute()


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _upload_keyframe_sync(
    supabase_client: "SupabaseClient", kf_path: Path, storage_path: str
) -> str:
    """Upload a keyframe PNG to Supabase Storage and return its public URL."""
    if not kf_path.exists():
        raise FileNotFoundError(f"Keyframe file missing on disk: {kf_path}")

    file_size = kf_path.stat().st_size
    print(f"[upload] {kf_path.name}  size={file_size}B  → training-videos/{storage_path}")

    data = kf_path.read_bytes()

    resp = supabase_client.storage.from_("training-videos").upload(
        path=storage_path,
        file=data,
        file_options={"content-type": "image/png", "upsert": "true"},
    )
    # supabase-py may return an error object instead of raising — check explicitly
    print(f"[upload] upload() response type={type(resp).__name__}  repr={resp!r}")

    url = supabase_client.storage.from_("training-videos").get_public_url(storage_path)
    print(f"[upload] public URL: {url}")
    return url


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------

async def run_pipeline(video_id: str, storage_path: str) -> None:
    """Download video from Supabase Storage, run pipeline, save SOP to DB.

    Stages (SOP-driven path):
      0. 音訊提取   — ffmpeg audio extraction
      1. 語音辨識   — Whisper transcription
      2. SOP 生成   — Claude generates SOP from transcript
      3. 截圖擷取   — 3 candidate frames extracted per step
      4. AI 選圖    — Claude Vision picks best frame per step
      5. 上傳截圖   — selected frames uploaded to Supabase Storage
      6. 審核掃描   — Claude review flags per step

    Fallback (no timestamps): stages 3-5 collapse into a single blind
    scene-detection + even-distribution pass before stage 6.
    """
    if supabase is None:
        print(f"[pipeline] Supabase not configured, skipping {video_id}")
        return

    STAGES = ["音訊提取", "語音辨識", "SOP 生成", "截圖擷取", "AI 選圖", "上傳截圖", "審核掃描"]

    def advance(idx: int) -> None:
        pct = round(idx / len(STAGES) * 100)
        label = STAGES[idx]
        print(f"[pipeline] [{pct}%] {label}")
        _report_stage(video_id, label, pct)

    work_dir = Path(tempfile.mkdtemp(prefix="sop_pipeline_"))
    sop_id: str | None = None
    try:
        # ── Download ────────────────────────────────────────────────────────
        print(f"[pipeline] Downloading {storage_path}")
        res = supabase.storage.from_("training-videos").download(storage_path)
        video_file = work_dir / Path(storage_path).name
        video_file.write_bytes(res)

        # ── Stage 0: 音訊提取 ───────────────────────────────────────────────
        advance(0)
        audio_path = await asyncio.to_thread(extract_audio, video_file, work_dir)

        # ── Stage 1: 語音辨識 ───────────────────────────────────────────────
        advance(1)
        transcript_segments = await asyncio.to_thread(transcribe_audio, audio_path)

        # ── Stage 2: SOP 生成 ───────────────────────────────────────────────
        advance(2)
        duration = await asyncio.to_thread(get_video_duration, video_file)
        sop = await asyncio.to_thread(synthesise_sop, transcript_segments, [], duration)

        # Persist SOP record now so we have sop_id for storage paths
        sop_title = sop.get("title", "Untitled SOP")
        sop_res = (
            supabase.table("sops")
            .insert({"video_id": video_id, "title": sop_title, "raw_json": sop})
            .execute()
        )
        sop_id = sop_res.data[0]["id"]

        steps = sop.get("steps", [])
        image_urls: list[str | None] = [None] * len(steps)

        if steps:
            has_timestamps = any(s.get("timestamp_start") is not None for s in steps)
            print(f"[pipeline] {len(steps)} steps, has_timestamps={has_timestamps}")

            if has_timestamps:
                # ── Stage 3: 截圖擷取 — extract 3 candidates per step ───────
                advance(3)
                all_frame_paths: list[list[Path]] = []
                for i, step in enumerate(steps):
                    paths = await asyncio.to_thread(
                        extract_step_frames, video_file, step, work_dir, i
                    )
                    print(f"[pipeline]   step {i + 1}: {len(paths)} candidates")
                    all_frame_paths.append(paths)

                # ── Stage 4: AI 選圖 — Claude Vision picks best frame ────────
                advance(4)
                selected_frames: list[Path | None] = []
                for i, (step, paths) in enumerate(zip(steps, all_frame_paths)):
                    chosen = await asyncio.to_thread(select_best_frame, step, paths)
                    print(f"[pipeline]   step {i + 1}: selected={chosen}")
                    selected_frames.append(chosen)

                # ── Stage 5: 上傳截圖 — upload selected frames ───────────────
                advance(5)
                for i, chosen in enumerate(selected_frames):
                    if chosen is None:
                        continue
                    kf_storage = f"sops/{sop_id}/frames/step_{i + 1}.png"
                    try:
                        url = await asyncio.to_thread(
                            _upload_keyframe_sync, supabase, chosen, kf_storage
                        )
                        image_urls[i] = url
                        print(f"[pipeline]   step {i + 1}: ✓ {url}")
                    except Exception:
                        print(f"[pipeline]   step {i + 1}: ✗ upload failed:")
                        traceback.print_exc()

            else:
                # ── Fallback: blind scene-detection → even distribution ───────
                print("[pipeline] No timestamps — falling back to scene-detection sampling")
                advance(3)
                keyframes = await asyncio.to_thread(extract_keyframes, video_file, work_dir)
                print(f"[pipeline] Fallback: {len(keyframes)} keyframes extracted")

                advance(5)  # skip AI 選圖; go straight to upload
                for i in range(len(steps)):
                    if not keyframes:
                        break
                    kf = keyframes[int(i * len(keyframes) / len(steps))]
                    kf_storage = f"sops/{sop_id}/frames/step_{i + 1}.png"
                    try:
                        url = await asyncio.to_thread(
                            _upload_keyframe_sync, supabase, Path(kf["path"]), kf_storage
                        )
                        image_urls[i] = url
                        print(f"[pipeline]   step {i + 1}: ✓ fallback {url}")
                    except Exception:
                        print(f"[pipeline]   step {i + 1}: ✗ fallback upload failed:")
                        traceback.print_exc()

            # Insert steps with resolved image URLs
            step_rows = [
                {
                    "sop_id": sop_id,
                    "step_number": i + 1,
                    "title": step.get("title", ""),
                    "description": step.get("description", ""),
                    "warnings": step.get("warnings", []),
                    "image_url": image_urls[i],
                }
                for i, step in enumerate(steps)
            ]
            supabase.table("sop_steps").insert(step_rows).execute()

            # ── Stage 6: 審核掃描 ────────────────────────────────────────────
            advance(6)
            inserted = (
                supabase.table("sop_steps")
                .select("*")
                .eq("sop_id", sop_id)
                .order("step_number")
                .execute()
                .data
            )
            await _apply_review(sop_id, inserted)

        _set_status(video_id, "done", current_stage="完成", progress_percent=100)
        print(f"[pipeline] Done — video {video_id}, sop {sop_id}")

    except Exception as exc:
        error_msg = str(exc)[:500]
        print(f"[pipeline] ERROR for {video_id}: {error_msg}")
        _set_status(video_id, "error", error_message=error_msg)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


async def _apply_review(sop_id: str, steps: list[dict]) -> None:
    """Run Claude review on `steps` and persist flags. Resets review_confirmed."""
    if not steps or supabase is None:
        return
    flags_list = await asyncio.to_thread(review_sop_steps, steps)
    for step, flags in zip(steps, flags_list):
        supabase.table("sop_steps").update(
            {"review_flags": flags, "review_confirmed": False}
        ).eq("id", step["id"]).execute()
    print(f"[review] Flags written for sop {sop_id} ({len(steps)} steps)")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.post("/pipeline/trigger")
async def trigger_pipeline(req: TriggerRequest, background_tasks: BackgroundTasks):
    """Enqueue a pipeline run for the given video."""
    background_tasks.add_task(run_pipeline, req.video_id, req.storage_path)
    return {"status": "queued", "video_id": req.video_id}


@app.post("/sops/{sop_id}/review")
async def review_sop(sop_id: str):
    """Re-run the review pass on all steps of an existing SOP (synchronous)."""
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    steps = (
        supabase.table("sop_steps")
        .select("*")
        .eq("sop_id", sop_id)
        .order("step_number")
        .execute()
        .data
    )
    if not steps:
        return {"status": "ok", "reviewed": 0}

    await _apply_review(sop_id, steps)
    return {"status": "ok", "reviewed": len(steps)}


@app.post("/auth/employee")
async def employee_login(req: EmployeeLoginRequest):
    """Verify employee PIN and return employee info."""
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase not configured")

    pin = req.pin.strip()
    if not pin.isdigit() or not (4 <= len(pin) <= 6):
        raise HTTPException(status_code=400, detail="PIN must be 4–6 digits")

    pin_hash = _sha256(pin)
    res = (
        supabase.table("employees")
        .select("id, name")
        .eq("pin_hash", pin_hash)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=401, detail="Invalid PIN")

    employee = res.data[0]
    return {"id": employee["id"], "name": employee["name"]}
