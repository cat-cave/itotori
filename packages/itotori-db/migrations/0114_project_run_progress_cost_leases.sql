-- mp-02: durable project-scoped driver runs built on immutable CAS snapshots.
-- Every mutable row carries the project/run scope; there is no singleton
-- account, progress registry, or lease shared by unrelated runs.

create table itotori_project_runs (
  run_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  context_snapshot_id text not null
    references itotori_llm_context_snapshots(snapshot_id) on delete restrict,
  localization_snapshot_id text not null
    references itotori_llm_localization_snapshots(snapshot_id) on delete restrict,
  status text not null default 'queued',
  lease_owner_id text,
  lease_expires_at timestamptz,
  fence_token bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_project_runs_scope_key unique (run_id, project_id),
  constraint itotori_project_runs_branch_scope_fkey
    foreign key (project_id, locale_branch_id)
    references itotori_locale_branches(project_id, locale_branch_id)
    on delete cascade,
  constraint itotori_project_runs_status_known
    check (status in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  constraint itotori_project_runs_lease_pair_consistent
    check ((lease_owner_id is null) = (lease_expires_at is null)),
  constraint itotori_project_runs_lease_owner_nonempty
    check (lease_owner_id is null or length(btrim(lease_owner_id)) > 0),
  constraint itotori_project_runs_fence_non_negative check (fence_token >= 0)
);

create index itotori_project_runs_project_status_idx
  on itotori_project_runs(project_id, status, updated_at desc);
create index itotori_project_runs_lease_idx
  on itotori_project_runs(status, lease_expires_at);

-- The localization snapshot itself commits its context snapshot and locale
-- branch in its immutable identity. Recheck that binding at the mutable run
-- boundary so a valid CAS object cannot be attached to another project branch.
create or replace function itotori_validate_project_run_snapshot_binding()
returns trigger
language plpgsql
as $$
declare
  snapshot_context_id text;
  snapshot_branch_id text;
begin
  select context_snapshot_id, snapshot_identity ->> 'localeBranchId'
    into snapshot_context_id, snapshot_branch_id
    from itotori_llm_localization_snapshots
    where snapshot_id = new.localization_snapshot_id;

  if not found then
    raise exception 'project run must reference an existing localization snapshot'
      using errcode = '23503';
  end if;
  if snapshot_context_id is distinct from new.context_snapshot_id then
    raise exception 'project run snapshots must share one context snapshot'
      using errcode = '23514';
  end if;
  if snapshot_branch_id is distinct from new.locale_branch_id then
    raise exception 'project run localization snapshot must match its locale branch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger itotori_project_runs_snapshot_binding
before insert or update of context_snapshot_id, localization_snapshot_id, locale_branch_id
on itotori_project_runs
for each row execute function itotori_validate_project_run_snapshot_binding();

create table itotori_project_run_cost_accounts (
  run_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  cap_micros_usd bigint,
  spent_micros_usd bigint not null default 0,
  reserved_micros_usd bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_project_run_cost_accounts_scope_key unique (run_id, project_id),
  constraint itotori_project_run_cost_accounts_run_scope_fkey
    foreign key (run_id, project_id)
    references itotori_project_runs(run_id, project_id)
    on delete cascade,
  constraint itotori_project_run_cost_accounts_cap_non_negative
    check (cap_micros_usd is null or cap_micros_usd >= 0),
  constraint itotori_project_run_cost_accounts_spent_non_negative check (spent_micros_usd >= 0),
  constraint itotori_project_run_cost_accounts_reserved_non_negative
    check (reserved_micros_usd >= 0)
);

create table itotori_project_run_cost_reservations (
  reservation_id text not null,
  run_id text not null,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  reserved_micros_usd bigint not null,
  settled_micros_usd bigint,
  state text not null default 'reserved',
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (run_id, reservation_id),
  constraint itotori_project_run_cost_reservations_account_fkey
    foreign key (run_id, project_id)
    references itotori_project_run_cost_accounts(run_id, project_id)
    on delete cascade,
  constraint itotori_project_run_cost_reservations_reserved_non_negative
    check (reserved_micros_usd >= 0),
  constraint itotori_project_run_cost_reservations_settled_non_negative
    check (settled_micros_usd is null or settled_micros_usd >= 0),
  constraint itotori_project_run_cost_reservations_state_known
    check (state in ('reserved', 'settled')),
  constraint itotori_project_run_cost_reservations_settlement_shape
    check (
      (state = 'reserved' and settled_micros_usd is null and settled_at is null)
      or (state = 'settled' and settled_micros_usd is not null and settled_at is not null)
    )
);

create index itotori_project_run_cost_reservations_scope_state_idx
  on itotori_project_run_cost_reservations(run_id, project_id, state, created_at);

create table itotori_project_run_progress (
  run_id text not null,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  bridge_unit_id text not null,
  role text not null,
  status text not null,
  cost_micros_usd bigint not null default 0,
  coverage_percent integer not null default 0,
  blockers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, bridge_unit_id, role),
  constraint itotori_project_run_progress_run_scope_fkey
    foreign key (run_id, project_id)
    references itotori_project_runs(run_id, project_id)
    on delete cascade,
  constraint itotori_project_run_progress_role_nonempty check (length(btrim(role)) > 0),
  constraint itotori_project_run_progress_status_known
    check (status in ('decoded', 'drafted', 'QA', 'accepted', 'patched')),
  constraint itotori_project_run_progress_cost_non_negative check (cost_micros_usd >= 0),
  constraint itotori_project_run_progress_coverage_range
    check (coverage_percent between 0 and 100),
  constraint itotori_project_run_progress_blockers_array
    check (jsonb_typeof(blockers) = 'array')
);

create index itotori_project_run_progress_scope_status_idx
  on itotori_project_run_progress(run_id, project_id, status);
