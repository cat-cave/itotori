# Agent Worktree Lifecycle

## Worktrees Live OUTSIDE The Repo

Itotori worktrees must be created under `/scratch/worktrees/`, never inside the
repo. In-repo worktrees pollute `vp check` and cargo discovery, and get picked
up by tooling that walks the workspace tree.

## Parallel-agent safety

Several of these rules exist because **many agents run concurrently in their own
worktrees** off the same main checkout. The conventions below keep them from
clobbering one another.

- **Worktree paths live OUTSIDE the repo**, under
  `/scratch/worktrees/itotori-<slug>` — never in-repo. Use the canonical
  `[a-z0-9]+(-[a-z0-9]+)*` slug with no
  random suffixes; if the path already exists, inspect and reuse or prune it.
- **Each worktree gets an isolated `CARGO_TARGET_DIR` automatically** via the
  `flake.nix` shell hook (see [`AGENTS.md`](../../AGENTS.md) and
  [Per-Worktree CARGO_TARGET_DIR](#per-worktree-cargo_target_dir) below). Never
  point two concurrent worktrees at the same target dir — concurrent writes
  corrupt the build.
- **Staying current:** use [`scripts/sync-main.sh`](../../scripts/sync-main.sh)
  (run in the main checkout — fast-forward-only, with `main`-branch + clean-tree
  guards) and [`scripts/sync-worktree.sh`](../../scripts/sync-worktree.sh) (run
  in a static worktree — rebases or fast-forwards onto `origin/main` and aborts
  cleanly on conflict). Always confirm local `main` == `origin/main` before
  branching off it.

## Provisioning `node_modules` (`just worktree-setup`)

A fresh worktree has **no `node_modules`**, so TypeScript checks,
`just check fixtures`, and public-manifest regeneration cannot run until it is
provisioned. Do this ONCE, right after `cd`-ing into the new worktree:

```sh
direnv exec . just worktree-setup    # after `direnv allow` approves this checkout
```

`worktree-setup` runs `pnpm install --frozen-lockfile --offline`. It is:

- **Offline / no network.** It installs from the shared pnpm content-addressed
  store (`~/.local/share/pnpm`), already populated by the main checkout, so it
  never touches the network (`--offline` fails loudly if a package is missing
  from the store rather than reaching out). Corepack's pnpm binary is likewise
  already cached, so no `corepack` download is needed.
- **Fast + deterministic.** ~1.5s; `--frozen-lockfile` pins to the committed
  `pnpm-lock.yaml`.

After it runs, `direnv exec . pnpm exec vp check` and `just check fixtures`
work.

**Why not symlink `node_modules` from the main checkout?** pnpm's `node_modules`
is a symlink farm whose workspace entries (`apps/*`, `packages/*`) point back at
the checkout that created it. A symlinked tree would resolve this worktree's
workspace packages to the _main_ checkout, masking the worktree's own edits. A
real per-worktree offline install is the reliable approach.

## Per-Worktree CARGO_TARGET_DIR

`nix develop` sets a per-worktree `CARGO_TARGET_DIR` under
`/scratch/cache/itotori/` so two worktrees never overwrite each other's Rust
build. The convention, the hashing scheme, and the stale-target cleanup command
are documented in [`AGENTS.md`](../../AGENTS.md). Run cargo and `just` commands
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
