-- KAIFUU-053: capability-leveled engine detector registry.
-- Mirrors `kaifuu_core::registry::capability` and
-- `packages/localization-bridge-schema/src/index.ts`
-- (`CapabilityLevelStatusV02`, `AdapterCapabilityMatrixV02`).

create type capability_level_enum as enum (
  'identify',
  'inventory',
  'extract',
  'patch'
);

create type capability_level_status_kind as enum (
  'supported',
  'partial',
  'unsupported'
);

-- One row per (adapter, level). The CHECK constraint mirrors the Rust
-- enum discriminator and the TS `assertCapabilityLevelStatusV02` guard:
--
-- - supported  : no limitations, no reason.
-- - partial    : limitations is a non-empty JSON array; no reason.
-- - unsupported: reason is a non-empty string; limitations is the empty
--   JSON array.
--
-- The strict gate (acceptance criterion 2) lives at the application layer
-- but this CHECK prevents string-typed drift from sneaking in.
create table if not exists itotori_engine_capability_reports (
  engine_capability_report_id  text primary key,
  adapter_id                   text not null,
  level                        capability_level_enum not null,
  status_kind                  capability_level_status_kind not null,
  limitations                  jsonb not null default '[]'::jsonb,
  reason                       text,
  reported_at                  timestamptz not null default now(),
  unique (adapter_id, level),
  check (
    (
      status_kind = 'supported'
      and reason is null
      and limitations = '[]'::jsonb
    )
    or (
      status_kind = 'partial'
      and reason is null
      and jsonb_typeof(limitations) = 'array'
      and jsonb_array_length(limitations) > 0
    )
    or (
      status_kind = 'unsupported'
      and reason is not null
      and length(trim(reason)) > 0
      and limitations = '[]'::jsonb
    )
  )
);

create index if not exists itotori_engine_capability_reports_adapter_idx
  on itotori_engine_capability_reports (adapter_id);

create index if not exists itotori_engine_capability_reports_level_idx
  on itotori_engine_capability_reports (level, status_kind);
