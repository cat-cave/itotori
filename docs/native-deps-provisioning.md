# Native-deps provisioning (installed, non-nix itotori)

`itotori-native-deps-provisioning` — the M2 crux. An **installed** (non-clone,
no nix devshell) itotori must still obtain and run the native dependencies that
today are provided **only** by `flake.nix`:

| Dep                       | What it is                                                                        | Wired via (existing seam)                                       |
| ------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **kaifuu / utsushi bins** | The Rust decode/patch (`kaifuu-cli`) + render/conformance (`utsushi-cli`) drivers | invoked by the pipeline (`just hello`, frame-capture ingestion) |
| **Node**                  | The itotori CLI + `@itotori/db` host runtime                                      | `.node-version` pin                                             |
| **Postgres**              | The `@itotori/db` real-Postgres store                                             | `DATABASE_URL` / `docker-compose.yml`                           |
| **Chromium**              | Render + MV/MZ real-browser gates                                                 | `PLAYWRIGHT_CHROMIUM_BIN` / `UTSUSHI_BROWSER_BIN`               |

The devshell (`flake.nix`) is the **developer** provisioning path and stays
authoritative for a clone. This document defines the **non-nix** provisioning
story and its boundary, and is implemented by `scripts/native-deps.mjs`
(`just doctor` / `just provision-native-deps`).

## Design principles

- **Deterministic** — every dep is pinned (a build from `rust-toolchain.toml` +
  `Cargo.lock`, a Chromium pinned by the Playwright version in `pnpm-lock.yaml`,
  Postgres pinned to major 18, Node pinned by `.node-version`). No floating
  "latest".
- **Self-hostable** — every dep can be provisioned on the operator's own machine
  with no itotori-hosted service. For each of Postgres and Chromium the operator
  may instead point at a binary they already manage (air-gap / bring-your-own).
- **Privacy / ZDR-preserving** — see [Boundary](#the-boundary--why-it-is-privacyzdr-safe).
- **No-vendored-code boundary respected** — see the same section.

## Per-dep provisioning approach

### Resolution seam (shared by the doctor and the runtime)

The doctor resolves each binary in a fixed order and **reuses the env vars the
existing pipeline already reads**, so the preflight and the real runtime never
disagree about which binary is authoritative.

### kaifuu / utsushi Rust bins — **build + ship pinned binaries**

Resolution order (`rustBinCandidates`), first hit wins:

1. `ITOTORI_KAIFUU_BIN` / `ITOTORI_UTSUSHI_BIN` — explicit operator/artifact pin.
2. `ITOTORI_LIBEXEC_DIR/<bin>` — **the primary installed path**: per-platform
   prebuilt bins shipped inside the artifact.
3. `CARGO_TARGET_DIR/{release,debug}/<bin>` — dev shell / worktree builds.
4. `<repo>/target/{release,debug}/<bin>` — a plain `cargo build` checkout.
5. `<bin>` on `PATH` — operator-placed or `cargo install`.

**Chosen approach:** ship **pinned prebuilt binaries** (built once per target from
the pinned `rust-toolchain.toml` + `Cargo.lock`) in the artifact's `libexec/`,
resolved via `ITOTORI_LIBEXEC_DIR`. Rationale over the alternatives: `cargo
install` would require a full Rust toolchain on every install machine (heavy,
non-deterministic across compiler versions); a from-source build on install is
the same cost. A prebuilt bin is deterministic (same inputs → same binary),
small, and needs no toolchain on the target. The build-from-source path (4) is
kept as the developer/self-host fallback for platforms we do not prebuild.

The doctor proves each bin **runs** (not merely exists): it executes the binary
and treats a spawn error — `ENOENT` (missing loader / wrong path) or `ENOEXEC`
(wrong arch / corrupt) — as the failure, which is exactly what a mis-provisioned
or wrong-platform binary produces. A usage banner with a non-zero exit still
counts as runnable.

### Node — **required host runtime**

Node is the runtime the itotori CLI + `@itotori/db` run on. The doctor checks
`process.version` satisfies the `.node-version` major (a newer patch/minor of the
same major is accepted; a different major is not). Node is **required** on the
host (installed via the artifact's declared `engines.node`, or a future
self-contained SEA/`node --experimental-sea` bundle — out of scope here).

### Postgres — **system | container | portable**

`postgresPlan` selects a mode from the environment:

1. **`explicit`** — `DATABASE_URL` set (a system / operator-managed Postgres 18).
   The doctor does a live TCP reachability check on the host:port.
2. **`portable`** — `ITOTORI_POSTGRES_BIN_DIR` points at an unpacked **pinned
   portable Postgres 18** bin dir (`postgres` + `pg_ctl`). Deterministic
   (pinned version + checksum), zero external services, fully self-hostable.
3. **`container`** — a `docker`/`podman` runtime is present → `just db-up` starts
   `postgres:18` via the committed `docker-compose.yml` (today's dev path); the
   derived per-worktree `DATABASE_URL` comes from
   `scripts/itotori-db-compose-env.mjs --print-database-url`.

**Chosen default order:** honor an explicit `DATABASE_URL` first (operator
control), then a portable bundle (most self-contained for a non-dev machine),
then a container runtime. An embedded/in-process store was rejected: the schema
is real Postgres (49 migrations using Postgres features), so a lighter embedded
store would fork the schema — a **portable Postgres** keeps one schema while
staying installable. The doctor never passes on an unreachable DB; it prints the
exact start command.

### Chromium — **reuse the Playwright pin**

Resolution order (`chromiumCandidates`), first hit wins:

1. `ITOTORI_CHROMIUM_BIN` — explicit override.
2. `UTSUSHI_BROWSER_BIN` — the var the Rust MV/MZ gates + the nix shell already set.
3. `PLAYWRIGHT_CHROMIUM_BIN` — the var the runtime-web Playwright config reads.
4. Playwright's own download cache (`~/.cache/ms-playwright/chromium-*/chrome-linux/chrome`).
5. A chromium-family binary on `PATH` (`chromium`, `chromium-browser`,
   `google-chrome`, …) — mirrors the Rust `UTSUSHI_BROWSER_BIN` PATH fallback.

**Chosen approach:** on a **non-nix glibc** machine, `pnpm exec playwright
install chromium` downloads the Chromium **pinned by the Playwright version in
`pnpm-lock.yaml`** — deterministic and already the project's browser authority.
On **NixOS** that downloaded Chromium cannot run (dynamic linking), so the nix
devshell Chromium (pinned by `flake.lock`) remains authoritative there; the
doctor detects a non-runnable binary and says so. The doctor proves Chromium
runs via `chromium --version`.

## The boundary — why it is privacy/ZDR-safe

### Bundled vs required vs downloaded

| Provisioning class                                                                       | Deps                                                                                                                             | Notes                                                                                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Bundled** (shipped in the artifact)                                                    | kaifuu/utsushi prebuilt bins, the compiled TS app, migrations, config                                                            | itotori's **own** code — no third-party vendoring.                                                                           |
| **Required** (must pre-exist on host)                                                    | a Node runtime matching `.node-version`; optionally a system Postgres or a container runtime if the operator prefers those modes | Host-provided; the operator's choice.                                                                                        |
| **Downloaded** (fetched deterministically at provision time, pinned + integrity-checked) | Chromium (Playwright-pinned), portable Postgres 18 (pinned version + sha256)                                                     | Large, platform-specific, third-party. Fetched, **not** source-vendored — mirrors how `flake.nix` fetches a pinned Chromium. |

### ZDR / privacy

All four are **local runtime deps** — a database, a browser for rendering, and
decode/patch/render binaries. **None of them touch the LLM pipeline** and none
send project data anywhere. The account-wide ZDR posture governs the OpenRouter
LLM calls, which are entirely separate and **unaffected** by how a local
Postgres or Chromium is obtained. The only network activity is at **install
time** (pinned, checksum-verified downloads from Playwright's CDN / the official
Postgres binaries); **runtime is fully local/offline**. Self-host / air-gap: an
operator can pre-stage the downloads and use the `explicit` Postgres +
`UTSUSHI_BROWSER_BIN` Chromium modes for a network-free install.

### No-vendored-code-in-the-shipped-pipeline

The project rule forbids vendoring third-party **code** into the shipped
localization pipeline (the bytes decode/patch/translate path). These native deps
are **runtime / dev tooling** — a database engine, a browser, the language
runtime — the same category as the nix packages in the devshell. They are
provisioned as **external pinned binaries** (built, bundled, or fetched), never
source-vendored into the pipeline. This is the identical boundary
[`dependency-policy.md`](dependency-policy.md) and the devshell already draw.

## Doctor / preflight

```sh
just doctor                         # profile: full (all deps)
just doctor --profile core          # localize pipeline: node + rust bins + postgres
just doctor --profile render        # adds Chromium
node scripts/native-deps.mjs doctor --json   # machine-readable
```

The doctor **resolves + runs** each dep and **exits non-zero with a per-dep
fix-it** if any required dep is missing or not runnable (no green-on-skip). It is
dependency-free (Node built-ins only) so it ships verbatim in the artifact and
runs before `pnpm install`. Unit-tested via `scripts/native-deps.test.mjs`
(wired into `just check`) with an injected probe (no real IO).

## Provisioning

```sh
just provision-native-deps --dry-run    # print the pinned plan
just provision-native-deps              # execute the missing steps
```

`provision` runs only the steps for **missing** deps: `cargo build --release -p
kaifuu-cli -p utsushi-cli`, `pnpm exec playwright install chromium`, and/or `just
db-up`. When a toolchain is absent it degrades to a precise manual note rather
than a silent partial.

## Fresh-machine install-to-localize (step-by-step)

On a fresh **non-nix, glibc Linux** machine (Node ≥ `.node-version` present):

1. Obtain the itotori artifact (installable-package node — the sibling M2 task).
   It ships the prebuilt kaifuu/utsushi bins in `libexec/` (`ITOTORI_LIBEXEC_DIR`)
   and the compiled app.
2. `just install` (or the artifact's bundled `node_modules`).
3. Provision the downloaded deps: `just provision-native-deps`
   - Chromium: `pnpm exec playwright install chromium` (Playwright-pinned).
   - Postgres: `just db-up` (container) **or** point `DATABASE_URL` at a system
     Postgres 18 **or** unpack a pinned portable Postgres and set
     `ITOTORI_POSTGRES_BIN_DIR`.
4. Run migrations: `just db-migrate`.
5. Preflight: `just doctor` → must be green (exit 0).
6. Localize (opt-in, needs corpus + ZDR creds per
   [`security-and-limitations.md`](security-and-limitations.md)):
   `just localize-project --project <target>`.

## Out of scope here (later nodes)

- The **installable-package artifact** itself (bin entry, packaging, the
  `libexec/` layout that sets `ITOTORI_LIBEXEC_DIR`) — `itotori-installable-package-artifact`.
- A **truly-fresh-machine `install-to-localize` e2e** (a clean container with no
  toolchain, running the whole chain to a rendered/patched output) — a separate
  later proof. This node proves the **provisioning logic + the doctor + the
  documented steps**, validated by the green doctor smoke above (bins execute,
  Postgres live, Chromium runs).
- A pinned **portable-Postgres download source + checksum** table (the design
  fixes the mode + env seam; wiring an exact download URL/sha is deferred to the
  artifact node so the pin lives next to the other artifact pins).
