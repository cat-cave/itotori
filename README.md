# Itotori

Itotori is an agentic localization toolkit for games. It brings together extraction, patching, localization state, QA, and runtime validation into one public monorepo.

The suite has three first-class subprojects:

- **Itotori**: localization graph, fake/provider-backed drafting, QA, feedback, benchmarks, and dashboard surfaces.
- **Kaifuu**: deterministic game extraction, patching, verification, and `.kaifuu` delta packages.
- **Utsushi**: validation runtimes for trace, replay, capture, screenshots, and runtime evidence.

The current scaffold is a functional DB-backed path. The hello-world fixture is the deterministic bootstrap that exercises the intended end-to-end contract across all three projects without copyrighted bytes; the first real-engine vertical is the explicit alpha proof target `ALPHA-006`, sourced from `/archive/vault/`.

## Quickstart

```sh
just install
just db-up
just ci
just hello
```

`just hello` remains the deterministic bootstrap path against Postgres-backed Itotori state; it proves the contract end-to-end on a synthetic fixture. Future real-corpus docs should teach generic project runners and corpus descriptors, not new title-specific commands, environment variables, artifact schemas, or preset names. The title-reference allowlist and review command live in [docs/fixtures-and-corpora.md](docs/fixtures-and-corpora.md#title-reference-allowlist-for-active-docs).

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
crates/
  kaifuu-*/
  utsushi-*/
docs/
  architecture.md
  hello-world.md
  spec-dag.md
```

Vite+ and Vite Task are the high-level TypeScript/web workspace surface. Cargo remains the Rust build and test authority. The root `justfile` orchestrates both.

## Status

This repository is scaffolded for DAG-driven development from the DB-backed hello
world toward `ALPHA-006`, the explicit first real-engine alpha proof target.

The canonical roadmap is tracked as machine-readable data in `roadmap/spec-dag.json`.
Use `just roadmap-validate`, `just roadmap-ready`, and `just roadmap-pop` to inspect
the next PR-sized specs.
