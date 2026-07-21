# Itotori

Itotori localizes games. You point it at a game you have the rights to work on,
it extracts the in-game text, drafts localized translations with a configurable
LLM provider, runs quality checks, applies a byte-correct patch to a writable
copy, and validates the patched game by replaying and rendering it. It is an
**agentic games-localization pipeline**, not a translation box: the whole
workflow — **catalog → inventory → extraction → localization → patching →
validation** — runs in one tool.

You do **not** need to clone this repository, install Nix, or use `pnpm` to
localize a game. Those are the developer paths
([Developer setup](#developer-setup-contributing)) and are linked out below.

## What you need before you start

- **A Node runtime** matching the project pin (a `>=24.14` major). This is the
  only host requirement of the installed CLI.
- **An OpenRouter API key** with your account configured for account-wide
  **Zero-Data-Retention (ZDR)**. Itotori fails closed (it will not run a live
  localization) until ZDR is asserted. See
  [docs/security-and-limitations.md](docs/security-and-limitations.md).
- **A game you have the rights to localize**, on a supported engine. The first
  real engine vertical is RealLive; see
  [docs/kaifuu-detection-matrix.md](docs/kaifuu-detection-matrix.md) for the
  supported/unsupported variant matrix.
- **Native runtime dependencies** the CLI drives but does not bundle (the
  kaifuu/utsushi Rust binaries, Postgres, and Chromium for render validation).
  `itotori init` walks you through the database; the rest are provisioned via
  the deterministic path in
  [docs/native-deps-provisioning.md](docs/native-deps-provisioning.md).

## Quickstart: install → localize → review → patched output

### 1. Install itotori

```sh
npm install -g itotori            # from the registry (when published)
itotori --version                 # itotori <version>
```

or from a clone (produces a self-contained tarball you can install anywhere,
no monorepo `node_modules` needed):

```sh
just itotori-package-pack         # packages/itotori-cli/itotori-<version>.tgz
npm install -g packages/itotori-cli/itotori-<version>.tgz
```

`itotori --help` lists the user command surface (`init`, `extract`,
`structure-export`, `wiki`, `localize`, `patch`, `validate`, …); `itotori help
--all` also lists the advanced/internal commands.

### 2. Set up (guided)

```sh
itotori init                      # OpenRouter key + ZDR + database + config file
itotori db-migrate                # apply the database schema (needs DATABASE_URL)
```

`itotori init` writes a config file to `~/.config/itotori/config.env` (mode
`0600`) and tells you exactly what to add to your shell profile. Your API key is
never printed or logged. See [docs/install.md](docs/install.md) for the full
install path and [docs/security-and-limitations.md](docs/security-and-limitations.md)
for the security posture.

### 3. Localize a game

The pipeline is a **multi-command sequence** — each stage is one `itotori`
command that produces the artifact the next stage consumes:

```
extract  →  structure-export  →  wiki build  →  localize  →  patch  →  validate
```

```sh
itotori extract --whole-seen \
  --engine reallive --game-root <read-only-game-root> \
  --game-id <id> --game-version <ver> \
  --source-profile-id <profile> --source-locale ja-JP \
  --bundle-output <run-dir>/bridge.json

itotori structure-export \
  --gameexe <game-root>/REALLIVEDATA/Gameexe.ini \
  --seen     <game-root>/REALLIVEDATA/Seen.txt \
  --bridge   <run-dir>/bridge.json --output <run-dir>/structure.json

itotori wiki build \
  --structure <run-dir>/structure.json --bridge <run-dir>/bridge.json \
  --source-locale ja-JP --run-mode production

itotori localize \
  --run-mode production \
  --structure <run-dir>/structure.json --bridge <run-dir>/bridge.json \
  --output-scope dialogue-only --output <run-dir>/run-summary.json

itotori patch \
  --source <read-only-game-root> --target <writable-output-root> \
  --bundle <run-dir>/run-summary.json --scope dialogue-only

itotori validate \
  --seen <target>/REALLIVEDATA/Seen.txt --scene <N> \
  --gameexe <target>/REALLIVEDATA/Gameexe.ini --game-dir <target>/REALLIVEDATA \
  --replay-log <run-dir>/replay.json \
  --artifact-root <run-dir>/render --render-output <run-dir>/render/report.json
```

Run `itotori --help` for each command's flag list. A live run requires the
OpenRouter key + ZDR assertion configured in step 2; without them itotori fails
loudly rather than downgrading.

For a step-by-step RealLive walkthrough with generic game placeholders, exact
flags, environment variables, and honest signposts, see the
[RealLive localizer runbook](docs/localize-reallive.md).

### 4. Review the results

Each stage writes its artifacts into your run directory: the extracted bridge
bundle, the narrative structure, the drafted translations, and the QA findings.
The validate stage produces a **replay log** and **render evidence**
(screenshots) so you can confirm the patched game actually works. On success
`localize` prints a JSON summary — `runMode`, `outputScope`, `sceneCount`,
`finalizedUnitCount`, `patchId`, `buildLqaVerdictCount`, `attemptCount` —
pointing you at the review surfaces. The Studio dashboard (the React app in
`apps/itotori/`, documented in [docs/frontend.md](docs/frontend.md)) is the
browsable review surface for drafts, QA findings, and runtime evidence.

### 5. Take the patched output

The patched, playable game lands in `patch --target`. Kaifuu can also emit a
`.kaifuu` delta package so the same patch can be re-applied or shipped without
redistributing the game — see
[docs/subprojects-kaifuu.md](docs/subprojects-kaifuu.md) and the format-stability
policy in
[docs/format-stability-and-compatibility-policy.md](docs/format-stability-and-compatibility-policy.md).

## The three subprojects

The suite is three first-class subprojects; you drive them through the single
`itotori` CLI above:

- **Itotori**: catalog/inventory, localization graph, agentic drafting + QA,
  feedback, benchmarks, and dashboard surfaces.
- **Kaifuu**: deterministic game extraction, patching, verification, and
  `.kaifuu` delta packages.
- **Utsushi**: validation runtimes for trace, replay, capture, screenshots, and
  runtime evidence.

## Project layout

```txt
apps/
  itotori/                 # TypeScript CLI + React SPA (the Studio dashboard)
  runtime-web-review/      # Runtime evidence dashboard
packages/
  itotori-cli/             # the installable, self-contained itotori bin
  localization-bridge-schema/
  itotori-db/
  itotori-ds/              # Dusk Observatory design system (React + CSS tokens)
crates/
  kaifuu-*/                # extraction / patching / delta
  utsushi-*/               # runtime validation
docs/                      # user-facing docs (you are reading the entry point)
  dev/                     # contributor / developer docs (see CONTRIBUTING.md)
```

## Status

Itotori is at the **alpha readiness** milestone: ready to _start_ a first real
localization project, with the whole pipeline proven end-to-end on public
fixtures and a real-engine vertical. It is not a terminal product release; beta
(≥2 games per engine, encrypted variants, the packaged non-developer install
surface) and full release are later tiers — see
[docs/project-readiness.md](docs/project-readiness.md) and
[docs/alpha-readiness.md](docs/alpha-readiness.md). The public-fixture proof and
its manifest contract are documented in [docs/alpha-proof.md](docs/alpha-proof.md).

The public formats a localization depends on (the bridge schema, the `.kaifuu`
delta, the API contract, the DB schema) each declare a stability tier + version
under the backward-compatibility policy in
[docs/format-stability-and-compatibility-policy.md](docs/format-stability-and-compatibility-policy.md)
and [docs/versioning-and-release-policy.md](docs/versioning-and-release-policy.md).

Readiness is enforced, not asserted: the readiness checklists re-derive their
claims from the generated artifacts so the docs cannot drift.

## Developer setup (contributing)

The paths above are the **user** path. If you are going to **change itotori**
itself — the Nix + direnv + pnpm dev toolchain, the `just`-orchestrated gates,
the qd DAG workflow, worktree lifecycle, internal architecture, testing
standard, CI policy — start at [CONTRIBUTING.md](CONTRIBUTING.md), which routes
you into [`docs/dev/`](docs/dev/README.md). The developer fresh-clone path
(`just install`, `just alpha-demo`, `just check` / `just ci`) is documented in
[docs/install.md](docs/install.md) under the developer sections.
