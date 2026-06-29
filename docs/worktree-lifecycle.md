# Agent Worktree Lifecycle

We use **qdcli** for orchestration. The branch/claim/plan/implement/audit/
repair/merge/complete/blocked/cleanup lifecycle and the worktree helpers
(`qd worktree create|env|status`, `qd claim`, `qd diff`) are documented in
qdcli's own `docs/llms.md` (worktree section) and `docs/agents.md`. Do not
duplicate that generic lifecycle here.

This page keeps only the itotori-specific worktree facts that qd does not
encode.

## Worktrees Live OUTSIDE The Repo

Itotori worktrees must be created under `/scratch/worktrees/`, never inside the
repo (e.g. not `.qd/worktrees/...`). In-repo worktrees pollute `vp check` and
cargo discovery, and get picked up by tooling that walks the workspace tree.

Naming convention (uppercase DAG id in prose, lower-case slug in branch/path;
slug format `[a-z0-9]+(-[a-z0-9]+)*`):

| Purpose                        | Branch                                      | Worktree                                                               |
| ------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| Primary spec work              | `spec/<node-id-lower>`                      | `/scratch/worktrees/itotori-spec-<node-id-lower>`                      |
| Disjoint implementation worker | `worker/<node-id-lower>-<scope-slug>`       | `/scratch/worktrees/itotori-worker-<node-id-lower>-<scope-slug>`       |
| Blocking repair worker         | `repair/<node-id-lower>-<finding-id-lower>` | `/scratch/worktrees/itotori-repair-<node-id-lower>-<finding-id-lower>` |
| Read-only audit lane           | detached from `spec/<node-id-lower>`        | `/scratch/worktrees/itotori-audit-<node-id-lower>-<lane-slug>`         |

Do not add random suffixes to resolve collisions. If the canonical branch or
worktree already exists, inspect and reuse or prune it.

## Per-Worktree CARGO_TARGET_DIR

`nix develop` sets a per-worktree `CARGO_TARGET_DIR` under
`/scratch/cache/itotori/` so two worktrees never overwrite each other's Rust
build. The convention, the hashing scheme, and the stale-target cleanup command
are documented in [`AGENTS.md`](../AGENTS.md). Run cargo and `just` commands
through `nix develop --command bash -lc '...'` so this isolation applies.

## `.env` And Secret Handling

- Never print, copy into artifacts, stage, or commit `.env`, `.env.*`, secret
  values, private corpora, or copyrighted local material. Approved local/live
  workflows may explicitly load scoped local-only env or secret files for the
  intended validation work, but diagnostics must name variables without dumping
  values.
- Keep raw provider logs, secret-bearing output, local caches, and large
  generated artifacts out of git.
- Before any command that lists paths from a worktree, and before commit/merge,
  run the env-path guard. Untracked or ignored local env files may exist for
  approved workflows; do not list them in status, diff, cleanup, or audit
  output. Do not replace these helpers with raw
  `git status --untracked-files=all`.

```sh
env_path_guard() {
  repo="$1"
  if git -C "$repo" ls-files -z | rg -z -q '(^|/)\.env(\.|$)'; then
    echo "tracked env file detected; stop"
    exit 1
  fi
  if git -C "$repo" diff --cached --name-only -z | rg -z -q '(^|/)\.env(\.|$)'; then
    echo "staged env file detected; stop"
    exit 1
  fi
}

safe_worktree_status() {
  repo="$1"
  env_path_guard "$repo"
  git -C "$repo" status --short --untracked-files=all -- . \
    ':(exclude).env' ':(exclude).env.*' \
    ':(exclude)**/.env' ':(exclude)**/.env.*'
}
```
