#!/usr/bin/env bash
set -euo pipefail

cargo_target_dir_for_worktree_root() {
  local worktree_root="$1"
  worktree_root="$(cd "$worktree_root" && pwd -P)"

  local worktree_basename="${worktree_root##*/}"
  local worktree_name
  worktree_name="$(printf "%s" "$worktree_basename" | tr -c 'A-Za-z0-9._-' '_')"

  local worktree_hash
  worktree_hash="$(printf "%s" "$worktree_root" | sha256sum | cut -c1-12)"

  printf "/scratch/cache/itotori/target-%s-%s\n" "$worktree_name" "$worktree_hash"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  mkdir -p "$tmpdir/parent-a/itotori" "$tmpdir/parent-b/itotori"

  target_a="$(cargo_target_dir_for_worktree_root "$tmpdir/parent-a/itotori")"
  target_b="$(cargo_target_dir_for_worktree_root "$tmpdir/parent-b/itotori")"
  target_a_again="$(cargo_target_dir_for_worktree_root "$tmpdir/parent-a/itotori")"

  [[ "$target_a" == "$target_a_again" ]]
  [[ "$target_a" != "$target_b" ]]
  [[ "$target_a" =~ ^/scratch/cache/itotori/target-itotori-[0-9a-f]{12}$ ]]
  [[ "$target_b" =~ ^/scratch/cache/itotori/target-itotori-[0-9a-f]{12}$ ]]
fi
