-- set-model-routing-ui: project model-routing settings.

create table if not exists itotori_model_routing_settings (
  project_id text not null references itotori_projects(project_id) on delete cascade,
  task_kind text not null,
  provider_id text not null references itotori_model_providers(provider_id) on delete restrict,
  model_registry_id text not null references itotori_model_registry(model_registry_id) on delete restrict,
  model_id text not null,
  fallback_model_ids jsonb not null default '[]'::jsonb,
  prompt_preset_id text not null,
  prompt_template_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, task_kind),
  constraint itotori_model_routing_settings_task_kind_check check (length(task_kind) > 0),
  constraint itotori_model_routing_settings_model_id_check check (length(model_id) > 0),
  constraint itotori_model_routing_settings_fallback_shape_check check (
    jsonb_typeof(fallback_model_ids) = 'array'
  ),
  constraint itotori_model_routing_settings_prompt_preset_fk foreign key (
    prompt_preset_id,
    prompt_template_version
  ) references itotori_prompt_presets(prompt_preset_id, prompt_template_version) on delete restrict
);

create index if not exists itotori_model_routing_settings_project_idx
  on itotori_model_routing_settings(project_id);
