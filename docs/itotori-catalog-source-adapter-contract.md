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

The crawler records fetches, source provenance, imported-step markers, checkpoints, and rate-limit
state. Source-specific importers remain responsible for their own fact identity and for using
upserts or durable markers. This keeps DLsite, Steam, IGDB, Wikidata, VNDB, and EGS
(ErogameScape / エロゲー批評空間) parsing outside the generic crawler while still making crash
replay safe.

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
