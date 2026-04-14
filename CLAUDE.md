# SOP Trainer AI

## Architecture
- Monorepo: /frontend (Next.js 16+) + /backend (Python FastAPI)
- Frontend: App Router, TypeScript, TailwindCSS, shadcn/ui
- Backend: FastAPI, ffmpeg, Whisper API, Claude API, Supabase
- Database: Supabase (Postgres + pgvector + Auth + Storage)
- Storage: Supabase Storage, bucket "training-videos" (public)
- Single-file preference: keep related logic in one file when possible

## Conventions
- UI text: 繁體中文 for user-facing, English for code
- i18n: All user-facing strings in /frontend/src/lib/i18n/zh-TW.ts via t() function. No hardcoded Chinese in components. Add new locales by adding new files (en.ts, ja.ts, etc.)
- Variable/function names: English, camelCase (TS), snake_case (Python)
- API responses: English keys, localized values
- Commit messages: English

## Current Phase: Phase 3 Step 3 - Employee Q&A Chat Panel (RAG)

## Completed
- Phase 1: Video → SOP pipeline (CLI)
- Phase 2: Admin dashboard (upload, SOP editor, FAQ, employee management, auto-review flags)
- Phase 3 Step 1: Employee PIN login + module selection
- Phase 3 Step 2: Step-by-step SOP reader with keyframe images

## Pipeline Flow (SOP-driven keyframe extraction)
1. video → ffmpeg audio extract (.wav)
2. audio → Whisper API → timestamped transcript
3. transcript → Claude Sonnet → structured SOP JSON with timestamps
4. SOP steps → ffmpeg targeted keyframe extraction (3 frames per step within timestamp range)
5. candidate frames → Claude Vision → pick best frame per step
6. selected frames → upload to Supabase Storage → store URLs in sop_steps
7. SOP steps → Claude review pass → safety/number/order flags

## RAG Architecture (Phase 3 Step 3)

### Three-layer knowledge retrieval:
- Layer 1: Current context (FREE, no RAG) — current step + previous/next step injected directly into prompt. Covers ~70% of questions.
- Layer 2: Store knowledge base (RAG search) — all SOP content + owner FAQ for this store. Embeddings in pgvector, cosine similarity search. Used when Layer 1 can't answer.
- Layer 3: Cross-store universal knowledge (FUTURE) — common F&B knowledge extracted from all stores' SOPs. Architecture must support this layer but don't implement yet.

### Question routing (save tokens):
- Step-related question → Layer 1 only
- Cross-step question → Layer 1 + Layer 2 search
- General knowledge question → Layer 2 + (future) Layer 3
- Off-topic question → Reject politely, zero API cost

### Chat history:
- Store ALL Q&A in chat_history table (user_id, sop_id, step_number, question, answer, created_at)
- This data will power future features: high-frequency question alerts, SOP improvement suggestions
- Do NOT build analytics/alerts yet, just store the data

## Key Decisions
- MVP = Training Mode only (no Shift Mode)
- iPad web app, not native
- Claude Sonnet for vision + text generation
- Whisper API for transcription (not local)
- Supabase pgvector for RAG (not Pinecone)
- Text-only Q&A in v1 (voice in v2)
- Employee auth: simple PIN code (not Supabase Auth)
- Admin auth: Supabase Auth magic link
- Processing stages: dynamic from backend, frontend adapts automatically

## File Structure
/backend/
  pipeline.py — video processing pipeline (SOP-driven keyframe extraction)
  main.py — FastAPI server (upload, pipeline trigger, review, employee auth)
  requirements.txt

/frontend/src/
  proxy.ts — auth guard (Next.js 16 renamed middleware → proxy)
  lib/supabase.ts — browser client
  lib/supabase-server.ts — server client
  lib/types.ts — Database types (supabase-js v2, must include Relationships:[])
  lib/i18n/zh-TW.ts — centralized Chinese strings
  lib/i18n/index.ts — t() function with interpolation
  lib/employee-session.ts — PIN session via sessionStorage
  app/login/ — admin magic link login
  app/auth/callback/ — OTP exchange
  app/admin/layout.tsx — sidebar (影片管理, SOP列表, 員工管理, FAQ管理)
  app/admin/videos/ — upload + processing status (dynamic stages)
  app/admin/sops/ — SOP list with review badges + publish toggle
  app/admin/sops/[id]/edit/ — step editor with review flag highlighting
  app/admin/employees/ — employee CRUD with PIN management
  app/admin/faq/ — FAQ CRUD
  app/train/login/ — PIN keypad login
  app/train/ — training module selection (published SOPs only)
  app/train/[sop_id]/ — step-by-step SOP reader

/supabase/migrations/ — all SQL migrations

## Key Implementation Notes
- Next.js 16: proxy.ts not middleware.ts, export function named "proxy"
- "use client" pages need ssr:false wrapper for Supabase client calls
- supabase-js v2 Database type needs Relationships:[], Views, Functions
- Storage bucket "training-videos" is PUBLIC for keyframe image access
- Backend uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS
- Admin pages auto-poll for processing status
- SOP steps have review_flags (jsonb) and review_confirmed (boolean)
- Pipeline stages are dynamic: backend defines stage list, frontend renders whatever backend reports
