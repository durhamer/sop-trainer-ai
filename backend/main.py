"""
SOP Trainer AI — FastAPI Server
Wraps the pipeline.py functions as an HTTP API and persists results to Supabase.
"""

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, BackgroundTasks
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


class TriggerRequest(BaseModel):
    video_id: str
    storage_path: str


def _set_status(video_id: str, status: str, error_message: str | None = None) -> None:
    if supabase is None:
        return
    payload: dict = {"status": status}
    if error_message is not None:
        payload["error_message"] = error_message
    supabase.table("videos").update(payload).eq("id", video_id).execute()


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
            supabase.table("sop_steps").insert(
                [
                    {
                        "sop_id": sop_id,
                        "step_number": i + 1,
                        "title": step.get("title", ""),
                        "description": step.get("description", ""),
                        "warnings": step.get("warnings", []),
                        "image_url": step.get("image_url"),
                    }
                    for i, step in enumerate(steps)
                ]
            ).execute()

        _set_status(video_id, "done")
        print(f"[pipeline] Done — video {video_id}, sop {sop_id}")

    except Exception as exc:
        error_msg = str(exc)[:500]
        print(f"[pipeline] ERROR for {video_id}: {error_msg}")
        _set_status(video_id, "error", error_message=error_msg)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.post("/pipeline/trigger")
async def trigger_pipeline(req: TriggerRequest, background_tasks: BackgroundTasks):
    """Enqueue a pipeline run for the given video."""
    background_tasks.add_task(run_pipeline, req.video_id, req.storage_path)
    return {"status": "queued", "video_id": req.video_id}
