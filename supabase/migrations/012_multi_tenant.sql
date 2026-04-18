-- 012_multi_tenant.sql
-- Introduce per-owner data isolation. Every owner is a Supabase Auth user
-- (admin who signed in via Google OAuth). Employees belong to an owner.

-- ── 1. owners table ───────────────────────────────────────────────────────────
CREATE TABLE public.owners (
  id                uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email             text        NOT NULL,
  name              text        NOT NULL DEFAULT '',
  subscription_tier text        NOT NULL DEFAULT 'free',
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.owners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read and update their own record"
  ON public.owners FOR ALL
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ── 2. Add owner_id columns ───────────────────────────────────────────────────
ALTER TABLE public.videos         ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.owners(id);
ALTER TABLE public.sops           ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.owners(id);
ALTER TABLE public.employees      ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.owners(id);
ALTER TABLE public.faq            ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.owners(id);
ALTER TABLE public.store_settings ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.owners(id);
ALTER TABLE public.faq_embeddings ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.owners(id);

-- One settings row per owner (NULLs don't conflict with each other, so the
-- legacy seeded row with owner_id = NULL is not affected)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_settings_owner_id_unique'
  ) THEN
    ALTER TABLE public.store_settings
      ADD CONSTRAINT store_settings_owner_id_unique UNIQUE (owner_id);
  END IF;
END $$;

-- ── 3. Auto-set owner_id on INSERT for admin-originated tables ────────────────
-- When the admin frontend inserts without an explicit owner_id, fill it from
-- the current authenticated user (auth.uid()). The backend always passes
-- owner_id explicitly (service_role token has no auth.uid()), so this trigger
-- is a no-op for backend inserts.

CREATE OR REPLACE FUNCTION public.auto_set_owner_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS NULL THEN
    NEW.owner_id = auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER videos_auto_owner
  BEFORE INSERT ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_owner_id();

CREATE TRIGGER sops_auto_owner
  BEFORE INSERT ON public.sops
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_owner_id();

CREATE TRIGGER employees_auto_owner
  BEFORE INSERT ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_owner_id();

CREATE TRIGGER faq_auto_owner
  BEFORE INSERT ON public.faq
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_owner_id();

CREATE TRIGGER store_settings_auto_owner
  BEFORE INSERT ON public.store_settings
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_owner_id();

-- ── 4. Replace RLS policies with owner-scoped versions ───────────────────────

-- videos
DROP POLICY IF EXISTS "Authenticated users can manage videos"            ON public.videos;
CREATE POLICY "Owners can manage their videos"
  ON public.videos FOR ALL
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- sops: admins manage their own; employees can read published ones (anon key)
DROP POLICY IF EXISTS "Authenticated users can manage SOPs"              ON public.sops;
DROP POLICY IF EXISTS "Anyone can read published SOPs"                   ON public.sops;
CREATE POLICY "Owners can manage their SOPs"
  ON public.sops FOR ALL
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Anyone can read published SOPs"
  ON public.sops FOR SELECT
  USING (published = true);

-- sop_steps: scoped through parent sop
DROP POLICY IF EXISTS "Authenticated users can manage SOP steps"         ON public.sop_steps;
DROP POLICY IF EXISTS "Anyone can read steps of published SOPs"          ON public.sop_steps;
CREATE POLICY "Owners can manage steps of their SOPs"
  ON public.sop_steps FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sops
      WHERE sops.id = sop_steps.sop_id AND sops.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sops
      WHERE sops.id = sop_steps.sop_id AND sops.owner_id = auth.uid()
    )
  );
CREATE POLICY "Anyone can read steps of published SOPs"
  ON public.sop_steps FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.sops
      WHERE sops.id = sop_steps.sop_id AND sops.published = true
    )
  );

-- employees
DROP POLICY IF EXISTS "Admins can manage employees"                      ON public.employees;
CREATE POLICY "Owners can manage their employees"
  ON public.employees FOR ALL
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- faq
DROP POLICY IF EXISTS "Authenticated users can manage FAQ"               ON public.faq;
CREATE POLICY "Owners can manage their FAQ"
  ON public.faq FOR ALL
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- store_settings
DROP POLICY IF EXISTS "admins can manage store_settings"                 ON public.store_settings;
CREATE POLICY "Owners can manage their settings"
  ON public.store_settings FOR ALL
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- training_progress: scoped through the employee's owner
DROP POLICY IF EXISTS "Authenticated users can read training_progress"   ON public.training_progress;
CREATE POLICY "Owners can read their employees training progress"
  ON public.training_progress FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.employees
      WHERE employees.id = training_progress.employee_id
        AND employees.owner_id = auth.uid()
    )
  );

-- ── 5. Update search_faq_embeddings to filter by owner ────────────────────────
-- The previous signature had no owner parameter and searched all FAQs.
-- New signature adds target_owner_id to isolate each owner's knowledge base.

CREATE OR REPLACE FUNCTION search_faq_embeddings(
  query_embedding vector(1536),
  target_owner_id uuid,
  match_count     int DEFAULT 3
)
RETURNS TABLE (
  faq_id     uuid,
  chunk_text text,
  metadata   jsonb,
  similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT
    fe.faq_id,
    fe.chunk_text,
    fe.metadata,
    1 - (fe.embedding <=> query_embedding) AS similarity
  FROM public.faq_embeddings fe
  WHERE fe.owner_id = target_owner_id
  ORDER BY fe.embedding <=> query_embedding
  LIMIT match_count;
$$;
