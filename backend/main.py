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
    describe_keyframes,
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


def _find_closest_keyframe(
    timestamp: float | None, keyframes: list[dict]
) -> dict | None:
    """Return the keyframe whose timestamp is closest to `timestamp`.

    Falls back to the first keyframe if timestamp is None (e.g. no audio track).
    Returns None only when the keyframes list is empty.
    """
    if not keyframes:
        return None
    if timestamp is None:
        return keyframes[0]
    return min(keyframes, key=lambda kf: abs(kf["timestamp"] - float(timestamp)))


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
    """Download video from Supabase Storage, run pipeline, save SOP to DB."""
    if supabase is None:
        print(f"[pipeline] Supabase not configured, skipping {video_id}")
        return

    work_dir = Path(tempfile.mkdtemp(prefix="sop_pipeline_"))
    try:
        # Download video from storage
        print(f"[pipeline] Downloading {storage_path}")
        res = supabase.storage.from_("training-videos").download(storage_path)
        video_file = work_dir / Path(storage_path).name
        video_file.write_bytes(res)

        # Step 1 — Extract audio
        print(f"[pipeline] Step 1/5: extracting audio")
        _set_status(video_id, "extracting_audio")
        audio_path = await asyncio.to_thread(extract_audio, video_file, work_dir)

        # Step 2 — Transcribe
        print(f"[pipeline] Step 2/5: transcribing")
        _set_status(video_id, "transcribing")
        transcript_segments = await asyncio.to_thread(transcribe_audio, audio_path)

        # Step 3 — Analyze frames
        print(f"[pipeline] Step 3/5: analyzing frames")
        _set_status(video_id, "analyzing_frames")
        keyframes = await asyncio.to_thread(extract_keyframes, video_file, work_dir)

        # ── Keyframe inventory ──────────────────────────────────────────────
        print(f"[pipeline] Keyframes extracted: {len(keyframes)}")
        for kf in keyframes:
            on_disk = Path(kf["path"]).exists()
            print(f"[pipeline]   t={kf['timestamp']:.3f}s  file={kf['path']}  on_disk={on_disk}")
        if not keyframes:
            print("[pipeline] WARNING: no keyframes — scene threshold may be too high or video has no scene changes")
        # ───────────────────────────────────────────────────────────────────

        frame_descriptions = await asyncio.to_thread(describe_keyframes, keyframes)

        # Step 4 — Generate SOP
        print(f"[pipeline] Step 4/5: generating SOP")
        _set_status(video_id, "generating_sop")
        duration = await asyncio.to_thread(get_video_duration, video_file)
        sop = await asyncio.to_thread(
            synthesise_sop, transcript_segments, frame_descriptions, duration
        )

        # Step 5 — Save results to Supabase
        print(f"[pipeline] Step 5/5: saving to Supabase")
        sop_title = sop.get("title", "Untitled SOP")
        sop_res = (
            supabase.table("sops")
            .insert({"video_id": video_id, "title": sop_title, "raw_json": sop})
            .execute()
        )
        sop_id = sop_res.data[0]["id"]

        steps = sop.get("steps", [])
        if steps:
            # If no steps have timestamp_start, distribute keyframes evenly
            has_timestamps = any(s.get("timestamp_start") is not None for s in steps)
            if not has_timestamps and keyframes:
                print("[pipeline] No timestamp_start values — distributing keyframes evenly across steps")
                # Pre-assign one keyframe per step by index (wraps if fewer frames than steps)
                assigned_kfs = [
                    keyframes[int(i * len(keyframes) / len(steps))]
                    for i in range(len(steps))
                ]
            else:
                assigned_kfs = [None] * len(steps)  # will use timestamp matching below

            print(f"[pipeline] Matching keyframes to {len(steps)} SOP steps:")
            step_rows: list[dict] = []
            for i, step in enumerate(steps):
                ts = step.get("timestamp_start")
                image_url: str | None = None

                kf = assigned_kfs[i] if assigned_kfs[i] is not None else _find_closest_keyframe(ts, keyframes)
                kf_ts = "none" if kf is None else f"{kf['timestamp']:.3f}s"
                print(f"[pipeline]   step {i + 1}  ts_start={ts}  matched_kf={kf_ts}")

                if kf is not None:
                    kf_storage = f"sops/{sop_id}/frames/step_{i + 1}.png"
                    try:
                        image_url = await asyncio.to_thread(
                            _upload_keyframe_sync, supabase, Path(kf["path"]), kf_storage
                        )
                        print(f"[pipeline]   step {i + 1}: ✓ image_url={image_url}")
                    except Exception:
                        print(f"[pipeline]   step {i + 1}: ✗ keyframe upload raised:")
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

            # Fetch inserted steps (need IDs) then run review pass
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
