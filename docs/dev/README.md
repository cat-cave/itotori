# Developer Docs (`docs/dev/`)

This directory collects the **contributor / developer-oriented** docs for
itotori: dev setup, internal architecture, the qd DAG / orchestration workflow,
worktree lifecycle, testing standard, CI policy, and audit playbook. They are
separated from the user-facing docs at the top level of `docs/` so a user
localizing a game does not have to read dev-internal material to follow the
user path.

If you are a new contributor, start with [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
at the repo root; it routes you to the right doc below for each contributor
concern.

## Index

### Dev setup

- [`toolchain-policy.md`](toolchain-policy.md) — Nix + direnv + pnpm + Rust
  versions, authorities, upgrade policy, lockfile rules, and the
  `node scripts/verify-toolchain-policy.mjs` verifier.

### Internal architecture

- [`architecture.md`](architecture.md) — what the three subprojects own, how
  they share the bridge/patch/delta schemas, and where the package + crate
  boundaries live.
- [`llm-attempt-policy.md`](llm-attempt-policy.md) — physical retry and
  deadline ownership, cancellation semantics, and spend-exposure admission.
- [`frontend.md`](../frontend.md) — the Studio SPA, `@itotori/ds` design
  system, and the typed API client (developer notes; lives at the top level
  because the Studio is part of the user-visible surface too).

### qd DAG / orchestration workflow

- [`docs/orchestration.md`](../orchestration.md) — **orchestrator playbook**
  (authoritative on-ramp; `qd method show` points here): landing flow, qd
  lifecycle, delegation, worktrees, waves, real-bytes honesty, external PRs,
  shell-out cookbook.
- [`spec-dag.md`](spec-dag.md) — the committed `roadmap/spec-dag.json` export,
  validation, and the qd-import contract.
- [`orchestration-operating-model.md`](orchestration-operating-model.md) —
  itotori-specific operating rules (milestones, provider/cost policy, DAG
  anti-patterns) that the playbook does not encode.

### Worktree + workflow

- [`worktree-lifecycle.md`](worktree-lifecycle.md) — itotori-specific worktree
  rules (`/scratch/worktrees/`, per-worktree `CARGO_TARGET_DIR`, the
  `just worktree-setup` provisioning step, the env-path guard).
- [`AGENTS.md`](../../AGENTS.md) (root) — the short agent-conventions file
  that delegates the full worktree story to `worktree-lifecycle.md`.

### Testing

- [`testing-standard.md`](testing-standard.md) — behavior-first principle,
  fixture-layering policy, the test-seam classifier, lane split between
  per-gate and periodic/strict.

### CI / dependency policy

- [`ci-lanes.md`](ci-lanes.md) — per-gate lane vs periodic/strict lane, what
  runs where, why.
- [`ci-cache-and-affected.md`](ci-cache-and-affected.md) — `just affected`,
  Vite+ task cache, Cargo cache, and the affected-vs-required-CI rule.
- [`dependency-policy.md`](dependency-policy.md) — `cargo-deny` strictness,
  the duplicate-version skip rules, and the `scripts/verify-deny-strict.mjs`
  guard.
- [`tanstack-openrouter-fork-governance.md`](tanstack-openrouter-fork-governance.md)
  — the temporary, coordinated pin of `@tanstack/ai` /
  `@tanstack/ai-openrouter` / `@openrouter/sdk` (incl. the root
  `pnpm.overrides` fork-divergence), its provenance + license, the
  rebase-onto-upstream / upstream-EXIT procedures, the pin JSON + CI guard
  (`scripts/assert-tanstack-openrouter-pin.mjs`), and the `.changeset` entry.

### Audit / investigation

- [`audit-playbook.md`](audit-playbook.md) — how to run and read a code or
  audit investigation against the monorepo.
