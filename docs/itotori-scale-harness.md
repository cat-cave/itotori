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

Public CI currently covers the normal test/build path through `just ci`; the smoke profile is the
required local/performance gate for UNIV-010 until the database-backed harness is wired into public
CI.

Run the explicit 1M+ Japanese-character profile:

```sh
just itotori-scale-large
```

Both commands build the TypeScript packages, start/wait for the local Postgres service, create an
isolated schema, run migrations, execute the harness, and drop the schema when the run finishes.
Override the database if needed:

```sh
DATABASE_URL=postgres://itotori:itotori@127.0.0.1:55433/itotori just itotori-scale-large
```

The direct script supports local tuning:

```sh
node scripts/itotori-scale-harness.mjs \
  --profile large \
  --target-japanese-characters 1050000 \
  --asset-count 96 \
  --output .tmp/itotori-scale-harness/large/summary.json
```

Use `--keep-schema` only for query-plan review. The script prints the temporary schema name and
stores it in the JSON report.

## Output

Reports are written to deterministic gitignored paths:

- Smoke: `.tmp/itotori-scale-harness/smoke/summary.json`
- Large: `.tmp/itotori-scale-harness/large/summary.json`

The report includes corpus size, import target IDs, batch counts, queue counts, dashboard status,
runtime status, cost summary, per-operation timings, and budget pass/fail details.

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
