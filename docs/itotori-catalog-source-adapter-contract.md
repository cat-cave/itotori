# Itotori Catalog Source Adapter Import Contract

CATALOG-065 defines the idempotent fact-write contract for catalog crawler source adapters.

An adapter can be marked `alpha_ready` or `production_ready` only when it declares
`factImportContract.contractId = "CATALOG-065"` and uses one of these strategies:

- `upsert`: every emitted catalog fact is written through a stable source fact identity and
  replays update or no-op the same row.
- `durable_import_marker`: the adapter writes a durable marker before or with fact writes so a
  replay can skip or reconcile already-imported facts before `commitStepImport`.

The crawler records fetches, source provenance, imported-step markers, checkpoints, and rate-limit
state. Source-specific importers remain responsible for their own fact identity and for using
upserts or durable markers. This keeps DLsite, Steam, IGDB, Wikidata, VNDB, and EGS parsing outside
the generic crawler while still making crash replay safe.

The replay validation record for recorded fixtures must include:

- source id
- fixture id
- import transaction id
- deterministic fact count

The critical replay window is: `recordFetchedStep` succeeds, source facts are written, the process
crashes before `commitStepImport`, then the same recorded fixture replays. A conforming importer must
not duplicate facts in that window.
