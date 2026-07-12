-- p0-core-attempt-and-outcome-journal follow-up:
--
-- The journal is the single physical-call source of truth. Preserve the
-- provider facts that the old draft-attempt ledger exposed, then retire that
-- table in this forward migration. Historical migrations remain immutable so
-- deployed databases keep their checksum history.
--
-- New provenance columns are nullable only for rows created before this
-- migration. NULL means not captured; it must never be read as a fabricated
-- zero-cache-hit or no-fallback assertion. Current writers supply the actual
-- ProviderRunRecord facts for every physical call.

alter table itotori_llm_attempts
  add column requested_model_id text,
  add column requested_provider_id text,
  add column cost_kind text,
  add column usage_response_json jsonb,
  add column token_count_source text,
  add column cache_read_tokens integer,
  add column cache_write_tokens integer,
  add column cache_discount_micros_usd bigint,
  add column fallback_used boolean,
  add column fallback_plan jsonb;

alter table itotori_llm_attempts
  add constraint itotori_llm_attempts_cost_kind_known
    check (cost_kind is null or cost_kind in ('billed', 'provider_estimate', 'zero')),
  add constraint itotori_llm_attempts_usage_response_object
    check (usage_response_json is null or jsonb_typeof(usage_response_json) = 'object'),
  add constraint itotori_llm_attempts_cache_read_non_negative
    check (cache_read_tokens is null or cache_read_tokens >= 0),
  add constraint itotori_llm_attempts_cache_write_non_negative
    check (cache_write_tokens is null or cache_write_tokens >= 0),
  add constraint itotori_llm_attempts_cache_discount_non_negative
    check (cache_discount_micros_usd is null or cache_discount_micros_usd >= 0),
  add constraint itotori_llm_attempts_fallback_plan_array
    check (fallback_plan is null or jsonb_typeof(fallback_plan) = 'array');

drop table if exists itotori_draft_attempt_provider_ledger;
