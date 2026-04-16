-- 009_sop_video_url.sql
-- Store the source video's public URL on the SOP so the employee reader
-- can stream the original video and seek to the current step's timestamp.

ALTER TABLE sops
  ADD COLUMN IF NOT EXISTS video_url text;

-- Also persist the per-step timestamp so the player can auto-seek.
ALTER TABLE sop_steps
  ADD COLUMN IF NOT EXISTS timestamp_start real;
