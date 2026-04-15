-- Phase 3 Step 4: Employee training progress tracking

CREATE TABLE IF NOT EXISTS public.training_progress (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  sop_id         uuid        NOT NULL REFERENCES public.sops(id) ON DELETE CASCADE,
  current_step   integer     NOT NULL DEFAULT 1,
  completed_steps integer[]  NOT NULL DEFAULT '{}',
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  CONSTRAINT training_progress_employee_sop_unique UNIQUE (employee_id, sop_id)
);

CREATE INDEX IF NOT EXISTS training_progress_employee_idx
  ON public.training_progress (employee_id);

CREATE INDEX IF NOT EXISTS training_progress_sop_idx
  ON public.training_progress (sop_id);

ALTER TABLE public.training_progress ENABLE ROW LEVEL SECURITY;

-- Admins (Supabase-authenticated) can read all progress records
CREATE POLICY "Authenticated users can read training_progress"
  ON public.training_progress FOR SELECT
  USING (auth.role() = 'authenticated');

-- Backend uses service_role key (bypasses RLS) for all writes
