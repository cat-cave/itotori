-- ITOTORI-230: persist the OpenRouter routing posture sent on each call into
-- the provider-run ledger AND drop the four dead `data_handling` /
-- `account_privacy` columns left behind by ITOTORI-227.
--
-- Why this exists
-- ---------------
-- The 2026-06-25 wiring audit (docs/audits/openrouter-wiring-audit-2026-
-- 06-25.md §4-4 + §3-G) showed that OpenRouter has NO per-response
-- `zdr_enforced: true` flag. The proof that ZDR was in effect for a
-- given call is therefore a 3-part posture:
--   (a) the account is ZDR-only at the dashboard level (asserted at
--       process startup via OPENROUTER_ZDR_ACCOUNT_ASSERTED=1);
--   (b) the request body carried `provider.zdr=true`; and
--   (c) the response came back non-error (the 404 envelope when no ZDR
--       provider can serve the call is the negative signal).
-- ITOTORI-227 wired (a) + (b); this node persists (b) verbatim into the
-- ledger so an offline audit can prove the posture without recapturing
-- the wire. The recorded-bundle path mirrors the same field at the
-- application layer (recorded.ts schema v2).
--
-- Drop in the same migration
-- --------------------------
-- ITOTORI-227 deleted itotori's per-pair privacy registry but left the
-- columns it used to populate behind so the application could still
-- satisfy `data_handling jsonb not null`. Every write since has passed
-- `dataHandling: {}` — pure dead weight. Per the no-legacy-compat rule
-- we drop the four dead columns in the same forward-only transaction
-- that adds `routing_posture`: a single migration touches the same two
-- tables, so doing it twice would be ceremonial.
--
-- Forward-only
-- ------------
-- No rollback. If the transaction fails mid-way Postgres rolls back the
-- whole thing; that is the desired behaviour. The backfill sentinel
-- (`{"_pre_itotori_230": true}`) is a TYPED admission that pre-
-- migration rows have NO captured routing posture — telemetry queries
-- filtering on `routing_posture->>'zdr' = 'true'` will simply not count
-- them, which is correct. We do NOT synthesise a fake "looked like ZDR"
-- posture for historical rows.
--
-- @permission-gate runtime.ingest writes
-- @permission-gate catalog.read reads

-- 1. Add routing_posture jsonb NOT NULL on itotori_provider_runs.
--
-- The sentinel `{"_pre_itotori_230": true}` is the explicit admission
-- that pre-migration rows have no captured posture. Picking a real-
-- looking JSON shape here would let a telemetry query that filters on
-- routing_posture->>'zdr' silently count rows it has no evidence for.
-- The sentinel key starts with an underscore so it cannot collide with
-- a real posture field (only, allow_fallbacks, data_collection, zdr,
-- require_parameters) and is greppable across the ledger.
alter table itotori_provider_runs
  add column routing_posture jsonb not null
    default '{"_pre_itotori_230": true}'::jsonb;

-- Drop the column default after the backfill so future inserts MUST
-- supply a routing_posture explicitly (the application layer makes the
-- field required on ProviderRunRecord; this is the storage-layer
-- belt-and-braces).
alter table itotori_provider_runs
  alter column routing_posture drop default;

-- Tighten the JSON-shape CHECK to require routing_posture to be an
-- object. The existing data_handling / account_privacy clauses are
-- dropped along with the columns themselves below.
alter table itotori_provider_runs
  drop constraint if exists itotori_provider_runs_json_shape_check;

alter table itotori_provider_runs
  add constraint itotori_provider_runs_json_shape_check check (
    jsonb_typeof(error_classes) = 'array'
      and jsonb_typeof(fallback_plan) = 'array'
      and jsonb_typeof(adapter_metadata) = 'object'
      and jsonb_typeof(routing_posture) = 'object'
      and (provider_preset is null or jsonb_typeof(provider_preset) = 'object')
  );

-- 2. Drop the dead data_handling / account_privacy columns from
--    itotori_provider_runs. These were unused since ITOTORI-227 deleted
--    the per-pair privacy registry; every write since has set them to
--    `{}` / null.
alter table itotori_provider_runs
  drop column data_handling;

alter table itotori_provider_runs
  drop column account_privacy;

-- 3. Drop the same dead columns from itotori_model_providers. The
--    application no longer populates them either; the canonical privacy
--    posture is account-wide ZDR + per-request `provider.zdr=true`.
alter table itotori_model_providers
  drop constraint if exists itotori_model_providers_json_shape_check;

alter table itotori_model_providers
  add constraint itotori_model_providers_json_shape_check check (
    jsonb_typeof(metadata) = 'object'
  );

alter table itotori_model_providers
  drop column data_handling;

alter table itotori_model_providers
  drop column account_privacy;
