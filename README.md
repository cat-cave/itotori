# Itotori

Itotori is an agentic localization toolkit for games. It brings together extraction, patching, localization state, QA, and runtime validation into one public monorepo.

The suite has three first-class subprojects:

- **Itotori**: localization graph, fake/provider-backed drafting, QA, feedback, benchmarks, and dashboard surfaces.
- **Kaifuu**: deterministic game extraction, patching, verification, and `.kaifuu` delta packages.
- **Utsushi**: validation runtimes for trace, replay, capture, screenshots, and runtime evidence.

The current scaffold is a functional DB-backed fixture path. It uses a fixture game rather than a real engine, but exercises the intended end-to-end contract across all three projects.

## Quickstart

```sh
just install
just db-up
just ci
just hello
```

`just hello` remains the deterministic fixture path against Postgres-backed Itotori state:

1. Kaifuu extracts `fixtures/hello-game` into a `BridgeBundle`.
2. Itotori imports the bridge, creates a fake `ja-JP -> en-US` draft, and exports `PatchExport`.
3. Kaifuu patches the fixture game, creates a `.kaifuu` delta package, and applies it.
4. Utsushi traces, captures, and smoke-validates the patched game.
5. Itotori ingests the runtime report and writes dashboard-readable status to database tables.
6. The Itotori dashboard reads project, QA, benchmark, and runtime state through typed API routes.
7. The runtime evidence dashboard serves `/runtime/evidence/:runtimeRunId` and reads `/api/runtime/v0.2/status`.

## Project Layout

```txt
apps/
  itotori/                 # TypeScript CLI and web shell
  runtime-web-review/      # Runtime evidence dashboard
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

This repository is scaffolded for DAG-driven development from the DB-backed hello
world toward alpha readiness for the first real localization project.

The canonical roadmap is tracked as machine-readable data in `roadmap/spec-dag.json`.
Use `just roadmap-validate`, `just roadmap-ready`, and `just roadmap-pop` to inspect
the next PR-sized specs.
