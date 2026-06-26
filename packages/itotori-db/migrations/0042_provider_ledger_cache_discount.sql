-- ITOTORI-233: cache-aware columns on the draft-attempt provider ledger.
--
-- Why this exists
-- ---------------
-- Per docs/openrouter-integration.md §5.3 (cache annotations) and
-- docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N7 / §1.3
-- (mirror real cache annotations through ledger + telemetry — never
-- estimation, always real), every OpenRouter response carries
-- prompt-caching annotations on `usage.prompt_tokens_details`
-- (`cached_tokens`, `cache_write_tokens`) and `usage.cost_details`
-- (`cache_discount`). ITOTORI-232 already persists the entire `usage`
-- block verbatim into `usage_response_json`. This node lifts the three
-- caching fields into typed columns so dashboards and per-pair cost
-- aggregates can render cache hit rates and cache-savings sums without
-- a JSONB extraction per row.
--
-- DOC-AMBIGUOUS-6 RESOLVED (docs/openrouter-integration.md §11 entry 6,
-- §5.3): `usage.cost` is treated as authoritative and net of
-- `cache_discount`. `cost_amount` therefore mirrors `usage.cost` verbatim
-- (ITOTORI-232's existing CHECK) and the new `cache_discount_micros_usd`
-- column is an INFORMATIONAL annotation for telemetry, NOT an arithmetic
-- input to the cost cap. The application layer (per ITOTORI-233's
-- recordSpend doc-comment) consumes `cost_amount` directly; subtracting
-- the discount would double-count it.
--
-- What the storage layer now exposes:
--
--   (a) cache_read_tokens integer NOT NULL DEFAULT 0
--       Mirrors `usage.prompt_tokens_details.cached_tokens` verbatim.
--       Absent on the wire → 0 (the documented OR shape for non-cache
--       hits, e.g. evidence file call_1: `cached_tokens: 0`). NOT NULL
--       with DEFAULT 0 is the typed admission that the value is always
--       known: on a non-cache hit it is 0, not NULL.
--   (b) cache_write_tokens integer NOT NULL DEFAULT 0
--       Mirrors `usage.prompt_tokens_details.cache_write_tokens` verbatim.
--       Same NOT NULL + DEFAULT 0 reasoning.
--   (c) cache_discount_micros_usd bigint NOT NULL DEFAULT 0
--       Mirrors `usage.cost_details.cache_discount` verbatim, converted
--       to integer micros via `decimalUsdStringToMicros` at the
--       application layer. `cache_discount: null` on the wire (the
--       normal non-cache-hit case, see evidence file call_6) → 0 here;
--       a real implicit-cache hit → the value in micros. NOT NULL +
--       DEFAULT 0 is honest: every response either has a cache discount
--       or it doesn't (which is the same as zero), so a NULL would be
--       a lie.
--
-- Real cost only — never estimated
-- ---------------------------------
-- Per the standing no-hardcoded-cost rule (memory: feedback-no-optionality-
-- evidence-first), cache_discount_micros_usd comes from
-- `usage.cost_details.cache_discount` verbatim. We never derive cache
-- savings from token counts × provider list pricing — the audit's named
-- anti-pattern ("Cache savings line on dashboard sourced from a derived/
-- estimated value instead of the real cache_discount") is the failure
-- mode this CHECK guards against.
--
-- Forward-only
-- ------------
-- No rollback path. ADD column + DEFAULT 0 backfill + (implicit) NOT NULL
-- land in one transaction. The DEFAULT 0 covers every pre-migration row
-- so the NOT NULL constraint passes by construction. The default is left
-- in place after backfill: future inserts that omit the cache fields
-- (e.g. local / fake / pre-ITOTORI-232 sentinel rows) get 0, which is
-- the correct truthful value.
--
-- @permission-gate draft.write writes
-- @permission-gate catalog.read reads

-- 1. cache_read_tokens integer NOT NULL DEFAULT 0 — verbatim mirror of
--    usage.prompt_tokens_details.cached_tokens. Non-negative by domain
--    (token counts cannot be negative); the application-layer guard in
--    assertRecordLedgerEntryInput enforces this before the round-trip.
alter table itotori_draft_attempt_provider_ledger
  add column cache_read_tokens integer not null default 0;

-- 2. cache_write_tokens integer NOT NULL DEFAULT 0 — verbatim mirror of
--    usage.prompt_tokens_details.cache_write_tokens.
alter table itotori_draft_attempt_provider_ledger
  add column cache_write_tokens integer not null default 0;

-- 3. cache_discount_micros_usd bigint NOT NULL DEFAULT 0 — verbatim
--    mirror of usage.cost_details.cache_discount converted to integer
--    micros. bigint (not integer) because the upper bound here is the
--    same as cost_amount: a long-running session could plausibly
--    accumulate cache discounts beyond the 32-bit signed range
--    ($2147 USD across a single row is unrealistic, but the column
--    type matches the same precision discipline cost_amount carries).
alter table itotori_draft_attempt_provider_ledger
  add column cache_discount_micros_usd bigint not null default 0;

-- 4. Domain CHECKs: every cache column is non-negative. The application
--    layer (assertRecordLedgerEntryInput) enforces the same guard before
--    the round-trip; this is the storage-layer belt-and-braces so a
--    future regression cannot smuggle in a negative cache value.
alter table itotori_draft_attempt_provider_ledger
  add constraint itotori_draft_attempt_provider_ledger_cache_read_tokens_check
    check (cache_read_tokens >= 0);

alter table itotori_draft_attempt_provider_ledger
  add constraint itotori_draft_attempt_provider_ledger_cache_write_tokens_check
    check (cache_write_tokens >= 0);

alter table itotori_draft_attempt_provider_ledger
  add constraint itotori_draft_attempt_provider_ledger_cache_discount_micros_check
    check (cache_discount_micros_usd >= 0);
