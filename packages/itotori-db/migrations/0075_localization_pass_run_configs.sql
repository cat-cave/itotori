-- p3-wire-localization-pass-run-config-registry: operator-local inputs for
-- the Studio launch-pass driver. These are path REFERENCES only; the game
-- bytes and generated artifacts remain on the operator's filesystem.

create table if not exists itotori_localization_pass_run_configs (
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  config_path text not null,
  data_root text not null,
  pair_policy_path text not null,
  model_id text not null,
  provider_id text not null,
  run_dir text not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, locale_branch_id),
  constraint itotori_localization_pass_run_configs_config_path_check check (length(config_path) > 0),
  constraint itotori_localization_pass_run_configs_data_root_check check (length(data_root) > 0),
  constraint itotori_localization_pass_run_configs_pair_policy_path_check check (length(pair_policy_path) > 0),
  constraint itotori_localization_pass_run_configs_model_id_check check (length(model_id) > 0),
  constraint itotori_localization_pass_run_configs_provider_id_check check (length(provider_id) > 0),
  constraint itotori_localization_pass_run_configs_run_dir_check check (length(run_dir) > 0)
);

create index if not exists itotori_localization_pass_run_configs_branch_idx
  on itotori_localization_pass_run_configs(locale_branch_id);
