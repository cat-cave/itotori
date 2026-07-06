# Itotori Design System — repo foundation

Source of truth: the **"Itotori Design System"** Claude Design project
(`claude.ai/design`, project id `428be6c4-a1db-41d2-954f-b50ff2e38353`, owner Trevor).
Pull/sync it with the `DesignSync` MCP + the `/design-sync` skill (auth: `/design-login`).
This doc is the distilled, version-controlled reference so repo work + the hi-fi agent
stay true to it without a live fetch. **The design project's own `readme.md`,
`tokens/`, and per-component `.prompt.md` files are the authoritative detail** — read
them directly when porting.

> The `ui_kits/studio/*` screens in the design project are **demos of components in
> action, NOT agreed-upon layouts.** Do not treat them as target screens. Layout,
> workflow, cross-surface interaction, and cohesion are the hi-fi agent's job (see
> `docs/design/hifi-brief.md`). Use them only as "here is a component rendered."

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

## Missing / to-spec tokens (flagged for the design system to add)

Reasoned from itotori's surface needs vs. the current groups — candidates to spec into
`tokens/` so the hi-fi + port don't invent ad-hoc values:

1. **Cost / spend semantics** — the drilldown distinguishes **billed vs zero vs unknown**
   cost as distinct states (`cost.state`); there's a data-viz group but no explicit
   _cost-state_ token trio (billed-ink / zero-muted / unknown-dashed). Spec them.
2. **ZDR / privacy posture** — `zdr=true; data_collection=none` is first-class evidence;
   needs a dedicated posture token/badge tone (a "privacy-ok" signal distinct from generic ok).
3. **Benchmark contestant tiers** — raw-MTL / fan / official / Itotori-with/without-context
   want a stable 4–5 swatch **contestant palette** (comparative, colour-blind-safe) for
   the benchmark surface, beyond the 3-tone status badges.
4. **Frame / render overlay** — the composited in-scene textbox over a game render needs
   overlay tokens (scrim opacity, textbox blur/tint, nameplate) — partially in `interface`
   (player-vs-snapshot) but the **redaction** state (redacted vs full-fidelity frame) has
   no token.
5. **Annotation severity scale** — AnnotationComposer/QA findings use a severity scale
   (blocker/critical/warning/note); confirm a dedicated severity ramp exists vs. reusing
   status tones.
6. **Pass-ledger / iteration state** — pass N vs N+1, accepted-delta, superseded — an
   iteration/diff token set for the multi-pass loop.
7. **Locale-branch identity** — source vs target locale colour identity (LocaleBranchSwitch)
   as a token, so branch chrome is consistent across surfaces.
   (These are candidates — verify against the live `tokens/*.css` before adding; some may
   already exist under `interface`/`data-viz`.)

## Incorporation status

Pull-down = this doc (design language in version control). The file-level port of the
tokens + component library into the repo, and wiring components to itotori data/APIs, is
tracked as the **design-system integration epic** (`ds-*` nodes in `roadmap/spec-dag.json`)
— done selectively/"as needed", per component category, driven by the hi-fi layouts.
