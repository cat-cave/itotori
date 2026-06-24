# Current State — 2026-06-24

Cold-start orientation for an orchestrator or subagent. Read this first; drill
into the named audit/research doc only when you need the evidence.

## Where We Stand

The alpha milestone was redefined on 2026-06-24 from "end-to-end runtime
evidence on Sweetie HD via a complete native RealLive port" to "architecture
proven on synthetic + real-bytes smoke, dogfoodable for a first localization
project." The redefinition lives at the top of
[`alpha-localization-project-readiness.md`](alpha-localization-project-readiness.md);
the body of that doc below the redefinition block is the long-term North Star,
not the alpha gate. `roadmap/spec-dag.json` is at **613 nodes** (209 ready);
`direnv exec . node scripts/spec-dag.mjs validate` reports valid. CI is green
locally (`just check` / `just test` / `just ci` / `just hello`). Four engine
research surfaces are staged read-only at `/scratch/itotori-research/`. Four
standing rules govern future work (see below).

## The 6 Alpha Gates

1. **Substrate extensions M.1–M.3 landed.** `UTSUSHI-222` (composite asset
   package + try-dir-then-archive resolver), `UTSUSHI-223` (snapshot envelope
   size class), `UTSUSHI-224` (`EnginePort` → substrate-sinks bridge with
   legacy `ObservationHookEvent` deleted). Each ships with multi-engine
   validation and same-change legacy deletion. M.4/M.5 (`UTSUSHI-225/226`)
   are RealLive-specific and continuous-tier.
2. **Non-synthetic engine port crate scaffolded.** `UTSUSHI-200` registers
   conformance against the substrate with the smallest credible opcode subset
   (call/return/text-display/wait), no author-fixture envelopes. Depends on
   M.1–M.3.
3. **Real-bytes smoke on Sweetie HD.** `kaifuu-cli detect` returns true,
   `parse_archive` returns a non-empty entry list, Gameexe classifies the
   dominant key families. Closed by `KAIFUU-188` (10000-slot envelope),
   `KAIFUU-189` (depth-N detector), `KAIFUU-190` (Gameexe key family
   expansion).
4. **Recorded-LLM bundle.** A reproducible recorded-provider run through
   draft → QA → patch export is reachable behind `ITOTORI_LIVE_PROVIDER=0`
   with deterministic outputs.
5. **Dashboard reachable.** `spec-dag-dashboard` renders DAG, claims, and
   audit state from real DB state, not fixtures.
6. **Repo hygiene.** `just check` / `just test` / `just ci` / `just hello`
   green; no silenced tests that represent real outstanding work
   (`audits/silenced-2026-06-24.md`); no foreign-tool subprocess invocations
   in production code.

## Wave A — What To Claim First

Three independent parallel streams; none blocks the others:

- **Substrate extensions.** `UTSUSHI-222` / `UTSUSHI-223` / `UTSUSHI-224`.
  Multi-engine validation against ≥2 real-bytes corpora; legacy deletion in
  same change.
- **Kaifuu real-bytes follow-ups.** `KAIFUU-188` / `KAIFUU-189` /
  `KAIFUU-190`, derived from `audits/real-bytes-validation-2026-06-24.md`.
- **Test-quality cleanup.** Replace the kaifuu-reallive 47-byte synthetic
  smokes (tautological — author-fixture round-trip) with real-bytes
  assertions gated on the documented Sweetie HD env vars. Tracked under the
  test-quality audit; no node-addition needed.

## Research Surfaces (read-only)

| Engine               | Title              | Path                                                      | Lang | Current scope     |
| -------------------- | ------------------ | --------------------------------------------------------- | ---- | ----------------- |
| RealLive             | Oshioki Sweetie HD | `/scratch/itotori-research/sweetie-hd/extracted/`         | JA   | Alpha (dogfood)   |
| RPG Maker MV/MZ      | Lust Memory        | `/scratch/itotori-research/rpg-maker-mv-mz/extracted/`    | EN   | Alpha (substrate) |
| Plain KiriKiri (XP3) | Bukkake Ranch      | `/scratch/itotori-research/kirikiri-plain/extracted/`     | EN   | Alpha (substrate) |
| Encrypted KiriKiri   | Wolf Girl          | `/scratch/itotori-research/kirikiri-encrypted/extracted/` | EN   | Continuous        |

User can source a JA original of the plain-KiriKiri title when needed; other
engines hold for now.

## Four Standing Rules

- **No timeline.** No eng-month/week/year estimates in DAG nodes, plans, or
  docs. Sized scope, not calendar promises. See
  [`feedback memory`](file:///home/trevor/.claude/projects/-home-trevor-projects-itotori/memory/project_no_timeline.md);
  mirrored as an anti-pattern in `orchestration-operating-model.md`.
- **No legacy-compat preservation.** Greenfield code deletes the legacy path
  in the same change — no shims, no `#[deprecated]` markers, no compat
  aliases. See
  [`feedback memory`](file:///home/trevor/.claude/projects/-home-trevor-projects-itotori/memory/feedback_no_legacy_compat.md);
  `orchestration-operating-model.md` §Legacy-path preservation.
- **Multi-game validation.** Engine-family claims require validation against
  ≥2 real-world games of that engine. Single-title pass is fixture-shaped.
  See
  [`feedback memory`](file:///home/trevor/.claude/projects/-home-trevor-projects-itotori/memory/feedback_multi_game_validation.md);
  `orchestration-operating-model.md` §Single-game validation.
- **Investigation is not a DAG node.** Research happens interactively against
  real bytes; concrete implementation nodes are written **from** research
  output, not as scaffolding for it. See
  [`feedback memory`](file:///home/trevor/.claude/projects/-home-trevor-projects-itotori/memory/feedback_investigation_not_in_dag.md);
  `orchestration-operating-model.md` §Investigation as a DAG node.

## What's NOT In Alpha

Continuous-tier post-alpha: the full RealLive runtime port
(`UTSUSHI-201..221`, 22 sub-nodes), the SiglusEngine port, RPG Maker MV/MZ
end-to-end on a real game (vs fixture vertical), encrypted XP3 + TJS, and
every engine in the "Continuous Expansion Candidates" section of the
readiness doc. The dogfood point feeds back into prioritizing this list.

## Where To Drill In

Audits — see [`audits/README.md`](audits/README.md) for the full index. Quick
pointers:

- `audits/alpha-scope-honesty.md` — milestone-level honesty check that drove
  the redefinition.
- `audits/dag-critique.md` — over-coarse-node review; surfaced UTSUSHI-146.
- `audits/substrate-honesty.md` — substrate cascade vs hypothetical RealLive
  port; named M.1–M.5 extensions.
- `audits/code-criticism.md` — load-bearing vs aspirational verdicts on every
  claimed-complete alpha capability.
- `audits/test-quality.md` — contract-vs-tautology grading of the ~2,000-test
  suite.
- `audits/ci-state-2026-06-24.md` — `just check`/`test`/`ci` diagnostic
  snapshot.
- `audits/real-bytes-validation-2026-06-24.md` — every kaifuu/utsushi CLI
  surface against real Sweetie HD bytes; sourced `KAIFUU-188/189/190`.
- `audits/non-reallive-fixture-needs-2026-06-24.md` — MV/MZ + plain XP3
  fixture-readiness map.
- `audits/silenced-2026-06-24.md` — silenced-test / ignored-failure /
  disabled-lint scan.

Research:

- `research/reallive-engine.md` — RealLive format research; reference for the
  port crate.
- `research/reallive-engine-dag-proposal.md` — 22-node decomposition of the
  former UTSUSHI-146.
- `research/reallive-sweetie-hd-encryption-mechanism.md` — Sweetie HD scene
  bytecode encryption mechanism probe.

Operating model: [`orchestration-operating-model.md`](orchestration-operating-model.md)
holds the four standing rules in their authoritative form.
