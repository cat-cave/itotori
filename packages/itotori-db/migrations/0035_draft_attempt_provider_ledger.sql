-- ITOTORI-077: draft attempt cost + provenance ledger.
--
-- Persists what model was invoked, what prompt + policy versions were
-- in force, what context artifacts were referenced, token counts,
-- decimal-precision cost, latency, fallback chain, and the recorded-
-- provider artifact id (when the attempt was satisfied from a recorded
-- bundle). The raw prompt and response payloads are NEVER written to
-- this ledger; only the prompt_hash is persisted -- see the redaction
-- regression test in apps/itotori/test/draft-attempt-recorder.test.ts.
--
-- Permission governance: write paths require draft.write (this is
-- part of the draft attempt loop); read paths (cost rollups, audit
-- queries) require catalog.read.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

create table if not exists itotori_draft_attempt_provider_ledger (
  ledger_entry_id text primary key,
  draft_job_attempt_id text not null references itotori_draft_job_attempts(draft_job_attempt_id) on delete cascade,
  provider_proof_id text not null,
  model_provider_family text,
  model_id text,
  model_context_window_tokens integer,
  model_max_output_tokens integer,
  prompt_template_version text,
  prompt_hash text,
  policy_versions jsonb not null default '{}'::jsonb,
  context_artifact_refs jsonb not null default '[]'::jsonb,
  tokens_in integer,
  tokens_out integer,
  cost_unit text not null,
  cost_amount numeric(20, 8) not null,
  latency_ms integer,
  fallback_chain jsonb not null default '[]'::jsonb,
  is_recorded_provider boolean not null default false,
  recorded_provider_bundle_id text,
  created_at timestamptz not null default now(),
  constraint itotori_draft_attempt_provider_ledger_policy_versions_is_object
    check (jsonb_typeof(policy_versions) = 'object'),
  constraint itotori_draft_attempt_provider_ledger_context_refs_is_array
    check (jsonb_typeof(context_artifact_refs) = 'array'),
  constraint itotori_draft_attempt_provider_ledger_fallback_chain_is_array
    check (jsonb_typeof(fallback_chain) = 'array'),
  constraint itotori_draft_attempt_provider_ledger_cost_amount_nonnegative
    check (cost_amount >= 0),
  constraint itotori_draft_attempt_provider_ledger_tokens_in_nonnegative
    check (tokens_in is null or tokens_in >= 0),
  constraint itotori_draft_attempt_provider_ledger_tokens_out_nonnegative
    check (tokens_out is null or tokens_out >= 0),
  constraint itotori_draft_attempt_provider_ledger_latency_nonnegative
    check (latency_ms is null or latency_ms >= 0)
);

create index if not exists itotori_draft_attempt_provider_ledger_attempt_idx
  on itotori_draft_attempt_provider_ledger (draft_job_attempt_id);

create unique index if not exists itotori_draft_attempt_provider_ledger_proof_idx
  on itotori_draft_attempt_provider_ledger (provider_proof_id);

create index if not exists itotori_draft_attempt_provider_ledger_family_created_idx
  on itotori_draft_attempt_provider_ledger (model_provider_family, created_at desc);
