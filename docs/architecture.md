# Architecture

Itotori is a monorepo because the shared contracts are the hard part. The three subprojects remain independent at runtime, but they evolve against the same bridge, patch, delta, and runtime evidence schemas.

## Boundaries

- **Localization Bridge Schema** is neutral and lives under `packages/localization-bridge-schema`.
- **Itotori** consumes bridge data, produces draft translations and patch exports, and ingests runtime evidence.
- **Itotori DB** owns migrations, Drizzle ORM schema, repositories, and dashboard read models.
- **Kaifuu** consumes game files and patch exports, then emits bridge bundles, patch results, and `.kaifuu` delta packages.
- **Utsushi** consumes patched game directories and emits runtime traces, captures, and smoke reports.

Search and indexing infrastructure is governed by
[ADR 0004](adrs/0004-search-and-indexing-infrastructure.md). Exact Postgres
indexes are the required baseline; semantic retrieval is an optional capability
with deterministic exact fallback when pgvector or embeddings are unavailable.

## Tooling

Vite+ and Vite Task provide the TypeScript/web workspace command surface and cached task orchestration. Cargo remains the authority for Rust builds, tests, and dependency modeling. The root `justfile` is the human-facing command layer.

## Current Hello World

The first fixture loop intentionally avoids copyrighted game files. It proves the contract between the projects without claiming real-engine support or translation quality.
