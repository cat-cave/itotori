#!/usr/bin/env bash
#
# sync-main.sh — fast-forward-only sync of the MAIN checkout to origin/main.
#
# Guards: no-op (exit 0) unless the current branch is exactly `main` AND the
# working tree is clean. This is intended to be run only inside the main
# checkout; it never rebases, never force-pushes, and never mutates a dirty or
# non-main tree. Repo root is derived from git, not hardcoded.
#
set -euo pipefail

repo_root="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$repo_root"

current_branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "$current_branch" != "main" ]; then
  echo "sync-main: not on 'main' (on '$current_branch'); skipping. cwd=$repo_root"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "sync-main: working tree is dirty; skipping. Resolve and re-run. cwd=$repo_root"
  exit 0
fi

echo "sync-main: fetching origin and fast-forwarding main..."
git fetch origin --quiet
git merge --ff-only origin/main
echo "sync-main: main is now $(git rev-parse --short HEAD) == origin/main."
