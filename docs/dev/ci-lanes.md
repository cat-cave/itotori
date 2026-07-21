# CI Lanes

Itotori's CI is split into two lanes with different determinism, cost, and
provisioning contracts. This document is the canonical map of **which tests run
where and why**. See also `testing-standard.md` (test-shape rules) and
`docs/real-bytes-periodic-oracle.md` (the real-bytes ground-truth anchor).

## Why two lanes

The fast per-gate lane must be **deterministic, offline, copyright-free, and
fast** so every commit gate can run it on every push (~86s, no real corpora, no
browser, no live providers). The heavy proofs — parsing whole real games and
driving a real browser — are legitimately slow and/or need host resources
(staged corpora, a runnable Chromium). Folding them into the per-gate gate would
make every commit pay for a ~30-45min run. So they live in a separate
**periodic/strict** lane, invoked on a schedule and on demand, never on the
per-gate path.

Nothing is permanently skipped: the strict lane is a named, CI-scheduled recipe,
and both lanes fail LOUD rather than passing on a skipped/absent prerequisite.

## Lane 1 — per-gate (fast, deterministic)

**Entry points:** `just ci` / `just ci-full` / `node scripts/qd-full-ci.mjs`
(affected-aware; `--all` forces the complete gate). `just check` is the fast
sub-gate. GitHub: `.github/workflows/pr-tiers.yml` → `_tier0.yml` / `_tier1.yml`.

**Contract:** single-mode SYNTHETIC — fast, offline, copyright-free, no real
corpora, **no browser**, no live providers. Deterministic.

**What runs here:**

| Suite                                       | Where it runs                                                                                                                       | Seam               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Synthetic fixtures + unit suites            | `just test` → `vp run ts:test` (all TS packages) + `cargo test`                                                                     | many               |
| `mutation-differential` guardrail           | `just ci` (proves synthetic ⊇ real regression-detection power)                                                                      | differential       |
| **Real-HTTP `/api` contract tests**         | `apps/itotori/test/api-http-contract.test.ts` (fetch, code-agnostic) via `pnpm --filter @itotori/app test` (ci-itotori + `ts:test`) | real-http          |
| **OpenAPI drift test**                      | `apps/itotori/test/openapi-contract.test.ts` (emitted OpenAPI vs guards) via the same app vitest lane                               | real-http/internal |
| **jsdom UI unit lane**                      | `apps/runtime-web-review/test/**/*.spec.ts` via `pnpm --filter @itotori/runtime-web-review test` (ci-utsushi + `ts:test`)           | dom                |
| DB repository / catalog / style-guide gates | `ci-itotori` against a disposable Postgres                                                                                          | real-db            |

The HTTP contract + OpenAPI drift + jsdom suites are ordinary Vitest tests, so
they are already inside `vp run ts:test` (and the per-family `ci-itotori` /
`ci-utsushi` gates). They stay in the fast lane precisely because they are fast
and deterministic: `fetch` against an in-process server and a jsdom DOM need no
real browser.

**Not here:** the ~30-45min real-bytes suites and the real-browser Playwright
e2e (below). The per-gate lane never launches a browser, so it stays fast.

## Lane 2 — periodic/strict (browser + real bytes)

**Entry point:** `just periodic-strict` — runs `browser-e2e` then
`real-bytes-oracle`. The sub-lanes are also individually named:
`just browser-e2e` and `just real-bytes-oracle` (+ `just real-bytes-oracle-drift`
for the corpora-free drift slice). GitHub: `.github/workflows/real-bytes-oracle.yml`
(nightly cron + `workflow_dispatch`).

**Contract:** deliberately OUTSIDE per-gate CI / qd-full-ci — a per-gate green
never pays for or waits on it. Each sub-lane fails LOUD on a missing
prerequisite; a strict proof lane may not go green-on-skip.

**What runs here:**

- **`browser-e2e`** — the runtime-web review Playwright e2e
  (`apps/runtime-web-review/e2e/*.e2e.ts`, 5 tests) in a REAL Chromium. Drives
  the shipping review UI (scene embed, branch-explorer filter/pagination,
  input-bridge gestures) over the app's own committed fixtures — no game bytes,
  no live game, no live server.
- **`real-bytes-oracle`** — the strict-proof ground-truth anchor: re-runs the
  full real-bytes suite (`ci-real-bytes`) against the staged corpora + the
  synthetic-vs-real drift check. The staged corpora span six engine/source
  families: RealLive (Sweetie HD + Kanon), RPG Maker MV/MZ (LustMemory +
  Countryside Life), vault source (live read-only vault), Siglus
  (vault-materialized Karetoshi + Gamekoi), and Softpal ADV (Kizuna +
  Dimension under the standalone `/scratch/softpal-research` tree). The Softpal
  sub-lane is the one exception to the missing-corpus hard-fail policy:
  skip-when-absent is legitimate for that family (the Softpal corpus lives
  under its own root, separate from the RealLive/RPG-Maker/vault tree), so a
  runner that has the other corpora but not the Softpal tree still runs the
  strict ground-truth suite for the five other families. See
  `docs/real-bytes-periodic-oracle.md`.

### The browser binary (nix-Chromium)

Playwright's own downloaded Chromium is dynamically linked against libraries
absent on NixOS and cannot run here. The nix devShell (`flake.nix`) provides a
runnable `pkgs.chromium` and exports its store path as `PLAYWRIGHT_CHROMIUM_BIN`
(and `UTSUSHI_BROWSER_BIN`, shared with the Rust MV/MZ browser gates), with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so nothing is ever downloaded.
`apps/runtime-web-review/e2e/playwright.config.ts` launches THAT binary via
`executablePath` and the browser is pinned by `flake.lock`.

- **Locally:** enter the dev shell (`direnv` / `nix develop`) and run
  `just browser-e2e`. Outside the dev shell, export `PLAYWRIGHT_CHROMIUM_BIN`
  to a runnable Chromium (>= 149, matching Playwright 1.60).
- **In CI:** the browser lane runs on the self-hosted `itotori-corpora` runner
  (the same host that stages the real corpora and provides nix) via
  `nix develop --command just browser-e2e`, so the exact pinned nix-Chromium is
  used. See the `browser-e2e` job in `.github/workflows/real-bytes-oracle.yml`.

### Skip-honesty / fail-loud

With no runnable Chromium, `just browser-e2e` FAILS LOUD (non-zero) with a
pointer to the dev shell — it never passes with the browser e2e unexercised.
This is the strict-lane analogue of the DB skip-honesty gates (`test-db-strict`,
`catalog-replay-db-strict`) and mirrors `ci-real-bytes`' missing-corpus
pre-check. The `playwright.config.ts` also throws if no `PLAYWRIGHT_CHROMIUM_BIN`
/ `UTSUSHI_BROWSER_BIN` is set, so both the recipe and the config refuse to run
browserless. A missing browser is a RED run, never a false green.

### Explicit browser-skip recipe for Chromium-less public lanes

The Utsushi CLI provides an operator-controlled escape valve only for recipe
steps that intentionally do not exercise a browser-backed runtime surface:

```sh
utsushi capabilities --skip-browser --output capabilities.json
utsushi smoke <game-dir> --adapter <browser-adapter> --skip-browser --output smoke.json
```

The flag is explicit; no environment variable enables a skip. The adapter still
owns browser probing and retains its `browser_host_availability` error severity
when Chromium is missing. The recipe-level output separately records a typed
`runtime_skip_acknowledged` diagnostic (`utsushi.runtime.skip_acknowledged`),
marks capability output `status: browser_runtime_skipped`, and marks smoke
output `status: skipped` with `alphaEvidence.status: not_established`. A skip
therefore cannot be consumed as a successful Chromium probe or runtime pass.

| CI lane / recipe                                                                                                                                                               | May pass `--skip-browser`? | Rule                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Tier 0 (`ci-tier0-*`), `just check`                                                                                                                                            | Yes                        | These are browser-free public/static gates; a capabilities report may explicitly acknowledge that a browser was not exercised. |
| Tier 1 portable, DB, and mutation recipes (`ci-tier1-ts-public-*`, `ci-tier1-rust-*`, `ci-tier1-db`, `ci-tier1-mutation`) and the browser-free `just ci` / `just ci-full` path | Yes                        | Only for a recipe step that is intentionally browserless, and only with the emitted skipped report retained as its evidence.   |
| Tier 1 browser (`ci-tier1-browser`), `just browser-e2e`, and `just periodic-strict`                                                                                            | **No**                     | These lanes own real-browser execution and must fail loudly if Chromium is unavailable.                                        |
| `just real-bytes-oracle` and every MV/MZ runtime-evidence or alpha-claim lane                                                                                                  | **No**                     | A Chromium launch is required evidence for an MV/MZ alpha claim; a skip is not an alpha pass.                                  |
| `ci-tier1-alpha` / `just alpha-proof`                                                                                                                                          | **No**                     | This named alpha recipe must not use a browser skip to imply any runtime-alpha evidence.                                       |

The `--skip-browser` surface is limited to `capabilities` and browser-adapter
`smoke`; trace, capture, and runtime-proof commands reject it. A lane that
actually claims browser runtime evidence must run with a supported Chromium
host instead of passing the flag.

## Public-lane coverage manifest (explicit, not implicit)

The public per-gate lane must PROVABLY run every required public test category
with no secret/network/real-corpora dependency, so a fork PR or a secretless run
passes it. That coverage is made EXPLICIT by a checked manifest:
`scripts/ci/public-lane-coverage.mjs`. It names, per required category — strict
schema, golden-wire interception, memo/fault, tool, Wiki/invalidation, workflow,
migration, patch-fixture, no-legacy, and LOC — the concrete secretless test file
(with a distinguishing marker that must appear in it) and the PUBLIC recipe that
runs it. `--check` fails (exit 1) if any category is dropped, cites a
private/secret lane, cites a missing test, has a stale marker, or is not
actually wired into its recipe. It runs in `just ci-tier0-meta` (a required
tier-0 merge-queue check), so the assertion gates every PR. Regression suite:
`scripts/ci/public-lane-coverage.test.mjs`.

## Opt-in private real-byte proof lane

`just ci-real-bytes-private-proof` (workflow:
`.github/workflows/real-bytes-private-proof.yml`, triggered on demand / by the
`real-byte-proof` label — NEVER `push`/`merge_group`, so it is not a
merge-required check) exercises extract -> structure -> patch -> replay on the
ACTUAL content-addressed Sweetie bytes under the exact approved ZDR profile.

Unlike the periodic oracle (which may skip a legitimately-absent family), this
lane may NOT green-skip: its preflight gate
(`scripts/ci/private-real-byte-proof.mjs --preflight`) FAILS (red) on any
missing REQUIRED Sweetie bytes, an unpinned/mismatched corpus content-address,
or ZDR profile drift. This is the key inversion — a missing required corpus reds
the lane rather than silently skipping. It emits a CONTENT-FREE evidence
manifest (`.tmp/private-proof/evidence.json` — counts/hashes/ids only, never
copyrighted bytes or prompt/source/target text; `assertContentFree` rejects
text-bearing keys and long non-hash strings), aligned with the redaction toggle.
The gate + manifest logic (config parses, fail-not-skip, content-free shape) are
unit-tested in `scripts/ci/private-real-byte-proof.test.mjs`, which runs in the
public `ci-tier0-meta` lane so drift is caught without the real corpus.
