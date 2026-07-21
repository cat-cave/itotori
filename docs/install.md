# Install

There are two install paths. Most users — anyone who wants to **localize a
game** — use the [user install](#user-install-the-package) (one self-contained
package, no clone, no Nix/pnpm). The
[developer / fresh-clone path](#developer-fresh-clone-setup) below it is for
people changing itotori itself.

> Start at the repo [README](../README.md) for the end-to-end user quickstart
> (install → `itotori init` → the multi-command localize flow:
> `extract` → `structure-export` → `wiki build` → `localize` → `patch` →
> `validate` → patched output). This document is the detailed install reference
> behind that quickstart.

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
just itotori-package-pack         # packages/itotori-cli/itotori-<version>.tgz
npm install -g packages/itotori-cli/itotori-<version>.tgz
```

The package version equals `ITOTORI_PRODUCT_VERSION`
([`product-version.ts`](../packages/localization-bridge-schema/src/product-version.ts));
a build-time check and a `just check` test assert they never drift. The bundle's
sole host requirement is a Node runtime matching the `.node-version` pin (a
`>=24.14` major).

### Set up with `itotori init`

```sh
itotori init                      # guided: OpenRouter key + ZDR + database + config
itotori db-migrate                # apply the DB schema migrations (needs DATABASE_URL)
```

`itotori init` writes `~/.config/itotori/config.env` (mode `0600`) and walks you
through the OpenRouter key, the account-wide ZDR assertion, and the database
footprint. Your API key is never printed or logged. A live localization
additionally requires the ZDR assertion `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`;
see [security-and-limitations.md](security-and-limitations.md).

### Native runtime dependencies (not bundled)

The installed bin dispatches the full CLI surface, but the native runtime
dependencies the pipeline drives — the kaifuu/utsushi Rust bins, Postgres, and
Chromium — are **not** bundled (they are third-party runtime tooling). Provision
them via the deterministic path in
[`native-deps-provisioning.md`](native-deps-provisioning.md), then run
`itotori db-migrate` (needs `DATABASE_URL`) before a live `itotori localize`.

| Dep                        | Provisioned via                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| kaifuu / utsushi Rust bins | `ITOTORI_LIBEXEC_DIR` (shipped prebuilt) or a `cargo build --release`                       |
| Postgres                   | `DATABASE_URL` (system / container / portable `ITOTORI_POSTGRES_BIN_DIR`)                   |
| Chromium (render/e2e)      | `UTSUSHI_BROWSER_BIN` / `PLAYWRIGHT_CHROMIUM_BIN` / `pnpm exec playwright install chromium` |

From a clone, `just doctor` verifies every native dep resolves + runs (it fails
loud with a per-dep fix-it) and `just provision-native-deps` obtains the
missing ones; an installed machine follows the provisioning doc above.

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
just install        # pnpm install (workspace)
```

### Run the public-fixture demo (no secrets, no real bytes)

```sh
just alpha-demo
```

This runs the deterministic public-fixture alpha vertical and its independent
linkage validator. It is the fastest end-to-end proof that a fresh clone is
working. See [`alpha-readiness.md`](alpha-readiness.md) §2 and
[`alpha-proof.md`](alpha-proof.md).

After the preceding extract, structure-export, and wiki-build stages have
produced their artifacts, invoke the localizer with an explicit run mode:

```sh
itotori localize \
  --run-mode test-dev \
  --structure <run-dir>/structure.json \
  --bridge <run-dir>/bridge.json \
  --output-scope dialogue-only \
  --output <run-dir>/run-summary.json
```

### Run the readiness checklist

```sh
just alpha-readiness-checklist
```

Validates that the readiness docs match the generated capability + benchmark
artifacts, that the evidence node references resolve, and that the
patched-output runtime proof is grounded.

### Full gates

- `just check` — the fast gate: lint, typecheck, unit tests, spec-DAG
  validation, capability-matrix drift check, and the readiness checklist. No DB
  required.
- `just ci` — the complete gate: `check` + build + DB migrations + full TS/Rust
  test suites + the real-bytes lane. Spins up and tears down a worktree-scoped
  Postgres stack (`just db-up` / `just db-down`). The real-bytes lane reads
  staged corpora **read-only** and is skipped unless the corpus roots are staged
  (it never copies copyrighted bytes).

### Live runs (opt-in only — see security docs first)

Live localization runs need explicit corpus + credential environment and are
**never** the default. Requirements, ZDR posture, and the copyright boundary are
documented in [`security-and-limitations.md`](security-and-limitations.md). In
short: a live `itotori localize --run-mode production` run requires a real corpus
root, an exported `OPENROUTER_API_KEY`, and the account-wide ZDR assertion
`OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`; without them the command fails loudly.
