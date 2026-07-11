-- translation-scope-configuration-ui: per-locale-branch config-driven
-- translation scope (dialogue-only -> dialogue-and-choices ->
-- dialogue-choices-ui -> all). This is the DB-backed default the whole-
-- project localize command reads when its run config omits
-- `translationScope`.

create table if not exists itotori_translation_scope_settings (
  locale_branch_id text primary key references itotori_locale_branches(locale_branch_id) on delete cascade,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  scope text not null,
  updated_at timestamptz not null default now(),
  constraint itotori_translation_scope_settings_scope_check check (
    scope in ('dialogue-only', 'dialogue-and-choices', 'dialogue-choices-ui', 'all')
  )
);

create index if not exists itotori_translation_scope_settings_project_idx
  on itotori_translation_scope_settings(project_id);
