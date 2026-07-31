# Install

There are two install paths. Most users — anyone who wants to **localize a
game** — use the [user install](#user-install-the-package) (one self-contained
package, no clone, no Nix/pnpm). The
[developer / fresh-clone path](#developer-fresh-clone-setup) below it is for
people changing itotori itself.

> Start at the repo [README](../README.md) for the observed user flow:
> install → `itotori init` → extract → structure-export → production localize
> → Studio **Produce patched build**. This document is the detailed install
> reference; the RealLive runbook names the credential and byte-proof steps.

## User install (the package)

Install the self-contained CLI package. It ships one `bin` entry — `itotori`
— with the CLI and all its workspace dependencies bundled into a single file,
so it runs **without** the monorepo's `node_modules` or the nix devshell.

```sh
npm install -g itotori            # from the registry (when published)
itotori --version                 # itotori <ITOTORI_PRODUCT_VERSION>
```

or from a clone (produces a tarball you can install anywhere):

```sh
just dev package-pack         # packages/itotori-cli/itotori-<version>.tgz
npm install -g packages/itotori-cli/itotori-<version>.tgz
```

The package version equals `ITOTORI_PRODUCT_VERSION`
([`product-version.ts`](../packages/localization-bridge-schema/src/product-version.ts));
a build-time check and a `just check` test assert they never drift. The bundle's
sole host requirement is a Node runtime matching the `.node-version` pin (a
`>=24.14` major).

### Set up with `itotori init`

```sh
itotori init                      # guided application and deployment setup
itotori db-migrate                # apply the DB schema migrations
```

`itotori init` writes `~/.config/itotori/config.env` (mode `0600`) and walks you
through application configuration and the database footprint. Deployment
inputs are limited to the environment registry; application choices do not
become environment variables. Secrets are never printed or logged. Every live
request carries the ZDR routing posture; see
[security-and-limitations.md](security-and-limitations.md).

### Native runtime dependencies (not bundled)

The installed bin dispatches the full CLI surface, but the native runtime
dependencies the pipeline drives — the kaifuu/utsushi Rust bins, Postgres, and
Chromium — are **not** bundled (they are third-party runtime tooling). Provision
them via the deterministic path in
[`native-deps-provisioning.md`](native-deps-provisioning.md), then run
`itotori db-migrate` before a live `itotori localize`.

| Dep                        | Provisioned via                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| kaifuu / utsushi Rust bins | Installed release artifacts or a local release build, selected through application setup. |
| Postgres                   | A database configured through the application setup.                                      |
| Chromium (render/e2e)      | Installed browser selected through application setup.                                     |

The current `just doctor <profile>` delegate has a dispatcher/parser mismatch
and exits before performing its check; see the provisioning document. Do not
use it as evidence until that behavior is repaired. An installed machine
follows the provisioning document above.

## Developer / fresh-clone setup

The rest of this document is the **developer** path: from a fresh clone to a
green public-fixture demo via Nix + direnv + pnpm + `just`. It requires **no
game bytes and no credentials** — everything here runs against the committed
public fixtures only.

### Prerequisites

The repo pins its toolchain through Nix + direnv so a fresh clone gets the exact
Rust and Node versions the CI uses.

- **Nix** with flakes enabled (provides the dev shell via `flake.nix`).
- **direnv** (loads the flake dev shell; `.envrc` is `use flake`). Run
  `direnv allow` once in the repo root.
- **just** (task runner; the root `justfile` orchestrates TS + Rust).
- **pnpm** (the Node package manager; version is pinned via `package.json`
  `packageManager` + `.node-version`).

Inside the dev shell the toolchain is fixed: Rust (`rust-toolchain.toml`) and
Node (`.node-version`). You do **not** need a system-wide Rust/Node install if
you use the flake. Toolchain-bump policy lives in
[`docs/dev/toolchain-policy.md`](dev/toolchain-policy.md).

If you are not using direnv, prefix commands with `nix develop -c` (or
`direnv exec .`) so they run inside the dev shell.

### Install dependencies

```sh
just dev install        # pnpm install (workspace)
```

### Run the public-fixture demo (no secrets, no real bytes)

```sh
just test alpha
```

This runs the deterministic public-fixture alpha vertical and its independent
linkage validator. It is the fastest end-to-end proof that a fresh clone is
working. See [`alpha-readiness.md`](alpha-readiness.md) §2 and
[`alpha-proof.md`](alpha-proof.md).

The repository's public-fixture demo is the supported full proof in this
checkout. A real-corpus run additionally needs the encrypted-state and
live-provider prerequisites. Its completed final accepted outputs are patched
through Studio's production **Produce patched build** action; the redacted
localize summary is not patch input.

### Run the readiness checklist

```sh
just test alpha
```

This is the supported readiness proof command. It reruns the deterministic
public-fixture vertical and its independent cross-artifact linkage validator;
`just check meta` separately enforces generated capability-matrix drift and the
repository's structural guards.

### Full gates

- `just check` — metadata and policy guards, generated-artifact checks,
  TypeScript formatting/typecheck, and Rust format/check/clippy/dependency
  checks. No DB is required.
- `just ci` — the public integration sequence: `check`, build, DB migration,
  public TypeScript and Rust tests, and mutation differential. Start the
  worktree-scoped Postgres stack first with `just dev db-up`; this command does
  not claim browser or private-byte evidence.

### Live runs (opt-in only — see security docs first)

Live localization runs need explicit corpus and configured credentials and are
**never** the default. Requirements, ZDR posture, and the copyright boundary are
documented in [`security-and-limitations.md`](security-and-limitations.md). In
short: a live `itotori localize --run-mode production` run requires a real corpus
root and approved deployment inputs; every provider request carries the
required ZDR routing posture.
