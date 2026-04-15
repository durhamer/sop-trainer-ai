-- Phase 3 Step 3: RAG-powered employee Q&A chat
-- Requires pgvector extension (Supabase enables this via dashboard or CLI)

CREATE EXTENSION IF NOT EXISTS vector;

-- ── SOP step embeddings ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sop_embeddings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_id      uuid        NOT NULL REFERENCES public.sops(id) ON DELETE CASCADE,
  step_number integer     NOT NULL,
  chunk_text  text        NOT NULL,
  embedding   vector(1536) NOT NULL,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sop_embeddings_sop_id_idx
  ON public.sop_embeddings (sop_id);

CREATE INDEX IF NOT EXISTS sop_embeddings_embedding_idx
  ON public.sop_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.sop_embeddings ENABLE ROW LEVEL SECURITY;
-- Backend uses service_role key (bypasses RLS); no frontend direct access needed.

-- ── FAQ embeddings ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.faq_embeddings (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  faq_id     uuid        NOT NULL REFERENCES public.faq(id) ON DELETE CASCADE,
  chunk_text text        NOT NULL,
  embedding  vector(1536) NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS faq_embeddings_embedding_idx
  ON public.faq_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.faq_embeddings ENABLE ROW LEVEL SECURITY;

-- ── Chat history ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid        REFERENCES public.employees(id) ON DELETE SET NULL,
  sop_id      uuid        REFERENCES public.sops(id) ON DELETE SET NULL,
  step_number integer,
  question    text        NOT NULL,
  answer      text        NOT NULL,
  sources     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.chat_history ENABLE ROW LEVEL SECURITY;

-- ── Vector similarity search functions ────────────────────────────────────
-- Called via supabase.rpc() from the backend. Add new layers here (Layer 3+).

CREATE OR REPLACE FUNCTION search_sop_embeddings(
  query_embedding vector(1536),
  target_sop_id   uuid,
  match_count     int DEFAULT 3
)
RETURNS TABLE (
  step_number int,
  chunk_text  text,
  metadata    jsonb,
  similarity  float
)
LANGUAGE sql STABLE AS $$
  SELECT
    step_number,
    chunk_text,
    metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM public.sop_embeddings
  WHERE sop_id = target_sop_id
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION search_faq_embeddings(
  query_embedding vector(1536),
  match_count     int DEFAULT 3
)
RETURNS TABLE (
  faq_id     uuid,
  chunk_text text,
  metadata   jsonb,
  similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT
    faq_id,
    chunk_text,
    metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM public.faq_embeddings
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
