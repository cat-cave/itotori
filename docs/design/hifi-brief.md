# Itotori — hi-fi design brief (handoff)

**For:** the agent building the high-fidelity mockups.
**You have:** (1) the **Itotori Design System** Claude Design project
(`claude.ai/design`, id `428be6c4-a1db-41d2-954f-b50ff2e38353`) — components, tokens,
voice, art direction; (2) this repo (product truth, current partial surfaces).
**Read first:** `docs/design/itotori-design-system.md` (distilled design language),
the design project's `readme.md` + per-component `.prompt.md`, and `docs/localization-surfaces.md`.

## What Itotori is (one breath)

An agentic **games-localization studio** — the "brain" of a trio (Kaifuu = the bytes,
Utsushi = the proof, Itotori = the localization graph). A human **director** drives an
agent to localize a whole visual novel to _strong-caliber_: extracted faithfully, drafted

- QA'd by LLMs under human steering, patched reproducibly, and **proven by running the
  patched game**. The dashboards are the cockpit the director steers from.

## Your job — and what it is NOT

Design the **hi-fi layouts, workflows, cross-surface interaction, and cohesive feel** of
the studio. Compose the design system's existing components/tokens/voice into real,
opinionated screens and flows.

- **NOT** a component gallery, and **NOT** a re-skin of the design project's
  `ui_kits/studio/*` screens — those are **demos of components in action, not agreed
  layouts.** Treat them only as "here's a component rendered." The layouts are yours to
  design.
- **DO** decide information hierarchy, screen composition, navigation, and how the director
  moves _between_ surfaces as one coherent instrument — where a DAW/film-suite would put
  density, focus, and transport.
- Honor the design language exactly (Dusk Observatory, evidence-first voice, VN-menu
  window chrome, sentence case, mono machine-tokens, the closed status vocabulary, icon-light,
  no emoji, `prefers-reduced-motion`). Cohesion is the deliverable.

## Design principle: game-agnostic

Itotori localizes _any_ supported game; a specific title is input/config, never baked in.
Layouts must be **project-parameterized** — a project/target picker, not Sweetie-specific
chrome. Use neutral/placeholder content (a "configured target corpus"), not a hardcoded game.

## The surfaces & workflows to design (the director's journey)

Design these as a cohesive whole, not isolated pages. Emphasis on layout + how they connect.

1. **Overview / cockpit.** The director's home: project + source→branch, the first-class
   **localization progress** (stage breakouts, cycle/ETA), a pending-decisions band, the
   pass-ledger (pass N → feedback → N+1) run table, live model **cost/ZDR posture**, and
   entry points to review / player / benchmark / runtime / wiki.
2. **Review workspace.** The core loop: **source ↔ draft ↔ re-draft** history side-by-side
   (`ComparisonPane`/`BiText`), QA findings, the director's **correction/annotation** and
   its severity, glossary + branch policy, and the "request repair / approve" decision.
   This is where taste enters the loop.
3. **Embedded player / playthrough.** The **ScenePlayer**: the localized build running
   in-scene (background + sprites + composited localized textbox) with VN **transport**
   (restart scene, prev/next choice, auto, end-of-scene), a **route/arc scene picker**
   (`RouteMap`), bilingual dialogue, and in-the-moment **AnnotationComposer** (note → QA
   finding). One player, two intents — _play_ and _review_.
4. **Benchmark / confidence.** Blind-judged quality vs raw-MTL / fan / official / Itotori
   (with & without context); the actionable backlog; and the **"strong-caliber vs keep
   iterating"** confidence verdict anchored to the director's own ratings.
5. **Runtime evidence.** Utsushi's proof: runtime summary, deterministic trace, findings,
   redaction-capable rendered frames/screenshots as feedback evidence.
6. **Context wiki.** Character / term / scene profiles (`WikiEntry`) with jump-to-scene
   `CrossRef`; the glossary + style guide + character-arc context that back the translation.

## Cross-surface interaction (the "one instrument" feel)

- **⌘K command palette** jumps to any scene / character / term / run / action across
  surfaces — the primary connective tissue.
- **Persistent status bar**: ZDR posture (`zdr=true; data_collection=none`) + source→branch,
  always in view.
- **Deep, addressable navigation**: a QA finding → the exact scene/line in the player →
  the wiki entry for that character → the runtime frame that proves it. Design these jumps.
- **The iterative loop is the spine**: annotate → correction ingested → pass N+1 re-drafts
  the affected scope → benchmark re-scores → confidence updates. Make the loop legible.

## Constraints & inputs

- **Imagery = the game itself** (real VN screenshots, drop-in scene render slot) — no stock/illustration.
- **Redaction is first-class**: frames/screenshots have a redacted (shareable) vs
  full-fidelity (private) state — design the toggle + how redacted evidence reads.
- **Evidence density**: exact numbers, mono tokens, hairline grids; but keep the _reading_
  surfaces (the actual translation prose/dialogue) comfortable. Balance instrument-density
  with reading-comfort.
- **Responsive**: usable on a wide studio monitor; degrade gracefully.

## Flag back to us

- Any **missing token** you need (see the candidates in `docs/design/itotori-design-system.md`
  §"Missing / to-spec tokens" — extend that list).
- Any **new component** the layouts require that the system lacks.
- Any surface where product intent is ambiguous — ask; don't invent workflow.

## Deliverable

Hi-fi mockups of the surfaces above **as designed layouts + the flows between them**,
in the design system's language, delivered back into the Claude Design project (so we can
import + break them into implementation nodes here). Prioritize the **director's core loop**
(overview → review → player → correction → re-draft → benchmark) as one cohesive pass first.
