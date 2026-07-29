# Itotori Subproject

> **Ownership and mechanism, not product intent.**
> [`action-plan.md`](action-plan.md) alone governs scope, state, and sequence;
> legacy tier labels below are historical context.

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

## Local database and scale checks

The application configuration selects the local database. For qd local CI, use
`just ci affected`; that runner owns the disposable database lifecycle. For
manual development, use the supported `just dev db-*` selectors. Do not use
ad-hoc environment variables for database URLs, Compose project names, ports,
or scale schemas: they are application/development configuration, not
deployment inputs.

```sh
just dev db-up
just dev db-wait
just dev db-migrate
just dev db-reset
just ci affected
just ci public
just dev scale-smoke
```

The scale harness creates an isolated temporary schema and writes the smoke
summary to
`.tmp/itotori-scale-harness/smoke/summary.json`.

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
On success, `--output` receives an ingestion receipt with the patch-result and
patch-export identities plus the reported status.
