-- 018_line_integration.sql
-- LINE Messaging API integration.
-- Employees bind their LINE account once with a PIN, then ask questions in LINE.

-- Add LINE binding column to employees
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS line_user_id text UNIQUE;

-- Add per-owner LINE channel credentials (for future multi-tenant LINE support).
-- For now the single LINE channel uses env vars; these columns are reserved.
ALTER TABLE public.owners
  ADD COLUMN IF NOT EXISTS line_channel_id text,
  ADD COLUMN IF NOT EXISTS line_channel_secret text,
  ADD COLUMN IF NOT EXISTS line_channel_access_token text;
