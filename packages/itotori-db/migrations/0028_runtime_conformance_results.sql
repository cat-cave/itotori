-- UTSUSHI-030: Runtime conformance ingestion seam.
-- Persistence for `ConformanceResult` / `ConformanceManifest` JSON payloads
-- ingested via `itotori ingest-conformance`. Evidence tier and fidelity tier
-- columns are `text` (never enums) so byte-equality cannot be defeated by an
-- enum rename. The semantic-code whitelist is mirrored by a DB CHECK
-- constraint as a belt-and-suspenders defense beside the TS validator in
-- `packages/localization-bridge-schema/src/conformance.ts`.

create table if not exists itotori_conformance_runs (
  conformance_run_id text primary key,
  project_id text not null
    references itotori_projects(project_id) on delete cascade,
  locale_branch_id text
    references itotori_locale_branches(locale_branch_id) on delete cascade,
  manifest_artifact_id text
    references itotori_artifacts(artifact_id) on delete set null,
  report_artifact_id text not null
    references itotori_artifacts(artifact_id) on delete cascade,
  adapter_id text not null,
  abi_version integer not null,
  schema_version text not null,
  manifest_fidelity_tier text,
  result_count integer not null default 0,
  pass_count integer not null default 0,
  fail_count integer not null default 0,
  skip_count integer not null default 0,
  unsupported_count integer not null default 0,
  recorded_at timestamptz not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_conformance_runs_counts_check check (
    result_count >= 0
    and pass_count >= 0
    and fail_count >= 0
    and skip_count >= 0
    and unsupported_count >= 0
    and result_count = pass_count + fail_count + skip_count + unsupported_count
  ),
  constraint itotori_conformance_runs_schema_version_check check (
    schema_version = '0.2.0-alpha'
  )
);

create index if not exists itotori_conformance_runs_project_recorded_idx
  on itotori_conformance_runs(project_id, recorded_at);
create index if not exists itotori_conformance_runs_adapter_idx
  on itotori_conformance_runs(adapter_id);

create table if not exists itotori_conformance_results (
  conformance_result_id text primary key,
  conformance_run_id text not null
    references itotori_conformance_runs(conformance_run_id) on delete cascade,
  project_id text not null
    references itotori_projects(project_id) on delete cascade,
  adapter_id text not null,
  profile_id text not null,
  outcome_kind text not null,
  pass_evidence_tier text,
  semantic_code text,
  outcome_message text,
  declared_in_manifest boolean,
  recorded_at timestamptz not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_conformance_results_outcome_kind_check check (
    outcome_kind in ('pass', 'fail', 'skip', 'unsupported')
  ),
  constraint itotori_conformance_results_profile_id_check check (
    profile_id in (
      'text-trace',
      'branch-capture',
      'snapshot-restore',
      'frame-capture',
      'recording-capture',
      'deterministic-replay'
    )
  ),
  constraint itotori_conformance_results_pass_tier_check check (
    (outcome_kind = 'pass' and pass_evidence_tier in ('E0','E1','E2','E3','E4'))
    or (outcome_kind <> 'pass' and pass_evidence_tier is null)
  ),
  constraint itotori_conformance_results_semantic_code_check check (
    (outcome_kind = 'pass' and semantic_code is null)
    or (outcome_kind <> 'pass' and semantic_code is not null)
  ),
  constraint itotori_conformance_results_semantic_code_prefix_check check (
    semantic_code is null
    or semantic_code like 'utsushi.conformance.%'
    or semantic_code like 'utsushi.snapshot.%'
    or semantic_code like 'kaifuu.%'
  ),
  constraint itotori_conformance_results_declared_flag_check check (
    (outcome_kind = 'unsupported' and declared_in_manifest is not null)
    or (outcome_kind <> 'unsupported' and declared_in_manifest is null)
  )
);

create index if not exists itotori_conformance_results_run_idx
  on itotori_conformance_results(conformance_run_id);
create index if not exists itotori_conformance_results_profile_outcome_idx
  on itotori_conformance_results(profile_id, outcome_kind);

create table if not exists itotori_conformance_evidence_refs (
  conformance_evidence_ref_id text primary key,
  conformance_result_id text not null
    references itotori_conformance_results(conformance_result_id) on delete cascade,
  evidence_kind text not null,
  artifact_kind text,
  uri text,
  artifact_id text,
  line_id text,
  frame_id text,
  run_id text,
  fixture_id text,
  bridge_unit_id text,
  state_path text,
  ordinal integer not null,
  created_at timestamptz not null default now(),
  constraint itotori_conformance_evidence_refs_kind_check check (
    evidence_kind in (
      'runtimeArtifact',
      'textLine',
      'frameArtifactRef',
      'replayLogRef',
      'implMapFixture',
      'bridgeUnit',
      'statePath'
    )
  ),
  constraint itotori_conformance_evidence_refs_uri_check check (
    uri is null
    or (
      uri !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and uri !~ '^/'
      and uri !~ '[\\]'
      and uri like 'artifacts/utsushi/runtime/%'
    )
  )
);

create index if not exists itotori_conformance_evidence_refs_result_idx
  on itotori_conformance_evidence_refs(conformance_result_id, ordinal);

create table if not exists itotori_conformance_findings (
  conformance_finding_id text primary key,
  conformance_run_id text not null
    references itotori_conformance_runs(conformance_run_id) on delete cascade,
  finding_code text not null,
  severity text not null,
  message text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  constraint itotori_conformance_findings_severity_check check (
    severity in ('info', 'warning', 'error')
  )
);

create index if not exists itotori_conformance_findings_run_idx
  on itotori_conformance_findings(conformance_run_id);
