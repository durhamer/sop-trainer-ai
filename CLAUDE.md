# SOP Trainer AI

## Architecture
- Monorepo: /frontend (Next.js 16+) + /backend (Python FastAPI)
- Frontend: App Router, TypeScript, TailwindCSS, shadcn/ui
- Backend: FastAPI, ffmpeg, Whisper API, Claude API, Supabase
- Database: Supabase (Postgres + pgvector + Auth + Storage)
- Storage: Supabase Storage, bucket "training-videos" (public)
- Auth: Google Sign-In (OAuth) for owners, PIN code for employees
- Deployment: Railway (both frontend and backend services)
- Single-file preference: keep related logic in one file when possible

## Conventions
- UI text: 繁體中文 for user-facing, English for code
- i18n: All user-facing strings in /frontend/src/lib/i18n/zh-TW.ts via t() function. No hardcoded Chinese in components. Add new locales by adding new files (en.ts, ja.ts, etc.)
- Variable/function names: English, camelCase (TS), snake_case (Python)
- API responses: English keys, localized values
- Commit messages: English
- Before pushing frontend changes: run `npm run build` locally to catch TypeScript errors

## Current Phase: Phase 4 - Multi-Tenant Architecture

## Completed
- Phase 1: Video → SOP pipeline (CLI)
- Phase 2: Admin dashboard (upload, SOP editor, FAQ, employee management, auto-review flags)
- Phase 3 Step 1: Employee PIN login + module selection
- Phase 3 Step 2: Step-by-step SOP reader with keyframe images
- Phase 3 Step 3: RAG-powered Q&A chat (Layer 1 + Layer 2)
- Phase 3 Step 4: Training progress tracking
- Phase 3 Extras: TTS voice narration, voice input (STT), AI personality selector, original video playback with timestamp seek, mobile responsive UI
- Deployment: Production on Railway (frontend + backend), Supabase (DB + storage)

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

### Three-layer knowledge retrieval:
- Layer 1: Current context (FREE, no RAG) — ALL step titles as outline + current step full content + previous/next step full content injected directly into prompt
- Layer 2: Owner's knowledge base (RAG search) — all SOPs (marked as shareable by owner) + FAQ for this owner only. Embeddings in pgvector, cosine similarity search. ALWAYS runs alongside Layer 1.
- Layer 3: Cross-owner universal knowledge (FUTURE) — common domain knowledge from SOPs that owners have opted in to share. Architecture supports this layer, not yet implemented.

### Owner-controlled sharing (per SOP):
- shareable_internal (bool, default true): SOP content joins Layer 2 for this owner's other SOPs
- shareable_external (bool, default false): SOP content joins Layer 3 cross-owner pool — owner must opt in

### Question handling:
- Always run Layer 1 + Layer 2 (let Claude decide relevance)
- Layer 3 added when implemented
- Claude's system prompt instructs: "If not in provided context, say 這個問題我不確定，建議詢問您的主管"

### Chat history:
- Store ALL Q&A in chat_history table for future analytics (high-frequency question alerts, SOP improvement suggestions)
- Data stored but analytics not built yet

## Multi-Tenant Model (Phase 4)
- owners table: id (from auth.users), email, name, subscription_tier (reserved for future billing)
- Every data table has owner_id foreign key: sops, employees, faq, store_settings
- RLS: authenticated users only access rows where owner_id = auth.uid()
- On first Google login: auto-create owner record
- Employee PIN auth: backend looks up employee → gets owner_id → scopes all queries
- Simplification: one owner = one store (multi-store per owner deferred)

## Key Decisions
- MVP = Training Mode only (no Shift Mode)
- iPad + mobile web app, not native
- Claude Sonnet for vision + text generation
- Whisper API for transcription (not local)
- Supabase pgvector for RAG (not Pinecone)
- Browser-native Web Speech API for TTS/STT (free, may upgrade to OpenAI TTS later)
- Employee auth: simple PIN code (sessionStorage)
- Admin auth: Google OAuth via Supabase Auth
- Processing stages: dynamic from backend, frontend adapts automatically
- AI personality: 4 presets (嚴厲學長, 溫柔學姊, 搞笑同事, 專業教練), configurable per owner

## File Structure
/backend/
  pipeline.py — video processing pipeline
  main.py — FastAPI server (upload, pipeline, review, employee auth, chat, progress)
  Dockerfile — Railway deployment
  railway.toml — Railway healthcheck config
  requirements.txt

/frontend/src/
  proxy.ts — auth guard (Next.js 16 renamed middleware → proxy)
  lib/supabase.ts — browser client
  lib/supabase-server.ts — server client
  lib/backend.ts — backend URL (uses /api/backend proxy for Safari compatibility)
  lib/types.ts — Database types (supabase-js v2, must include Relationships:[])
  lib/i18n/zh-TW.ts — centralized Chinese strings
  lib/i18n/index.ts — t() function with interpolation
  lib/employee-session.ts — PIN session via sessionStorage
  app/login/ — Google Sign-In
  app/auth/callback/ — OAuth exchange
  app/admin/layout.tsx — sidebar (影片管理, SOP列表, 員工管理, FAQ管理, 訓練進度, 系統設定)
  app/admin/videos/ — upload + processing status (dynamic stages)
  app/admin/sops/ — SOP list with review badges + publish toggle + review state indicators
  app/admin/sops/[id]/edit/ — step editor with review flag highlighting
  app/admin/employees/ — employee CRUD with PIN management
  app/admin/faq/ — FAQ CRUD
  app/admin/progress/ — training progress dashboard
  app/admin/settings/ — AI personality selector
  app/train/login/ — PIN keypad login
  app/train/ — training module selection with progress badges
  app/train/[sop_id]/ — split-screen: step reader (left) + chat panel (right)

/supabase/migrations/ — all SQL migrations in order (001 through latest)

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

## Deployment Notes
- Frontend: Railway service, root directory /frontend, Next.js auto-build
- Backend: Railway service, root directory /backend, Dockerfile build (Nixpacks deprecated)
- Env vars (backend): ANTHROPIC_API_KEY, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FRONTEND_URL
- Env vars (frontend): NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_BACKEND_URL
- Supabase: Site URL and Redirect URLs must match production domain
- Google Cloud Console: OAuth authorized redirect URI = Supabase auth callback

## Known Regression Risks

The following features have regressed during refactors. Be extra careful not to drop these fields/behaviors:

1. **sop_steps.timestamp_start** — Must be included in the step_rows insert in main.py. Required for the "觀看示範" video playback feature to seek to the correct step time. Regressed twice (2026-04-16, 2026-04-20).

2. **Employee page uses anon Supabase client** — /train/** pages MUST use createAnonClient() from lib/supabase.ts, not createClient(). Otherwise admin auth cookies leak into employee queries and RLS filters out other tenants' SOPs. Regressed 2026-04-20.

3. **Video bucket must be PUBLIC** — training-videos bucket in Supabase Storage must be public, otherwise keyframe images won't load for employees (PIN auth, no Supabase session).

4. **RLS policies must specify role** — anon policies need TO anon, authenticated policies need TO authenticated. A policy without role qualifier applies to all roles and can leak data across tenants. See migration 013.

When refactoring, verify all items above still work before pushing.
