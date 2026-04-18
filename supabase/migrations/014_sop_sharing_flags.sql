-- 014_sop_sharing_flags.sql
-- Per-SOP knowledge sharing controls for Layer 2 (within owner) and Layer 3
-- (cross-owner, future). Flags are checked at query time so owners can toggle
-- sharing without re-running the embedding pipeline.

-- ── 1. Sharing flags on sops ──────────────────────────────────────────────────
ALTER TABLE public.sops
  ADD COLUMN IF NOT EXISTS shareable_internal boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS shareable_external boolean NOT NULL DEFAULT false;

-- ── 2. Layer 2: cross-SOP same-owner search ───────────────────────────────────
-- Searches the owner's OTHER shareable SOPs (excluding the current one).
-- Called alongside search_sop_embeddings so the current SOP's own content
-- always comes first (via Layer 1 context), then peer SOPs contribute here.

CREATE OR REPLACE FUNCTION search_owner_sop_embeddings(
  query_embedding  vector(1536),
  target_owner_id  uuid,
  exclude_sop_id   uuid,
  match_count      int DEFAULT 3
)
RETURNS TABLE (
  sop_id      uuid,
  step_number int,
  chunk_text  text,
  metadata    jsonb,
  similarity  float
)
LANGUAGE sql STABLE AS $$
  SELECT
    se.sop_id,
    se.step_number,
    se.chunk_text,
    se.metadata,
    1 - (se.embedding <=> query_embedding) AS similarity
  FROM public.sop_embeddings se
  JOIN public.sops s ON s.id = se.sop_id
  WHERE s.owner_id = target_owner_id
    AND s.id <> exclude_sop_id
    AND s.shareable_internal = true
  ORDER BY se.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── 3. Layer 3 scaffold: global cross-owner search (NOT YET ACTIVE) ───────────
-- Queries sop_embeddings joined with sops where shareable_external = true.
-- This function is deployed but never called by the backend until Layer 3
-- is explicitly activated. Tenant isolation is preserved: other owners never
-- get direct row access — they only receive searched/aggregated content via
-- this RPC, and the backend controls what it does with the result.

CREATE OR REPLACE FUNCTION search_global_sop_embeddings(
  query_embedding vector(1536),
  match_count     int DEFAULT 3
)
RETURNS TABLE (
  sop_id      uuid,
  step_number int,
  chunk_text  text,
  metadata    jsonb,
  similarity  float
)
LANGUAGE sql STABLE AS $$
  SELECT
    se.sop_id,
    se.step_number,
    se.chunk_text,
    se.metadata,
    1 - (se.embedding <=> query_embedding) AS similarity
  FROM public.sop_embeddings se
  JOIN public.sops s ON s.id = se.sop_id
  WHERE s.shareable_external = true
  ORDER BY se.embedding <=> query_embedding
  LIMIT match_count;
$$;
