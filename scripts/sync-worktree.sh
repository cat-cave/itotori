#!/usr/bin/env bash
#
# sync-worktree.sh — bring a static worktree's branch current on origin/main.
#
# Intended for long-lived/static worktrees that track main. Fetches origin, then
# moves the current branch forward on top of origin/main:
#   - if there are NO local commits ahead of origin/main -> `git merge --ff-only`
#   - if there ARE local commits -> `git rebase origin/main`
# Safety: on any rebase conflict the rebase is aborted immediately so the tree is
# NEVER left half-finished; the script exits non-zero with a clear message. Repo
# root is derived from git, not hardcoded.
#
set -euo pipefail

repo_root="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$repo_root"

# Refuse to operate on a dirty tree: a rebase would either error out or require
# --autostash. Fail loud rather than risk a half-finished state.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "sync-worktree: working tree is dirty; aborting. Commit/stash first. cwd=$repo_root" >&2
  exit 1
fi

echo "sync-worktree: fetching origin..."
git fetch origin --quiet

ahead="$(git rev-list --count origin/main..HEAD)"
current_branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "$ahead" -eq 0 ]; then
  echo "sync-worktree: '$current_branch' has no local commits; fast-forwarding to origin/main..."
  git merge --ff-only origin/main
else
  echo "sync-worktree: '$current_branch' has $ahead local commit(s); rebasing onto origin/main..."
  if ! git rebase origin/main; then
    git rebase --abort 2>/dev/null || true
    echo "sync-worktree: rebase onto origin/main conflicted; aborted to leave a clean tree." >&2
    echo "sync-worktree: resolve the divergence manually in $repo_root." >&2
    exit 1
  fi
fi

echo "sync-worktree: '$current_branch' is now up to date on top of origin/main ($(git rev-parse --short HEAD))."
