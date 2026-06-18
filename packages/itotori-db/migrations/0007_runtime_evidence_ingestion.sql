create table if not exists itotori_runtime_evidence_runs (
  runtime_run_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_bundle_id text not null references itotori_source_bundles(source_bundle_id) on delete restrict,
  source_bundle_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  runtime_report_artifact_id text not null references itotori_artifacts(artifact_id) on delete cascade,
  patch_result_artifact_id text references itotori_artifacts(artifact_id) on delete set null,
  adapter_name text not null,
  adapter_version text,
  status text not null,
  fidelity_tier text not null,
  evidence_tier text,
  text_event_count integer not null default 0,
  branch_event_count integer not null default 0,
  capture_count integer not null default 0,
  recording_count integer not null default 0,
  validation_finding_count integer not null default 0,
  reference_comparison_count integer not null default 0,
  report_created_at timestamptz not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_runtime_runs_status_check check (status in ('passed', 'failed')),
  constraint itotori_runtime_runs_counts_check check (
    text_event_count >= 0
    and branch_event_count >= 0
    and capture_count >= 0
    and recording_count >= 0
    and validation_finding_count >= 0
    and reference_comparison_count >= 0
  )
);

create index if not exists itotori_runtime_runs_project_created_idx
  on itotori_runtime_evidence_runs(project_id, report_created_at);
create index if not exists itotori_runtime_runs_branch_created_idx
  on itotori_runtime_evidence_runs(locale_branch_id, report_created_at);
create index if not exists itotori_runtime_runs_bundle_revision_idx
  on itotori_runtime_evidence_runs(source_bundle_id, source_bundle_revision_id);
create index if not exists itotori_runtime_runs_status_idx
  on itotori_runtime_evidence_runs(status);

create table if not exists itotori_runtime_evidence_items (
  runtime_evidence_id text primary key,
  runtime_run_id text not null references itotori_runtime_evidence_runs(runtime_run_id) on delete cascade,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_bundle_id text not null references itotori_source_bundles(source_bundle_id) on delete restrict,
  source_bundle_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  bridge_unit_id text references itotori_source_units(bridge_unit_id) on delete set null,
  artifact_id text references itotori_artifacts(artifact_id) on delete set null,
  evidence_kind text not null,
  evidence_tier text,
  artifact_kind text,
  portable_artifact_uri text,
  frame integer,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_runtime_evidence_kind_check check (
    evidence_kind in (
      'trace_event',
      'branch_event',
      'capture',
      'recording',
      'approximation',
      'reference_comparison'
    )
  ),
  constraint itotori_runtime_evidence_frame_check check (frame is null or frame >= 0),
  constraint itotori_runtime_evidence_portable_uri_check check (
    portable_artifact_uri is null
    or (
      portable_artifact_uri !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and portable_artifact_uri !~ '^/'
      and portable_artifact_uri !~ '[\\]'
      and portable_artifact_uri like 'artifacts/utsushi/runtime/%'
    )
  )
);

create index if not exists itotori_runtime_evidence_run_kind_idx
  on itotori_runtime_evidence_items(runtime_run_id, evidence_kind);
create index if not exists itotori_runtime_evidence_bridge_unit_idx
  on itotori_runtime_evidence_items(bridge_unit_id);
create index if not exists itotori_runtime_evidence_artifact_idx
  on itotori_runtime_evidence_items(artifact_id);

create table if not exists itotori_runtime_evidence_bridge_unit_refs (
  runtime_evidence_id text not null references itotori_runtime_evidence_items(runtime_evidence_id) on delete cascade,
  bridge_unit_id text not null references itotori_source_units(bridge_unit_id) on delete cascade,
  ref_role text not null,
  source_unit_key text not null default '',
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  primary key (runtime_evidence_id, bridge_unit_id, ref_role, source_unit_key),
  constraint itotori_runtime_evidence_ref_role_check check (
    ref_role in ('primary', 'branch_label', 'branch_target', 'affected', 'covered')
  )
);

create index if not exists itotori_runtime_evidence_refs_bridge_unit_idx
  on itotori_runtime_evidence_bridge_unit_refs(bridge_unit_id);

create table if not exists itotori_runtime_validation_findings (
  finding_id text primary key references itotori_findings(finding_id) on delete cascade,
  runtime_run_id text not null references itotori_runtime_evidence_runs(runtime_run_id) on delete cascade,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_bundle_id text not null references itotori_source_bundles(source_bundle_id) on delete restrict,
  source_bundle_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  bridge_unit_id text references itotori_source_units(bridge_unit_id) on delete set null,
  artifact_id text references itotori_artifacts(artifact_id) on delete set null,
  finding_kind text not null,
  severity text not null,
  message text not null,
  evidence_tier text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists itotori_runtime_validation_run_idx
  on itotori_runtime_validation_findings(runtime_run_id);
create index if not exists itotori_runtime_validation_bridge_unit_idx
  on itotori_runtime_validation_findings(bridge_unit_id);
create index if not exists itotori_runtime_validation_artifact_idx
  on itotori_runtime_validation_findings(artifact_id);

insert into itotori_runtime_evidence_runs (
  runtime_run_id,
  project_id,
  locale_branch_id,
  source_bundle_id,
  source_bundle_revision_id,
  runtime_report_artifact_id,
  patch_result_artifact_id,
  adapter_name,
  adapter_version,
  status,
  fidelity_tier,
  evidence_tier,
  text_event_count,
  branch_event_count,
  capture_count,
  recording_count,
  validation_finding_count,
  reference_comparison_count,
  report_created_at,
  metadata,
  created_at,
  updated_at
)
select
  runtime.artifact_id,
  runtime.project_id,
  runtime.locale_branch_id,
  runtime.source_bundle_id,
  bundle.source_bundle_revision_id,
  runtime.artifact_id,
  patch.artifact_id,
  coalesce(runtime.metadata->>'adapterName', 'unknown-runtime-adapter'),
  runtime.metadata->>'adapterVersion',
  case
    when runtime.metadata->>'status' = 'failed' then 'failed'
    else 'passed'
  end,
  coalesce(runtime.metadata->>'fidelityTier', 'layout_probe'),
  runtime.metadata->>'evidenceTier',
  coalesce(nullif(runtime.metadata->>'textEventCount', ''), '0')::integer,
  coalesce(nullif(runtime.metadata->>'branchEventCount', ''), '0')::integer,
  coalesce(nullif(runtime.metadata->>'frameCaptureCount', ''), '0')::integer,
  coalesce(nullif(runtime.metadata->>'recordingArtifactCount', ''), '0')::integer,
  coalesce(nullif(runtime.metadata->>'validationFindingCount', ''), '0')::integer,
  coalesce(nullif(runtime.metadata->>'referenceComparisonCount', ''), '0')::integer,
  runtime.created_at,
  runtime.metadata || jsonb_build_object('backfilledFromArtifacts', true),
  runtime.created_at,
  now()
from itotori_artifacts runtime
join itotori_source_bundles bundle
  on bundle.source_bundle_id = runtime.source_bundle_id
left join lateral (
  select artifact_id
  from itotori_artifacts patch
  where patch.project_id = runtime.project_id
    and patch.locale_branch_id is not distinct from runtime.locale_branch_id
    and patch.artifact_kind = 'patch_result'
    and patch.metadata->>'runtimeReportId' = runtime.artifact_id
  order by patch.created_at desc
  limit 1
) patch on true
where runtime.artifact_kind = 'runtime_report'
  and runtime.locale_branch_id is not null
  and runtime.source_bundle_id is not null
on conflict (runtime_run_id) do nothing;
