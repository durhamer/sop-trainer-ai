-- Add dynamic pipeline progress fields to videos table.
-- current_stage: human-readable stage label set by the backend (e.g. "音訊提取")
-- progress_percent: 0-100, computed from stage index by the backend

alter table public.videos
  add column if not exists current_stage text,
  add column if not exists progress_percent integer;
