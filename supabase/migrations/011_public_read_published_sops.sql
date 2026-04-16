-- Allow anonymous (employee-facing) reads of published SOPs and their steps.
--
-- The employee training pages use the Supabase anon key with no auth session.
-- Without these policies, RLS silently returns 0 rows for unauthenticated
-- requests, which appeared as "no modules" on Safari (strict cookie isolation
-- meant the admin session never leaked into the employee browser context).

create policy "Anyone can read published SOPs"
  on public.sops for select
  using (published = true);

create policy "Anyone can read steps of published SOPs"
  on public.sop_steps for select
  using (
    exists (
      select 1 from public.sops
      where sops.id = sop_steps.sop_id
        and sops.published = true
    )
  );
