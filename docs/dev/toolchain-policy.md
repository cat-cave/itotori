# Toolchain Policy

Itotori uses current toolchains deliberately. We do not target LTS by default; we
target the latest stable versions that make the suite faster, stricter, and more
maintainable. Version movement is expected, but it must be explicit, reviewed,
and proven by CI.

## Authorities

| Surface               | Authority                                 | Notes                                                                            |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Node runtime          | `.node-version`                           | CI and local shells should use this exact version.                               |
| pnpm runtime          | `packageManager` in `package.json`        | Corepack reads this exact package manager version.                               |
| TypeScript/web tools  | root `package.json` and `pnpm-lock.yaml`  | Vite+ is the high-level TypeScript/web command surface.                          |
| Rust runtime          | `rust-toolchain.toml`                     | Cargo remains the build, test, clippy, and dependency authority for Rust crates. |
| CI behavior           | `.github/workflows/ci.yml` and `justfile` | CI must call the same root recipes developers use locally.                       |
| Dependency lock state | `pnpm-lock.yaml` and `Cargo.lock`         | Lockfiles are committed and reviewed.                                            |

Vite+ manages the TypeScript/web workspace and task graph. It does not replace
Cargo, Cargo.lock, rustup, or Rust's dependency model. Root `just` recipes are the
suite-level interface that call the native tool for each ecosystem.

## Local Setup

Use Corepack and the committed package manager field:

```sh
corepack enable
pnpm install
```

Use rustup for the committed Rust toolchain:

```sh
rustup toolchain install
```

The normal local gate is:

```sh
just check
```

The full integration gate is:

```sh
just ci
```

## Upgrade Policy

`just upgrade` is the canonical upgrade entry point. It should:

1. Enable Corepack.
2. Run `node scripts/update-node-version.mjs` to move `.node-version` and
   `package.json` `engines.node` to the latest stable Node release from the
   Node distribution index.
3. Move pnpm to the latest stable version and update `packageManager`.
4. Run `node scripts/sync-pnpm-engine.mjs` so `package.json`
   `engines.pnpm` matches the new `packageManager` minimum.
5. Upgrade TypeScript/web dependencies to latest compatible releases.
6. Update the stable Rust toolchain.
7. Refresh Cargo dependencies.
8. Run the toolchain policy verifier.
9. Finish with `just ci` before an upgrade PR is considered mergeable.

Upgrade commits must be isolated from feature work unless the feature cannot be
tested without the upgrade. Lockfile churn is acceptable only when it is caused
by the explicit upgrade command or by adding/removing dependencies needed by the
spec.

## CI Repair Path

When an upgrade breaks CI:

1. Identify whether the failure is TypeScript/web, Rust, database, or roadmap
   validation.
2. Reproduce the failing `just` recipe locally.
3. Prefer fixing source, tests, or config over pinning back.
4. Pin back only when the latest release has a confirmed upstream bug or breaks a
   required dependency contract.
5. Record the reason in the PR body and add a DAG node if the pin creates follow-up
   work.

## Lockfile Rules

- `pnpm-lock.yaml` and `Cargo.lock` are committed.
- CI uses `pnpm install --frozen-lockfile`.
- `cargo update` belongs in upgrade work, not unrelated specs.
- `node_modules`, Cargo `target`, Vite output, and local fixture corpora stay
  uncommitted.
- Generated files must either be checked in with a verifier that proves they are
  current, or regenerated during the relevant build/test command.

## Verification

The deterministic verifier is:

```sh
node scripts/verify-toolchain-policy.mjs
```

The verifier is read-only and network-free, so the normal local gate remains
network-free after dependencies have been installed:

```sh
just check
```

`just upgrade` also calls:

```sh
node scripts/update-node-version.mjs
node scripts/sync-pnpm-engine.mjs
```

The Node update script is the only canonical policy command that asks the Node
distribution index for release data. It selects the highest normal `x.y.z` Node
release, updates `.node-version`, and keeps `package.json` `engines.node`
aligned as the same minimum version. The pnpm sync command is network-free: it
reads the Corepack-updated `packageManager` pin and writes the matching
`engines.pnpm` minimum. The verifier checks that the committed policy
authorities agree on the basics: exact Node and pnpm pins, CI using
`.node-version` and frozen pnpm installs, Rust tooling with rustfmt and clippy,
committed lockfiles, and root `just` recipes that call both Vite+/pnpm and
Cargo.
