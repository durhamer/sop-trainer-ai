#!/usr/bin/env python3
"""
SOP Trainer AI — Phase 1 Pipeline
Converts a video file into a structured SOP JSON document.

Pipeline:
  1. video → ffmpeg → audio (.wav)
  2. audio → Whisper API → timestamped transcript
  3. video → ffmpeg scene detect → keyframe PNGs
  4. keyframes → Claude Vision → visual action descriptions
  5. transcript + visual descriptions → Claude Sonnet → structured SOP JSON
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).parent.parent / ".env")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

CLAUDE_MODEL = "claude-sonnet-4-6"
WHISPER_MODEL = "whisper-1"

# Scene detection sensitivity: lower = more scenes captured
SCENE_THRESHOLD = 0.3
# Max keyframes to send to Claude Vision (cost control)
MAX_KEYFRAMES = 20


# ---------------------------------------------------------------------------
# Step 1 — Extract audio
# ---------------------------------------------------------------------------

def has_audio_stream(video_path: Path) -> bool:
    """Return True if the video contains at least one audio stream."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0",
        str(video_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return bool(result.stdout.strip())


def extract_audio(video_path: Path, output_dir: Path) -> Path | None:
    """Extract mono 16kHz WAV from video using ffmpeg.

    Returns None if the video has no audio stream.
    """
    if not has_audio_stream(video_path):
        print("  No audio stream found — skipping audio extraction")
        return None

    audio_path = output_dir / "audio.wav"
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-ac", "1",          # mono
        "-ar", "16000",      # 16 kHz (Whisper sweet spot)
        "-vn",               # no video
        str(audio_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[ffmpeg audio] stderr:\n{result.stderr}", file=sys.stderr)
        raise RuntimeError("ffmpeg audio extraction failed")
    print(f"  Audio extracted → {audio_path}")
    return audio_path


# ---------------------------------------------------------------------------
# Step 2 — Transcribe with Whisper
# ---------------------------------------------------------------------------

def transcribe_audio(audio_path: Path | None) -> list[dict]:
    """
    Returns a list of segments:
      [{"start": float, "end": float, "text": str}, ...]

    Returns [] if audio_path is None (video had no audio stream).
    """
    if audio_path is None:
        print("  No audio — returning empty transcript")
        return []

    client = OpenAI(api_key=OPENAI_API_KEY)
    with open(audio_path, "rb") as f:
        response = client.audio.transcriptions.create(
            model=WHISPER_MODEL,
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    segments = [
        {"start": s.start, "end": s.end, "text": s.text.strip()}
        for s in response.segments
    ]
    print(f"  Transcribed {len(segments)} segments")
    return segments


# ---------------------------------------------------------------------------
# Step 3 — Extract keyframes via scene detection
# ---------------------------------------------------------------------------

def extract_keyframes(video_path: Path, output_dir: Path) -> list[dict]:
    """
    Use ffmpeg select filter with scene change detection.
    Returns list of {"timestamp": float, "path": Path} sorted by timestamp.
    """
    frames_dir = output_dir / "keyframes"
    frames_dir.mkdir(exist_ok=True)

    # Extract frames where scene score > threshold; embed timestamp in filename
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-vf", (
            f"select='gt(scene,{SCENE_THRESHOLD})',"
            "showinfo"
        ),
        "-vsync", "vfr",
        "-frame_pts", "1",
        str(frames_dir / "frame_%08d.png"),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[ffmpeg keyframes] stderr:\n{result.stderr}", file=sys.stderr)
        raise RuntimeError("ffmpeg keyframe extraction failed")

    # Parse timestamps from showinfo lines in stderr
    # showinfo outputs: "... pts_time:12.345 ..."
    import re
    timestamp_map: dict[str, float] = {}
    frame_index = 1
    for line in result.stderr.splitlines():
        if "pts_time:" in line:
            match = re.search(r"pts_time:([0-9.]+)", line)
            if match:
                ts = float(match.group(1))
                filename = f"frame_{frame_index:08d}.png"
                timestamp_map[filename] = ts
                frame_index += 1

    keyframes = []
    for png in sorted(frames_dir.glob("frame_*.png")):
        ts = timestamp_map.get(png.name, 0.0)
        keyframes.append({"timestamp": ts, "path": png})

    keyframes.sort(key=lambda x: x["timestamp"])

    # Subsample if too many
    if len(keyframes) > MAX_KEYFRAMES:
        step = len(keyframes) / MAX_KEYFRAMES
        keyframes = [keyframes[int(i * step)] for i in range(MAX_KEYFRAMES)]

    print(f"  Extracted {len(keyframes)} keyframes")
    return keyframes


# ---------------------------------------------------------------------------
# Step 4 — Describe keyframes with Claude Vision
# ---------------------------------------------------------------------------

def describe_keyframes(keyframes: list[dict]) -> list[dict]:
    """
    Returns list of {"timestamp": float, "description": str}.
    Sends all frames in a single API call (batched in one message) to
    minimise latency and cost.
    """
    if not keyframes:
        return []

    client = Anthropic(api_key=ANTHROPIC_API_KEY)

    content: list[dict] = []
    for kf in keyframes:
        image_data = base64.standard_b64encode(kf["path"].read_bytes()).decode()
        content.append({
            "type": "text",
            "text": f"Frame at {kf['timestamp']:.2f}s:",
        })
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": image_data,
            },
        })

    content.append({
        "type": "text",
        "text": (
            "For each frame above (identified by its timestamp), "
            "write a concise one-sentence description of the main action "
            "or state visible. Reply as a JSON array:\n"
            '[{"timestamp": <seconds>, "description": "<text>"}, ...]'
        ),
    })

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": content}],
    )

    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    descriptions = json.loads(raw.strip())
    print(f"  Got {len(descriptions)} frame descriptions from Claude Vision")
    return descriptions


# ---------------------------------------------------------------------------
# Step 5 — Synthesise SOP JSON with Claude Sonnet
# ---------------------------------------------------------------------------

SOP_SYSTEM_PROMPT = """\
You are an expert SOP (Standard Operating Procedure) author.
Given a timestamped transcript and visual descriptions from a training video,
produce a structured SOP document in JSON format.

Output schema:
{
  "title": "string — concise SOP title inferred from the content",
  "summary": "string — 2-3 sentence overview",
  "steps": [
    {
      "step_number": integer,
      "title": "string — short action title",
      "description": "string — full instruction (繁體中文)",
      "timestamp_start": float | null,
      "timestamp_end": float | null,
      "visual_cues": ["string", ...],
      "warnings": ["string", ...]   // optional safety notes
    }
  ],
  "metadata": {
    "total_duration_seconds": float,
    "language": "zh-TW",
    "generated_by": "sop-trainer-ai-v1"
  }
}

Rules:
- step descriptions MUST be in 繁體中文
- warnings array may be empty []
- infer step boundaries from natural breakpoints in the transcript + scene changes
- do NOT invent information not present in the source material
"""

def synthesise_sop(
    transcript_segments: list[dict],
    frame_descriptions: list[dict],
    video_duration: float,
) -> dict:
    client = Anthropic(api_key=ANTHROPIC_API_KEY)

    transcript_text = "\n".join(
        f"[{s['start']:.2f}s–{s['end']:.2f}s] {s['text']}"
        for s in transcript_segments
    )
    visuals_text = "\n".join(
        f"[{d['timestamp']:.2f}s] {d['description']}"
        for d in frame_descriptions
    )

    user_message = (
        f"## Transcript\n{transcript_text}\n\n"
        f"## Visual Descriptions\n{visuals_text}\n\n"
        f"## Video Duration\n{video_duration:.2f} seconds\n\n"
        "Please produce the SOP JSON now."
    )

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4096,
        system=SOP_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    sop = json.loads(raw.strip())
    print(f"  SOP synthesised: {len(sop.get('steps', []))} steps")
    return sop


# ---------------------------------------------------------------------------
# Step 6 — Review SOP steps for safety / number / order flags
# ---------------------------------------------------------------------------

def review_sop_steps(steps: list[dict]) -> list[dict]:
    """
    Run a review pass on SOP steps using Claude.
    Returns a list of flag dicts (same length and order as ``steps``).

    Each dict::
        {
          "safety_critical": bool,
          "needs_number_verification": bool,
          "order_dependent": bool,
          "notes": str
        }
    """
    if not steps:
        return []

    client = Anthropic(api_key=ANTHROPIC_API_KEY)

    steps_text = "\n\n".join(
        f"[Step {s.get('step_number', i + 1)}]\n"
        f"Title: {s.get('title', '')}\n"
        f"Description: {s.get('description', '')}\n"
        f"Warnings: {'; '.join(s.get('warnings') or [])}"
        for i, s in enumerate(steps)
    )

    prompt = (
        "You are a safety reviewer for Standard Operating Procedures (SOPs).\n"
        "Review the following SOP steps and identify flags for each step.\n\n"
        f"{steps_text}\n\n"
        "For each step return a JSON object with:\n"
        '- "safety_critical": true if the step involves hazards such as oil temperature, '
        "knives, allergens, food storage temperatures, hot surfaces, electrical hazards, "
        "chemicals, or other safety risks\n"
        '- "needs_number_verification": true if the step contains specific numbers '
        "(time durations, temperatures, weights, quantities, percentages, counts) "
        "that a human should verify for accuracy\n"
        '- "order_dependent": true if this step must be performed in its exact position '
        "relative to the other steps and must not be reordered\n"
        '- "notes": one-sentence explanation of why any flags were set, or "" if none\n\n'
        "Return a JSON array with exactly one object per step in the same order as the input. "
        "Return ONLY the JSON array."
    )

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    flags: list[dict] = json.loads(raw.strip())

    # Guard against Claude returning wrong count
    empty = {"safety_critical": False, "needs_number_verification": False,
             "order_dependent": False, "notes": ""}
    while len(flags) < len(steps):
        flags.append(empty)

    print(f"  Review pass complete: {len(steps)} steps reviewed")
    return flags[: len(steps)]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_video_duration(video_path: Path) -> float:
    """Return video duration in seconds via ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return 0.0
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_pipeline(video_path: Path, output_path: Path) -> None:
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    if not ANTHROPIC_API_KEY:
        raise EnvironmentError("ANTHROPIC_API_KEY not set")
    if not OPENAI_API_KEY:
        raise EnvironmentError("OPENAI_API_KEY not set")

    work_dir = Path(tempfile.mkdtemp(prefix="sop_pipeline_"))
    try:
        print(f"\n[Pipeline] Working directory: {work_dir}")
        print(f"[Pipeline] Input video: {video_path}")

        print("\n[1/5] Extracting audio…")
        audio_path = extract_audio(video_path, work_dir)  # None if no audio stream

        print("\n[2/5] Transcribing audio…")
        transcript_segments = transcribe_audio(audio_path)  # [] if audio_path is None

        print("\n[3/5] Extracting keyframes…")
        keyframes = extract_keyframes(video_path, work_dir)

        print("\n[4/5] Describing keyframes with Claude Vision…")
        frame_descriptions = describe_keyframes(keyframes)

        print("\n[5/5] Synthesising SOP…")
        duration = get_video_duration(video_path)
        sop = synthesise_sop(transcript_segments, frame_descriptions, duration)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(sop, ensure_ascii=False, indent=2))
        print(f"\n[Pipeline] Done. SOP written to: {output_path}")

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert a training video into a structured SOP JSON file."
    )
    parser.add_argument("video", type=Path, help="Path to the input video file")
    parser.add_argument(
        "-o", "--output",
        type=Path,
        default=None,
        help="Path for the output JSON file (default: <video_stem>_sop.json)",
    )
    args = parser.parse_args()

    video_path: Path = args.video.resolve()
    output_path: Path = (
        args.output.resolve()
        if args.output
        else video_path.parent / f"{video_path.stem}_sop.json"
    )

    run_pipeline(video_path, output_path)


if __name__ == "__main__":
    main()
