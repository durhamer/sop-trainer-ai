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

def _set_status(video_id: str, status: str, error_message: str | None = None) -> None:
    if supabase is None:
        return
    payload: dict = {"status": status}
    if error_message is not None:
        payload["error_message"] = error_message
    supabase.table("videos").update(payload).eq("id", video_id).execute()


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

    New flow (SOP-driven keyframe selection):
      1. Extract audio → transcribe
      2. Generate SOP from transcript only → gives steps with timestamps
      3a. If steps have timestamps: extract 3 candidate frames per step,
          ask Claude Vision to pick the best one, upload it.
      3b. If no timestamps: fall back to blind scene-detection sampling.
      4. Insert steps + run review pass.
    """
    if supabase is None:
        print(f"[pipeline] Supabase not configured, skipping {video_id}")
        return

    work_dir = Path(tempfile.mkdtemp(prefix="sop_pipeline_"))
    try:
        # ── Download ────────────────────────────────────────────────────────
        print(f"[pipeline] Downloading {storage_path}")
        res = supabase.storage.from_("training-videos").download(storage_path)
        video_file = work_dir / Path(storage_path).name
        video_file.write_bytes(res)

        # ── Step 1/4: Extract audio ─────────────────────────────────────────
        print("[pipeline] Step 1/4: extracting audio")
        _set_status(video_id, "extracting_audio")
        audio_path = await asyncio.to_thread(extract_audio, video_file, work_dir)

        # ── Step 2/4: Transcribe ────────────────────────────────────────────
        print("[pipeline] Step 2/4: transcribing")
        _set_status(video_id, "transcribing")
        transcript_segments = await asyncio.to_thread(transcribe_audio, audio_path)

        # ── Step 3/4: Generate SOP from transcript only ─────────────────────
        print("[pipeline] Step 3/4: generating SOP")
        _set_status(video_id, "generating_sop")
        duration = await asyncio.to_thread(get_video_duration, video_file)
        sop = await asyncio.to_thread(synthesise_sop, transcript_segments, [], duration)

        # ── Step 4/4: Targeted keyframe extraction + save ───────────────────
        print("[pipeline] Step 4/4: analyzing frames & saving")
        _set_status(video_id, "analyzing_frames")

        sop_title = sop.get("title", "Untitled SOP")
        sop_res = (
            supabase.table("sops")
            .insert({"video_id": video_id, "title": sop_title, "raw_json": sop})
            .execute()
        )
        sop_id = sop_res.data[0]["id"]

        steps = sop.get("steps", [])
        if steps:
            has_timestamps = any(s.get("timestamp_start") is not None for s in steps)
            print(f"[pipeline] {len(steps)} steps, has_timestamps={has_timestamps}")

            step_rows: list[dict] = []

            if has_timestamps:
                # ── SOP-driven path ─────────────────────────────────────────
                for i, step in enumerate(steps):
                    image_url: str | None = None
                    ts = step.get("timestamp_start")
                    print(f"[pipeline]   step {i + 1}  ts_start={ts}")

                    frame_paths = await asyncio.to_thread(
                        extract_step_frames, video_file, step, work_dir, i
                    )
                    print(f"[pipeline]   step {i + 1}: {len(frame_paths)} candidate frames extracted")

                    selected = await asyncio.to_thread(select_best_frame, step, frame_paths)

                    if selected is not None:
                        kf_storage = f"sops/{sop_id}/frames/step_{i + 1}.png"
                        try:
                            image_url = await asyncio.to_thread(
                                _upload_keyframe_sync, supabase, selected, kf_storage
                            )
                            print(f"[pipeline]   step {i + 1}: ✓ image_url={image_url}")
                        except Exception:
                            print(f"[pipeline]   step {i + 1}: ✗ upload failed:")
                            traceback.print_exc()

                    step_rows.append({
                        "sop_id": sop_id,
                        "step_number": i + 1,
                        "title": step.get("title", ""),
                        "description": step.get("description", ""),
                        "warnings": step.get("warnings", []),
                        "image_url": image_url,
                    })

            else:
                # ── Fallback: blind scene-detection sampling ─────────────────
                print("[pipeline] No timestamps — falling back to blind keyframe sampling")
                keyframes = await asyncio.to_thread(extract_keyframes, video_file, work_dir)
                print(f"[pipeline] Fallback: {len(keyframes)} keyframes extracted")

                for i, step in enumerate(steps):
                    image_url = None
                    if keyframes:
                        kf = keyframes[int(i * len(keyframes) / len(steps))]
                        kf_storage = f"sops/{sop_id}/frames/step_{i + 1}.png"
                        try:
                            image_url = await asyncio.to_thread(
                                _upload_keyframe_sync, supabase, Path(kf["path"]), kf_storage
                            )
                            print(f"[pipeline]   step {i + 1}: ✓ fallback image_url={image_url}")
                        except Exception:
                            print(f"[pipeline]   step {i + 1}: ✗ fallback upload failed:")
                            traceback.print_exc()

                    step_rows.append({
                        "sop_id": sop_id,
                        "step_number": i + 1,
                        "title": step.get("title", ""),
                        "description": step.get("description", ""),
                        "warnings": step.get("warnings", []),
                        "image_url": image_url,
                    })

            supabase.table("sop_steps").insert(step_rows).execute()

            # ── Review pass ─────────────────────────────────────────────────
            print(f"[pipeline] Running review pass for sop {sop_id}")
            inserted = (
                supabase.table("sop_steps")
                .select("*")
                .eq("sop_id", sop_id)
                .order("step_number")
                .execute()
                .data
            )
            await _apply_review(sop_id, inserted)

        _set_status(video_id, "done")
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
