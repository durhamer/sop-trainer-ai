-- Employees table for PIN-based kitchen staff login
create table if not exists public.employees (
  id         uuid primary key default gen_random_uuid(),
  store_id   text,                          -- reserved for multi-tenant; null for now
  name       text not null,
  pin_hash   text not null,                 -- SHA-256 hex of the PIN
  created_at timestamptz not null default now()
);

alter table public.employees enable row level security;

-- Only authenticated (admin) users can manage employees.
-- The backend uses service_role key and bypasses RLS entirely for login checks.
create policy "Admins can manage employees"
  on public.employees for all
  using (auth.role() = 'authenticated');

-- Add published flag to SOPs (default true so existing SOPs stay visible)
alter table public.sops
  add column if not exists published boolean not null default true;
