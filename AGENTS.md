# Agent Conventions

## Rust Build Artifacts

`nix develop` sets `CARGO_TARGET_DIR` to a per-worktree scratch path:

```sh
/scratch/cache/itotori/target-$(basename "$worktree_root")-$short_hash
```

The shell hook resolves the canonical Git worktree root with
`git rev-parse --show-toplevel` and `pwd -P`, sanitizes that root's basename to
`A-Za-z0-9._-`, then appends the first 12 hex characters of the SHA-256 digest
of the canonical full root path. This keeps the main checkout stable at its
existing path while preventing two worktrees with the same basename under
different parents from sharing a Rust target directory.

This keeps concurrent `cargo`, `just check`, and `just ci` runs from different
worktrees from overwriting one another. The owner of a worktree/build should
remove only target directories they own, and only when no shell, `cargo`, `just
check`, or `just ci` process is using them. For example:

```sh
find /scratch/cache/itotori -maxdepth 1 -type d -user "$USER" -name 'target-*' -mtime +14 -prune -exec rm -rf -- {} +
```
