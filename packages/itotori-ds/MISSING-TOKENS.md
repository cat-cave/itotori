# Missing / to-spec token groups

The Dusk Observatory design language (`docs/design/itotori-design-system.md`
§"Missing / to-spec tokens") flags **seven** token groups that itotori's surface
needs but the current `tokens/` set does not yet define. This foundation node
**does not invent** those values — inventing ad-hoc colours is exactly what the
design doc warns against. Instead each group is specced here as a documented gap
plus a plan, so a downstream node adds them deliberately (verified against the
live design project's `tokens/*.css` first).

Status legend: **gap** = named by the doc, not yet in `tokens/`; the "verify"
step confirms it isn't already covered under `interface`/`data-viz` before adding.

---

## 1. Cost / spend semantics (`--ito-cost-*`)

- **Need.** The cost drilldown distinguishes **billed vs zero vs unknown** cost
  as distinct states (`cost.state`); today there is a `data-viz` group but no
  explicit cost-state trio.
- **Plan.** Add `--ito-cost-billed` (ink — a real charge), `--ito-cost-zero`
  (muted — genuinely $0, e.g. cached), `--ito-cost-unknown` (dashed/hatched
  treatment — not yet metered). Pair with a `.itotori-cost--{billed,zero,unknown}`
  utility. Numbers stay exact (billed micros-USD, 4–6 dp).
- **Consumers.** Overview cost/ZDR band, pass-ledger spend column, StatReadout
  cost readouts.
- **Verify.** Not representable by the three status tones (this is a spend-state
  axis, orthogonal to ok/critical).

## 2. ZDR / privacy posture (`--ito-posture-*`)

- **Need.** `zdr=true; data_collection=none` is first-class evidence and wants a
  **privacy-ok** signal distinct from the generic ok-mint.
- **Plan.** Add a dedicated posture tone + badge (`--ito-posture-ok-*`,
  `--ito-posture-warn-*`) so "privacy verified" reads differently from "task
  succeeded". Likely a cooler evidence hue than mint.
- **Consumers.** The persistent status bar (posture is always in view), the
  model/provider readouts.
- **Verify.** Currently would collapse onto the ok tone, losing the privacy
  semantic — that is the gap.

## 3. Benchmark contestant tiers (`--ito-contestant-*`)

- **Need.** raw-MTL / fan / official / Itotori-with-context / Itotori-without-
  context want a **stable 4–5 swatch contestant palette** (comparative,
  colour-blind-safe), beyond the 3-tone status badges.
- **Plan.** Add `--ito-contestant-{mtl,fan,official,self,self-nocontext}` chosen
  for categorical distinctness under the common colour-vision deficiencies, with
  matching series strokes for the benchmark charts.
- **Consumers.** The benchmark/confidence surface (`bmk-*` nodes).
- **Verify.** Comparative categorical palette; must not reuse the semantic status
  hues (amber/mint/coral) or the two will be confused.

## 4. Frame / render overlay + redaction (`--ito-frame-*`, `--ito-redact-*`)

- **Need.** The composited in-scene textbox over a game render needs overlay
  tokens (scrim opacity, textbox blur/tint, nameplate). `interface` partially
  covers player-vs-snapshot, but the **redaction** state (redacted vs
  full-fidelity frame) has **no token** — and redaction is first-class.
- **Plan.** Add `--ito-frame-scrim`, `--ito-frame-textbox-tint`,
  `--ito-frame-nameplate`, and a `--ito-redact-blur` / `--ito-redact-overlay`
  pair with a `.itotori-redacted` utility. Redaction must be a toggle (default on
  for committed/shared frames), never baked in.
- **Consumers.** ScenePlayer, runtime-evidence frames, any shared screenshot.
- **Verify.** Confirm which player-vs-snapshot values already exist under
  `interface` and add only the missing overlay + redaction tokens.

## 5. Annotation severity scale (`--ito-severity-*`)

- **Need.** AnnotationComposer / QA findings use a severity scale
  (blocker / critical / warning / note); confirm a dedicated ramp exists vs.
  reusing status tones.
- **Plan.** Add `--ito-severity-{blocker,critical,warning,note}` as an ordered
  ramp (a severity axis is not the same as the pass/fail status axis). Feeds the
  AnnotationComposer chips and finding rows.
- **Consumers.** Review findings, in-scene AnnotationComposer, the pending-
  decisions band.
- **Verify.** `blocker`/`warning` appear in the closed status vocabulary but as
  _badge statuses_; a severity **ramp** (ordinal) is the distinct need.

## 6. Pass-ledger / iteration state (`--ito-iter-*`)

- **Need.** pass N vs N+1, accepted-delta, superseded — an iteration/diff token
  set for the multi-pass loop.
- **Plan.** Add `--ito-iter-current`, `--ito-iter-prior`, `--ito-iter-superseded`,
  `--ito-delta-accepted` / `--ito-delta-rejected` so the pass ledger and diff
  views read the iteration axis consistently.
- **Consumers.** Pass-ledger run table, ComparisonPane re-draft history, the
  confidence trend.
- **Verify.** Distinct from status tone; encodes "which pass" + "delta outcome".

## 7. Locale-branch identity (`--ito-branch-*`)

- **Need.** source vs target locale colour identity (LocaleBranchSwitch) as a
  token, so branch chrome is consistent across every surface.
- **Plan.** Add `--ito-branch-source` / `--ito-branch-target` (+ neutral for
  multi-target) so locale badges, BiText locale tokens, and the branch switch all
  share one identity. BiText currently tints locale tokens cyan as a placeholder —
  it should consume `--ito-branch-*` once specced.
- **Consumers.** LocaleBranchSwitch, BiText, the status bar source→branch, wiki
  cross-refs.
- **Verify.** Today collapses onto the generic link/cyan; the gap is a stable
  source/target identity pair.

---

### How the port behaved in the meantime

Where a component in this node needed one of the above (e.g. BiText's locale
token colour, ProgressBar/LocalizationProgress fills), it reused an **existing**
token (`--ito-color-cyan`, `--ito-color-mint`) rather than inventing a value, and
the reuse is called out above so the follow-up node can retarget it to the real
token once specced. No ad-hoc hex values were introduced for the seven gaps.
