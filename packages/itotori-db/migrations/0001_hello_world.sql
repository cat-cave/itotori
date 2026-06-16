create table if not exists itotori_projects (
  project_id text primary key,
  bridge_id text not null,
  source_locale text not null,
  target_locale text not null,
  locale_branch_id text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists itotori_bridge_units (
  bridge_unit_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  source_unit_key text not null,
  source_text text not null,
  target_text text,
  text_surface text not null,
  protected_span_count integer not null,
  updated_at timestamptz not null default now()
);

create table if not exists itotori_patch_exports (
  patch_export_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  target_locale text not null,
  entry_count integer not null,
  created_at timestamptz not null default now()
);

create table if not exists itotori_runtime_reports (
  runtime_report_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  status text not null,
  fidelity_tier text not null,
  text_event_count integer not null,
  frame_capture_count integer not null,
  created_at timestamptz not null default now()
);

create table if not exists itotori_hello_world_runs (
  run_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  patch_result_id text not null,
  final_status text not null,
  updated_at timestamptz not null default now()
);
