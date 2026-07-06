-- itotori-multipass-pass-ledger / pass-ledger-production-wiring:
-- DB-backed persistence for the multi-pass localization ledger.
--
-- The orchestrator's `PassLedgerPort` (apps/itotori pass-ledger.ts) records
-- one row per localization pass on a locale branch: pass N+1 CONSUMES pass N's
-- accepted state + flagged-unit feedback, so the ledger is the medium of
-- iteration. Until this migration the only implementation was
-- `InMemoryPassLedger` (tests); production had nowhere to persist a pass, so a
-- pass N+1 run could never build on a persisted pass N. This table is that
-- durable store.
--
-- Design: the ledger is APPEND-ONLY (no update / delete). The generic,
-- game-agnostic record body — inputs (scope / pair / unit counts), outputs
-- (accepted + deferred + failed unit outcomes, ACCEPTED DELTAS), and the
-- consumed feedback notes — is stored verbatim as a jsonb `record_body`; the
-- fields the port + queries key on are promoted to typed columns:
--   - pass_number / prior_pass_number : the iteration lineage (pass N -> N+1).
--   - total_usage_cost_usd            : the REAL usage.cost the executor summed
--                                       verbatim from per-invocation provider
--                                       telemetry (PROJECT LAW: never
--                                       fabricated; a zero-cost fake provider
--                                       records the real zero it produced).
--   - zdr_confirmed                   : the run's ZDR posture.
--
-- Determinism: `pass_number` is assigned as `max(pass_number) + 1` per locale
-- branch inside the recording transaction; the unique index on
-- (locale_branch_id, pass_number) is the hard guard against a concurrent
-- double-record racing to the same number.

create table if not exists itotori_localization_pass_ledger (
  pass_ledger_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict,
  pass_number integer not null,
  prior_pass_number integer,
  total_usage_cost_usd numeric not null,
  zdr_confirmed boolean not null,
  -- The full generic pass record (inputs / outputs / acceptedDeltas /
  -- consumedFeedbackNotes) minus the promoted columns above. Game-agnostic:
  -- no title / engine-instance / game-specific field, only routing outcomes,
  -- draft text, defer reasons, and free-form feedback notes.
  record_body jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- Pass numbers are 1-based and chain the prior pass; enforce both.
  constraint itotori_localization_pass_ledger_pass_number_positive check (pass_number >= 1),
  constraint itotori_localization_pass_ledger_prior_pass_number_valid check (
    prior_pass_number is null or prior_pass_number = pass_number - 1
  ),
  -- Cost is never negative (PROJECT LAW; a real zero is allowed).
  constraint itotori_localization_pass_ledger_cost_non_negative check (total_usage_cost_usd >= 0),
  -- One row per (branch, pass number): the deterministic-assignment guard.
  constraint itotori_localization_pass_ledger_branch_pass_unique unique (
    locale_branch_id, pass_number
  )
);

create index if not exists itotori_localization_pass_ledger_branch_pass_idx
  on itotori_localization_pass_ledger (locale_branch_id, pass_number desc);

create index if not exists itotori_localization_pass_ledger_project_idx
  on itotori_localization_pass_ledger (project_id, locale_branch_id, pass_number desc);
