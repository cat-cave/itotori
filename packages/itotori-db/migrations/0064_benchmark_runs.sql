-- itotori-bmk-cockpit-read-model — durable store for benchmark cockpit runs.
--
-- The benchmark facility (`apps/itotori/src/benchmark-stages/benchmark-facility.ts`)
-- computes contestants + human anchor + actionable backlog per run. This table
-- is the persistent store of that composed result: one row per BENCHMARK RUN, the
-- facility's body (game-agnostic contestants + ranked ladder + the
-- `PanelHumanCalibrationReport` human anchor + the actionable improvement
-- backlog) carried verbatim in a jsonb `report_body` column. Promoted query keys
-- (project / locale branch / target locale / status / count summary) are typed
-- columns the read-model + listings rely on.
--
-- A benchmark cockpit read-model is what the §10 framing names a DIAGNOSTIC
-- INSTRUMENT — it tells us where to improve. The actionable backlog is the
-- primary output, not a leaderboard. Each run row exists so the bmk cockpit can
-- (a) render the latest run's composed shape, and (b) page a run history so a
-- reviewer sees whether the backlog is shrinking over time.
--
-- Design:
--   - PRIMARY KEY (`run_id`) — opaque benchmark run id (the benchmark facility's
--     `REAL_RUN_BENCHMARK_SCHEMA_VERSION` ids are deterministic UUIDv7s).
--   - project_id / locale_branch_id (nullable for project-level runs) — the
--     scope the run belongs to. `locale_branch_id` is nullable because the
--     benchmark facility can also run a project-level (no-branch) comparison.
--     target_locale is required (a run is a localization benchmark; locale-less
--     runs have no meaning for the cockpit).
--   - status — the run's terminal status (`succeeded` | `failed` | `partial`),
--     surfaced on the cockpit so a reviewer can spot a half-finished run.
--   - kind — the run's benchmark kind (`real_run` | `fixture` | `replay`),
--     surfaced on the cockpit so a reviewer knows what the row actually scored
--     (real run vs fixture vs explicit replay).
--   - units_scored — promoted count of source units the facility scored.
--   - schema_version — the report body's schemaVersion constant, so the
--     read-model can assert compatibility before parsing the body.
--   - report_body — the verbatim generic record: contestants (official / self /
--     self_nocontext / fan / mtl) with their per-dimension scores + ranked
--     ladder + cost/latency + the §8 panel↔human anchor + the §10 actionable
--     backlog. Game-agnostic — no title / engine-instance / game-specific
--     field. The app's read-model re-parses this verbatim.
--   - recorded_at / created_at — when the run was recorded.
--
-- Determinism: append-only (no UPDATE / DELETE). There is NO pass-number or
-- uniqueness to coordinate across runs — a run is its own row, the
-- `unique (project_id, run_id)` pair is the only invariant, and `run_id` is
-- the primary key itself. The (project_id, recorded_at desc) index is the
-- "latest run for a project" read path.

create table if not exists itotori_benchmark_runs (
  run_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text references itotori_locale_branches(locale_branch_id) on delete set null,
  target_locale text not null,
  schema_version text not null,
  kind text not null,
  status text not null,
  units_scored integer not null,
  -- The verbatim generic report body — contestants (official / self /
  -- self_nocontext / fan / mtl) + ranked ladder + human anchor + the
  -- §10 actionable backlog. Game-agnostic; no title / engine / work field.
  report_body jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- A real run must score ≥1 unit (a zero-unit run is a refusal, not a result).
  constraint itotori_benchmark_runs_units_scored_positive check (units_scored >= 1),
  -- Status surface is the same enum the benchmark report's wire contract uses.
  constraint itotori_benchmark_runs_status_known check (status in ('succeeded', 'failed', 'partial')),
  -- Kind surface is the three run kinds the §10 §11 framing distinguishes.
  constraint itotori_benchmark_runs_kind_known check (kind in ('real_run', 'fixture', 'replay')),
  -- The body schemaVersion is required so the read-model can refuse a parsing
  -- drift at read-time instead of silently omitting the cockpit rows.
  constraint itotori_benchmark_runs_schema_version_non_empty check (length(schema_version) > 0),
  constraint itotori_benchmark_runs_target_locale_non_empty check (length(target_locale) > 0)
);

create index if not exists itotori_benchmark_runs_project_recorded_idx
  on itotori_benchmark_runs (project_id, recorded_at desc);

create index if not exists itotori_benchmark_runs_branch_recorded_idx
  on itotori_benchmark_runs (project_id, locale_branch_id, recorded_at desc);
