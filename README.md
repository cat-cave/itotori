# Itotori

Itotori is an agentic localization toolkit for games. It brings together extraction, patching, localization state, QA, and runtime validation into one public monorepo.

The suite has three first-class subprojects:

- **Itotori**: localization graph, fake/provider-backed drafting, QA, feedback, benchmarks, and dashboard surfaces.
- **Kaifuu**: deterministic game extraction, patching, verification, and `.kaifuu` delta packages.
- **Utsushi**: validation runtimes for trace, replay, capture, screenshots, and runtime evidence.

The current scaffold is a functional public-fixture path. The alpha proof (the `ALPHA-007` public-fixture vertical, gated by `ALPHA-009`) is the deterministic guardrail that exercises the intended end-to-end contract across all three projects without copyrighted bytes; the first real-engine vertical is the explicit alpha proof target `ALPHA-006`, sourced from `/archive/vault/`.

## Quickstart

```sh
just install
just alpha-proof
```

`just alpha-proof` is the required cross-project integration command: it runs `pnpm exec vp run alpha:public-fixture` and then re-proves cross-artifact linkage with `pnpm exec vp run alpha:public-fixture-validate`. It is public-fixture-only and deterministic — no database, no live credentials, no private corpora — and proves the contract end-to-end through schema-valid, hash-addressed artifact linkage rather than a `status=hello_world_passed` success string. See [docs/alpha-proof.md](docs/alpha-proof.md). Future real-corpus docs should teach generic project runners and corpus descriptors, not new title-specific commands, environment variables, artifact schemas, or preset names. The title-reference allowlist and review command live in [docs/fixtures-and-corpora.md](docs/fixtures-and-corpora.md#title-reference-allowlist-for-active-docs).

The vertical composes and links, for the same public fixture id, source revision, and locale branch:

1. Kaifuu extraction (`BridgeBundle`) and the `.kaifuu` delta package / PatchResult.
2. Itotori bridge import, draft, and `PatchExport`.
3. Utsushi runtime observation proof.
4. A sanitized provider proof and a fresh ITOTORI-026 benchmark report.
5. Dashboard / read-model ingestion and the SHARED-025 alpha proof manifest.

For the full DB-backed test suite and Rust gates, run `just ci` (which starts and tears down a worktree-scoped Postgres stack).

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
  alpha-proof.md
  spec-dag.md
```

Vite+ and Vite Task are the high-level TypeScript/web workspace surface. Cargo remains the Rust build and test authority. The root `justfile` orchestrates both.

## Status

This repository is scaffolded for DAG-driven development from the public-fixture
alpha proof toward `ALPHA-006`, the explicit first real-engine alpha proof target.

The canonical roadmap is tracked as machine-readable data in `roadmap/spec-dag.json`.
Use `just roadmap-validate`, `just roadmap-ready`, and `just roadmap-pop` to inspect
the next PR-sized specs.
