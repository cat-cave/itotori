# Itotori

Itotori is an agentic games-localization pipeline, not a translation box. It
brings the whole workflow into one public monorepo:
**catalog → inventory → readiness → extraction → localization → patching →
validation**.

The suite has three first-class subprojects:

- **Itotori**: catalog/inventory, localization graph, agentic drafting + QA,
  feedback, benchmarks, and dashboard surfaces.
- **Kaifuu**: deterministic game extraction, patching, verification, and
  `.kaifuu` delta packages.
- **Utsushi**: validation runtimes for trace, replay, capture, screenshots, and
  runtime evidence.

## Alpha = readiness to _start_ a real localization project

The **alpha milestone is readiness to _start_ a first real localization
project**, not a finished product and not a terminal release. It means the whole
pipeline fires end-to-end on a single real game (RealLive) and every stage is
swappable; output quality is explicitly not the bar at alpha. The full readiness
statement, the generated capability claims, and the evidence node references
live in [docs/alpha-readiness.md](docs/alpha-readiness.md). Tier definitions
(real-game-testing-ready → alpha → beta → full release) live in
[docs/project-readiness.md](docs/project-readiness.md).

The alpha proof (the `ALPHA-007` public-fixture vertical, gated by `ALPHA-009`)
is the deterministic guardrail that exercises the end-to-end contract across all
three projects without copyrighted bytes; the first real-engine vertical is the
explicit alpha proof target `ALPHA-006`, sourced read-only from the configured
target corpus root (the corpus vault).

## Quickstart (fresh clone — no secrets, no real bytes)

```sh
just install                    # install workspace deps
just alpha-demo                 # public-fixture end-to-end demo (deterministic)
just alpha-readiness-checklist  # verify docs against generated artifacts
```

See [docs/install.md](docs/install.md) for the full fresh-clone path and
[docs/security-and-limitations.md](docs/security-and-limitations.md) for the
security posture, legal boundaries, and honest limitations. `just alpha-demo`
delegates to the alpha proof below.

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
  itotori/                 # TypeScript CLI + React SPA on @itotori/ds (fnd-spa-shell)
  runtime-web-review/      # Runtime evidence dashboard
packages/
  localization-bridge-schema/
  itotori-db/
  itotori-ds/              # Dusk Observatory design system (React + CSS tokens)
  spec-dag-dashboard/      # Self-contained browsable spec-DAG dashboard
crates/
  kaifuu-*/
  utsushi-*/
docs/
  architecture.md
  alpha-proof.md
  spec-dag.md
  frontend.md              # SPA / @itotori/ds / typed API client notes
```

Vite+ and Vite Task are the high-level TypeScript/web workspace surface. Cargo remains the Rust build and test authority. The root `justfile` orchestrates both.

## Status

This repository is at the **alpha readiness** milestone: ready to _start_ a first
real localization project, with the whole pipeline proven end-to-end on the
public fixtures and on the first real-engine vertical (`ALPHA-006`). It is not a
terminal product release; beta (≥2 games per engine, encrypted variants) and full
release are later tiers ([docs/project-readiness.md](docs/project-readiness.md)).

Readiness is enforced, not asserted: `just alpha-readiness-checklist`
([scripts/alpha-readiness-checklist.mjs](scripts/alpha-readiness-checklist.mjs))
re-derives the readiness-doc claims from the generated capability + benchmark
artifacts and the SHARED-025 proof manifest, so the docs cannot drift. It runs
inside `just check` / `just ci`.

The canonical roadmap is tracked as machine-readable data in `roadmap/spec-dag.json`
and imported into the qd orchestration ledger, which is the source of truth for
inspecting and choosing work. Run `qd ready` (or `qd status`) to see the next
PR-sized specs. Use `just roadmap-validate` to validate the `spec-dag.json` data.
