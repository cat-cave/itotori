# Install & Fresh-Clone Setup

This is the tested path from a fresh clone to a green public-fixture demo. It
requires **no game bytes and no credentials** — everything here runs against the
committed public fixtures only.

## 0. Install the itotori package (non-clone users)

If you are **not** developing itotori and do not want the nix/pnpm dev monorepo,
install the self-contained CLI package instead. It ships one `bin` entry —
`itotori` — with the CLI and all its workspace dependencies bundled into a single
file, so it runs without the monorepo's `node_modules`.

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

The installed bin dispatches the full CLI surface (`itotori --version`,
`itotori localize`, `itotori db-migrate`, …). The native runtime dependencies the
pipeline drives — the kaifuu/utsushi Rust bins, Postgres, Chromium — are **not**
bundled (they are third-party runtime tooling); provision them via the
deterministic path in
[`native-deps-provisioning.md`](native-deps-provisioning.md), then run
`itotori db-migrate` (needs `DATABASE_URL`) before a live `itotori localize`.

The rest of this document is the **developer / fresh-clone** path via Nix.

## 1. Prerequisites

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

This section is the **developer / fresh-clone** path via Nix. An **installed**
itotori on a machine **without** the nix devshell obtains its native deps
(kaifuu/utsushi Rust bins, Node, Postgres, Chromium) through the deterministic
provisioning path in
[`native-deps-provisioning.md`](native-deps-provisioning.md). Run `just doctor`
to verify every native dep resolves + runs — it fails loud with a per-dep
fix-it — and `just provision-native-deps` to obtain the missing ones.

## 2. Install dependencies

```sh
just install        # pnpm install (workspace)
```

## 3. Run the public-fixture demo (no secrets, no real bytes)

```sh
just alpha-demo
```

This runs the deterministic public-fixture alpha vertical and its independent
linkage validator. It is the fastest end-to-end proof that a fresh clone is
working. See [`alpha-readiness.md`](alpha-readiness.md) §2 and
[`alpha-proof.md`](alpha-proof.md).

To inspect the real-project pipeline plan without a game or an LLM (select an
alpha target-data record with `--project <alpha-target>`; the committed
allowlisted target record is listed in
[`fixtures-and-corpora.md`](fixtures-and-corpora.md#title-reference-allowlist-for-active-docs)):

```sh
just localize-project --dry-run --project <alpha-target>
```

## 4. Run the readiness checklist

```sh
just alpha-readiness-checklist
```

Validates that the readiness docs match the generated capability + benchmark
artifacts, that the evidence node references resolve, and that the
patched-output runtime proof is grounded.

## 5. Full gates

- `just check` — the fast gate: lint, typecheck, unit tests, spec-DAG
  validation, capability-matrix drift check, and the readiness checklist. No DB
  required.
- `just ci` — the complete gate: `check` + build + DB migrations + full TS/Rust
  test suites + the real-bytes lane. Spins up and tears down a worktree-scoped
  Postgres stack (`just db-up` / `just db-down`). The real-bytes lane reads
  staged corpora **read-only** and is skipped unless the corpus roots are staged
  (it never copies copyrighted bytes).

## 6. Live runs (opt-in only — see security docs first)

Live localization runs need explicit corpus + credential environment and are
**never** the default. Requirements, ZDR posture, and the copyright boundary are
documented in [`security-and-limitations.md`](security-and-limitations.md) and
the `just localize-project` recipe header. In short: a live run requires a real
corpus root, an exported `OPENROUTER_API_KEY`, and the account-wide ZDR
assertion `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`; without them the driver fails
loudly rather than downgrading to a recorded provider.
