# SOP Trainer AI

## Architecture
- Monorepo: /frontend (Next.js 14+) + /backend (Python FastAPI)
- Frontend: App Router, TypeScript, TailwindCSS, shadcn/ui
- Backend: FastAPI, ffmpeg, Whisper API, Claude API, Supabase
- Database: Supabase (Postgres + pgvector + Auth + Storage)
- Single-file preference: keep related logic in one file when possible

## Conventions
- UI text: 繁體中文 for user-facing, English for code
- Variable/function names: English, camelCase (TS), snake_case (Python)
- API responses: English keys, localized values
- Commit messages: English

## Current Phase: Phase 1 - Pipeline Prototype
Goal: CLI tool that takes a video and outputs structured SOP JSON
Stack: Python only (no frontend yet)

Pipeline steps:
1. video → ffmpeg audio extract (.wav)
2. audio → Whisper API → timestamped transcript
3. video → ffmpeg scene detect → keyframe PNGs
4. keyframes → Claude Vision → visual action descriptions
5. transcript + visual descriptions → Claude Sonnet → structured SOP JSON

## Key Decisions
- MVP = Training Mode only (no Shift Mode)
- iPad web app, not native
- Claude Sonnet for vision + text generation
- Whisper API for transcription (not local)
- Supabase pgvector for RAG (not Pinecone)
- Text-only Q&A in v1 (voice in v2)

## File Structure (Phase 1)
/backend/pipeline.py — main pipeline script
/backend/requirements.txt — Python dependencies
/.env — API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY)
