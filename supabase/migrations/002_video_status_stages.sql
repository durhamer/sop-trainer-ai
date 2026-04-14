-- Extend videos.status check constraint to include pipeline stage values

alter table public.videos
  drop constraint if exists videos_status_check;

alter table public.videos
  add constraint videos_status_check
    check (status in (
      'uploaded',
      'uploading',
      'processing',
      'extracting_audio',
      'transcribing',
      'analyzing_frames',
      'generating_sop',
      'done',
      'error'
    ));
