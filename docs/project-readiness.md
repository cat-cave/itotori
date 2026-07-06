# Project Readiness

> **Rename note (2026-06-24).** This file was renamed from
> `alpha-localization-project-readiness.md` on 2026-06-24 when the milestone
> framework was redefined from a two-level ("alpha" + "continuous") split
> into a four-tier framework (real-game-testing-ready → alpha → beta → full
> release). The previous body of that file described "alpha = dogfood point"
> and was preserved as "North Star" — both framings are obsolete and have
> been removed. What used to be called "alpha" is now
> **real-game-testing-ready**; alpha now names a stricter milestone that
> requires real LLM calls, the full agentic loop, real patchback, and Linux
> replay on the configured alpha corpus (a single real RealLive target).
> Cross-reference: `docs/audits/alpha-scope-honesty.md`
> §D is the historical record of the redefinition that led to the rename;
> the DAG re-tier follow-up lives at
> [`docs/proposals/dag-retier-2026-06-24.md`](proposals/dag-retier-2026-06-24.md).

## 1. The Four-Tier Framework

1. **real-game-testing-ready** — building blocks present, parsing layer
   validated against real bytes, workflow runs end-to-end with recorded
   providers and fixture data, Rust port crate scaffolded, dashboard
   reachable. Safe to attempt real runs in find-bugs mode. Output here is
   throwaway.
2. **alpha** — the configured alpha target (a single real RealLive corpus)
   can be localized end-to-end on this Linux machine. Real-bytes extraction
   (kaifuu reads real scene bytecode and produces v0.2 bridge units); live LLM
   call via OpenRouter with an explicit (model, provider) pair; the FULL
   agentic loop fires (context building + pre-translation + translation + QA
   agents + deterministic checks + editing/review cycles, all minimally
   functional even if output is worse than MTL); real patchback;
   `utsushi-reallive` runtime runs the patched game locally on Linux;
   verifiable patch landed via trace + frame capture. Single-game by
   definition.
3. **beta** — ≥2 games per intended engine localized e2e, including
   encrypted variants. Multi-game-validation rule fully applies. Edge cases
   and instability expected.
4. **full release** — most games in most common engines, by non-technical
   users, with rare bugs.

Alpha-ready = "the system functions well enough to say 'I think this QA
agent doesn't do anything helpful, let's swap to this strategy' rather than
'QA doesn't work at all, the system bricks once any qa rejection is
pushed'." It is **NOT** "output is good"; it is "all the building blocks
fire and pieces can be swapped."

## 2. Concrete Acceptance Criteria Per Tier

### 2.1 real-game-testing-ready

1. **Substrate extensions M.1–M.3 landed.** `UTSUSHI-222` (composite asset
   package + try-dir-then-archive resolver), `UTSUSHI-223` (snapshot
   envelope size class), `UTSUSHI-224` (`EnginePort` → substrate-sinks
   bridge, the legacy Rust runtime `ObservationHookEvent` enum deleted
   from `crates/`). Each ships with multi-engine validation against ≥2
   real-bytes corpora and same-change legacy deletion. (The distinct TS
   bridge wire type `ObservationHookEvent` in
   `packages/localization-bridge-schema` is unaffected and remains live
   as an `observationHookEvents` field of `RuntimeEvidenceReportV02`.)
2. **Non-synthetic engine port crate scaffolded.** `UTSUSHI-200` registers
   conformance against the substrate with the smallest credible opcode
   subset (call/return/text-display/wait); does not depend on author-fixture
   envelopes.
3. **Real-bytes alpha-corpus smoke.** `kaifuu-cli detect` returns true,
   `parse_archive` returns a non-empty entry list (no silent zero-state),
   the Gameexe parser classifies the dominant key families. Closed by
   `KAIFUU-188` (10000-slot envelope), `KAIFUU-189` (depth-N detector),
   `KAIFUU-190` (Gameexe key family expansion).
4. **Recorded-LLM bundle.** A reproducible recorded-provider run through
   the full Itotori workflow (draft → QA → patch export) is reachable
   behind `ITOTORI_LIVE_PROVIDER=0` with deterministic outputs. Tracked by
   `ITOTORI-019` / `ITOTORI-021` / `ITOTORI-025`.
5. **Dashboard reachable.** The spec-dag-dashboard renders DAG, claims, and
   audit state from real DB state (not fixtures); audit-findings dashboard
   work in flight extends this.
6. **Repo hygiene.** `just check` / `just test` / `just ci` / `just hello`
   green locally; no silenced tests that represent real outstanding work
   (cross-ref `audits/silenced-2026-06-24.md`); no foreign-tool subprocess
   invocations in production code.

### 2.2 alpha

Stricter than real-game-testing-ready. All six criteria above PLUS:

1. **Live LLM via OpenRouter with explicit (model, provider) pair.** Every
   model invocation seam in the workflow declares both `modelId` and
   `providerId` as a pair (no defaulting, no fallback). Recorded bundles
   pin both. Pre-alpha development pairs are small/cheap; alpha defends its
   chosen pair in prompt/preset metadata.
2. **UTSUSHI-201..221 runtime port largely landed.** The 22-sub-node
   `utsushi-reallive` runtime decomposition (`UTSUSHI-200..221`,
   `docs/research/reallive-engine-dag-proposal.md`) has shipped enough of
   the opcode VM, variable system, asset pipeline, and system-call dispatch
   to run a patched scene of the configured alpha corpus on Linux.
3. **Full agentic loop fires end-to-end.** Context building +
   pre-translation + translation + QA agents + deterministic checks +
   editing/review cycles all minimally functional. Each piece is swappable.
   Output quality is NOT the bar (worse-than-MTL is acceptable); the bar is
   that "swap this QA strategy for that one" is a tractable change rather
   than a rewrite.
4. **Real patchback on the configured alpha corpus scene bytecode.** Not
   length-preserving only — offset-table rewriting works, JA→EN expansions land, the patched
   `Seen.txt` is byte-stable enough to load.
5. **Linux replay via `utsushi-reallive` runtime.** The patched game runs
   locally on Linux to the point where the localized scene renders.
6. **Verifiable patch evidence.** Utsushi trace + frame capture (E2 or
   better) demonstrates that the patched scene rendered with the new text.
   Single-game (the configured alpha corpus) by definition — multi-game
   claims are beta.

### 2.3 beta

The multi-game-validation rule is the gate. Specifically:

1. **≥2 real-world games per claimed engine family**, end-to-end. A single
   engine-family claim with only the configured alpha corpus is alpha, not
   beta.
2. **Encrypted variants land.** Encrypted XP3 + TJS-heavy KiriKiri,
   encrypted RPG Maker MV/MZ archives, etc. — at least one encrypted
   variant per family the project claims.
3. **Engine families the project intends to claim** all clear (1) and (2).
   Today's intent set is RealLive, SiglusEngine, RPG Maker MV/MZ, plain
   KiriKiri/XP3 + KAG; expansions (TyranoScript, VX Ace/RGSS3,
   BGI/Ethornell, Unity/Unreal/Godot) are beta when their families clear
   the rule, not before. **SiglusEngine is corpus-blocked:** the spec'd
   `kaifuu-siglus` vertical exists (skeleton landed) but its real-bytes
   chain is parked behind an external dependency — the only owned Siglus
   titles are copy-protected DVD images that are unrealizable under the
   no-Wine/no-shell-out/no-installer laws, so SiglusEngine beta is gated on
   re-acquiring a realizable (download-edition) Siglus corpus (≥2 titles).
4. **Cross-engine substrate generality demonstrated.** Substrate extensions
   M.1–M.5 and the substrate-sinks bridge work uniformly across families;
   no per-engine shim leaks into substrate code.
5. **Edge cases and instability expected.** Beta does not require polish;
   it requires that the multi-game-validation rule is structurally
   satisfied so that "this engine works" is a defensible claim rather than
   a single-title fixture-shape.

### 2.4 full release

1. Most games in most common engines.
2. Non-technical end users can run the workflow.
3. Bugs are rare; failure modes are diagnosable from logs and reports.
4. Patch and runtime evidence are the defaults, not the exception.

No further enumeration here — full release is the asymptote, not the next
gate.

## 3. What's NOT In Alpha

Multi-engine claims belong to **beta**, not alpha. Specifically:

- SiglusEngine end-to-end is beta (alpha is the single configured RealLive
  corpus only).
- RPG Maker MV/MZ end-to-end on a real game is beta.
- Plain KiriKiri/XP3 + KAG end-to-end on a real game is beta.
- Encrypted XP3, encrypted RPG Maker archives, TJS-heavy KiriKiri, and
  every additional engine family are beta or later.
- Cross-engine breadth claims ("Itotori supports family X") are beta, not
  alpha.

Alpha is single-game (one configured RealLive corpus) by definition. The
other engines may have substrate-level coverage at alpha (substrate extensions
M.1–M.3 require multi-engine validation against ≥2 real-bytes corpora),
but their **end-to-end** localization claims are beta work.

## 4. Standing Rules

These rules govern every tier:

- **`feedback_model_provider_pair`** — every model invocation declares
  `(modelId, providerId)` as a pair; calling out by model alone is a P0
  architectural violation
  (`~/.claude/projects/-home-trevor-projects-itotori/memory/feedback_model_provider_pair.md`).
- **`feedback_no_legacy_compat`** — greenfield code deletes the legacy
  path in the same change; no shims, no `#[deprecated]`, no compat aliases
  (`~/.claude/projects/-home-trevor-projects-itotori/memory/feedback_no_legacy_compat.md`).
- **`feedback_multi_game_validation`** — engine-family claims require
  validation against ≥2 real-world games of that engine; single-title pass
  is fixture-shaped
  (`~/.claude/projects/-home-trevor-projects-itotori/memory/feedback_multi_game_validation.md`).
- **`feedback_investigation_not_in_dag`** — research happens
  interactively against real bytes; concrete implementation nodes are
  written **from** research output, not as scaffolding for it
  (`~/.claude/projects/-home-trevor-projects-itotori/memory/feedback_investigation_not_in_dag.md`).
- **`project_no_timeline`** — no eng-month/week/year estimates in DAG
  nodes, plans, or docs; sized scope, not calendar promises
  (`~/.claude/projects/-home-trevor-projects-itotori/memory/project_no_timeline.md`).

## 5. DAG Re-Tier Proposal

The companion proposal at
[`docs/proposals/dag-retier-2026-06-24.md`](proposals/dag-retier-2026-06-24.md)
translates the four-tier framework into per-node `target` retagging across
`roadmap/spec-dag.json`. Read it for the concrete node-by-node retag list;
the present doc only fixes the framework vocabulary and acceptance
criteria. `roadmap/spec-dag.json` is not mutated by this doc.
