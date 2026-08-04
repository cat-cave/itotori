-- Durable localization runs use a distinct fair-share admission scope while
-- retaining the profile scope as the global spend ceiling.

alter table itotori_llm_http_attempts
  add column if not exists admission_run_scope text,
  add column if not exists admission_cohort_id text;

alter table itotori_llm_http_attempts
  disable trigger itotori_llm_history_immutable;

update itotori_llm_http_attempts
set admission_run_scope = admission_scope
where admission_run_scope is null;

update itotori_llm_http_attempts
set max_exposure_usd = greatest(max_exposure_usd, coalesce(cost_usd, 0))
where max_exposure_usd < coalesce(cost_usd, 0);

alter table itotori_llm_http_attempts
  enable trigger itotori_llm_history_immutable;

alter table itotori_llm_http_attempts
  alter column admission_run_scope set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'itotori_llm_http_attempts'::regclass
      and conname = 'itotori_llm_http_attempts_admission_run_scope'
  ) then
    alter table itotori_llm_http_attempts
      add constraint itotori_llm_http_attempts_admission_run_scope check (
        length(admission_run_scope) between 1 and 256
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'itotori_llm_http_attempts'::regclass
      and conname = 'itotori_llm_http_attempts_confirmed_cost_within_exposure'
  ) then
    alter table itotori_llm_http_attempts
      add constraint itotori_llm_http_attempts_confirmed_cost_within_exposure check (
        cost_usd is null or cost_usd <= max_exposure_usd
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'itotori_llm_http_attempts'::regclass
      and conname = 'itotori_llm_http_attempts_admission_cohort_id'
  ) then
    alter table itotori_llm_http_attempts
      add constraint itotori_llm_http_attempts_admission_cohort_id check (
        admission_cohort_id is null or length(admission_cohort_id) between 1 and 256
      );
  end if;
end;
$$;

create index if not exists itotori_llm_http_attempts_profile_admission_idx
  on itotori_llm_http_attempts (admission_scope, attempt_status);

create index if not exists itotori_llm_http_attempts_run_admission_idx
  on itotori_llm_http_attempts (admission_run_scope, attempt_status);

create index if not exists itotori_llm_http_attempts_cohort_admission_idx
  on itotori_llm_http_attempts (admission_cohort_id, admission_run_scope, attempt_status)
  where admission_cohort_id is not null;

-- One profile cohort atomically records its fixed member set. member_count tracks
-- active members; releases reallocate only capacity not already spent or exposed.
create table if not exists itotori_llm_provider_budget_cohorts (
  profile_scope text not null,
  cohort_id text not null,
  profile_cost_cap_usd numeric(24, 12) not null,
  member_count integer not null,
  cohort_state text not null default 'active',
  created_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (profile_scope, cohort_id),
  constraint itotori_llm_provider_budget_cohorts_scope check (
    length(profile_scope) between 1 and 256
    and length(cohort_id) between 1 and 256
  ),
  constraint itotori_llm_provider_budget_cohorts_budget check (
    profile_cost_cap_usd >= 0 and member_count >= 0
  ),
  constraint itotori_llm_provider_budget_cohorts_lifecycle check (
    (cohort_state = 'active' and member_count > 0 and released_at is null)
    or (cohort_state = 'released' and member_count = 0 and released_at is not null)
  )
);

create unique index if not exists itotori_llm_provider_budget_active_profile_idx
  on itotori_llm_provider_budget_cohorts (profile_scope)
  where cohort_state = 'active';

create table if not exists itotori_llm_provider_budget_cohort_members (
  profile_scope text not null,
  cohort_id text not null,
  project_id text not null,
  run_id text not null,
  admission_run_scope text not null,
  run_cost_cap_usd numeric(24, 12) not null,
  member_state text not null default 'active',
  created_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (profile_scope, cohort_id, admission_run_scope),
  unique (profile_scope, cohort_id, project_id, run_id),
  foreign key (profile_scope, cohort_id)
    references itotori_llm_provider_budget_cohorts (profile_scope, cohort_id),
  constraint itotori_llm_provider_budget_cohort_members_values check (
    length(project_id) > 0
    and length(run_id) > 0
    and length(admission_run_scope) between 1 and 256
    and run_cost_cap_usd >= 0
  ),
  constraint itotori_llm_provider_budget_cohort_members_lifecycle check (
    (member_state = 'active' and released_at is null)
    or (member_state = 'released' and released_at is not null)
  )
);

create index if not exists itotori_llm_provider_budget_active_members_idx
  on itotori_llm_provider_budget_cohort_members (profile_scope, cohort_id, admission_run_scope)
  where member_state = 'active';
