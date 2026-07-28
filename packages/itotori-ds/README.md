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
  Storybook play-function runners via `composeStories`, then Storybook visual
  regression against committed baselines.
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

Visual regression is the dev-only screenshot diff surface for
`fe-ds-visual-regression`. It renders Storybook's generated `iframe.html` for
every entry in the real `index.json`, so coverage follows the same CSF catalog
used for design review.

The runner is deterministic by contract:

- fixed viewport: 1280x800, device scale factor 1, dark scheme;
- `prefers-reduced-motion: reduce`, disabled animations/transitions, hidden caret;
- local static Storybook only; external network requests are aborted;
- explicit Chromium binary via `PLAYWRIGHT_CHROMIUM_BIN` or `UTSUSHI_BROWSER_BIN`;
- explicit font set via `FONTCONFIG_FILE`.

Those, plus the launch flags exported as `rasterizationArgs` from
`scripts/visual-regression.mjs`, are the **renderer contract**, and all three
parts are load-bearing at `maxDiffPixels=0`. A screenshot is a function of the
browser binary, the faces fontconfig resolves for it, _and_ the rasterization
path Chromium picks from the machine (GPU vs software, LCD-subpixel vs grayscale
text, fractional vs integer glyph positioning, Skia kernels chosen from CPU
feature bits, raster tiling). The DS type stacks are art direction rather than
shipped files (see Fonts below), so every family falls through to `system-ui` /
`sans-serif` / `monospace`, which an unpinned host answers with whatever it
happens to have installed. `flake.nix` pins Chromium and a hand-written hermetic
fontconfig file in the default dev shell and in the minimal `.#browser` shell
that CI's Tier-1 browser lane enters. Re-capture baselines only from inside one
of those shells.

The font config is hand-written rather than generated because the nixpkgs helper
is additive, not hermetic: it emits a `/nix/store` path that still
`<include>`s the host's `/etc/fonts/conf.d` and lists `/usr/share/fonts`, so a
store path is not by itself a pinned font universe. It also pins **CJK**
explicitly — `BiText` renders a `ja-JP` line, which previously resolved only via
this workstation's own system font list, so any other host drew tofu.

`just ci tier1-browser` asserts the contract before it runs anything and FAILS
when it is unmet; it does not skip. (It skipped for the whole of the lane's
prior life, because CI provisioned Playwright's own Chromium and therefore never
satisfied it.) `ITOTORI_DS_VISUAL_STRICT=1` is the one opt-out, for an operator
who deliberately rebased the baselines onto another renderer.

## Fonts

The four families (Chakra Petch / DotGothic16 / Zen Kaku Gothic New / Space Mono)
are an art-direction choice and are **not repo-shipped**. `fonts.css` declares the
stacks with graceful system fallbacks; a host opts into the web fonts (the gallery
`index.html` links Google Fonts). See `MISSING-TOKENS.md` for the reconciled
semantic groups that hi-fi and port work must consume.
