"""
SOP Trainer AI — FastAPI Server
Wraps the pipeline.py CLI as an HTTP API and persists results to Supabase.
"""

import asyncio
import json
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

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


async def run_pipeline(video_id: str, storage_path: str) -> None:
    """Download video from Supabase Storage, run pipeline, save SOP to DB."""
    if supabase is None:
        print(f"[pipeline] Supabase not configured, skipping {video_id}")
        return

    try:
        # Mark as processing
        supabase.table("videos").update({"status": "processing"}).eq("id", video_id).execute()

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            video_file = tmp_path / Path(storage_path).name

            # Download from Supabase Storage
            print(f"[pipeline] Downloading {storage_path}")
            res = supabase.storage.from_("training-videos").download(storage_path)
            video_file.write_bytes(res)

            # Run the pipeline CLI as subprocess
            sop_json_path = tmp_path / "sop.json"
            print(f"[pipeline] Running pipeline on {video_file}")
            proc = await asyncio.create_subprocess_exec(
                "python3",
                str(Path(__file__).parent / "pipeline.py"),
                str(video_file),
                "--output",
                str(sop_json_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                raise RuntimeError(stderr.decode()[-1000:])
            if not sop_json_path.exists():
                raise RuntimeError("pipeline.py did not produce sop.json")

            sop_data = json.loads(sop_json_path.read_text())

            # Insert SOP record
            sop_title = sop_data.get("title", "Untitled SOP")
            sop_res = (
                supabase.table("sops")
                .insert({"video_id": video_id, "title": sop_title, "raw_json": sop_data})
                .execute()
            )
            sop_id = sop_res.data[0]["id"]

            # Insert SOP steps
            steps = sop_data.get("steps", [])
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

        # Mark video as done
        supabase.table("videos").update({"status": "done"}).eq("id", video_id).execute()
        print(f"[pipeline] Done — video {video_id}, sop {sop_id}")

    except Exception as exc:
        error_msg = str(exc)[:500]
        print(f"[pipeline] ERROR for {video_id}: {error_msg}")
        if supabase:
            supabase.table("videos").update(
                {"status": "error", "error_message": error_msg}
            ).eq("id", video_id).execute()


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.post("/pipeline/trigger")
async def trigger_pipeline(req: TriggerRequest, background_tasks: BackgroundTasks):
    """Enqueue a pipeline run for the given video."""
    background_tasks.add_task(run_pipeline, req.video_id, req.storage_path)
    return {"status": "queued", "video_id": req.video_id}
