-- ITOTORI-035: asset localization decision workflow.
--
-- Persists explicit per-asset, per-locale-branch policy decisions for
-- how localization should treat assets that carry text (images with
-- text, song titles, UI art, fonts, videos) — including the option to
-- romanize, fully localize, or skip altogether. This decision layer is
-- consumed by ITOTORI-025 (patch export) to determine per-asset
-- handling.
--
-- Permission governance: write paths require draft.write (human-driven
-- workflow decisions); read paths require catalog.read.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads
--
-- Asset-kind vocabulary mirrored in TypeScript (packages/itotori-db/src/schema.ts):
--   asset_kind = image_with_text | song_title | ui_art | font | video
--              | romanization | full_localization | do_not_translate
--
-- Decision-policy vocabulary mirrored in TypeScript:
--   decision_policy = keep_original | translate_text | swap_with_replacement
--                   | romanize | full_localize | skip
--
-- Supersede semantics: recording a new decision for the same
-- (project, locale_branch, asset_ref->>'ref') tuple supersedes the
-- previously-active row by setting superseded_at and
-- superseded_by_decision_id. Old rows are retained for audit history.
-- A partial unique index enforces at most one active decision per
-- asset+locale_branch (where superseded_at IS NULL).

create table if not exists itotori_asset_localization_decisions (
  decision_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  asset_ref jsonb not null,
  asset_kind text not null check (
    asset_kind in (
      'image_with_text',
      'song_title',
      'ui_art',
      'font',
      'video',
      'romanization',
      'full_localization',
      'do_not_translate'
    )
  ),
  decision_policy text not null check (
    decision_policy in (
      'keep_original',
      'translate_text',
      'swap_with_replacement',
      'romanize',
      'full_localize',
      'skip'
    )
  ),
  decision_rationale text,
  decided_by_user_id text references itotori_users(user_id) on delete set null,
  decided_at timestamptz not null default now(),
  superseded_at timestamptz,
  superseded_by_decision_id text references itotori_asset_localization_decisions(decision_id) deferrable initially deferred,
  created_at timestamptz not null default now(),
  constraint itotori_asset_localization_decisions_asset_ref_is_object
    check (jsonb_typeof(asset_ref) = 'object'),
  constraint itotori_asset_localization_decisions_asset_ref_has_ref
    check (asset_ref ? 'ref'),
  -- Supersede semantics: an active row has both fields null. A
  -- superseded row has superseded_at not null; superseded_by_decision_id
  -- points at the replacement row (and must be non-null whenever
  -- superseded_at is non-null, to keep audit chains intact).
  constraint itotori_asset_localization_decisions_supersede_consistent
    check (
      (superseded_at is null and superseded_by_decision_id is null)
      or (superseded_at is not null and superseded_by_decision_id is not null)
    )
);

create index if not exists itotori_asset_localization_decisions_project_branch_kind_idx
  on itotori_asset_localization_decisions (project_id, locale_branch_id, asset_kind);

create index if not exists itotori_asset_localization_decisions_decided_by_idx
  on itotori_asset_localization_decisions (decided_by_user_id, decided_at desc);

create unique index if not exists itotori_asset_localization_decisions_active_unique_idx
  on itotori_asset_localization_decisions (
    project_id,
    locale_branch_id,
    (asset_ref->>'ref')
  )
  where superseded_at is null;
