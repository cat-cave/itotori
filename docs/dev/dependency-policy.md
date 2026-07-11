# Dependency policy (supply-chain strictness)

itotori enforces its Cargo dependency posture with [`cargo-deny`](https://embarkstudios.github.io/cargo-deny/)
via `deny.toml`. This document records the `[bans]` strictness introduced by
KAIFUU-208 and how to keep the workspace green under it.

## Strict bans

`deny.toml` pins two supply-chain guards to `"deny"` (never `"warn"`/`"allow"`):

- `bans.multiple-versions = "deny"` — the dependency graph may resolve only a
  single version of each crate, except for the explicitly documented skips
  below. This keeps the tree from silently accumulating duplicate transitive
  versions (larger builds, split feature unification, ambiguous audits).
- `bans.wildcards = "deny"` — no dependency may use an open `version = "*"`
  requirement.
  - `bans.allow-wildcard-paths = true` exempts ONLY the version-less internal
    workspace `path` deps (e.g. `kaifuu-core = { path = "../kaifuu-core" }`),
    which `cargo-deny` reports as wildcards. The ban stays fully active for any
    real external `*` requirement.

`cargo deny check bans` must exit 0 on `main`. Both settings, plus the
`# reason:` documentation on every skip, are guarded by
`scripts/verify-deny-strict.mjs` (wired into `just check`).

## Accepted duplicate-version skips

Each accepted duplicate is a narrow, exact-version `[[bans.skip]]` — NOT a
blanket relaxation — and carries a `# reason:` comment on the line immediately
above its `[[bans.skip]]` header. The current skips are transitive,
upstream-pinned duplicates that cannot be aligned from itotori's own manifests:

| crate       | skipped version | why it is accepted                                                                                                                                                                                                                         |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getrandom` | `=0.2.17`       | Pulled only by `redox_users` (a Redox-OS-target-only transitive dep of `dirs` -> `dirs-sys`); never builds on our Linux/macOS targets. The live graph otherwise resolves a single `getrandom` 0.4 via `uuid`. No upstream dedup available. |
| `getrandom` | `=0.3.4`        | Pinned by `jsonschema` 0.46 -> `ahash`, while `uuid` and `tempfile` resolve `getrandom` 0.4.3. The third-party requirements cannot be aligned from itotori's manifests.                                                                    |
| `hashbrown` | `=0.16.1`       | Pinned by `jsonschema` 0.46 -> `referencing`; `rusqlite` 0.40 -> `hashlink` pulls `hashbrown` 0.17. Neither is bumpable without an upstream release aligning the two.                                                                      |
| `r-efi`     | `=5.3.0`        | Pinned by `getrandom` 0.3.4 through `jsonschema` 0.46, while `uuid`'s `getrandom` 0.4.3 pins `r-efi` 6.0.0. Both are EFI-target-only transitive requirements with no aligned upstream release.                                             |

## Rules of the road

- Do NOT add a new dependency solely to dedup a version. Allowlist the genuine
  transitive duplicate with a narrow `[[bans.skip]]` + `# reason:` instead.
- Prefer aligning versions from itotori's own manifests when possible; only skip
  duplicates that originate in third-party crates' own version requirements.
- When a skip becomes unnecessary (upstream aligned the versions), remove the
  `[[bans.skip]]` and its `# reason:` line; `cargo deny check bans` will confirm
  the graph is still single-version.
- Never relax `multiple-versions` or `wildcards` back to `"warn"`/`"allow"`.
  `scripts/verify-deny-strict.mjs` fails the `check` gate if you do.

## Verifying locally

```sh
direnv exec . cargo deny check bans      # must exit 0
direnv exec . node scripts/verify-deny-strict.mjs
grep -E '^(multiple-versions|wildcards) = "deny"' deny.toml   # both lines
```
