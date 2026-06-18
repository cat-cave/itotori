alter table itotori_catalog_source_provenance
  add column if not exists raw_content_redaction_class text not null default 'public_metadata';

alter table itotori_catalog_source_provenance
  drop constraint if exists itotori_catalog_source_provenance_raw_redaction_check;

alter table itotori_catalog_source_provenance
  add constraint itotori_catalog_source_provenance_raw_redaction_check check (
    raw_content_redaction_class in ('public_raw', 'public_metadata', 'private_corpus', 'redacted')
  );

alter table itotori_catalog_language_statuses
  add column if not exists imported_at timestamptz not null default now(),
  add column if not exists parser_version text not null default 'unknown',
  add column if not exists raw_content_redaction_class text not null default 'public_metadata';

alter table itotori_catalog_language_statuses
  drop constraint if exists itotori_catalog_language_statuses_raw_redaction_check;

alter table itotori_catalog_language_statuses
  add constraint itotori_catalog_language_statuses_raw_redaction_check check (
    raw_content_redaction_class in ('public_raw', 'public_metadata', 'private_corpus', 'redacted')
  );

create index if not exists itotori_catalog_language_statuses_completeness_idx
  on itotori_catalog_language_statuses(language, status, is_current, work_id);
