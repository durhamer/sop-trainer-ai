-- 015_general_chat.sql
-- Support for "老闆我有問題！" general Q&A mode.
--
-- Changes:
--   1. search_owner_sop_embeddings: allow NULL exclude_sop_id so general chat
--      (which has no current SOP to exclude) can search all shareable SOPs.
--      Previously AND s.id <> exclude_sop_id would filter everything when NULL
--      because NULL comparisons are always NULL in SQL.

CREATE OR REPLACE FUNCTION search_owner_sop_embeddings(
  query_embedding  vector(1536),
  target_owner_id  uuid,
  exclude_sop_id   uuid,      -- pass NULL from general chat to include all SOPs
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
    -- NULL exclude_sop_id means "don't exclude anything" (general chat mode)
    AND (exclude_sop_id IS NULL OR s.id <> exclude_sop_id)
    AND s.shareable_internal = true
  ORDER BY se.embedding <=> query_embedding
  LIMIT match_count;
$$;
