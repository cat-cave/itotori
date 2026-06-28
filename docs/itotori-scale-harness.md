# Itotori Synthetic Scale Harness

UNIV-010 provides a deterministic synthetic bridge bundle generator and a DB-backed harness for
large-project import, indexing, draft batch planning, queue scheduling, and dashboard/status query
budgets. The corpus is generated from public Japanese template text and does not use private game
data.

## Profiles

Run the CI-sized smoke profile:

```sh
just itotori-scale-smoke
```

The smoke profile is the alpha-required local and CI-friendly scale gate. It writes
`.tmp/itotori-scale-harness/smoke/summary.json`.

Run the explicit 1M+ Japanese-character profile:

```sh
just itotori-scale-large
```

Both commands build the TypeScript packages, start/wait for the local Postgres service, create an
isolated schema, run migrations, execute the harness, and drop the schema when the run finishes.
Override the database or schema if needed:

```sh
DATABASE_URL=postgres://itotori:itotori@127.0.0.1:55433/itotori just itotori-scale-large
ITOTORI_SCALE_SCHEMA=itotori_scale_review just itotori-scale-smoke
```

The direct script supports local tuning:

```sh
node scripts/itotori-scale-harness.mjs \
  --profile large \
  --target-japanese-characters 1050000 \
  --asset-count 96 \
  --schema itotori_scale_review \
  --output .tmp/itotori-scale-harness/large/summary.json
```

Use `--keep-schema` only for query-plan review. The script prints the temporary schema name and
stores it in the JSON report.

## Output

Reports are written to deterministic gitignored paths:

- Smoke: `.tmp/itotori-scale-harness/smoke/summary.json`
- Large: `.tmp/itotori-scale-harness/large/summary.json`

The report includes top-level `profile`, `outputPath`, `budgetPassed`, `unitCount`, `batchCount`,
`scheduledJobCount`, and `schemaKept` fields for audit tooling, plus corpus size, import target IDs,
batch counts, queue counts, dashboard status, runtime status, cost summary, per-operation timings,
and budget pass/fail details. The `database` section records the schema name and whether it was kept
for inspection.

## Disposable Postgres

The local disposable database path is:

```sh
DATABASE_URL=postgres://itotori:itotori@127.0.0.1:55433/itotori
COMPOSE_PROJECT_NAME=itotori
```

These are no-secret public CI defaults. `just db-up` writes
`.tmp/itotori-db/compose.env` from `DATABASE_URL`, then starts the `postgres` service with the
matching host port, database name, user, and password. The recipes set
`COMPOSE_DISABLE_ENV_FILE=1` so Compose does not implicitly load `.env`; the generated compose env
file is the only env file used for this disposable database. Set a unique `DATABASE_URL` host port
and `COMPOSE_PROJECT_NAME` when running parallel worktrees so both port bindings and Docker resource
names do not collide. If `COMPOSE_PROJECT_NAME` is unset locally, the generated compose env derives a
disposable project name from the worktree directory.

The compose service passes Postgres runtime server settings instead of initdb-only flags:
`max_connections=400` and `shared_buffers=512MB`. The buffer value keeps the same 4x ratio from
Postgres' default 128MB as the connection increase from the default 100, so a container recreate
retains the tuning without depending on persisted database initialization state.

The database recipes are:

```sh
just db-up
just db-wait
just db-migrate
just db-reset
```

When `DATABASE_URL` is intentionally unavailable, DB-only verification is deterministic:

```sh
env -u DATABASE_URL pnpm --filter @itotori/db test
```

That command exits successfully, prints
`itotori db tests skipped: DATABASE_URL unset`, and writes
`.tmp/itotori-db/no-database-skipped.json` with `status`, `reason`, `command`, `checkedEnv`, and
`timestamp`.

The alpha readiness DB and scale commands are:

```sh
node scripts/spec-dag.mjs validate
just ci-itotori
just itotori-scale-smoke
env -u DATABASE_URL pnpm --filter @itotori/db test
```

## Interpreting Failures

`generateBundle` or `schemaValidation` failures mean the synthetic corpus no longer matches the
public bridge contract. Re-run the schema package tests before changing budgets.

`importIndex` failures usually point at slow per-row persistence, missing indexes, or unexpectedly
large JSON payloads. Check source unit, branch-unit, asset, and revision insert behavior first.

`batchPlanning` failures indicate that planning work has become more than a linear scan over units
or that the batch metadata now stores too much per-unit data.

`queueSchedule` or `queueClaim` failures point at job/outbox insert or ready-queue lookup behavior.
Review `itotori_event_outbox_*` and `itotori_jobs_*` indexes and idempotency-key contention.

`dashboardStatus`, `runtimeStatus`, or `costReport` failures mean user-facing status endpoints are
too slow for large projects. Run the harness with `--keep-schema`, then use `EXPLAIN (ANALYZE,
BUFFERS)` against the generated schema to inspect joins and aggregate counts.
