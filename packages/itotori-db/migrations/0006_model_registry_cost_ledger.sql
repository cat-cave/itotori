create table if not exists itotori_model_providers (
  provider_id text primary key,
  provider_family text not null,
  endpoint_family text not null,
  provider_name text not null,
  data_handling jsonb not null,
  account_privacy jsonb,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_model_providers_json_shape_check check (
    jsonb_typeof(data_handling) = 'object'
      and (account_privacy is null or jsonb_typeof(account_privacy) = 'object')
      and jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists itotori_model_providers_identity_idx
  on itotori_model_providers(provider_family, endpoint_family, provider_name);

create table if not exists itotori_model_registry (
  model_registry_id text primary key,
  provider_id text not null references itotori_model_providers(provider_id) on delete restrict,
  model_id text not null,
  capabilities jsonb not null,
  pricing jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_model_registry_json_shape_check check (
    jsonb_typeof(capabilities) = 'object'
      and jsonb_typeof(pricing) = 'object'
  )
);

create unique index if not exists itotori_model_registry_provider_model_idx
  on itotori_model_registry(provider_id, model_id);
create index if not exists itotori_model_registry_model_idx
  on itotori_model_registry(model_id);

create table if not exists itotori_prompt_presets (
  prompt_preset_id text not null,
  prompt_template_version text not null,
  preset_schema_version text not null,
  prompt_hash text not null,
  config_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (prompt_preset_id, prompt_template_version),
  constraint itotori_prompt_presets_hash_check check (prompt_hash like 'sha256:%'),
  constraint itotori_prompt_presets_config_shape_check check (
    jsonb_typeof(config_snapshot) = 'object'
  )
);

create index if not exists itotori_prompt_presets_hash_idx
  on itotori_prompt_presets(prompt_hash);

create table if not exists itotori_provider_runs (
  provider_run_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  job_id text references itotori_jobs(job_id) on delete set null,
  system_id text,
  task_kind text not null,
  status text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  latency_ms integer not null,
  provider_id text not null references itotori_model_providers(provider_id) on delete restrict,
  requested_model_registry_id text not null references itotori_model_registry(model_registry_id) on delete restrict,
  actual_model_registry_id text not null references itotori_model_registry(model_registry_id) on delete restrict,
  requested_model_id text not null,
  actual_model_id text not null,
  upstream_provider text,
  route_settings_hash text,
  prompt_preset_id text not null,
  prompt_template_version text not null,
  prompt_hash text not null,
  provider_preset jsonb,
  structured_output_mode text not null,
  retry_count integer not null,
  error_classes jsonb not null,
  fallback_used boolean not null,
  fallback_plan jsonb not null,
  token_count_source text not null,
  prompt_tokens integer,
  completion_tokens integer,
  reasoning_tokens integer,
  cached_input_tokens integer,
  total_tokens integer,
  data_handling jsonb not null,
  account_privacy jsonb,
  adapter_metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_provider_runs_status_check check (
    status in ('succeeded', 'failed', 'partial', 'skipped')
  ),
  constraint itotori_provider_runs_latency_check check (latency_ms >= 0),
  constraint itotori_provider_runs_retry_check check (retry_count >= 0),
  constraint itotori_provider_runs_prompt_hash_check check (prompt_hash like 'sha256:%'),
  constraint itotori_provider_runs_json_shape_check check (
    jsonb_typeof(error_classes) = 'array'
      and jsonb_typeof(fallback_plan) = 'array'
      and jsonb_typeof(data_handling) = 'object'
      and (account_privacy is null or jsonb_typeof(account_privacy) = 'object')
      and jsonb_typeof(adapter_metadata) = 'object'
      and (provider_preset is null or jsonb_typeof(provider_preset) = 'object')
  ),
  constraint itotori_provider_runs_prompt_preset_fk foreign key (
    prompt_preset_id,
    prompt_template_version
  ) references itotori_prompt_presets(prompt_preset_id, prompt_template_version) on delete restrict
);

create index if not exists itotori_provider_runs_project_started_idx
  on itotori_provider_runs(project_id, started_at);
create index if not exists itotori_provider_runs_project_task_idx
  on itotori_provider_runs(project_id, task_kind);
create index if not exists itotori_provider_runs_prompt_idx
  on itotori_provider_runs(prompt_preset_id, prompt_template_version);
create index if not exists itotori_provider_runs_fallback_idx
  on itotori_provider_runs(project_id, fallback_used);

create table if not exists itotori_cost_ledger_entries (
  cost_ledger_entry_id text primary key,
  provider_run_id text not null references itotori_provider_runs(provider_run_id) on delete cascade,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  cost_kind text not null,
  currency text not null,
  amount_micros_usd bigint,
  pricing_snapshot_id text,
  token_count_source text not null,
  prompt_tokens integer,
  completion_tokens integer,
  reasoning_tokens integer,
  cached_input_tokens integer,
  total_tokens integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_cost_ledger_cost_kind_check check (
    cost_kind in ('billed', 'provider_estimate', 'local_estimate', 'zero', 'unknown')
  ),
  constraint itotori_cost_ledger_currency_check check (currency = 'USD'),
  constraint itotori_cost_ledger_amount_check check (
    (cost_kind = 'unknown' and amount_micros_usd is null)
      or (cost_kind = 'zero' and amount_micros_usd = 0)
      or (cost_kind in ('billed', 'provider_estimate', 'local_estimate') and amount_micros_usd is not null and amount_micros_usd >= 0)
  )
);

create unique index if not exists itotori_cost_ledger_provider_run_idx
  on itotori_cost_ledger_entries(provider_run_id);
create index if not exists itotori_cost_ledger_project_kind_idx
  on itotori_cost_ledger_entries(project_id, cost_kind);
create index if not exists itotori_cost_ledger_project_created_idx
  on itotori_cost_ledger_entries(project_id, created_at);
