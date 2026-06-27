# DAG Re-Tier Proposal — 2026-06-24

Proposal only. Does not mutate `roadmap/spec-dag.json` or the schema. A
sibling subagent will write the mutation script after the maintainer
approves this proposal.

## Context

The milestone framework was redefined on 2026-06-24. The previous "alpha"
definition has been demoted to **real-game-testing-ready**. The new
4-tier model:

1. **real-game-testing-ready** — building blocks present, parsing layer
   validated against real bytes, workflow runs e2e with recorded
   providers + fixture data, Rust port crate scaffolded, dashboard
   reachable. Throwaway output.
2. **alpha** — Oshioki Sweetie HD localized e2e on Linux with real-bytes
   extraction, live LLM via OpenRouter with explicit `(model, providerId)`
   pair, full agentic loop (context + pre-translation + translation + QA
   agents + deterministic checks + edit/review cycles), real patchback,
   `utsushi-reallive` runtime running the patched game on Linux, verifiable
   patch via trace + frame capture / text-event introspection.
3. **beta** — ≥2 games per intended engine localized e2e, including
   encrypted variants. Multi-game-validation rule fully applies.
4. **full release** — most games in most common engines, by non-technical
   users, with rare bugs.

The current DAG only has `baseline | alpha | continuous`. This proposal
treats:

- Most existing `target: alpha` nodes (the entire MV/MZ vertical, the
  Siglus surface, the dashboard / QA / benchmarks foundation, the
  alpha-integration nodes that build on synthetic + MV/MZ fixtures) as
  **real-game-testing-ready** under the new framework — they are the
  scaffolding required to attempt the first dogfood pass; they are not
  what makes Sweetie HD localize e2e.
- A small set of existing alpha nodes (`ALPHA-006` and the Sweetie-HD
  side of the agentic loop) stays **alpha** under the new framework.
- The MV/MZ-positive engine vertical and the Siglus vertical move to
  **beta** — they prove the multi-game-validation rule (≥2 games per
  engine), not Sweetie HD's single-game alpha.
- UTSUSHI-201..221 promotes from continuous to **alpha** wholesale
  (minus UTSUSHI-219, which stays cancelled).
- KAIFUU-NEW-N1..N4 from the encryption-mechanism research doc and the
  agentic-loop bridge / live-LLM (model, provider) / `just
localize-sweetie-hd` / Linux replay validation nodes need minting.

## 1. Method

The audit scanned `roadmap/spec-dag.json` (613 nodes; jq-derived
counts) for every node with `target == "alpha"` and every node with
`target == "continuous"` that the new alpha definition might touch.

Classification rubric applied per node:

- **real-game-testing-ready** — was an alpha gate by the old definition
  (architecture proven on synthetic + real-bytes smoke; dashboard /
  benchmarks scaffolding; readiness profiles; MV/MZ fixture vertical;
  recorded-provider proofs). The new alpha needs more than the node
  delivers.
- **alpha** — required to localize Sweetie HD e2e on Linux: kaifuu
  real-bytes extraction, the agentic loop's minimally-firing stages,
  live (model, provider) call, patchback to writable copy,
  `utsushi-reallive` runtime + replay verification.
- **beta** — multi-game-validation work: MV/MZ-positive vertical,
  Siglus extraction adapter, encrypted XP3 variants, claimed-support
  regression infrastructure.
- **continuous** — does not fit any meaningful alpha runway slot.

For UTSUSHI-201..221, classification reads the 22-node decomposition
in `docs/research/reallive-engine-dag-proposal.md` against the new
alpha definition's runtime-runs-on-Linux clause; every sub-node that
the e2e Sweetie HD scene-1 replay needs is alpha. UTSUSHI-219 stays
cancelled per the investigation-not-in-DAG rule.

For continuous-tier promotion candidates, the audit looked for every
node that names live LLM, model-provider configuration, kaifuu
real-bytes Sweetie HD extraction, the editing/review cycle of the
agentic loop, and Linux-side runtime replay.

## 2. Current state inventory (before re-tier)

Targets:

| target     | total | complete | planned | in_progress | cancelled |
| ---------- | ----- | -------- | ------- | ----------- | --------- |
| baseline   | 2     | 2        | 0       | 0           | 0         |
| alpha      | 276   | 180      | 95      | 1           | 0         |
| continuous | 335   | 8        | 325     | 0           | 2         |
| **total**  | 613   | 190      | 420     | 1           | 2         |

Alpha-target priority breakdown:

| priority | count | complete                                                                               |
| -------- | ----- | -------------------------------------------------------------------------------------- |
| P0       | 3     | (KAIFUU-NEW-... TBD; current P0s: ITOTORI-116, UTSUSHI-102 planned; UNIV-021 complete) |
| P1       | 261   | ~178                                                                                   |
| P2       | 3     | 0                                                                                      |
| P3       | 9     | 2                                                                                      |

Continuous-tier cancelled: UTSUSHI-219 (research-only XOR-2 key
resolution — superseded by the encryption-mechanism probe), one other
existing cancellation. Continuous-tier in_progress: 0; complete: 8.

## 3. Re-tier classification

### 3.1 Alpha nodes that stay **alpha** (single-game Sweetie HD e2e)

Required for the Sweetie HD e2e clause; one-line justifications:

- **ALPHA-006** — First real-engine e2e alpha vertical (Sukara
  Sweetie HD). Criteria reword: live (model, providerId) +
  utsushi-reallive runtime + frame capture.
- **ALPHA-005** — Milestone aggregator. `dependsOn` rewritten
  against the new alpha tier (drop MV/MZ deps; add UTSUSHI-201..221
  alphas + the new §4 nodes).
- **ALPHA-008** — Sanitized live provider proof bundle. Tighten
  criteria to require (model, providerId) pair.
- **ITOTORI-116** (P0) — Public real-LLM proof harness; criteria
  must include (model, providerId) pair.
- **ITOTORI-117** — Real-LLM degenerate MTL baseline (comparative
  anchor for the agentic-loop alpha).
- **ITOTORI-022 / 024 / 038 / 042 / 081..084 / 118 / 023** — QA →
  feedback → repair → edit/review queue pipeline (edit/review-cycle
  clause).
- **ITOTORI-095 / 028 / 040 / 027** — fixture iteration runner,
  draft iteration command, workspace browse UX, cost+quality
  dashboard (full-agentic-loop-fires clause + live cost visibility).
- **UTSUSHI-200** (complete), **UTSUSHI-222/223/224** (complete,
  M.1–M.3 substrate) — runtime clause prerequisites.
- **UTSUSHI-147** — RealLive/Siglus shared substrate alignment;
  the runtime port needs the alignment.
- **KAIFUU-053** (in_progress) — Capability-leveled detector;
  Sweetie HD extraction depends on it.

Explicitly **not** in this list: MV/MZ vertical (KAIFUU-007,
UTSUSHI-006, UTSUSHI-031..033, UTSUSHI-119, etc.) and Siglus
adapter (KAIFUU-015, KAIFUU-022, KAIFUU-069/070, UTSUSHI-034..036)
— second-engine work, beta.

### 3.2 Alpha nodes that demote to **real-game-testing-ready**

Was an alpha gate by the old "architecture proven on synthetic +
real-bytes smoke" framing; still required, but pre-requisite
scaffolding rather than agentic-loop-fires clause. Grouped:

- **All ~180 already-`complete` `target: alpha` infrastructure
  nodes** — substrate baseline, bridge schema, catalog adapters,
  provider abstraction, context agents (scene summary, character
  relationship, route map, terminology candidate, speaker labeling),
  draft/QA/patch-export pipeline, runtime substrate facade
  (UTSUSHI-001..030 + UTSUSHI-050..120), M.1–M.3 substrate
  extensions. All stay `complete`; tier reclassifies to real-game-
  testing-ready. Justification: building-blocks-present clause.
- **Synthetic / dogfood scaffolding (planned)**: `ALPHA-001`,
  `ALPHA-002`, `ALPHA-003`, `ALPHA-004`, `ALPHA-007`, `ALPHA-009`
  (all target hello-world or MV/MZ); `CATALOG-003 / 004 / 061 / 007`
  (local corpus + benchmark seed + opportunity ranking + MV/MZ
  readiness); `ITOTORI-026 / 039 / 059 / 089..092 / 099 / 100`
  (benchmark harness + experiment + report renderers — except
  `ITOTORI-039` is on edge; flag for orchestrator if on the
  (model, providerId) ledger critical path); `KAIFUU-104` (synthetic
  encrypted readiness); `KAIFUU-171` (synthetic XP3 scaffolding);
  `UNIV-021` (DAG implementability lint, P0).
- **MV/MZ vertical alpha nodes**: see §3.3 — these go to **beta**,
  not real-game-testing-ready, because they prove a second engine
  family. Catalog/benchmark scaffolding goes real-game-testing-
  ready; engine-specific MV/MZ adapter work goes beta.

### 3.3 Alpha nodes that move to **beta**

Engine-family work outside Sweetie HD; beta is the right tier per
multi-game-validation (≥2 games per engine, including encrypted
variants):

- **MV/MZ family**: `KAIFUU-007 / 039 / 068 / 108 / 109 / 110 / 111 /
112 / 115 / 116 / 117`; `UTSUSHI-006 / 010 / 011 / 031 / 032 / 033
/ 065 / 102 (P0) / 119 / 133 / 134`. Justification: every node
  names MV/MZ; MV/MZ is not the alpha-defining engine. Note
  **UTSUSHI-102** demotes from alpha P0 to beta P1 — flag for
  priority review.
- **Siglus family**: `KAIFUU-015 / 022 / 069 / 070 / 094`;
  `UTSUSHI-034 / 035 / 036`. Justification: second-engine adapter
  surface. The shared substrate alignment node `UTSUSHI-147` stays
  alpha because the alpha runtime needs the alignment.
- **KAG / plain-KiriKiri family**: `KAIFUU-009 / 038 / 054 / 056 /
071 / 098`; `UTSUSHI-037 / 038 / 039`. Justification: second-
  engine breadth.
- **Encrypted-corpus helper infrastructure**: `KAIFUU-036 / 042 /
060 / 067 / 090 / 103 / 105 / 106 / 107 / 129`. Justification:
  encrypted variants are beta-defining ("≥2 games per engine,
  **including encrypted variants**"). If any helper subset is needed
  for Sweetie HD (e.g., `Gameexe.ini` publisher-table reading),
  promote that subset specifically; do not bulk-promote the whole
  encrypted-helper surface to alpha.

### 3.4 Alpha nodes that move to **continuous**

None of the audited alpha nodes belong at continuous tier under the
new framework; everything either stays alpha, demotes to
real-game-testing-ready, or promotes to beta. (Continuous is the
"doesn't fit anywhere meaningful for the alpha runway" residue;
nothing on the alpha list landed there cleanly.)

If the maintainer disagrees on the beta classification of any KAG /
XP3 / encrypted helper node, those are the candidates to push to
continuous instead. Surface the choice; do not bake it in.

### 3.5 Continuous nodes that promote to **alpha**

**UTSUSHI-201..221 — the RealLive runtime decomposition.**
Currently all `continuous`. Under the new alpha, "runtime runs the
patched game on Linux" means most of these become alpha:

All promote to **alpha** except UTSUSHI-219 (stays cancelled —
investigation-not-in-DAG rule; encryption-mechanism doc resolved
this interactively with `xor_2_pass = None` for Sukara):

- **UTSUSHI-201..206** — Seen.txt 10,000-slot directory parser,
  scene header parser, AVG32 LZ+XOR decompressor (Sukara `xor_2 =
None` default per the encryption-mechanism doc), bytecode element
  decoder, expression evaluator, variable banks. Foundation layer
  prerequisites for replaying any scene.
- **UTSUSHI-207** — Structured Gameexe.ini parser; resolves speaker
  names, system-call routes, NAMAE table.
- **UTSUSHI-208** — Bytecode VM fetch/decode/dispatch/advance; drives
  scene-1 to first textout.
- **UTSUSHI-209** — Text/messaging RLOperation family; emits the
  TextLine events the verifiable-patch clause checks for.
- **UTSUSHI-210..213** — Control-flow, choice (`select`), string/
  memory/arithmetic, system-call dispatch families. Required because
  scene-1 invokes these inline; without choice support the patched
  game freezes at the first `select`.
- **UTSUSHI-214..216** — Graphics object stack (headless), graphics
  RLOps, g00 image decoder. Frame-capture clause depends on these.
- **UTSUSHI-217** — Audio NWA+OVK decoders + AudioEvent emitter.
  Required so VM advances past `bgmPlay`/`koePlay` without stalling
  (metadata-only emission; no mixing).
- **UTSUSHI-218** — Save/load (AVG-derived). Required because Sweetie
  HD's autoboot writes `read.sav`; also reads `regname` for the
  publisher-table lookup feeding KAIFUU-NEW-N4.
- **UTSUSHI-220** — End-to-end Sweetie HD scene-1 text-replay smoke.
  **The alpha-defining node** — the gate's "runtime runs the patched
  game" clause is exactly this.
- **UTSUSHI-221** — Cross-engine substrate conformance + Siglus
  lineage notes. Alpha because UTSUSHI-220 depends on the substrate
  facade staying generic; cost is documentation-side.

**Substrate M.4 / M.5 (UTSUSHI-225/226)** stay continuous unless
UTSUSHI-220 implementation reveals them as blockers. Do not
pre-promote.

**KAIFUU-NEW-N1..N4** — encryption-mechanism follow-ups (research
doc §5). The mechanism probe bottomed out 2026-06-24 with Outcome A
(no Sukara xor_2). Under the new alpha framework, the **N1
decompressor** is genuinely kaifuu-side (and becomes `KAIFUU-NEW-A1`
in §4); the **N2 scene header parser** + **N3 BytecodeElement
decoder** + **N4 publisher-table use_xor_2 branch** are absorbed
into the UTSUSHI-201/202/203/204 promotions above (the
utsushi-reallive runtime crate owns the scene/header/bytecode side).
This is the no-legacy-compat reading: do not mint kaifuu-side
duplicates when the utsushi-reallive runtime owns the canonical
implementation.

Other continuous-tier promotions / non-promotions:

- **KAIFUU-191** (drop synthetic `#` opener) — **promote to
  alpha**; real-bytes extraction clause needs kaifuu-reallive's
  parser to handle real bytes, not synthetic openers.
- **KAIFUU-193** (extract/profile/verify partial output) — **promote
  to alpha**; patchback clause needs partial output to survive
  imperfect detector states for Sweetie HD's nested data dir.
- **KAIFUU-188 / 189 / 190** (complete) — tier reclassifies to
  **real-game-testing-ready** (parsing-layer-validated-on-real-bytes
  clause). Status stays `complete`.
- **Stays continuous**: KAIFUU-192 (diagnostic rollup), KAIFUU-185 /
  186 / 187 (quality improvements), ITOTORI-036 (local provider
  parity — OpenRouter is the alpha channel), ITOTORI-041 (non-text
  asset work), ITOTORI-114 (already covered by dashboard scaffolding).

### 3.6 Itotori agentic-loop edit/review search

The "edit/review cycles" clause is structurally covered by existing
alpha nodes ITOTORI-022 / 024 / 038 / 042 / 081..084 / 118 — no new
edit/review node needs minting. What needs minting is the (model,
providerId) wiring (§4.3 `ITOTORI-NEW-B1`).

## 4. New nodes to mint

Five new nodes (placeholder ids; sibling subagent assigns real ids
when ingesting):

### 4.1 `KAIFUU-NEW-A1` — RealLive AVG32 LZSS+XOR decompressor on real Sweetie HD bytes

- **Title:** kaifuu-reallive: AVG32 LZSS + 256-byte XOR decompressor
  (Sukara branch, second-level XOR disabled).
- **Target:** **alpha** (real-bytes extraction clause).
- **Summary:** Land `crates/kaifuu-reallive/src/compression.rs` —
  `decompress_scene(compressed: &[u8], dst_len: usize, xor_2_pass:
Option<&Xor2Pass>)`, restated from rlvm `compression.cc::Decompress`
  in our own words. Default `xor_2_pass = None` for Sukara-branch.
  256-byte AVG32 mask as `const`. Delete synthetic-envelope
  compressed path in same change (no-legacy-compat).
- **Acceptance criteria (observable):**
  1. With `ITOTORI_REAL_GAME_ROOT=...`, decompressor on
     scene-1's compressed payload (offsets `0x13a54..0x13e7a`, 1062
     bytes, `xor_2_pass=None`) produces exactly 1660 bytes.
  2. First 16 output bytes are
     `0a 02 00 0a 03 00 21 00 00 0a 04 00 0a 05 00 0a`.
  3. 8-byte preamble XOR'd vs `AVG32_XOR_MASK[0..8]` yields
     `(0x426, 0x67c)` u32 LE.
- **Depends on:** KAIFUU-188 / 189 / 190 (all complete).
- **Audit focus:** no-legacy-compat; rlvm source not vendored (mask
  is documented constant, restated); multi-game-validation
  (publisher table tested against ≥1 synthetic Key/VisualArts case).

### 4.2 `KAIFUU-NEW-A2` — Kaifuu real Sweetie HD scene bytecode → v0.2 bridge units

- **Title:** kaifuu-reallive: produce localization-bridge v0.2 bridge
  units from real Sweetie HD scene bytecode (text + choice surfaces).
- **Target:** **alpha** (bridges kaifuu real-bytes extraction to the
  itotori agentic workflow input — no existing node covers this).
- **Summary:** Walk decompressed bytecode (KAIFUU-NEW-A1 +
  KAIFUU-191) and emit `BridgeBundle` v0.2 units for textout +
  select/select_s/select_w. Speakers via `Gameexe.ini #NAMAE`;
  protected spans capture `0x80..0xFF` inline directives + Shift-JIS
  lead bytes. Delete synthetic-fixture bridge-emission path for
  RealLive in same change (no-legacy-compat).
- **Acceptance criteria (real-bytes, observable):**
  1. `cargo run -p kaifuu-cli -- extract <SWEETIE_HD>/REALLIVEDATA/Seen.txt
--scene 1 --bridge-out /tmp/sweetie-hd-scene-1.bridge.json`
     writes a schema-valid `BridgeBundle` v0.2 JSON.
  2. `units[]` length matches textout+choice element count from
     UTSUSHI-204 decoded stream.
  3. First text unit's `source.text` Shift-JIS-decodes non-empty;
     speaker resolved via NAMAE for ≥1 unit.
- **Depends on:** KAIFUU-NEW-A1, KAIFUU-191 (now alpha), UTSUSHI-207
  (Gameexe parser, now alpha), SHARED-001 (complete).
- **Audit focus:** no-legacy-compat (synthetic-fixture path deleted);
  investigation-not-in-DAG (observable bytes + schema-valid output);
  multi-game-validation (bundle schema testable on Sweetie HD alone
  for alpha; second Sukara title is sequencing).

### 4.3 `ITOTORI-NEW-B1` — `(modelId, providerId)` pair required field on ModelProvider

- **Title:** itotori-agent-runtime: make `providerId` required on
  `ModelProvider` / `ModelInvocationConfig`; propagate through cost
  ledger + recorded-LLM bundle key.
- **Target:** **alpha** (live LLM clause's standing rule, per
  `feedback_model_provider_pair.md`).
- **Summary:** Every model invocation declares the (model, provider)
  pair. Calls without explicit `providerId` must fail at compile
  time (TS) or panic with typed error (Rust) at construction. Update
  the types, bundle keys, and `draft_attempt_provider_ledger.provider_id`
  column; **delete** the old model-only surface same change.
- **Acceptance criteria (observable):**
  1. `pnpm exec vp run ts:typecheck` rejects a call site passing
     `modelId` without `providerId`.
  2. `git grep "ModelInvocationConfig::new_with_model"` is empty.
  3. Recorded-LLM bundle key schema includes both `modelId` and
     `providerId` (deterministic key test).
  4. Ledger row from a live call populates `provider_id` non-null.
- **Depends on:** ITOTORI-009 / 010 / 031 (all complete).
- **Audit focus:** no-legacy-compat (`git grep` invariant);
  (model, providerId) pair enforced not defaulted; multi-game does
  not apply (agent-runtime, not engine-family).

### 4.4 `ALPHA-NEW-C1` — `just localize-sweetie-hd` end-to-end command

- **Title:** suite: `just localize-sweetie-hd` wraps kaifuu extract
  → itotori agentic translate (live (model, providerId)) → kaifuu
  patch → utsushi-reallive replay → verify, in one command.
- **Target:** **alpha** (the e2e Sweetie HD on Linux clause,
  command-side).
- **Summary:** Justfile recipe + thin driver composing the four
  phases. Inputs: Sweetie HD source path (read-only), writable patch
  output dir, `(modelId, providerId)` env vars (ADR 0002), Itotori
  project id. Output: patched game directory + alpha-readiness proof
  manifest (per SHARED-025).
- **Acceptance criteria (observable):**
  1. With `OPENROUTER_API_KEY`, `ITOTORI_MODEL_ID`, `ITOTORI_PROVIDER_ID`
     exported, `just localize-sweetie-hd --project sweetie-hd-alpha-1`
     runs e2e on a writable copy of the extracted game.
  2. Agentic loop fires every stage exactly once for scene-1: context,
     pre-translation, translation, QA agents, deterministic checks,
     ≥1 edit/review cycle (auto or human).
  3. Output contains patched `REALLIVEDATA/Seen.txt` + JSON proof
     manifest naming each stage's artifact hash; recorded
     `(modelId, providerId)` matches env-provided pair byte-for-byte.
- **Depends on:** ALPHA-006, UTSUSHI-NEW-D1 (Linux replay),
  ITOTORI-NEW-B1, KAIFUU-NEW-A1, KAIFUU-NEW-A2, UTSUSHI-220,
  ITOTORI-038, ITOTORI-118, ITOTORI-022, ITOTORI-095.
- **Audit focus:** no-optionality (no "fallback to recorded provider"
  in live mode); investigation-not-in-DAG (criteria name exact env
  vars + exit code + artifact paths); multi-game-validation does not
  yet apply (single-game by alpha definition).

### 4.5 `UTSUSHI-NEW-D1` — Linux-side replay validation (frame capture + text-event introspection)

- **Title:** utsushi-reallive: Linux replay validation of patched
  Sweetie HD scene-1 — frame capture + text-event introspection.
- **Target:** **alpha** (verifiable-patch-landed clause).
- **Summary:** Linux driver runs `utsushi-reallive::replay_scene`
  against the **patched** `Seen.txt` (round-tripped through
  KAIFUU-NEW-A2 + patchback) and emits (a) headless frame-capture
  PNGs from the graphics object stack and (b) `TextSurfaceEvent`
  stream. Patched TextLine bodies must differ from source Shift-JIS
  (proves patch landed); frame structural shape (object count +
  region geometry) must match source replay (proves patch didn't
  break the runtime). Linux-only — no `Command::new("wine ...")`.
- **Acceptance criteria (observable):**
  1. `cargo run -p utsushi-reallive --bin replay-validate-sweetie-hd
-- --patched-seen=<patched>/REALLIVEDATA/Seen.txt
--source-seen=<SWEETIE_HD>/REALLIVEDATA/Seen.txt --scene=1
--out=/tmp/sweetie-hd-replay/` exits 0.
  2. `<out>/text-events.json` lists ≥1 TextLine whose body is the
     localized target text (not Shift-JIS source).
  3. `<out>/frame-0001.png` is 1280x720 (per `SCREENSIZE_MOD`);
     object count matches source replay at same scene-tick. Two
     runs produce byte-identical outputs.
- **Depends on:** UTSUSHI-220, UTSUSHI-214/215/216, UTSUSHI-209,
  KAIFUU-NEW-A2.
- **Audit focus:** no-optionality (frame capture not optional);
  Linux-not-Wine clause; investigation-not-in-DAG (all criteria name
  observable artifacts); multi-game does not yet apply.

Plus an acceptance-criteria amendment (not a new node) on the
in-progress `KAIFUU-053` (capability-leveled detector registry) to
verify the detector returns the correct capability level for Sweetie
HD's nested `REALLIVEDATA/` path.

## 5. Re-tier summary

Counts under the proposed re-tier:

| movement                                     | count                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| alpha → real-game-testing-ready              | ~210                                                                                                    |
| alpha → alpha (kept)                         | ~28                                                                                                     |
| alpha → beta                                 | ~36                                                                                                     |
| alpha → continuous                           | 0                                                                                                       |
| continuous → alpha                           | 21 (UTSUSHI-201..221 minus UTSUSHI-219 cancelled = 20; plus KAIFUU-191, KAIFUU-193) — net 22 promotions |
| continuous → real-game-testing-ready         | 3 (KAIFUU-188/189/190 complete; tier reclassification only)                                             |
| new alpha nodes to mint                      | 5                                                                                                       |
| **Total alpha (proposed)**                   | ~55                                                                                                     |
| **Total real-game-testing-ready (proposed)** | ~213                                                                                                    |
| **Total beta (proposed)**                    | ~36                                                                                                     |
| **Total continuous (proposed)**              | ~302                                                                                                    |
| **Total baseline (proposed)**                | 2                                                                                                       |
| **Total (incl. minted)**                     | 618                                                                                                     |

Counts are approximate because:

- The classification of the encrypted-helper subset depends on
  which specific helper Sweetie HD needs at runtime (e.g., reading
  `Gameexe.ini` `#REGNAME` for the publisher-table lookup — that
  subset may stay alpha; the rest moves to beta).
- The substrate M.4 / M.5 question (UTSUSHI-225/226) is parked at
  continuous until UTSUSHI-220 implementation reveals whether they
  are blockers.
- ITOTORI-039 (provider experiment reporting) is on the edge
  between real-game-testing-ready and alpha; flag for orchestrator
  review.

**What alpha looks like under the new framework (one paragraph):**

Alpha is the point at which a single command — `just
localize-sweetie-hd` with an explicit `(modelId, providerId)` pair
exported in the environment — reads real Sukara Sweetie HD scene
bytecode through the kaifuu real-bytes path, drives the full
itotori agentic loop (context building + pre-translation +
translation + QA agents + deterministic checks + at least one
edit/review cycle, all minimally functional), patches the
extracted bytes back onto a writable copy of the game, runs the
patched scene through the `utsushi-reallive` runtime on Linux
(not Wine, not Windows), and verifies the patch landed via frame
capture PNGs and `TextSurfaceEvent` introspection. Alpha output is
allowed to be worse than MTL; what matters is that the entire
pipeline fires so that swapping any single stage ("this QA agent
isn't useful; let's try X") is a small change rather than a
bricked system.

## 6. Schema change

The current `target` enum:

```json
"target": {
  "type": "string",
  "enum": ["baseline", "alpha", "continuous"]
}
```

Proposed new enum (additive plus retained, since real-game-testing-
ready is the **new** intermediate and existing alpha nodes that
demote need a place to land):

```json
"target": {
  "type": "string",
  "enum": [
    "baseline",
    "real-game-testing-ready",
    "alpha",
    "beta",
    "continuous"
  ]
}
```

The implicit ordering used by `validateAlphaReadinessPath` and
`targetRank` in `scripts/spec-dag.mjs` (`baseline: 0, alpha: 1,
continuous: 2`) becomes:

```js
const targetRank = {
  baseline: 0,
  "real-game-testing-ready": 1,
  alpha: 2,
  beta: 3,
  continuous: 4,
};
```

### Cascading rule change: ALPHA-005 ancestor requirement

The current validator rule (`scripts/spec-dag.mjs:735-750`)
requires every non-complete `P1` `target: alpha` node to be an
ancestor of `ALPHA-005`. Under the new framework, two hubs are
appropriate:

- `ALPHA-005` (existing) — milestone hub for the new alpha tier
  (single-game Sweetie HD e2e). Validator rule stays: every
  non-complete P1 `target: alpha` node must be an ancestor of
  `ALPHA-005`. The proposed re-tier rewires `ALPHA-005.dependsOn`
  to point at the new alpha set (drop MV/MZ deps; add
  UTSUSHI-201..221 alphas, KAIFUU-NEW-A1/A2, ITOTORI-NEW-B1,
  ALPHA-NEW-C1, UTSUSHI-NEW-D1).
- **New hub `RGT-005` (mint as part of schema change)** — milestone
  hub for real-game-testing-ready. A new validator rule should
  require every non-complete P1 `target: real-game-testing-ready`
  node to be an ancestor of `RGT-005`. This catches the demoted
  "dogfoodable for first project" scaffolding (ALPHA-001..009 minus
  ALPHA-005/006/008, plus the catalog / benchmark / dashboard
  planned nodes).

Beta does not yet need its own hub since beta nodes are not
near-term schedulable; the validator can defer that until the first
beta-tier node is claimed. **Recommend:** ship the schema change
with the alpha + real-game-testing-ready hub rules; add the beta
hub rule in a follow-up node when the first beta work claims.

Continuous tier rule does not change (no hub requirement).

### `parallelGroup` enum addition

The existing `alpha-integration` and `milestone` groups suffice;
add nothing new. (The new `ALPHA-NEW-C1` lands in `milestone` or
`alpha-integration`; `KAIFUU-NEW-A1` / `KAIFUU-NEW-A2` lands in
`engine-adapters`; `ITOTORI-NEW-B1` lands in `agent-runtime`;
`UTSUSHI-NEW-D1` lands in `runtime-adapters`.)

### Migration path

Sibling mutation subagent should:

1. Apply the schema diff above (atomic).
2. For each existing node listed in §3.1–§3.5, update its
   `target` field per the classification table.
3. Mint the five new nodes in §4 with the placeholder ids
   replaced by next-available sequential ids.
4. Mint `RGT-005` milestone hub node.
5. Rewire `ALPHA-005.dependsOn` per §6 cascading-rule note.
6. Update `metadata.priorityDefinitions` / `statusDefinitions` if
   any new wording is needed (none required by this proposal).
7. Run `direnv exec . node scripts/spec-dag.mjs validate` until
   green; iterate on dependsOn rewrites until validator passes.

The mutation script is **not** part of this proposal — sibling
subagent owns that step after maintainer approval.

## Appendix: nodes not yet examined

The 335 continuous-tier nodes outside the UTSUSHI-201..221 +
KAIFUU-19x + ITOTORI-03x bands were not individually classified —
nothing in the new alpha definition touches them, so they all stay
`continuous` by default. Bands not exhaustively walked:

- CATALOG-014..210 (catalog source adapters beyond the alpha set)
- KAIFUU-005..183 outside the alpha + 188..193 band
- ITOTORI-100..157 outside the alpha + 110..118 + agentic-loop band
- UTSUSHI-040..199 outside the alpha + 200..226 band
- SHARED-016..025 outside the alpha set

If any of these unexplored nodes get flagged by the maintainer as
relevant to the new alpha, the sibling mutation subagent should
re-classify them at ingestion time using the rubric in §1; this
proposal does not pretend to cover them.
