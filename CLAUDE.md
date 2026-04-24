# SOP Trainer AI

## Architecture
- Monorepo: /frontend (Next.js 16+) + /backend (Python FastAPI)
- Frontend: App Router, TypeScript, TailwindCSS, shadcn/ui
- Backend: FastAPI, ffmpeg, Whisper API, Claude API, Supabase
- Database: Supabase (Postgres + pgvector + Auth + Storage)
- Storage: Supabase Storage, bucket "training-videos" (public)
- Auth: Google Sign-In (OAuth) for owners, PIN code for employees
- Deployment: Railway (frontend + backend); backend uses Dockerfile (Nixpacks deprecated)
- Single-file preference: keep related logic in one file when possible

## Conventions
- UI text: 繁體中文 for user-facing, English for code
- i18n: All user-facing strings in /frontend/src/lib/i18n/zh-TW.ts via t() function. No hardcoded Chinese in components. Add new locales by adding new files (en.ts, ja.ts, etc.)
- Variable/function names: English, camelCase (TS), snake_case (Python)
- API responses: English keys, localized values
- Commit messages: English
- Before pushing frontend changes: run `npm run build` locally to catch TypeScript errors

## Current Phase: Phase 4 Complete — Multi-tenant SaaS with knowledge sharing

## Completed
- Phase 1: Video → SOP pipeline (CLI)
- Phase 2: Admin dashboard (upload, SOP editor, FAQ, employee management, auto-review flags)
- Phase 3 Step 1: Employee PIN login + module selection
- Phase 3 Step 2: Step-by-step SOP reader with keyframe images
- Phase 3 Step 3: RAG-powered Q&A chat (Layer 1 + Layer 2)
- Phase 3 Step 4: Training progress tracking
- Phase 3 Extras: TTS voice narration, voice input (STT), AI personality selector, original video playback with timestamp seek, mobile responsive UI
- Deployment: Production on Railway (frontend + backend), Supabase (DB + storage)
- Phase 4 Stage 1: Multi-tenant architecture — owners table, per-owner RLS on all data tables, Google OAuth first-login auto-provisioning via auth callback upsert, employee queries scoped by owner_id
- Phase 4 Stage 2: Per-SOP knowledge sharing controls — shareable_internal (Layer 2 peer search) and shareable_external (Layer 3 scaffold, not yet active); admin toggle UI + badges in SOP list
- General Q&A feature ("老闆我有問題！") — employees ask questions outside any specific SOP; floating button on /train, full-screen ChatPanel in mode="general", separate POST /api/chat/general endpoint, sources link back to /train/[sop_id]
- Phase 4 Extra: FAQ import from chat log — owners can upload LINE export (.txt) and get AI-suggested FAQ Q&A pairs, with duplicate detection via embedding similarity (threshold 0.8); POST /api/faq/import-from-chat (multipart: file, role_context, owner_id) + POST /api/faq/reembed; wizard UI in /admin/faq with 3 steps: upload, loading, review+select
- Bulk delete for SOPs and videos in admin list pages (checkbox selection + confirmation dialog)
- RAG query expansion — Claude Haiku rewrites each question into 2-3 phrasing variants before embedding; results unioned, deduped, re-ranked; improves recall when question phrasing is noisy (e.g. "大份胖雞丁炸多久" → strips "大份", finds timing info)
- RAG top_k raised from 3 to 5

## Pipeline Flow (SOP-driven keyframe extraction)
1. video → ffmpeg audio extract (.wav)
2. audio → Whisper API → timestamped transcript
3. transcript → Claude Sonnet → structured SOP JSON with timestamps
4. SOP steps → ffmpeg targeted keyframe extraction (3 frames per step within timestamp range)
5. candidate frames → Claude Vision → pick best frame per step
6. selected frames → upload to Supabase Storage → store URLs in sop_steps
7. SOP steps → Claude review pass → safety/number/order flags
8. SOP content + FAQ → OpenAI embeddings → pgvector for RAG

## RAG Architecture

### Query expansion (step 0 of every search)
- Claude Haiku (`HAIKU_MODEL`) rewrites the question into 2-3 phrasing variants
- All variants embedded in one batch call (OpenAI `text-embedding-3-small`)
- Searches run per-variant; results unioned, deduped by `(sop_id, step_number)` or `faq_id` keeping highest similarity score, then top_k=5 selected
- Falls back to `[original_question]` on any error — zero regression risk

### Three-layer knowledge retrieval:
- Layer 1: Current context (FREE, no RAG) — ALL step titles as outline + current step full content + previous/next step full content injected directly into prompt. Not run in general Q&A mode.
- Layer 2a: Current SOP embeddings — `search_sop_embeddings`, scoped to current SOP. Not run in general Q&A mode.
- Layer 2b: Peer SOPs — `search_owner_sop_embeddings`, same owner, `shareable_internal=true`, current SOP excluded (or no exclusion in general mode). top_k=5 per variant; CHAT_TOP_K constant in main.py.
- Layer 2c: Owner FAQ — `search_faq_embeddings`, scoped to owner_id. top_k=5 per variant.
- Layer 3: Cross-owner universal knowledge (NOT ACTIVE) — SOPs where `shareable_external=true`. SQL function `search_global_sop_embeddings` exists and is deployed but never called. Activate by uncommenting stub in `_search_knowledge_base`.

### Owner-controlled sharing (per SOP):
- `shareable_internal` (bool, default true): SOP content joins Layer 2b for this owner's other SOPs
- `shareable_external` (bool, default false): SOP content joins Layer 3 cross-owner pool — owner must opt in

### General Q&A mode (no specific SOP)
- Triggered by "老闆我有問題！" floating button on /train
- Layer 1 adapted: all published SOP titles as outline (no current step context)
- Layer 2: Layer 2b (all shareable SOPs, `exclude_sop_id=NULL`) + Layer 2c (FAQ); no Layer 2a
- Sources are SOP-level with `sop_id` for `/train/[sop_id]` links
- `chat_history` records: `sop_id=null`, `step_number=null`
- Endpoint: `POST /api/chat/general` — `{employee_id, owner_id, question}`

### Chunking strategy:
- One embedding per SOP step: title + description + warnings concatenated
- One embedding per FAQ entry: question + answer concatenated
- If recall suffers on long steps, consider splitting into multiple smaller chunks (not done yet)

### Chat history:
- All Q&A stored in chat_history for future analytics (high-frequency questions, SOP improvement signals)
- Analytics not built yet

## Multi-Tenant Model (Phase 4)
- `owners` table: `id` (mirrors `auth.users.id`), `email`, `name`, `subscription_tier` (reserved)
- Every data table has `owner_id` FK: `sops`, `employees`, `faq`, `store_settings`
- RLS: `authenticated` role sees only rows where `owner_id = auth.uid()`; `anon` role sees only published SOPs/steps (migrations 011, 013)
- On first Google login: `auth/callback/route.ts` upserts into `owners` (non-fatal, best-effort)
- `auto_set_owner_id()` BEFORE INSERT trigger fills `owner_id = auth.uid()` for admin inserts
- Employee PIN auth: backend reads `owner_id` from employee row, scopes all queries explicitly
- Simplification: one owner = one store (multi-store per owner deferred)

## Key Decisions
- MVP = Training Mode only (no Shift Mode)
- iPad + mobile web app, not native
- Claude Sonnet for vision + text generation + RAG answer generation
- Claude Haiku for query expansion (cheap/fast; one call per chat request)
- Whisper API for transcription (not local)
- Supabase pgvector for RAG (not Pinecone)
- Browser-native Web Speech API for TTS/STT (free, may upgrade to OpenAI TTS later)
- Employee auth: simple PIN code (sessionStorage)
- Admin auth: Google OAuth via Supabase Auth
- Processing stages: dynamic from backend, frontend adapts automatically
- AI personality: 4 presets (嚴厲學長, 溫柔學姊, 搞笑同事, 專業教練), configurable per owner
- Chunking: one embedding per step (whole step as one chunk); consider sub-step chunking if recall degrades on long steps

## File Structure
/backend/
  pipeline.py — video processing pipeline
  main.py — FastAPI server (upload, pipeline, review, employee auth, chat, progress, general chat)
  Dockerfile — Railway deployment (replaces deprecated Nixpacks)
  railway.toml — Railway healthcheck config
  requirements.txt

/frontend/src/
  proxy.ts — auth guard (Next.js 16 renamed middleware → proxy)
  lib/supabase.ts — browser client; createAnonClient() for /train/** (no auth cookie)
  lib/supabase-server.ts — server client
  lib/backend.ts — backend URL (/api/backend proxy for Safari ITP compatibility)
  lib/types.ts — Database types (supabase-js v2, must include Relationships:[])
  lib/i18n/zh-TW.ts — centralized Chinese strings
  lib/i18n/index.ts — t() function with interpolation
  lib/employee-session.ts — PIN session via sessionStorage; includes owner_id
  app/login/ — Google Sign-In
  app/auth/callback/ — OAuth exchange + owner upsert on first login
  app/admin/layout.tsx — sidebar (影片管理, SOP列表, 員工管理, FAQ管理, 訓練進度, 系統設定)
  app/admin/videos/ — upload + processing status (dynamic stages) + bulk delete
  app/admin/sops/ — SOP list with review badges + publish toggle + sharing badges + bulk delete
  app/admin/sops/[id]/edit/ — step editor with review flag highlighting + sharing toggles
  app/admin/employees/ — employee CRUD with PIN management
  app/admin/faq/ — FAQ CRUD
  app/admin/progress/ — training progress dashboard
  app/admin/settings/ — AI personality selector
  app/train/login/ — PIN keypad login
  app/train/ — training module selection with progress badges + "老闆我有問題！" floating button
  app/train/[sop_id]/ — split-screen: step reader (left) + chat panel (right)
  app/train/[sop_id]/chat-panel.tsx — reusable chat; mode="sop" (default) or mode="general"

/supabase/migrations/
  001–010: initial schema, video status, review flags, employees, storage policies,
            pipeline progress, RAG/chat, training progress, video URL, store settings
  011: public read policies for published SOPs (anon role)
  012: multi-tenant — owners table, owner_id columns, RLS, auto_set_owner_id trigger
  013: fix RLS tenant isolation — scope anon policies to TO anon only
  014: SOP sharing flags (shareable_internal/external) + Layer 2b/3 SQL functions
  015: search_owner_sop_embeddings handles NULL exclude_sop_id (general chat)

## Key Implementation Notes
- Next.js 16: proxy.ts not middleware.ts, export function named "proxy"
- "use client" pages need ssr:false wrapper for Supabase client calls
- supabase-js v2 Database type needs Relationships:[], Views, Functions
- Storage bucket "training-videos" is PUBLIC for keyframe image access
- Backend uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS
- Frontend uses /api/backend/* proxy (next.config.ts rewrites) to avoid Safari ITP cross-site blocks
- SOP steps have: review_flags (jsonb), review_confirmed (bool), timestamp_start (real), image_url
- SOPs have: published (bool), video_url, shareable_internal (default true), shareable_external (default false)
- Pipeline stages are dynamic: backend defines stage list, frontend renders current_stage + progress_percent
- RLS silently returns empty results (no error) — always suspect RLS first when debugging "data visible to some users but not others"
- HAIKU_MODEL constant in main.py = "claude-haiku-4-5-20251001"; CLAUDE_MODEL imported from pipeline.py

## Deployment Notes
- Frontend: Railway service, root directory /frontend, Next.js auto-build
- Backend: Railway service, root directory /backend, Dockerfile build (Nixpacks deprecated — do not revert)
- Env vars (backend): ANTHROPIC_API_KEY, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FRONTEND_URL
- Env vars (frontend): NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_BACKEND_URL
- Supabase: Site URL and Redirect URLs must match production domain
- Google Cloud Console: OAuth authorized redirect URI = Supabase auth callback

## Known Regression Risks

The following features have regressed during refactors. Be extra careful not to drop these fields/behaviors:

1. **sop_steps.timestamp_start in pipeline insert** — Must be included in the `step_rows` dict in `main.py run_pipeline`. Required for the "觀看示範" video playback seek. Regressed twice (2026-04-16, 2026-04-20). Defensive runtime check already added above the insert.

2. **Employee pages must use createAnonClient()** — `/train/**` pages MUST use `createAnonClient()` from `lib/supabase.ts`, never `createClient()`. Otherwise admin auth cookies leak into employee queries and RLS filters out the wrong tenant's SOPs. Regressed 2026-04-20.

3. **training-videos bucket must be PUBLIC** — Supabase Storage bucket must stay public; employees have no Supabase session so private signed URLs won't work for keyframe images.

4. **RLS policies must specify role** — Anon-facing policies need `TO anon`; admin policies need `TO authenticated`. A policy without a role qualifier applies to all roles and can leak data across tenants. See migration 013.

5. **Frontend sop_steps SELECT must include timestamp_start** — `/train/[sop_id]/sop-reader.tsx` uses `.select("*")` — do not narrow this to a field list without explicitly including `timestamp_start`, or the video player cannot seek to the correct step time.

6. **All sop_steps writes must preserve timestamp_start** — Any UPDATE, DELETE+INSERT, or upsert on `sop_steps` must carry `timestamp_start` through. The SOP editor `handleSave()` does a full delete+re-insert for reordering — omitting the field silently wipes it on every admin save. Fixed 2026-04-21; do not regress.

7. **Employee PIN login must be scoped to owner_id** — The `/auth/employee` backend endpoint requires both `pin` AND `owner_id`; it filters `employees` by `pin_hash AND owner_id`. PINs are not unique across tenants — a 4-digit PIN has high collision probability. The employee login URL must be `/train/login/[owner_id]` so the correct owner is always known. The owner's store-specific URL is shown in Admin → Settings. Never revert to PIN-only lookup. Fixed 2026-04-23.

When refactoring, verify all items above still work before pushing.
