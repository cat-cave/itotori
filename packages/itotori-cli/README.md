# itotori

The installable **itotori** CLI — the localization command surface as a
self-contained bundle.

This package is the publishable artifact produced from the itotori dev monorepo
(`itotori-installable-package-artifact`). It ships one `bin` entry — `itotori`
— whose compiled CLI and workspace dependencies are bundled into a single
`dist/cli.js`, so an installed bin runs **without** the monorepo's `node_modules`
or the nix devshell. See [`docs/install.md`](../../docs/install.md) for the full
install path.

## Install

```sh
npm install -g itotori
```

or with a tarball produced from the repo:

```sh
(cd packages/itotori-cli && npm pack)   # produces itotori-<version>.tgz
npm install -g itotori-<version>.tgz
```

The bundle is self-contained (no runtime npm dependencies); `npm install` only
unpacks the bin. A Node runtime matching the project pin (`.node-version`,
currently a `>=24.14` major) is the sole host requirement.

## Usage

```sh
itotori --version          # itotori <ITOTORI_PRODUCT_VERSION>
itotori -v                 # alias
itotori localize --run-mode production --structure <structure.json> --bridge <bridge.json> --output-scope dialogue-only   # whole-game localize
itotori db-migrate          # apply the DB schema migrations (needs DATABASE_URL)
```

`itotori --version` reports the product semver
([`ITOTORI_PRODUCT_VERSION`](../localization-bridge-schema/src/product-version.ts))
— the single source of truth for the publishable surface.

### Native runtime dependencies

The CLI dispatches the decode/patch/render pipeline against native binaries and
a database that are **not** bundled here (they are third-party runtime tooling,
provisioned separately — see
[`docs/native-deps-provisioning.md`](../../docs/native-deps-provisioning.md)):

| Dep                        | Provisioned via                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| kaifuu / utsushi Rust bins | `ITOTORI_LIBEXEC_DIR` (shipped prebuilt) or a `cargo build --release`                       |
| Postgres                   | `DATABASE_URL` (system / container `just db-up` / portable `ITOTORI_POSTGRES_BIN_DIR`)      |
| Chromium (render/e2e)      | `UTSUSHI_BROWSER_BIN` / `PLAYWRIGHT_CHROMIUM_BIN` / `pnpm exec playwright install chromium` |

Run `just doctor` (from a clone) to preflight every native dep; an installed
machine follows the deterministic provisioning path in
[`docs/native-deps-provisioning.md`](../../docs/native-deps-provisioning.md).

A live `itotori localize` run additionally requires an exported `OPENROUTER_API_KEY`
and the account-wide ZDR assertion `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1` (see
[`docs/security-and-limitations.md`](../../docs/security-and-limitations.md)).

## Versioning

This package's `version` equals `ITOTORI_PRODUCT_VERSION`. A build-time check
(`packages/itotori-cli/build.mjs`) and a `just check` test assert they never
drift. See [`docs/versioning-and-release-policy.md`](../../docs/versioning-and-release-policy.md).
