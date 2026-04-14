-- Storage policies for training-videos bucket
--
-- The backend always uses the service_role key (bypasses RLS) so it can
-- upload without any policy.  These policies cover frontend access:
--   1. Admin (Supabase-authenticated) can read everything in the bucket.
--   2. Anyone can read the sops/* prefix — keyframe images are embedded in
--      the employee training view which uses PIN auth, not Supabase Auth.

create policy "Authenticated users can read training-videos"
  on storage.objects for select
  using (
    bucket_id = 'training-videos'
    and auth.role() = 'authenticated'
  );

create policy "Public read for SOP keyframes"
  on storage.objects for select
  using (
    bucket_id = 'training-videos'
    and starts_with(name, 'sops/')
  );
