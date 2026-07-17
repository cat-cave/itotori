-- UTSUSHI-094: persisted runtime artifact refs must use the same managed,
-- portable URI policy as the runtime repository. These constraints protect
-- direct SQL writes as well as repository-mediated ingestion.

create or replace function itotori_is_managed_runtime_artifact_uri(uri text)
returns boolean
language sql
immutable
strict
as $$
  select
    uri !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
    and uri !~ '^/'
    and uri !~ '[\\]'
    and uri like 'artifacts/utsushi/runtime/%'
    and uri !~ '(^|/)(\.|\.\.|)(/|$)'
$$;

alter table itotori_runtime_evidence_items
  drop constraint if exists itotori_runtime_evidence_portable_uri_check,
  add constraint itotori_runtime_evidence_managed_uri_check check (
    portable_artifact_uri is null
    or itotori_is_managed_runtime_artifact_uri(portable_artifact_uri)
  );

alter table itotori_conformance_evidence_refs
  drop constraint if exists itotori_conformance_evidence_refs_uri_check,
  add constraint itotori_conformance_evidence_refs_managed_uri_check check (
    uri is null
    or itotori_is_managed_runtime_artifact_uri(uri)
  );

alter table itotori_artifacts
  add constraint itotori_runtime_artifact_uri_check check (
    uri is null
    or artifact_kind not in (
      'trace_log',
      'screenshot',
      'recording',
      'capture_metadata',
      'reference_comparison',
      'runtime_report'
    )
    or itotori_is_managed_runtime_artifact_uri(uri)
  );
