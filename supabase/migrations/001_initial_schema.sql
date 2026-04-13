-- Phase 2 — Admin Dashboard schema

-- Videos
create table if not exists public.videos (
  id            uuid primary key default gen_random_uuid(),
  filename      text not null,
  storage_path  text not null,
  status        text not null default 'uploaded'
                  check (status in ('uploaded','processing','done','error')),
  error_message text,
  created_at    timestamptz not null default now(),
  user_id       uuid references auth.users(id) on delete set null
);

alter table public.videos enable row level security;

create policy "Authenticated users can manage videos"
  on public.videos for all
  using (auth.role() = 'authenticated');

-- SOPs
create table if not exists public.sops (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid references public.videos(id) on delete set null,
  title      text not null,
  raw_json   jsonb,
  created_at timestamptz not null default now()
);

alter table public.sops enable row level security;

create policy "Authenticated users can manage SOPs"
  on public.sops for all
  using (auth.role() = 'authenticated');

-- SOP Steps
create table if not exists public.sop_steps (
  id          uuid primary key default gen_random_uuid(),
  sop_id      uuid not null references public.sops(id) on delete cascade,
  step_number integer not null,
  title       text not null,
  description text,
  warnings    text[],
  image_url   text,
  created_at  timestamptz not null default now()
);

alter table public.sop_steps enable row level security;

create policy "Authenticated users can manage SOP steps"
  on public.sop_steps for all
  using (auth.role() = 'authenticated');

-- FAQ
create table if not exists public.faq (
  id         uuid primary key default gen_random_uuid(),
  question   text not null,
  answer     text not null,
  created_at timestamptz not null default now()
);

alter table public.faq enable row level security;

create policy "Authenticated users can manage FAQ"
  on public.faq for all
  using (auth.role() = 'authenticated');

-- Storage bucket for training videos
-- Run this in the Supabase Dashboard > Storage (or via the API):
--   create bucket 'training-videos' (public: false)
