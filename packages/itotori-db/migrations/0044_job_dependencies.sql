alter table itotori_jobs
  add column if not exists depends_on_job_ids jsonb not null default '[]'::jsonb;

alter table itotori_jobs
  add constraint itotori_jobs_depends_on_job_ids_array_chk
  check (jsonb_typeof(depends_on_job_ids) = 'array');

create index if not exists itotori_jobs_depends_on_job_ids_gin_idx
  on itotori_jobs using gin (depends_on_job_ids);
