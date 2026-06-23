# Architecture

Itotori is a monorepo because the shared contracts are the hard part. The three
subprojects remain independent at runtime, but they evolve against the same
catalog, bridge, patch, delta, readiness, and runtime evidence schemas. Itotori
reads owned-game bytes from `/archive/vault/` — managed by the sibling
vault-curation project — strictly read-only through the contract in
[itotori-vault-source-adapter.md](itotori-vault-source-adapter.md).

## Boundaries

- **Localization Bridge Schema** is neutral and lives under `packages/localization-bridge-schema`.
- **Catalog and readiness state** identify works across VNDB, EGS
  (ErogameScape / エロゲー批評空間), DLsite, Steam, IGDB, Wikidata, and local
  corpora. It records translation completeness,
  engine evidence, editions, releases, install state, and opportunity ranking
  before extraction or drafting is assumed possible.
- **Itotori** consumes catalog/readiness and bridge data, produces draft
  translations and patch exports, and ingests runtime evidence.
- **Itotori DB** owns migrations, Drizzle ORM schema, repositories, and dashboard read models.
- **Kaifuu** consumes game files and patch exports, then emits inventory,
  readiness profiles, bridge bundles, patch results, and `.kaifuu` delta
  packages. Text access is modeled as layered reversible transforms: locate
  surface, unpack container, decrypt, decode/decompile, normalize text, and
  patch back. Plaintext is the identity/null-key configuration of that model.
- **Utsushi** consumes patched game directories and emits runtime traces, captures, and smoke reports.

Search and indexing infrastructure is governed by
[ADR 0004](adrs/0004-search-and-indexing-infrastructure.md). Exact Postgres
indexes are the required baseline; semantic retrieval is an optional capability
with deterministic exact fallback when pgvector or embeddings are unavailable.

## Tooling

Vite+ and Vite Task provide the TypeScript/web workspace command surface and cached task orchestration. Cargo remains the authority for Rust builds, tests, and dependency modeling. The root `justfile` is the human-facing command layer.

## Current Hello World

The first fixture loop intentionally avoids copyrighted game files. It proves the contract between the projects without claiming real-engine support or translation quality.

The Hello World workflow remains the deterministic integration guardrail on the
synthetic fixture path. The first real-engine vertical is `ALPHA-006` (Sukara's
_Oshioki Sweetie HD Remaster + Sweets fandisc_ on RealLive, sourced from
`/archive/vault/` per the vault-source adapter contract). `ALPHA-007` and
`ALPHA-009` are the workflow handoff steps that promote the alpha-proof command
into CI and retire the literal hello-world gate: the replacement proof must
validate real cross-project artifact linkage instead of only a placeholder
success line. Once that replacement is green, the old Hello World workflow must
either disappear or become the same alpha proof under a compatibility alias; it
should not remain as a second, weaker source of truth.
