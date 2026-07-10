# @itotori/ds — Dusk Observatory design system

The repo port of the **Itotori Design System** ("Dusk Observatory") design
language into a React + CSS package. This is the **foundation** of the hi-fi
Studio epic: the ~50 downstream UI nodes build their screens by composing these
tokens + components, so the patterns here are the precedent.

Source of truth for the design language:
[`docs/design/itotori-design-system.md`](../../docs/design/itotori-design-system.md).
Component parity notes and the live DesignSync research gap are recorded in
[`PARITY.md`](./PARITY.md).

## Layout

```
tokens/                 the token set — one file per group, entry styles.css
  colors · fonts · typography · spacing · interface · forms · prose · diagram · effects
  styles.css            @imports every token group + the component layer (the single CSS entry)
src/
  status.ts             the closed status vocabulary → three-tone mapping
  cx.ts                 className joiner (the only styling helper)
  components/
    core/Badge           layout/Panel
    data/DataTable · ProgressBar · ComparisonPane · LocalizationProgress · StatReadout
    localization/BiText   navigation/NavPills · CommandPalette   feedback/Toast
    game/ScenePlayer · AnnotationComposer   wiki/WikiEntry
    <Name>.tsx + <Name>.css co-located; components.css @imports them
  gallery/              lightweight component gallery (vite demo surface)
  stories/              Storybook CSF stories — design-review catalog + play tests
.storybook/             Storybook harness config (fe-ds-storybook-harness)
test/                   behaviour tests + committed Storybook visual baselines
```

## Patterns downstream UI nodes copy

1. **className-based styling, CSS ships separately.** Components render semantic
   DOM with `itotori-*` classes; the visual truth lives in `tokens/` + co-located
   component CSS, shipped as one bundle (`@itotori/ds/styles.css`). No CSS-in-JS,
   no CSS modules — tsc stays clean and the library is drop-in.
2. **Import the bundle once**, then components:
   ```tsx
   import "@itotori/ds/styles.css";
   import { Panel, Badge, DataTable } from "@itotori/ds";
   ```
3. **Status is a closed vocabulary → derived tone.** Never pick a badge colour by
   hand; pass the product status to `<Badge status={…} />` / `statusTone(…)`.
4. **Tokens, never literals.** Reference `--ito-*` variables; never inline a hex
   value. The previously flagged missing semantic groups are reconciled in
   `MISSING-TOKENS.md` and pinned by `test/tokens.test.ts`.
5. **Sentence case, mono machine-tokens, icon-light, no emoji, and every
   animation is suppressed under `prefers-reduced-motion`** (see `effects.css`).
6. **Behaviour-first tests.** Assert rendered DOM + real interactions
   (Testing Library), never component internals — see any `test/*.test.tsx`.

## Scripts

- `pnpm --filter @itotori/ds build` — tsc emits the library (JS + `.d.ts`).
- `pnpm --filter @itotori/ds test` — Vitest component tests (jsdom), including
  Storybook play-function runners via `composeStories`.
- `pnpm --filter @itotori/ds test:dom` — Vitest/jsdom only for tight component
  loops.
- `pnpm --filter @itotori/ds typecheck` — `tsc --noEmit` over library + gallery +
  Storybook stories + tests.
- `pnpm --filter @itotori/ds storybook` — design-review catalog (Storybook UI).
- `pnpm --filter @itotori/ds storybook:build` — static Storybook build (CI-friendly
  compile gate; output `storybook-static/`, gitignored).
- `pnpm --filter @itotori/ds visual:test` — build Storybook with `--test`, render
  every real story in Chromium, and compare screenshots with
  `test/visual-baselines/`.
- `pnpm --filter @itotori/ds visual:update` — regenerate committed baselines after
  an intentional DS visual change.
- `pnpm --filter @itotori/ds gallery:dev` — serve the lightweight gallery.
- `pnpm --filter @itotori/ds gallery:build` — build the gallery for the browser.

## Storybook harness

Storybook is the **component behavior surface + design-review catalog** for the
ported DS (decision: Trevor 2026-07-07, node `fe-ds-storybook-harness`). There is
one CSF story file per public component under `src/stories/`, with play-function
interaction tests for interactive surfaces. Play bodies run:

1. in the Storybook Interactions panel during design review, and
2. deterministically in CI via Vitest + `composeStories` (jsdom) — see
   `test/stories.test.tsx`.

## Visual regression

Visual regression is the developer-facing screenshot-diff surface and a
strict/periodic CI proof for `fe-ds-visual-regression`. It renders Storybook's
generated `iframe.html` for every entry in the real `index.json`, so coverage
follows the same CSF catalog used for design review. Run it locally with
`visual:test`; CI runs it in the strict browser lane (`just browser-e2e`, as
part of `just periodic-strict`), outside the fast per-gate lane.

The runner is deterministic by contract:

- fixed viewport: 1280x800, device scale factor 1, dark scheme;
- `prefers-reduced-motion: reduce`, disabled animations/transitions, hidden caret;
- local static Storybook only; external network requests are aborted;
- explicit Chromium binary via `PLAYWRIGHT_CHROMIUM_BIN` or `UTSUSHI_BROWSER_BIN`.

The explicit browser path is required so baselines do not silently shift between
host browsers. In the dev shell this is exported by the native-deps setup; outside
it, set one of those env vars before running `visual:test` or `visual:update`.

## Fonts

The four families (Chakra Petch / DotGothic16 / Zen Kaku Gothic New / Space Mono)
are an art-direction choice and are **not repo-shipped**. `fonts.css` declares the
stacks with graceful system fallbacks; a host opts into the web fonts (the gallery
`index.html` links Google Fonts). See `MISSING-TOKENS.md` for the reconciled
semantic groups that hi-fi and port work must consume.
