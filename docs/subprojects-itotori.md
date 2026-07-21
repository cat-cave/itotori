# Itotori Subproject

> **Alpha definition (2026-06-24).** The redefined alpha gates live at the top
> of [`project-readiness.md`](project-readiness.md).
> Alpha-ready means the architecture-proven dogfood point: substrate
> M.1–M.3, a non-synthetic engine port crate, real-bytes alpha-corpus smoke,
> dashboard reachability, and repo hygiene. The product loop and live-provider
> bar remain the alpha contract for Itotori's own surface; full end-to-end on a
> real game is the **dogfood project that follows alpha**, not the alpha gate
> itself.

Itotori owns localization state: catalog identity, local corpus inventory,
translation-completeness intelligence, locale branches, drafts, policy, QA
findings, feedback, runtime evidence ingestion, and patch-ready exports.

The product uses the live OpenRouter localization path, surfaced through
TanStack in the Studio. Deterministic public fixtures verify contracts and
artifact linkage, but they do not define the production localization workflow.

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
`COMPOSE_PROJECT_NAME=itotori` as the no-secret public CI default. For qd local
CI, use `qd ci run <NODE-ID>` or `just qd-full-ci`; that wrapper derives a
worktree-specific host port and Compose project name, writes a per-run compose
env file, starts Postgres, waits for readiness, runs `just ci`, and tears the
stack down. If the derived port range is occupied, it fails before startup with
the blocked ports listed. For manual parallel worktrees outside qd, set a unique
`DATABASE_URL` host port and `COMPOSE_PROJECT_NAME`; when `COMPOSE_PROJECT_NAME`
is unset locally, `just db-up` derives one from the worktree directory.

The local compose Postgres service uses runtime server flags, not initdb-only
settings: `max_connections=400` and `shared_buffers=512MB`. `shared_buffers`
tracks the same 4x increase from Postgres' default 128MB as the connection cap
increase from the default 100, so recreating the container keeps the intended
capacity without relying on persisted initialization state.

```sh
just db-up
just db-wait
just db-migrate
just db-reset
just qd-full-ci
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

## Ingesting patch results

`itotori ingest-patch-result` reads a v0.2 patch result JSON artifact, validates
it against the shared schema (`assertPatchResultV02`), and routes it through the
project workflow boundary. The boundary additionally enforces three cross-
artifact checks the schema cannot do alone: it rejects results whose
`patchExportId` does not match the project's recorded export
(`kaifuu.patch_result.mismatched_export_id`), recomputes and re-checks the
`outputHash` rollup against `touchedAssets` for passed reports
(`kaifuu.patch_result.output_hash_drift`), and raises a P0 finding for any
`partialWrite.disposition === "retained_partial"`
(`kaifuu.patch_result.silent_partial_write`).

```sh
node apps/itotori/dist/cli.js ingest-patch-result \
  --project .tmp/<run-id>/itotori-project.json \
  --patch-result .tmp/<run-id>/patch-result.json \
  --output .tmp/<run-id>/patch-result-ingest.json
```

Persistence is in-memory for the current slice; `@itotori/db` schema work that
records ingested patch results is tracked as a follow-up.
