-- Add review flags to sop_steps for the auto-review feature

alter table public.sop_steps
  add column if not exists review_flags jsonb,
  add column if not exists review_confirmed boolean not null default false;
