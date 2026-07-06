# Itotori Catalog Source Adapter Import Contract

This contract governs _metadata-import_ adapters that write catalog facts from
external sources (DLsite, VNDB, EGS, etc.) into the itotori catalog. For
_binary game data_ ingest from the local vault-curation store, see
[itotori-vault-source-adapter.md](itotori-vault-source-adapter.md).

CATALOG-065 defines the idempotent fact-write contract for catalog crawler source adapters.

An adapter can be marked `alpha_ready` or `production_ready` only when it declares
`factImportContract.contractId = "CATALOG-065"` and uses one of these strategies:

- `upsert`: every emitted catalog fact is written through a stable source fact identity and
  replays update or no-op the same row.
- `durable_import_marker`: the adapter writes a durable marker before or with fact writes so a
  replay can skip or reconcile already-imported facts before `commitStepImport`. The marker key
  must be the runner-provided `stableImportKey`, not a crawler job id or crawler job step id.

The generic crawler records fetches, source provenance, imported-step markers, checkpoints, and
rate-limit state, and it orders `commitStepImport` (the call that advances the checkpoint) strictly
after the importer's persisted evidence has been verified. That ordering is necessary but **not
sufficient**: the generic crawler does not make crash replay safe on its own. It has no knowledge of a
source's fact identity, so if an importer writes facts without actually implementing its declared
persistence strategy, a replay inside the crash window duplicates those facts regardless of the
crawler's bookkeeping.

Crash-replay safety holds **only** when each source-specific importer both **implements and verifies**
its declared strategy (`upsert` or `durable_import_marker`), keyed by a stable source fact identity,
before the step is committed. Source-specific importers remain responsible for their own fact identity
and for the durable writes their strategy requires. This keeps DLsite, Steam, IGDB, Wikidata, VNDB,
and EGS (ErogameScape / エロゲー批評空間) parsing outside the generic crawler, while placing the
replay-safety obligation squarely on each importer's strategy implementation — the crawler only
enforces that a declared contract has an importer and a verifier and refuses to commit otherwise.

For any adapter declaring `factImportContract.contractId = "CATALOG-065"`, each non-skipped step
must have an `ingestStep` importer and a `verifyFactImport` verifier. The importer receives
`stableImportKey`, `importTransactionId`, `expectedFactIdentities`, and the parsed facts. It must
write facts through an upsert path or persist a durable marker keyed by `stableImportKey`, then
return a fact-import proof with the same `stableImportKey`, strategy, deterministic fact count, and
fact identities.

The proof is not trusted by itself. Before `commitStepImport`, `verifyFactImport` must read durable
storage and return persisted evidence matching the stable key, strategy, count, and fact identities.
For `upsert`, that evidence is the persisted fact rows for the step. For `durable_import_marker`,
that evidence is a persisted marker row keyed by `stableImportKey` plus the deterministic fact
identities it covers. If the importer, proof, verifier, fact rows, or marker evidence are missing or
mismatched, the runner marks the step failed and does not call `commitStepImport`.

## Persistence strategies: the evidence that must be durable before the checkpoint advances

The generic crawler cannot infer what "already imported" means for a source, so each strategy defines
exactly what the importer must have **durably written** before `commitStepImport` runs and advances the
checkpoint. `verifyFactImport` reads that durable evidence back and the runner validates it against the
step (`validatePersistedFactImportEvidence` in
`packages/itotori-db/src/services/catalog-crawler-runner.ts`); a crawler that merely recorded the step
proves none of this.

### `upsert`

- **Implement**: write every emitted catalog fact through its stable source fact identity
  (`factImportContract.factIdentity`), so a replay updates or no-ops the same rows instead of inserting
  duplicates.
- **Persisted evidence required before the checkpoint advances**: the **persisted catalog fact rows for
  the step**, addressed by the step's deterministic fact identities. `verifyFactImport` must read those
  rows back from durable storage and return evidence with `persisted: true`, `strategy: "upsert"`,
  `stableImportKey` equal to the runner-provided key, `factCount` equal to the step's fact count, and
  `factIdentities` equal to the step's deterministic identities. Only then does the runner call
  `commitStepImport`.

### `durable_import_marker`

- **Implement**: write a durable marker row keyed by the runner-provided `stableImportKey` before or
  with the fact writes, recording the deterministic fact identities it covers, so a replay can detect
  the already-imported step and skip or reconcile it.
- **Persisted evidence required before the checkpoint advances**: the **persisted marker row keyed by
  `stableImportKey`** plus the deterministic fact identities it covers. `verifyFactImport` must read
  that marker back and return evidence with `persisted: true`, `strategy: "durable_import_marker"`,
  `durableMarkerId` equal to `stableImportKey`, and matching `factCount` and `factIdentities`. Only then
  does the runner call `commitStepImport`.

In both strategies the checkpoint advances **after** the durable evidence is read back and matched — not
because the crawler recorded a fetch or a step. An importer that returns a proof but has not durably
written the fact rows (upsert) or the marker (durable) fails verification, and the step is not
committed.

`stableImportKey` is deterministic across crash replay jobs. It is derived from catalog source,
adapter name, partition, source version, parser version, step key, source id, request identity, and
payload hash. `importTransactionId` is currently the same stable value so recorded validation and
future durable-marker importers do not depend on per-job crawler step ids.

The replay validation record for recorded fixtures must include:

- source id
- fixture id
- stable import key
- import transaction id
- deterministic fact count
- deterministic fact identities

The critical replay window is: `recordFetchedStep` succeeds, source facts are written, the process
crashes before `commitStepImport`, then the same recorded fixture replays. A conforming importer must
not duplicate facts in that window.

## Durable replay-validation artifact (CATALOG-076)

The runner returns the replay validation records in memory (`CatalogCrawlerRunResult.replayValidation`),
which by itself only proves acceptance inside the test process. CATALOG-076 makes that evidence
**durable, deterministic, and redacted** so adapter acceptance can cite an artifact instead of only a
green test log.

`buildCatalogReplayValidationArtifact(records)` /
`writeCatalogReplayValidationArtifact(records, outPath)`
(`packages/itotori-db/src/services/catalog-replay-validation-artifact.ts`) emit a
`catalog-replay-validation.v1` JSON artifact:

```jsonc
{
  "artifactVersion": "catalog-replay-validation.v1",
  "node": "CATALOG-076",
  "contractId": "CATALOG-065",
  "recordCount": 2,
  "records": [
    {
      "contractId": "CATALOG-065",
      "catalogSource": "vndb",
      "sourceId": "v1001",
      "fixtureId": "catalog-recorded-importer-vndb-dump-v0.1",
      "stepKey": "...",
      "stableImportKey": "catalog-import:<sha256>",
      "importTransactionId": "catalog-import:<sha256>",
      "factCount": 1,
      "factIdentities": ["catalogSource=vndb|sourceId=v1001"],
      "alreadyImported": false,
    },
  ],
  "digest": "sha256:<sha256 over the sorted records>",
}
```

- **Redacted**: each record is an explicit WHITELIST projection of safe identity metadata
  (`catalogReplayValidationRecordFields`). There is no raw source payload, no request body, and no
  private local filesystem path — even if an upstream record object carried extra fields, the
  projection drops everything outside the whitelist.
- **Deterministic**: records are sorted by a stable content key (`stableImportKey`, then `stepKey`,
  then `sourceId`), serialization sorts object keys, and the artifact carries a content `digest` but
  **no run-varying timestamp**. Because `stableImportKey` is derived from content (not per-job ids),
  two runs of the same replay serialize byte-identically.

**How adapter acceptance cites it**: `just catalog-replay-db-strict` runs the
`catalog-replay-validation-artifact.test.ts` suite against the database, which performs a real replay
run and writes `.tmp/itotori-db/catalog-replay-validation.json`. Acceptance cites that artifact path
plus its `digest` (and the covered `sourceId` / `fixtureId` / `stableImportKey` / `factIdentities`) as
durable evidence of CATALOG-065 replay conformance, rather than pointing only at test-run logs.

## Verifying the contract (DB-backed local gate)

The replay and idempotency tests that prove this contract are DB-classified: they drive an isolated
migrated Postgres via `packages/itotori-db/test/db-test-context.ts`, so the fast-local
`pnpm --filter @itotori/db test` (and any run without `DATABASE_URL`) **skips** them with a
prominent, machine-readable marker. A skipped suite is _not_ replay coverage — a green fast-local run
proves nothing about the CATALOG-065 replay path.

To prove the replay path actually ran against a database, use the CATALOG-072 DB-backed local gate:

```sh
just db-up          # bring up a disposable Postgres (docker/podman compose)
just db-migrate     # apply migrations
just catalog-replay-db-strict   # run + PROVE the catalog replay/idempotency suites
just db-down        # tear the disposable database down
```

`just catalog-replay-db-strict` (`scripts/catalog-replay-db-gate.mjs`) runs only the catalog
source-adapter replay + idempotency repository suites against the database:

- `catalog-crawler-repository.test.ts` — crash-before-`commitStepImport` replay windows.
- `catalog-recorded-importers.test.ts` — VNDB / EGS / DLsite / Steam / IGDB / Wikidata rerun
  idempotency.
- `catalog-dlsite-demand.test.ts` — DLsite demand-import replay idempotency.

The gate is **fail-loud, never green-on-skip**:

- With no `DATABASE_URL` it writes a machine-readable skipped artifact
  (`.tmp/itotori-db/catalog-replay-skipped.json`, `replayCovered: false`) and **exits non-zero**, so
  a skip can never be mistaken for full persisted replay verification.
- With a reachable database it asserts each named suite executed replayed tests (per-suite test
  count &gt; 0, zero skipped, zero failed) and writes a deterministic proof artifact
  (`.tmp/itotori-db/catalog-replay-proof.json`) recording per-suite counts. A zero-test or skipped
  outcome is a hard failure.

`just ci-itotori` runs this gate after bringing up the database, so CATALOG-065 replay coverage is
proven explicitly in CI (not merely implied by an all-suites `test:db` run). The gate uses only
public recorded fixtures — no private data or network credentials.
