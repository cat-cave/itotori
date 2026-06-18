# Itotori Subproject

Itotori owns localization state: catalog identity, local corpus inventory,
translation-completeness intelligence, locale branches, drafts, policy, QA
findings, feedback, runtime evidence ingestion, and patch-ready exports.

The scaffold uses deterministic fake translation. Live model routing is
intentionally out of scope for the hello world, but not out of alpha readiness:
`ITOTORI-116` proves structured draft and QA paths with recorded or opted-in
live providers, and `ITOTORI-117` proves the deliberately naive raw MTL
baseline through the same provider, retry, ledger, and quality-report machinery.

The product entrypoint is no longer assumed to be a bridge bundle. Real
workflows start with catalog/work identity, local corpus scan evidence,
translation completeness, engine readiness, and only then extraction/import
when Kaifuu can prove the required capability level. Bridge import remains a
low-level foundation, not the only project intake path.

Search and indexing decisions live in
[ADR 0004](adrs/0004-search-and-indexing-infrastructure.md). Itotori features
must rely on exact Postgres indexes first, and agent-facing semantic retrieval
must expose the ADR's tool contract and exact fallback behavior instead of an
opaque retrieval store.

## Local Database And Scale Checks

Itotori DB-backed checks use `DATABASE_URL`. The local disposable Postgres
default is `postgres://itotori:itotori@127.0.0.1:55433/itotori`, with
`COMPOSE_PROJECT_NAME=itotori` as the no-secret public CI default. Use a unique
`COMPOSE_PROJECT_NAME` for parallel worktrees; when it is unset locally,
`just db-up` derives one from the worktree directory.

```sh
just db-up
just db-wait
just db-migrate
just db-reset
just ci-itotori
just itotori-scale-smoke
```

`ITOTORI_SCALE_SCHEMA` optionally pins the schema name used by
`just itotori-scale-smoke`; otherwise the harness creates a unique temporary
schema and drops it after the run. The smoke summary is
`.tmp/itotori-scale-harness/smoke/summary.json`.

For DB-only verification without a database, run:

```sh
env -u DATABASE_URL pnpm --filter @itotori/db test
```

The command exits successfully, prints the skip reason, and writes
`.tmp/itotori-db/no-database-skipped.json`.
