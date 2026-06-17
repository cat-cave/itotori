do $$
begin
  if to_regclass('itotori_events') is not null then
    drop trigger if exists itotori_events_append_only_trigger on itotori_events;
  end if;
end $$;
drop function if exists itotori_events_append_only();

do $$
begin
  if to_regclass('itotori_projects') is not null
    and exists (
      select 1
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'itotori_projects'
        and column_name = 'bridge_id'
    )
    and to_regclass('itotori_legacy_projects') is null then
    alter table itotori_projects rename to itotori_legacy_projects;
  end if;

  if to_regclass('itotori_bridge_units') is not null
    and to_regclass('itotori_legacy_bridge_units') is null then
    alter table itotori_bridge_units rename to itotori_legacy_bridge_units;
  end if;

  if to_regclass('itotori_patch_exports') is not null
    and to_regclass('itotori_legacy_patch_exports') is null then
    alter table itotori_patch_exports rename to itotori_legacy_patch_exports;
  end if;

  if to_regclass('itotori_runtime_reports') is not null
    and to_regclass('itotori_legacy_runtime_reports') is null then
    alter table itotori_runtime_reports rename to itotori_legacy_runtime_reports;
  end if;

  if to_regclass('itotori_hello_world_runs') is not null
    and to_regclass('itotori_legacy_hello_world_runs') is null then
    alter table itotori_hello_world_runs rename to itotori_legacy_hello_world_runs;
  end if;
end $$;

create table if not exists itotori_workspaces (
  workspace_id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists itotori_projects (
  project_id text primary key,
  workspace_id text not null references itotori_workspaces(workspace_id) on delete cascade,
  project_key text not null,
  name text not null,
  source_locale text not null,
  status text not null,
  game_id text,
  game_version text,
  source_profile_id text,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists itotori_projects_workspace_key_idx
  on itotori_projects(workspace_id, project_key);
create index if not exists itotori_projects_workspace_status_idx
  on itotori_projects(workspace_id, status);

create table if not exists itotori_source_revisions (
  source_revision_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  revision_kind text not null,
  value text not null,
  created_at timestamptz not null default now()
);

create index if not exists itotori_source_revisions_project_idx
  on itotori_source_revisions(project_id);
create index if not exists itotori_source_revisions_kind_value_idx
  on itotori_source_revisions(revision_kind, value);

create table if not exists itotori_source_bundles (
  source_bundle_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  source_bundle_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  bridge_id text not null,
  schema_version text not null,
  source_bundle_hash text not null,
  source_locale text not null,
  extractor_name text not null,
  extractor_version text not null,
  unit_count integer not null,
  asset_count integer not null,
  imported_at timestamptz not null default now()
);

create unique index if not exists itotori_source_bundles_bridge_idx
  on itotori_source_bundles(bridge_id);
create index if not exists itotori_source_bundles_project_imported_idx
  on itotori_source_bundles(project_id, imported_at);
create index if not exists itotori_source_bundles_revision_idx
  on itotori_source_bundles(source_bundle_revision_id);
create index if not exists itotori_source_bundles_hash_idx
  on itotori_source_bundles(source_bundle_hash);

create table if not exists itotori_assets (
  asset_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  source_bundle_id text not null references itotori_source_bundles(source_bundle_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  asset_key text not null,
  asset_kind text not null,
  source_hash text not null,
  path text,
  created_at timestamptz not null default now()
);

create index if not exists itotori_assets_project_kind_idx
  on itotori_assets(project_id, asset_kind);
create index if not exists itotori_assets_bundle_key_idx
  on itotori_assets(source_bundle_id, asset_key);
create index if not exists itotori_assets_revision_idx
  on itotori_assets(source_revision_id);

create table if not exists itotori_source_units (
  bridge_unit_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  source_bundle_id text not null references itotori_source_bundles(source_bundle_id) on delete cascade,
  source_asset_id text not null references itotori_assets(asset_id) on delete restrict,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  surface_id text not null,
  surface_kind text not null,
  source_unit_key text not null,
  occurrence_id text not null,
  source_locale text not null,
  source_text text not null,
  source_hash text not null,
  source_location jsonb not null,
  speaker jsonb,
  context jsonb not null,
  policy jsonb,
  spans jsonb not null,
  patch_ref jsonb not null,
  runtime_expectation jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists itotori_source_units_bundle_key_idx
  on itotori_source_units(source_bundle_id, source_unit_key);
create index if not exists itotori_source_units_project_locale_key_idx
  on itotori_source_units(project_id, source_locale, source_unit_key);
create index if not exists itotori_source_units_asset_idx
  on itotori_source_units(source_asset_id);
create index if not exists itotori_source_units_revision_idx
  on itotori_source_units(source_revision_id);

create table if not exists itotori_locale_branches (
  locale_branch_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  source_bundle_id text not null references itotori_source_bundles(source_bundle_id) on delete restrict,
  target_locale text not null,
  branch_name text not null,
  status text not null,
  created_by_user_id text references itotori_users(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists itotori_locale_branches_project_locale_idx
  on itotori_locale_branches(project_id, target_locale);
create index if not exists itotori_locale_branches_bundle_idx
  on itotori_locale_branches(source_bundle_id);

create table if not exists itotori_locale_branch_units (
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  bridge_unit_id text not null references itotori_source_units(bridge_unit_id) on delete cascade,
  target_text text,
  updated_at timestamptz not null default now(),
  primary key (locale_branch_id, bridge_unit_id)
);

create index if not exists itotori_locale_branch_units_bridge_unit_idx
  on itotori_locale_branch_units(bridge_unit_id);

create table if not exists itotori_events (
  event_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  event_kind text not null,
  occurred_at timestamptz not null,
  actor jsonb not null,
  task_id text,
  finding_id text,
  subject_refs jsonb not null,
  provenance jsonb not null,
  causal_links jsonb not null,
  payload jsonb,
  appended_at timestamptz not null default now()
);

create index if not exists itotori_events_project_branch_time_idx
  on itotori_events(project_id, locale_branch_id, occurred_at);
create index if not exists itotori_events_kind_time_idx
  on itotori_events(event_kind, occurred_at);
create index if not exists itotori_events_task_idx
  on itotori_events(task_id);
create index if not exists itotori_events_finding_idx
  on itotori_events(finding_id);

create table if not exists itotori_findings (
  finding_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  finding_kind text not null,
  severity text not null,
  quality_category text,
  title text not null,
  description text not null,
  impact text not null,
  status text not null,
  created_at timestamptz not null,
  reported_by_task_id text,
  first_seen_event_id text references itotori_events(event_id) on delete set null,
  affected_refs jsonb not null,
  evidence jsonb not null,
  provenance jsonb not null,
  causal_links jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists itotori_findings_project_branch_status_idx
  on itotori_findings(project_id, locale_branch_id, status);
create index if not exists itotori_findings_project_severity_created_idx
  on itotori_findings(project_id, severity, created_at);
create index if not exists itotori_findings_first_seen_event_idx
  on itotori_findings(first_seen_event_id);

create table if not exists itotori_artifacts (
  artifact_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  source_bundle_id text references itotori_source_bundles(source_bundle_id) on delete set null,
  bridge_unit_id text references itotori_source_units(bridge_unit_id) on delete set null,
  finding_id text references itotori_findings(finding_id) on delete set null,
  artifact_kind text not null,
  uri text,
  hash text,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists itotori_artifacts_project_branch_kind_idx
  on itotori_artifacts(project_id, locale_branch_id, artifact_kind);
create index if not exists itotori_artifacts_finding_idx
  on itotori_artifacts(finding_id);
create index if not exists itotori_artifacts_bridge_unit_idx
  on itotori_artifacts(bridge_unit_id);
create index if not exists itotori_artifacts_source_bundle_idx
  on itotori_artifacts(source_bundle_id);

do $$
begin
  if to_regclass('itotori_legacy_projects') is not null then
    insert into itotori_workspaces (workspace_id, name)
    values ('local-workspace', 'Local workspace')
    on conflict (workspace_id) do nothing;

    insert into itotori_projects (
      project_id,
      workspace_id,
      project_key,
      name,
      source_locale,
      status,
      created_at,
      updated_at
    )
    select
      p.project_id,
      'local-workspace',
      p.project_id,
      p.project_id,
      p.source_locale,
      case
        when exists (
          select 1 from itotori_legacy_runtime_reports rr where rr.project_id = p.project_id
        )
          or exists (
            select 1 from itotori_legacy_hello_world_runs hwr where hwr.project_id = p.project_id
          )
          then 'runtime_ingested'
        when exists (
          select 1 from itotori_legacy_patch_exports pe where pe.project_id = p.project_id
        )
          then 'patch_exported'
        when exists (
          select 1
          from itotori_legacy_bridge_units bu
          where bu.project_id = p.project_id
            and bu.target_text is not null
        )
          then 'drafted'
        else 'imported'
      end,
      p.created_at,
      p.updated_at
    from itotori_legacy_projects p
    on conflict (project_id) do nothing;

    insert into itotori_source_revisions (
      source_revision_id,
      project_id,
      revision_kind,
      value,
      created_at
    )
    select
      'legacy:' || p.project_id || ':bundle-revision',
      p.project_id,
      'legacy_bridge_id',
      p.bridge_id,
      p.created_at
    from itotori_legacy_projects p
    on conflict (source_revision_id) do nothing;

    insert into itotori_source_bundles (
      source_bundle_id,
      project_id,
      source_bundle_revision_id,
      bridge_id,
      schema_version,
      source_bundle_hash,
      source_locale,
      extractor_name,
      extractor_version,
      unit_count,
      asset_count,
      imported_at
    )
    select
      'legacy:' || p.project_id || ':source-bundle',
      p.project_id,
      'legacy:' || p.project_id || ':bundle-revision',
      case
        when count(*) over (partition by p.bridge_id) = 1 then p.bridge_id
        else p.bridge_id || ':' || p.project_id
      end,
      '0.1.0',
      'legacy:' || p.bridge_id,
      p.source_locale,
      'legacy-hello-world',
      '0.1.0',
      (
        select count(*)::integer
        from itotori_legacy_bridge_units bu
        where bu.project_id = p.project_id
      ),
      1,
      p.created_at
    from itotori_legacy_projects p
    on conflict (source_bundle_id) do nothing;

    insert into itotori_assets (
      asset_id,
      project_id,
      source_bundle_id,
      source_revision_id,
      asset_key,
      asset_kind,
      source_hash,
      path,
      created_at
    )
    select
      'legacy:' || p.project_id || ':text-asset',
      p.project_id,
      'legacy:' || p.project_id || ':source-bundle',
      'legacy:' || p.project_id || ':bundle-revision',
      'legacy-text',
      'text',
      'legacy:' || p.bridge_id,
      null,
      p.created_at
    from itotori_legacy_projects p
    on conflict (asset_id) do nothing;

    insert into itotori_source_units (
      bridge_unit_id,
      project_id,
      source_bundle_id,
      source_asset_id,
      source_revision_id,
      surface_id,
      surface_kind,
      source_unit_key,
      occurrence_id,
      source_locale,
      source_text,
      source_hash,
      source_location,
      speaker,
      context,
      policy,
      spans,
      patch_ref,
      runtime_expectation,
      updated_at
    )
    select
      bu.bridge_unit_id,
      bu.project_id,
      'legacy:' || bu.project_id || ':source-bundle',
      'legacy:' || bu.project_id || ':text-asset',
      'legacy:' || bu.project_id || ':bundle-revision',
      bu.bridge_unit_id,
      case when bu.text_surface = 'system' then 'ui_label' else bu.text_surface end,
      bu.source_unit_key,
      bu.bridge_unit_id,
      p.source_locale,
      bu.source_text,
      'legacy:' || bu.bridge_unit_id,
      jsonb_build_object('legacyTable', 'itotori_bridge_units'),
      null,
      jsonb_build_object('legacyProtectedSpanCount', bu.protected_span_count),
      null,
      case
        when bu.protected_span_count > 0 then jsonb_build_array(
          jsonb_build_object(
            'spanKind',
            'legacy_protected_span_count',
            'count',
            bu.protected_span_count
          )
        )
        else '[]'::jsonb
      end,
      jsonb_build_object(
        'assetId',
        'legacy:' || bu.project_id || ':text-asset',
        'writeMode',
        'replace',
        'sourceUnitKey',
        bu.source_unit_key,
        'sourceRevision',
        jsonb_build_object(
          'revisionId',
          'legacy:' || bu.project_id || ':bundle-revision',
          'revisionKind',
          'legacy_bridge_id',
          'value',
          p.bridge_id
        )
      ),
      jsonb_build_object('expectationKind', 'trace_text'),
      bu.updated_at
    from itotori_legacy_bridge_units bu
    join itotori_legacy_projects p on p.project_id = bu.project_id
    on conflict (bridge_unit_id) do nothing;

    insert into itotori_locale_branches (
      locale_branch_id,
      project_id,
      source_bundle_id,
      target_locale,
      branch_name,
      status,
      created_at,
      updated_at
    )
    select
      p.locale_branch_id,
      p.project_id,
      'legacy:' || p.project_id || ':source-bundle',
      p.target_locale,
      p.target_locale,
      'active',
      p.created_at,
      p.updated_at
    from itotori_legacy_projects p
    on conflict (locale_branch_id) do nothing;

    insert into itotori_locale_branch_units (
      locale_branch_id,
      bridge_unit_id,
      target_text,
      updated_at
    )
    select
      p.locale_branch_id,
      bu.bridge_unit_id,
      bu.target_text,
      bu.updated_at
    from itotori_legacy_bridge_units bu
    join itotori_legacy_projects p on p.project_id = bu.project_id
    on conflict (locale_branch_id, bridge_unit_id) do nothing;

    insert into itotori_artifacts (
      artifact_id,
      project_id,
      locale_branch_id,
      source_bundle_id,
      artifact_kind,
      metadata,
      created_at
    )
    select
      pe.patch_export_id,
      pe.project_id,
      p.locale_branch_id,
      'legacy:' || pe.project_id || ':source-bundle',
      'patch_export',
      jsonb_build_object(
        'schemaVersion',
        '0.1.0',
        'targetLocale',
        pe.target_locale,
        'entryCount',
        pe.entry_count,
        'legacyTable',
        'itotori_patch_exports'
      ),
      pe.created_at
    from itotori_legacy_patch_exports pe
    join itotori_legacy_projects p on p.project_id = pe.project_id
    on conflict (artifact_id) do nothing;

    insert into itotori_artifacts (
      artifact_id,
      project_id,
      locale_branch_id,
      source_bundle_id,
      artifact_kind,
      metadata,
      created_at
    )
    select
      rr.runtime_report_id,
      rr.project_id,
      p.locale_branch_id,
      'legacy:' || rr.project_id || ':source-bundle',
      'runtime_report',
      jsonb_build_object(
        'schemaVersion',
        '0.1.0',
        'adapterName',
        'legacy-runtime',
        'status',
        rr.status,
        'fidelityTier',
        rr.fidelity_tier,
        'textEventCount',
        rr.text_event_count,
        'frameCaptureCount',
        rr.frame_capture_count,
        'legacyTable',
        'itotori_runtime_reports'
      ),
      rr.created_at
    from itotori_legacy_runtime_reports rr
    join itotori_legacy_projects p on p.project_id = rr.project_id
    on conflict (artifact_id) do nothing;

    insert into itotori_artifacts (
      artifact_id,
      project_id,
      locale_branch_id,
      source_bundle_id,
      artifact_kind,
      metadata,
      created_at
    )
    select
      hwr.patch_result_id,
      hwr.project_id,
      p.locale_branch_id,
      'legacy:' || hwr.project_id || ':source-bundle',
      'patch_result',
      jsonb_build_object(
        'status',
        hwr.final_status,
        'finalStatus',
        hwr.final_status,
        'runId',
        hwr.run_id,
        'legacyTable',
        'itotori_hello_world_runs'
      ),
      hwr.updated_at
    from itotori_legacy_hello_world_runs hwr
    join itotori_legacy_projects p on p.project_id = hwr.project_id
    on conflict (artifact_id) do nothing;

    insert into itotori_events (
      event_id,
      project_id,
      locale_branch_id,
      event_kind,
      occurred_at,
      actor,
      subject_refs,
      provenance,
      causal_links,
      payload
    )
    select
      rr.runtime_report_id || ':legacy-migrated',
      rr.project_id,
      p.locale_branch_id,
      'runtime_report_migrated',
      rr.created_at,
      jsonb_build_object('actorKind', 'tool', 'displayName', '0003_persistence_v02'),
      jsonb_build_array(
        jsonb_build_object(
          'subjectKind',
          'runtime_report',
          'subjectId',
          rr.runtime_report_id,
          'label',
          rr.status
        )
      ),
      '[]'::jsonb,
      '[]'::jsonb,
      jsonb_build_object('status', rr.status, 'fidelityTier', rr.fidelity_tier)
    from itotori_legacy_runtime_reports rr
    join itotori_legacy_projects p on p.project_id = rr.project_id
    on conflict (event_id) do nothing;

    insert into itotori_events (
      event_id,
      project_id,
      locale_branch_id,
      event_kind,
      occurred_at,
      actor,
      subject_refs,
      provenance,
      causal_links,
      payload
    )
    select
      hwr.run_id || ':legacy-migrated',
      hwr.project_id,
      p.locale_branch_id,
      'patch_result_recorded',
      hwr.updated_at,
      jsonb_build_object('actorKind', 'tool', 'displayName', '0003_persistence_v02'),
      jsonb_build_array(
        jsonb_build_object(
          'subjectKind',
          'patch_result',
          'subjectId',
          hwr.patch_result_id,
          'label',
          hwr.final_status
        )
      ),
      '[]'::jsonb,
      '[]'::jsonb,
      jsonb_build_object('patchResultId', hwr.patch_result_id, 'status', hwr.final_status)
    from itotori_legacy_hello_world_runs hwr
    join itotori_legacy_projects p on p.project_id = hwr.project_id
    on conflict (event_id) do nothing;
  end if;
end $$;

create function itotori_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'itotori_events is append-only';
end;
$$;

create trigger itotori_events_append_only_trigger
before update or delete on itotori_events
for each row execute function itotori_events_append_only();
