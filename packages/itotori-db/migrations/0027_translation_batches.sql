create table if not exists itotori_translation_batches (
  batch_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  batch_ordinal integer not null,
  token_estimate integer not null,
  token_budget_cap integer not null,
  scene_id text,
  scene_split_index integer,
  route_id text,
  model_provider_family text not null,
  model_id text not null,
  model_context_window_tokens integer not null,
  model_max_output_tokens integer,
  model_target_fill_ratio numeric(4,3) not null,
  model_prompt_overhead_tokens integer not null,
  token_estimator_id text not null,
  near_cap_warning boolean not null default false,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (batch_ordinal >= 1),
  check (token_estimate >= 0),
  check (token_budget_cap >= 0),
  check (model_context_window_tokens > 0),
  check (model_prompt_overhead_tokens >= 0),
  check (model_target_fill_ratio > 0 and model_target_fill_ratio <= 1),
  check (scene_split_index is null or scene_split_index >= 1)
);

create unique index if not exists itotori_translation_batches_triple_ordinal_idx
  on itotori_translation_batches (project_id, locale_branch_id, source_revision_id, batch_ordinal);

create index if not exists itotori_translation_batches_triple_idx
  on itotori_translation_batches (project_id, locale_branch_id, source_revision_id);

create index if not exists itotori_translation_batches_scene_idx
  on itotori_translation_batches (scene_id)
  where scene_id is not null;

create table if not exists itotori_translation_batch_units (
  batch_id text not null references itotori_translation_batches(batch_id) on delete cascade,
  bridge_unit_id text not null,
  source_unit_key text not null,
  source_hash text not null,
  unit_ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, bridge_unit_id),
  check (unit_ordinal >= 1)
);

create index if not exists itotori_translation_batch_units_bridge_unit_idx
  on itotori_translation_batch_units (bridge_unit_id);

create index if not exists itotori_translation_batch_units_batch_ordinal_idx
  on itotori_translation_batch_units (batch_id, unit_ordinal);

create table if not exists itotori_translation_batch_context_refs (
  batch_id text not null references itotori_translation_batches(batch_id) on delete cascade,
  ref_kind text not null check (
    ref_kind in (
      'glossary_term',
      'style_rule',
      'character',
      'scene_summary',
      'prior_example',
      'source_unit_key_prefix'
    )
  ),
  ref_id text not null,
  ref_secondary_id text not null default '',
  inclusion_reason text not null check (
    inclusion_reason in (
      'hit',
      'always_on',
      'category_match',
      'explicit_pin',
      'same_speaker',
      'same_scene',
      'same_surfaceKind',
      'fallback_grouping'
    )
  ),
  hit_bridge_unit_ids jsonb,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (batch_id, ref_kind, ref_id, ref_secondary_id)
);

create index if not exists itotori_translation_batch_context_refs_ref_idx
  on itotori_translation_batch_context_refs (ref_kind, ref_id);
