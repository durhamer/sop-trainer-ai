-- 013_fix_sop_tenant_isolation.sql
-- The "Anyone can read published SOPs" policies were created with no role
-- qualifier, so they applied to ALL roles including `authenticated`. This
-- allowed authenticated admin users to see published SOPs from every tenant.
--
-- Fix: scope both policies to the `anon` role only. Employees use the anon
-- key (no Supabase Auth session), so they still get read access. Authenticated
-- admins fall through exclusively to the "Owners can manage their SOPs" policy
-- which already enforces owner_id = auth.uid().

-- sops
DROP POLICY IF EXISTS "Anyone can read published SOPs" ON public.sops;
CREATE POLICY "Anon can read published SOPs"
  ON public.sops FOR SELECT
  TO anon
  USING (published = true);

-- sop_steps
DROP POLICY IF EXISTS "Anyone can read steps of published SOPs" ON public.sop_steps;
CREATE POLICY "Anon can read steps of published SOPs"
  ON public.sop_steps FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.sops
      WHERE sops.id = sop_steps.sop_id AND sops.published = true
    )
  );
