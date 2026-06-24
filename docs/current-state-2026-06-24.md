# Current State — 2026-06-24

Cold-start orientation for an orchestrator or subagent. Read this first;
drill into the named audit/research doc only when you need the evidence.

## Where We Stand

The milestone framework was redefined on 2026-06-24 into a four-tier
framework: **real-game-testing-ready → alpha → beta → full release**.
What was previously called "alpha" is now **real-game-testing-ready**;
alpha now requires live LLM via OpenRouter with an explicit
(model, provider) pair, the full agentic loop, real patchback, and Linux
replay of Sweetie HD via `utsushi-reallive`. Authoritative tier definitions
live in [`project-readiness.md`](project-readiness.md) (renamed from
`alpha-localization-project-readiness.md` on 2026-06-24). DAG re-tier
proposal: [`proposals/dag-retier-2026-06-24.md`](proposals/dag-retier-2026-06-24.md).

What landed this session (~17+ nodes): kaifuu real-bytes parsers,
substrate extensions M.1–M.3 (`UTSUSHI-222/223/224`), `utsushi-reallive`
scaffold (`UTSUSHI-200`), itotori agentic stack with recorded provider
(`ITOTORI-019/021/025`), plus dashboard and CI-hygiene work in flight.
**This puts the suite at real-game-testing-ready, not alpha.**
`roadmap/spec-dag.json` is at 613 nodes (209 ready);
`direnv exec . node scripts/spec-dag.mjs validate` reports valid. CI green
locally. Four engine research surfaces staged read-only at
`/scratch/itotori-research/`.

## Real-Game-Testing-Ready Gates

The seven requirements (six original + the audit-findings dashboard work
in flight):

1. **Substrate M.1–M.3.** `UTSUSHI-222/223/224` with multi-engine
   validation against ≥2 real-bytes corpora and same-change legacy
   deletion.
2. **Non-synthetic engine port crate scaffolded.** `UTSUSHI-200`
   registers conformance (call/return/text-display/wait).
3. **Real-bytes Sweetie HD smoke.** `kaifuu-cli detect` returns true,
   `parse_archive` returns non-empty, Gameexe classifies dominant key
   families. Closed by `KAIFUU-188/189/190`.
4. **Recorded-LLM bundle** reachable behind `ITOTORI_LIVE_PROVIDER=0`
   (`ITOTORI-019/021/025`).
5. **Dashboard reachable** from real DB state.
6. **Repo hygiene.** `just check`/`test`/`ci`/`hello` green; no silenced
   real work; no foreign-tool subprocess invocations in production.
7. **Audit-findings dashboard in flight** — extends gate (5) for
   orchestrator triage of the 2026-06-24 audit batch.

## Alpha Gates

Stricter than the seven above. Adds:

1. **Live LLM via OpenRouter with explicit (model, provider) pair.**
2. **UTSUSHI-201..221 runtime port largely landed** — enough opcode VM,
   variable system, asset pipeline, and system-call dispatch to run a
   patched Sweetie HD scene on Linux.
3. **Full agentic loop fires.** Context-build + pre-translation +
   translation + QA agents + deterministic checks + editing/review
   cycles, all minimally functional and swappable. Output quality is not
   the bar; piece-swappability is.
4. **Real patchback** (not length-preserving only) with offset-table
   rewriting on Sweetie HD scene bytecode.
5. **Linux replay via `utsushi-reallive`** to the point where the
   localized scene renders.
6. **Verifiable patch evidence** — trace + frame capture (E2 or better)
   shows the patched scene rendered with the new text. Single-game
   (Sweetie HD) by definition.

Cross-ref [`project-readiness.md`](project-readiness.md) §2.2.

## Beta Gates

Multi-game-validation rule is the gate:

1. **≥2 real-world games per claimed engine family**, end-to-end.
2. **Encrypted variants land** for at least one per family.
3. **All claimed engine families** clear (1) and (2). Intent set today:
   RealLive, SiglusEngine, RPG Maker MV/MZ, plain KiriKiri/XP3 + KAG.
4. **Cross-engine substrate generality** — no per-engine shim leaks into
   substrate code.

Cross-ref [`project-readiness.md`](project-readiness.md) §2.3.

## Wave Priorities

Concrete per-node retag list lives in the parallel DAG re-tier proposal at
[`proposals/dag-retier-2026-06-24.md`](proposals/dag-retier-2026-06-24.md).
Immediate work surfaces:

- Close real-game-testing-ready gate (3): land
  `KAIFUU-188/189/190`.
- Close real-game-testing-ready gate (7): audit-findings dashboard.
- Replace kaifuu-reallive 47-byte synthetic smokes with real-bytes
  assertions (test-quality follow-up).
- Begin alpha work: `(model, provider)` pair surface (alpha gate 1),
  `UTSUSHI-201..221` runtime decomposition (alpha gate 2), full agentic
  loop wiring (alpha gate 3).

## Research Surfaces (read-only)

| Engine               | Title              | Path                                                      | Tier role                                               |
| -------------------- | ------------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| RealLive             | Oshioki Sweetie HD | `/scratch/itotori-research/sweetie-hd/extracted/`         | Alpha (single-game)                                     |
| RPG Maker MV/MZ      | Lust Memory        | `/scratch/itotori-research/rpg-maker-mv-mz/extracted/`    | Real-game-testing-ready (substrate corpus) / Beta (e2e) |
| Plain KiriKiri (XP3) | Bukkake Ranch      | `/scratch/itotori-research/kirikiri-plain/extracted/`     | Real-game-testing-ready (substrate corpus) / Beta (e2e) |
| Encrypted KiriKiri   | Wolf Girl          | `/scratch/itotori-research/kirikiri-encrypted/extracted/` | Beta                                                    |

## Standing Rules

Five rules, sourced from
`~/.claude/projects/-home-trevor-projects-itotori/memory/`:

- **`feedback_model_provider_pair`** — every model invocation declares
  `(modelId, providerId)` as a pair.
- **`feedback_no_legacy_compat`** — greenfield code deletes the legacy
  path in the same change.
- **`feedback_multi_game_validation`** — engine-family claims require ≥2
  real-world games of that engine.
- **`feedback_investigation_not_in_dag`** — research happens
  interactively against real bytes; nodes are written from research
  output.
- **`project_no_timeline`** — no eng-month/week/year estimates.

Authoritative anti-pattern enforcement:
[`orchestration-operating-model.md`](orchestration-operating-model.md).

## Where To Drill In

Audits — see [`audits/README.md`](audits/README.md) for the full index.
Quick pointers: `audits/alpha-scope-honesty.md` §D is the 2026-06-23
redefinition now called real-game-testing-ready;
`audits/dag-critique.md` surfaced UTSUSHI-146;
`audits/substrate-honesty.md` named M.1–M.5;
`audits/real-bytes-validation-2026-06-24.md` sourced KAIFUU-188/189/190;
`audits/non-reallive-fixture-needs-2026-06-24.md` mapped MV/MZ + plain
XP3 fixtures; `audits/silenced-2026-06-24.md`,
`audits/code-criticism.md`, `audits/test-quality.md`,
`audits/ci-state-2026-06-24.md` round out the batch.

Research: `research/reallive-engine.md`,
`research/reallive-engine-dag-proposal.md` (22-node decomposition),
`research/reallive-sweetie-hd-encryption-mechanism.md`.
