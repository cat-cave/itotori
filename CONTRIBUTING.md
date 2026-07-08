# Contributing

Thanks for contributing to itotori. This file is the **top-level pointer** for
contributors; the developer-oriented docs are collected under
[`docs/dev/`](docs/dev/).

## User docs vs developer docs

The docs at the top level of [`docs/`](docs/) are the user-facing surface:
they explain what itotori does, how to install it, how to localize a game,
what the formats are, and how to read the alpha / beta milestones. **You do
not need to read anything in `docs/dev/` to localize a game.**

The docs under [`docs/dev/`](docs/dev/) are the contributor / developer
surface: dev setup, internal architecture, the qd DAG workflow, worktree
lifecycle, testing standard, CI policy, and the audit playbook. Start there
when you are going to change code.

## Where to start as a contributor

1. **Read [`AGENTS.md`](AGENTS.md) at the repo root.** It is the short agent /
   contributor conventions file (fresh-worktree provisioning, per-worktree
   `CARGO_TARGET_DIR`, env-path guard).
2. **Skim [`docs/dev/README.md`](docs/dev/README.md).** It indexes every doc
   under `docs/dev/` so you can jump to the one your task needs.
3. **For "what is this repo laid out like"**, read
   [`docs/dev/architecture.md`](docs/dev/architecture.md) and the
   [`docs/dev/spec-dag.md`](docs/dev/spec-dag.md) /
   [`docs/dev/orchestration-operating-model.md`](docs/dev/orchestration-operating-model.md)
   pair if you are picking up a qd-driven work item.
4. **For "how do I run a single test or a single gate"**, read
   [`docs/dev/testing-standard.md`](docs/dev/testing-standard.md) and
   [`docs/dev/ci-lanes.md`](docs/dev/ci-lanes.md).
5. **For dev-toolchain questions** (Nix flakes, pnpm, Rust versions, upgrades),
   read [`docs/dev/toolchain-policy.md`](docs/dev/toolchain-policy.md).

## Workflow at a glance

- Worktrees live under `/scratch/worktrees/` (not inside the repo) and have a
  per-worktree `CARGO_TARGET_DIR` — see
  [`docs/dev/worktree-lifecycle.md`](docs/dev/worktree-lifecycle.md).
- A fresh worktree has no `node_modules`; run `just worktree-setup` once
  before `pnpm exec vp check` or `just fixtures-validate`.
- Orchestration goes through qd; see
  [`docs/dev/orchestration-operating-model.md`](docs/dev/orchestration-operating-model.md)
  and [`docs/dev/spec-dag.md`](docs/dev/spec-dag.md).
- Before opening a PR, run `just check`; the full lane is `just ci`. Lanes
  and which tests run where are mapped in
  [`docs/dev/ci-lanes.md`](docs/dev/ci-lanes.md).
