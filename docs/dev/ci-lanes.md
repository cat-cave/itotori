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
sub-gate. GitHub: `.github/workflows/ci.yml`.

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
  synthetic-vs-real drift check. See `docs/real-bytes-periodic-oracle.md`.

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
