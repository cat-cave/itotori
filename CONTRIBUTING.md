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
surface: dev setup, internal architecture, worktree lifecycle, testing
standard, and CI policy. Start there when you are going to change code.

## How to work in this repository

1. Read [`AGENTS.md`](AGENTS.md), then the index at
   [`docs/dev/README.md`](docs/dev/README.md).
2. In a fresh worktree, approve the checked-in dev shell once and provision
   dependencies from the offline store:

   ```sh
   direnv allow
   direnv exec . just worktree-setup
   ```

3. Use the six stable `just` delegates. `just --summary` lists them; selectors
   are validated by `scripts/developer-command.mjs`, not added as new recipes.
4. Start with `just check` for the complete static gate. Use a scoped command
   when it matches the change, for example `just check fixtures` or
   `just test dlsite-demand`. See
   [`docs/dev/testing-standard.md`](docs/dev/testing-standard.md) for the
   available scopes and selectors.
5. Use [`docs/dev/ci-lanes.md`](docs/dev/ci-lanes.md) to choose a CI lane.
   `just ci public` is the local public integration lane.

## Workflow at a glance

- Worktrees live under `/scratch/worktrees/` (not inside the repo) and have a
  per-worktree `CARGO_TARGET_DIR` — see
  [`docs/dev/worktree-lifecycle.md`](docs/dev/worktree-lifecycle.md).
- A fresh worktree has no `node_modules`; run `direnv exec . just
worktree-setup` once before TypeScript checks or fixture validation.
- Before opening a PR, run the lane appropriate to the change. The available
  lanes and their contents are mapped in
  [`docs/dev/ci-lanes.md`](docs/dev/ci-lanes.md).
