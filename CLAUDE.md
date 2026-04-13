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

## File Structure (Phase 2)
/backend/main.py — FastAPI server; POST /pipeline/trigger queues pipeline as background task
/frontend/ — Next.js 16.2 (App Router, TypeScript, Tailwind, shadcn/ui)
  src/proxy.ts — auth protection (Next.js 16 renamed middleware → proxy)
  src/lib/supabase.ts — browser client (createBrowserClient)
  src/lib/supabase-server.ts — server client (createServerClient + cookies())
  src/lib/types.ts — Database type (must include Relationships:[] per supabase-js v2)
  src/app/login/ — magic link login
  src/app/auth/callback/ — OTP exchange route
  src/app/admin/layout.tsx — sidebar layout
  src/app/admin/videos/ — upload + status (page.tsx is thin ssr:false wrapper, videos-content.tsx is real UI)
  src/app/admin/sops/ — list SOPs (server component)
  src/app/admin/sops/[id]/edit/ — edit SOP steps (page.tsx = server, sop-editor.tsx = client)
  src/app/admin/faq/ — FAQ CRUD (page.tsx is thin ssr:false wrapper, faq-content.tsx is real UI)
/supabase/migrations/001_initial_schema.sql — DB schema (videos, sops, sop_steps, faq)

## Key Implementation Notes
- Next.js 16: middleware.ts renamed to proxy.ts, export function named `proxy` not `middleware`
- "use client" pages that call createClient() need ssr:false dynamic import wrapper to avoid build-time crash
- supabase-js v2 Database type must include Relationships:[], Views, Functions fields on GenericSchema
- Storage bucket name: training-videos (private)
- Backend uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (not the anon key) to write to DB
- Admin pages auto-poll every 5s for video processing status updates
