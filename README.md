# Itotori

Itotori is an agentic localization toolkit for games. It brings together extraction, patching, localization state, QA, and runtime validation into one public monorepo.

The suite has three first-class subprojects:

- **Itotori**: localization graph, fake/provider-backed drafting, QA, feedback, benchmarks, and dashboard surfaces.
- **Kaifuu**: deterministic game extraction, patching, verification, and `.kaifuu` delta packages.
- **Utsushi**: validation runtimes for trace, replay, capture, screenshots, and runtime evidence.

The current scaffold is a functional hello world. It uses a fixture game rather than a real engine, but exercises the intended end-to-end contract across all three projects.

## Quickstart

```sh
just install
just db-up
just ci
just hello
```

`just hello` runs the full suite against Postgres-backed Itotori state:

1. Kaifuu extracts `fixtures/hello-game` into a `BridgeBundle`.
2. Itotori imports the bridge, creates a fake `ja-JP -> en-US` draft, and exports `PatchExport`.
3. Kaifuu patches the fixture game, creates a `.kaifuu` delta package, and applies it.
4. Utsushi traces, captures, and smoke-validates the patched game.
5. Itotori ingests the runtime report and writes dashboard-readable status to database tables.
6. The Itotori and Utsushi dashboards read the hello-world status through an API backed by those tables.

## Project Layout

```txt
apps/
  itotori/                 # TypeScript CLI and web shell
  runtime-web-review/      # Minimal browser review shell
packages/
  localization-bridge-schema/
  itotori-db/
  test-fixtures/
crates/
  kaifuu-*/
  utsushi-*/
docs/
  architecture.md
  hello-world.md
  roadmap-dag-prep.md
```

Vite+ and Vite Task are the high-level TypeScript/web workspace surface. Cargo remains the Rust build and test authority. The root `justfile` orchestrates both.

## Status

This repository is scaffolded for the first real roadmap pass. The next step after the hello world is a full roadmap DAG for the shared schema, Itotori, Kaifuu, and Utsushi tracks.
