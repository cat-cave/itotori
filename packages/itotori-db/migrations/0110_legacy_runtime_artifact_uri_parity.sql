-- UTSUSHI-094 follow-up: legacy RuntimeVerificationReport frame captures
-- persist in itotori_artifacts with artifact_kind = 'frame_capture'. The
-- repository validates these refs too, but they are not part of the v0.2
-- RUNTIME_ARTIFACT_KINDS_V02 set constrained by migration 0107.
--
-- Legacy reports intentionally allow fixture:// refs and do not require the
-- managed storage root. This predicate mirrors assertPortableLegacyRuntimeArtifactUri:
-- fixture refs may contain empty segments, while every other ref must be a
-- portable relative path with no empty, dot, or dot-dot segments.

create or replace function itotori_is_portable_legacy_runtime_artifact_uri(uri text)
returns boolean
language sql
immutable
strict
as $$
  select
    (
      uri like 'fixture://%'
      and uri !~ '[\\]'
      and uri !~ '(^|/)(\.|\.\.)(/|$)'
    )
    or (
      uri !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and uri !~ '^/'
      and uri !~ '[\\]'
      and uri !~ '(^|/)(\.|\.\.|)(/|$)'
    )
$$;

alter table itotori_artifacts
  add constraint itotori_legacy_runtime_artifact_uri_check check (
    uri is null
    or artifact_kind <> 'frame_capture'
    or itotori_is_portable_legacy_runtime_artifact_uri(uri)
  );
