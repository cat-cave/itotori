# Runtime Web Review

Vite runtime evidence dashboard for Utsushi reports ingested by Itotori.

The current app renders `/runtime/evidence/:runtimeRunId` and reads
`/api/runtime/v0.2/status`. It shows the selected runtime run/report ids,
runtime status, fidelity and evidence tiers, text events, frame captures,
screenshot and recording artifacts, validation findings, and artifact links.

This package is still intentionally small, but it is no longer only a future
browser shell: it is the current review surface for runtime evidence produced by
the fixture path and shared v0.2 runtime API.

## Tests

Two lanes:

- **Fast (jsdom) unit lane** — `pnpm --filter @itotori/runtime-web-review test`
  (vitest, `test/**`). Part of the per-gate CI. Asserts each render module in
  isolation. `.spec.ts` files belong to this lane.
- **Browser e2e lane** — `pnpm --filter @itotori/runtime-web-review e2e`
  (Playwright, `e2e/**/*.e2e.ts`). NOT part of the fast per-gate lane. Drives
  the shipping review UI in a REAL Chromium and asserts observable behavior
  (embed renders the scene, branch-explorer filter + pagination navigate, the
  input-bridge turns gestures into engine-neutral advance/choice events) over
  the app's OWN committed fixtures + built-in seed data — no game bytes, no live
  game, no live server. The e2e file extension is `.e2e.ts` (not `.spec.ts`) so
  vitest's default `**/*.spec.ts` glob never picks up the browser lane.

### Browser binary (Chromium)

The e2e runs against a **nix-provided Chromium**. Playwright's own downloaded
browsers are dynamically linked against libraries absent on NixOS and cannot
run here, so the dev shell (`flake.nix`) adds `pkgs.chromium` and exports its
store path as `PLAYWRIGHT_CHROMIUM_BIN` (and `UTSUSHI_BROWSER_BIN`, shared with
the Rust MV/MZ browser gates); `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` prevents any
download. `e2e/playwright.config.ts` launches that binary via `executablePath`.
Inside the dev shell (`direnv` / `nix develop`) the browser is provisioned
automatically and pinned by `flake.lock`; outside it, set `PLAYWRIGHT_CHROMIUM_BIN`
to a runnable Chromium (>= 149, matching Playwright 1.60).
