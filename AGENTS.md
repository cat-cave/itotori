# Agent Conventions

## Rust Build Artifacts

`nix develop` sets `CARGO_TARGET_DIR` to a per-worktree scratch path:

```sh
/scratch/cache/itotori/target-$(basename "$PWD")
```

The shell hook sanitizes the basename to `A-Za-z0-9._-`, replacing other bytes
with `_`, so worktrees with spaces or other shell-sensitive characters still get
a stable target directory.

This keeps concurrent `cargo`, `just check`, and `just ci` runs from different
worktrees from overwriting one another. Stale target directories can be removed
when no shell or build is using them, for example:

```sh
find /scratch/cache/itotori -maxdepth 1 -type d -name 'target-*' -mtime +14 -prune -exec rm -rf {} +
```
