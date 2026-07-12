-- p0-core-universal-invocation-supervisor-retry audit repair — durable
-- driver ownership, fencing, and atomic planned-unit claims.
--
-- A run lease covers the full provider-call window. Every takeover increments
-- fence_token, so a completion from an expired driver cannot mutate attempts,
-- units, or the run after a newer driver resumes it. Planned units move through
-- pending -> claimed -> pending/written; beginAttempt is the sole claim point.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

alter table itotori_localization_journal_runs
  add column lease_owner_id text,
  add column lease_expires_at timestamptz,
  add column fence_token integer not null default 0;

alter table itotori_localization_journal_runs
  add constraint itotori_localization_journal_runs_lease_pair_consistent
    check ((lease_owner_id is null) = (lease_expires_at is null)),
  add constraint itotori_localization_journal_runs_lease_owner_non_empty
    check (lease_owner_id is null or length(btrim(lease_owner_id)) > 0),
  add constraint itotori_localization_journal_runs_fence_non_negative
    check (fence_token >= 0);

create index if not exists itotori_localization_journal_runs_lease_idx
  on itotori_localization_journal_runs (status, lease_expires_at);

alter table itotori_localization_journal_run_units
  add column claim_owner_id text,
  add column claim_fence_token integer;

alter table itotori_localization_journal_run_units
  drop constraint itotori_localization_journal_run_units_state_known,
  add constraint itotori_localization_journal_run_units_state_known
    check (state in ('pending', 'claimed', 'written')),
  add constraint itotori_localization_journal_run_units_claim_consistency
    check (
      (state = 'claimed') =
      (claim_owner_id is not null and claim_fence_token is not null)
    ),
  add constraint itotori_localization_journal_run_units_claim_owner_non_empty
    check (claim_owner_id is null or length(btrim(claim_owner_id)) > 0),
  add constraint itotori_localization_journal_run_units_claim_fence_positive
    check (claim_fence_token is null or claim_fence_token > 0);

alter table itotori_llm_attempts
  add column fence_token integer not null default 0,
  add constraint itotori_llm_attempts_fence_non_negative
    check (fence_token >= 0);

create index if not exists itotori_llm_attempts_run_fence_idx
  on itotori_llm_attempts (run_id, fence_token, lifecycle_state);
