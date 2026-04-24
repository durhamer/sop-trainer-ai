-- 017_faq_import_jobs.sql
-- Async job tracking for the FAQ import-from-chat feature.
-- The backend creates a row, launches processing in a background task,
-- and updates status/stage as it progresses. The frontend polls
-- GET /api/faq/import-jobs/{job_id} every 3 seconds.

CREATE TABLE IF NOT EXISTS faq_import_jobs (
    id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id      UUID        NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'processing', 'done', 'failed')),
    stage         TEXT,                    -- human-readable progress label shown in the UI
    total_chunks  INT,
    current_chunk INT,
    result        JSONB,                   -- final suggestions array when status='done'
    error_message TEXT,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Only the owning admin can read their own jobs.
-- All writes go through the backend (service role), so no INSERT/UPDATE policy needed.
ALTER TABLE faq_import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_read_own_faq_import_jobs"
    ON faq_import_jobs
    FOR SELECT
    TO authenticated
    USING (owner_id = auth.uid());
