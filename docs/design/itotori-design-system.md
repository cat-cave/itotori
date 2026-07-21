# Itotori Design System — repo foundation

Source of truth: the **"Itotori Design System"** Claude Design project
(`claude.ai/design`, project id `428be6c4-a1db-41d2-954f-b50ff2e38353`, owner Trevor).
Pull/sync it with the `DesignSync` MCP + the `/design-sync` skill (auth: `/design-login`).
This doc is the distilled, version-controlled reference so repo work + the hi-fi agent
stay true to it without a live fetch. **The design project's own `readme.md`,
`tokens/`, and per-component `.prompt.md` files are the authoritative detail** — read
them directly when porting.

> The `ui_kits/studio/*` screens in the design project are **demos of components in
> action, NOT agreed-upon layouts.** Do not treat them as target screens. Shipped
> studio UI and the design-language pointer live in-tree (see
> `docs/design/hifi-brief.md`). Use design-project demos only as "here is a
> component rendered."

## Art direction — "Dusk Observatory"

A 90s/2000s Japanese visual-novel title screen at twilight, rebuilt as a modern dark
studio cockpit — CRT amber, bitmap type, config-menu window chrome, faint scanlines —
crisp, responsive, and dense enough to be a real instrument (a DAW / film-editing suite,
not an admin panel). Soul is unchanged: **evidence over vibes.** (Note: today's shipped
dashboards are flat neutral grey; this system is the _destination_ skin, not the current
production surface.)

## Voice (content fundamentals)

- Plain, technical, understated; system-voice in-product, "you" (the director) in framing;
  never marketing "we/our". **Sentence case everywhere**; the only uppercase is the small
  pixel **eyebrow** kicker + `dt`/`th` labels (via `text-transform`).
- **Machine tokens are shown, not hidden** — ids/hashes/revisions/locales/model names in
  monospace `<code>` (`bridge-unit:scene-07-line-014`, `sha256:…`, `claude-sonnet-4.5`).
- **Status = a closed lowercase vocabulary** rendered as badges: `pending`, `in_review`,
  `drafting`, `proven`, `succeeded`, `running`, `failed`, `stale`, `accepted`, `rejected`,
  `blocker`, `warning`, `captured`, `runtime-faithful`. Never sentence-cased.
- Numbers exact + sourced (USD to 4–6 dp billed micros, token counts, frame indices).
  No confidence score without a real judge; benchmark verdicts anchored to the human.
- **No emoji. No hype.** Reverence through restraint.

## Color

- Night canvas: page `#15101f`, surface `#201a34`, raised `#2a2246`, code well `#100c1c`.
  Text lavender-white `#f3efff`; muted `#9a8dc4`.
- **Primary sunset-amber `#ffb648`** (scarce — the one decisive action, active pills,
  wordmark dot, panel title tick; dark ink on it).
- Sakura `#ff6ca0` (attention/decision + romance), **mint `#45e6ad`** (the _evidence_
  signal — progress fill, "proven", faint glow), cyan `#55d6ea` (links/info).
- Three-tone badges (neutral / ok-mint / critical-coral), tone derived from the status
  string. Alerts on deep coral-plum `#2c1622` / `#6e3242`. No SaaS gradients.

## Type (era blend, all Google Fonts — art-direction choice, not repo-shipped)

- **Chakra Petch** (display — titles/buttons/nav, 600/700), **DotGothic16** (pixel —
  eyebrows/labels/badges/nameplate, tracked uppercase), **Zen Kaku Gothic New** (sans/body,
  Inter fallback), **Space Mono** (mono — every `<code>`, cyan-tinted).
- Scale rem: h1 `1.9`/`1.55`, h2 `1.02`, body/table `0.9`, pixel labels `0.66–0.7`.

## Spacing / radius / elevation

- Radii `10px` default / `6px` tight / `14px` large / `999px` pills. Spacing steps
  `1,4,6,8,10,12,14,16,18,24`. Panels = VN config-menu windows (title bar w/ vertical
  sheen + leading amber tick, night body, soft shadow + 1px inset top-highlight bevel).
  **Hairline-divider grid** is the signature data motif (1px gap over divider colour,
  night cells → seams read as thin dividers, no drawn rules). Amber controls carry a glow.
- Icon-light: **no icon font/set** — meaning via pixel-face labels + three-tone badges +
  mono tokens; only Unicode `→ ◀ ▶` glyphs. Flag any new icon need. No emoji.
- Brand mark: "Itotori." in Chakra Petch 700 + amber accent period. No logo ships.

## Component vocabulary (`window.ItotoriDesignSystem_428be6.<Name>`)

Each has a `.jsx`, `.d.ts` (props), `.prompt.md` (usage), and a `.card.html` demo.

- **core**: Badge (auto-tone from `status`), Eyebrow, CodeToken, Kbd, **Ruby** (furigana)
- **forms**: Button, TextField, Select, Choice, Switch, SegmentedControl
- **layout**: Panel (VN window: `lamps`/`frame`/`hoverable`/`tone`), MetricList
- **navigation**: NavPills, Tabs, Menu, **CommandPalette** (⌘K), ContextMenu
- **data**: DataTable, ProgressBar, **ComparisonPane** (source↔draft), **LocalizationProgress**
  (first-class progress instrument), **StatReadout** (metric + sparkline)
- **localization**: **BiText** (source↔translation + copy), **LocaleBranchSwitch** (source-first)
- **game**: **ScenePlayer** (the single VN player — play _and_ review modes),
  **AnnotationComposer** (in-the-moment note → QA finding)
- **wiki**: WikiEntry (character/term/scene profile), CrossRef (jump-to-scene source links)
- **diagram**: **RouteMap** (route/choice tree)
- **feedback**: Banner, Tooltip, Toast, Dialog
- **content**: Prose (markdown), EmptyState, Skeleton

## Token groups (`tokens/`, entry `styles.css`)

`colors` · `typography` · `fonts` · `spacing` · `interface` (menu / kbd / command / tabs /
status-bar / selection / bevels / layers / data-viz) · `forms` (fields / toggles) · `prose`
(`.itotori-prose`) · `diagram` (route-map nodes/edges/branches) · `effects` (keyframes +
utilities: `.itotori-scanlines/-stripes-run/-sweep/-caret/-live-dot/-glow/-lift/-riser/-frame`,
all suppressed under `prefers-reduced-motion`).

## Reconciled missing-token candidates

Verified against the repo live `packages/itotori-ds/tokens/*.css` for
`ds-spec-missing-tokens`. Hi-fi + port work must use these tokens instead of ad-hoc
values.

| Surface need               | Token coverage                                                                                                                                                                                                                        | Value                                                                                                                                                                                                                 | Usage note                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cost billed                | `--ito-cost-billed-ink`                                                                                                                                                                                                               | `var(--ito-color-text)`                                                                                                                                                                                               | Text for measured billed micros (`cost.state="billed"`).                                                                     |
| Cost zero                  | `--ito-cost-zero-muted`                                                                                                                                                                                                               | `var(--ito-color-text-muted)`                                                                                                                                                                                         | Muted text for known zero/no-op spend (`cost.state="zero"`).                                                                 |
| Cost unknown               | `--ito-cost-unknown-ink`, `--ito-cost-unknown-dash`                                                                                                                                                                                   | `#cbbdf2`, `#6f6394`                                                                                                                                                                                                  | Unknown spend reads as unmeasured, with dashed chrome; do not render as zero.                                                |
| ZDR / privacy posture      | `--ito-privacy-ok-fg`, `--ito-privacy-ok-bg`, `--ito-privacy-ok-border`                                                                                                                                                               | `#8ff5dc`, `#102f30`, `#34766f`                                                                                                                                                                                       | Explicit privacy badge tone for `zdr=true; data_collection=none`, distinct from generic ok status.                           |
| Benchmark contestant tiers | `--ito-contestant-official`, `--ito-contestant-self`, `--ito-contestant-self-nocontext`, `--ito-contestant-fan`, `--ito-contestant-mtl`                                                                                               | `#c08bff`, `#ffe066`, `#7fb3d5`, `#e07ab8`, `#9aa5b8`                                                                                                                                                                 | Stable colour-blind-safer categorical swatches for official, Itotori, Itotori without context, fan, and raw MTL contestants. |
| Render overlay             | `--ito-render-scrim`, `--ito-render-textbox-bg`, `--ito-render-textbox-border`, `--ito-render-textbox-blur`, `--ito-render-textbox-shadow`, `--ito-render-nameplate-bg`, `--ito-render-nameplate-fg`, `--ito-render-nameplate-border` | `rgba(9, 6, 16, 0.34)`, `rgba(16, 12, 28, 0.88)`, `rgba(243, 239, 255, 0.18)`, `blur(6px)`, `0 18px 42px -20px rgba(0, 0, 0, 0.86)`, `rgba(42, 22, 42, 0.92)`, `var(--ito-color-sakura)`, `rgba(255, 108, 160, 0.46)` | ScenePlayer textbox/speaker overlay over game frames.                                                                        |
| Redaction state            | `--ito-redact-blur`, `--ito-redact-overlay`, `--ito-redact-fg`, `--ito-redact-border`                                                                                                                                                 | `18px`, `rgba(21, 16, 31, 0.78)`, `var(--ito-color-amber)`, `var(--ito-tone-critical-border)`                                                                                                                         | Redacted shareable frames/screenshots; full-fidelity reveal must remove the redacted state, not override values.             |
| Annotation severity        | `--ito-severity-blocker`, `--ito-severity-critical`, `--ito-severity-warning`, `--ito-severity-note` plus matching `*-bg` and `*-border` tokens                                                                                       | `#f4737e`, `#ff6ca0`, `#ffb648`, `#9a8dc4`                                                                                                                                                                            | Ordinal finding severity for AnnotationComposer and QA rows; do not reuse pass/fail badge tone as severity.                  |
| Pass-ledger iteration/diff | `--ito-pass-current-border`, `--ito-pass-next-border`, `--ito-pass-accepted-delta`, `--ito-pass-superseded-fg`, `--ito-pass-diff-added`, `--ito-pass-diff-removed`                                                                    | `var(--ito-color-amber)`, `var(--ito-color-cyan)`, `var(--ito-color-mint)`, `#7d719e`, `rgba(69, 230, 173, 0.18)`, `rgba(244, 115, 126, 0.18)`                                                                        | Pass N / N+1 ledger rows and accepted/superseded/diff cells in the iterative loop.                                           |
| Locale branch identity     | `--ito-locale-source-accent`, `--ito-locale-source-bg`, `--ito-locale-source-border`, `--ito-locale-target-accent`, `--ito-locale-target-bg`, `--ito-locale-target-border`                                                            | `var(--ito-color-cyan)`, `#122735`, `#2d6672`, `var(--ito-color-sakura)`, `#2a162a`, `#743653`                                                                                                                        | Source→target branch chrome for LocaleBranchSwitch, BiText, ComparisonPane, and the persistent status bar.                   |

## Incorporation status

Pull-down = this doc (design language in version control). The file-level port of the
tokens + component library into the repo, and wiring components to itotori data/APIs, is
tracked as the **design-system integration epic** (`ds-*` nodes in `roadmap/spec-dag.json`)
— done selectively/"as needed", per component category, driven by the hi-fi layouts.
