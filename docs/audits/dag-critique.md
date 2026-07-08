# DAG Critique — Over-Coarse Nodes and Vague Acceptance Criteria

This audit examines `roadmap/spec-dag.json` for nodes whose scope or
acceptance criteria are loose enough that a worker could deliver a thin
wrapper and legitimately "pass." Every verdict cites the merged code or
named gap. **No code or DAG edits in this commit** — the document is a
recommendation, not a change.

The user's flagship complaint is `UTSUSHI-146` ("the entire RealLive
runtime port" as one node). It is the most extreme instance, but the
pattern is broader. The DAG has 273 alpha-target nodes; 165 are
`complete`, 106 are `planned`, 2 are `in_progress`. We reviewed every
alpha-target node, triaged each as ok / problem, and went deeper on
problems. A node is flagged when its acceptance criteria do not name
observable file paths, exact command outputs, hashes, byte counts, or
seam-specific test cases — i.e. when the criteria are vague enough that a
fixture-only smoke can satisfy them.

Verdict legend:

- **theater** — work that exists but proves something other than what
  the title promises (e.g. synthetic fixture standing in for a real port);
- **coarse** — scope is correct but combines too many irreversible
  decisions into one merge;
- **vague** — scope is correct but acceptance criteria let a worker
  ship a partial implementation;
- **split-needed** — work cannot be safely audited as one node and
  should be decomposed before claim;
- **ok** — kept as is.

---

## A. Engine port nodes (the flagship complaint)

### A.1 UTSUSHI-146 — RealLive runtime port (rlvm research anchor)

**Current title:** "RealLive runtime port (rlvm research anchor)"
**Status:** planned (P1, alpha).

**Current acceptance criteria (verbatim):**

1. The runtime port is built on the UTSUSHI-120 substrate facade and does not import substrate internals directly.
2. Scene/SEEN replay produces deterministic trace and snapshot evidence through Utsushi runtime contracts.
3. Headless render and deterministic clock/input land through the substrate sinks, not engine-specific shortcuts.
4. rlvm is referenced only as a research anchor (provenance, license, and clean-room boundary notes) and never invoked as a binary.
5. Out-of-profile or unsupported scenes emit semantic diagnostics rather than silent skips.

**Verdict:** split-needed (severe). This is the user's flagship example
and the diagnosis is correct: AC2 ("Scene/SEEN replay produces
deterministic trace and snapshot evidence") covers what is in rlvm
several hundred KLOC of C++ — VM dispatch, ~500 RealLive opcodes,
Gameexe-driven configuration, save state, text window/window-rule
rendering, the SDL/audio sinks, and the GAN animation runtime — all
behind one "trace and snapshot evidence" phrase.

**Why a thin wrapper passes:** Today `crates/kaifuu-reallive` has 3,318
LOC of pure-Rust parsing (archive, parser, ast, opcodes, gameexe,
inventory, patchback). A worker could:

1. Build a `utsushi-reallive` crate that re-imports `kaifuu_reallive::parse_archive` + `parse_scene`,
2. Walk the scene linearly emitting one `text` observation per dialogue slot it already recognizes (`crates/kaifuu-reallive/src/strings.rs:1-51`),
3. Pipe that through the `EnginePort` trait at `crates/utsushi-core/src/port/trait_.rs` and `port/conformance.rs`,
4. Stamp every other opcode as `unsupported_capability`,

and pass AC1-AC5 with one synthetic SEEN.TXT fixture similar to the
existing `crates/kaifuu-reallive/tests/fixtures/smoke-scene-001/SEEN.TXT`
(47 bytes: `#s Aoi#s Hello!#s Yess No#`). No actual VM, no Gameexe-driven
font/window state, no GAN frame, no real Sukara title byte ever
exercised. The 3.8 MB `Seen.txt` from
`/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt`
is 79,000× larger than the smoke fixture and would never touch this
"port."

**Citations:**

- `crates/kaifuu-reallive/tests/fixtures/smoke-scene-001/SEEN.TXT` — 47-byte synthetic envelope all three KAIFUU-173/174 tests run against.
- `crates/utsushi-core/tests/engine_port.rs:1-80` — UTSUSHI-103's "production engine port" conformance uses only synthetic `ReferencePort`/`MissingObservePort`/etc. defined in the test file. No real engine exercises the runner ABI yet.
- `roadmap/spec-dag.json` UTSUSHI-160 (planned) — the node whose existence proves this gap: "first production engine port consumes ConformanceManifest." Until it lands, the conformance surface only proves itself.

**Proposed action — split into 7 sub-nodes:**

| Suggested id | Scope                                                                                                                   | Acceptance hook                                                                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTSUSHI-146a | `utsushi-reallive` crate scaffold + clean-room/license attestation + `EnginePort` trait wiring (no logic)               | `cargo test -p utsushi-reallive` produces a `clean-room-attestation.json` artifact naming rlvm commit, license, and which subsystems were studied vs not copied. Zero opcode handlers permitted at this stage.                                                                            |
| UTSUSHI-146b | RealLive VM dispatch loop for a declared **opcode subset list** (~30 opcodes covering scene flow, text, choices, jumps) | Test runs every listed opcode against a fixture and emits a typed event; out-of-list opcodes return `unsupported_opcode { opcode_id }` with a stable diagnostic code. Reviewer must approve the exact list before merge.                                                                  |
| UTSUSHI-146c | Gameexe.ini driven configuration loader and substrate-facade sink wiring (text window, font, language)                  | A second fixture varies Gameexe values and the trace varies deterministically; missing/unknown Gameexe keys are typed diagnostics, not silent defaults.                                                                                                                                   |
| UTSUSHI-146d | Scene/SEEN replay against the Sweetie HD `Seen.txt` (3.8 MB) bytes through the vault adapter (KAIFUU-176)               | Replay over the real `Seen.txt` enters at least N scene entries (declared in the AC), records every encountered opcode, and surfaces an explicit `unsupported_opcode_observed` count. This is the AC that actually tests a port.                                                          |
| UTSUSHI-146e | Deterministic clock/input wiring through `UTSUSHI-021` for choice branches                                              | Choice traversal driven by an input log produces identical trace hashes on two runs; choice opcodes route through `crates/utsushi-core/src/input.rs` rather than RealLive-internal hooks.                                                                                                 |
| UTSUSHI-146f | Snapshot primitives wiring through `UTSUSHI-023` for save/restore drift                                                 | A snapshot in the Sweetie HD scene tree restores byte-identically; mutated snapshots fail with `StatePath` diagnostics per the UTSUSHI-028 contract.                                                                                                                                      |
| UTSUSHI-146g | Conformance manifest registration + UTSUSHI-160 closure                                                                 | `crates/utsushi-reallive` registers a real `ConformanceManifest`, runs `cross_validate_results_against_manifest` (per `crates/utsushi-core/tests/conformance_cross_validation.rs`) on a non-synthetic adapter id, and emits drift findings as separate audit reports. Closes UTSUSHI-160. |

Sequence: 146a → 146b → 146c → 146d (depends on KAIFUU-176, already
complete) → 146e/146f in parallel → 146g.

### A.2 UTSUSHI-147 — RealLive/Siglus shared substrate alignment

Status: planned. Acceptance criteria depend transitively on UTSUSHI-146
_and_ UTSUSHI-034 (Siglus VM smoke). The node's job is "prove both ports
share one API surface," which is reasonable, but it currently expects to
land after a single-shot 146.

**Verdict:** vague (depends on a split parent). After UTSUSHI-146 is
split, UTSUSHI-147 stays a single node but its acceptance criteria
should be tightened to: "the conformance fixture lists the exact API
calls each engine makes, and a drift between RealLive and Siglus on any
of those calls fails the fixture with a _named_ call-site diagnostic
rather than 'shape differs.'" Otherwise both engines could share a
diluted API surface and pass.

### A.3 KAIFUU-173 / KAIFUU-174 — RealLive parser & inventory adapter (already marked complete)

**Verdict:** theater (in part). These nodes are marked complete and the
code is real (3,318 LOC), but every test fixture is the synthetic
`#s Aoi#s Hello!#s Yess No#`-class envelope. The acceptance criterion
"the adapter is engine-generic across AVG32-variant RealLive titles, not
specialized to one game" cannot be evidenced by 47-byte fixtures.

**Proposed action — do NOT reopen the nodes** (the contract scaffolding
is genuinely landed and protected by 30+ unit tests), but **add two
follow-up DAG nodes**:

- `KAIFUU-173b`: Inventory the _real_ Sweetie HD `Seen.txt` and emit a redacted opcode-frequency report. AC: the inventory must encounter at least three unsupported_opcode kinds and the report must list them by RLDEV-style mnemonic. This is the first time the parser meets bytes it didn't author. Depends on KAIFUU-176 (complete).
- `KAIFUU-174b`: Round-trip a non-trivial slot replacement on a real-game scene and verify byte-for-byte equality of the non-string regions. AC names a specific scene id and a byte budget. This puts pressure on `crates/kaifuu-reallive/src/patchback.rs` (534 LOC) against bytes the author did not control.

These belong in the continuous tier — not alpha-blocking — but should
exist so KAIFUU-173/174 are not the load-bearing evidence for the engine
claim.

---

## B. Substrate nodes (already complete)

The substrate slices (UTSUSHI-020/021/022/023/056/103/120) are
load-bearing scaffolding, _not_ theater. Tests in
`crates/utsushi-core/tests/substrate_*.rs` (802 + 251 LOC + 6,494 LOC
across the tests directory) actually exercise the API surface with
multiple synthetic ports including drift/missing/leaked variants. The
crate's `lib.rs` is 5,665 LOC of typed substrate.

**Verdict for UTSUSHI-020/021/022/023/025/026/056/103/120:** ok. They
correctly limit themselves to the facade and have negative fixtures that
would catch silent regression.

However:

- **UTSUSHI-103** ("Engine-port runner crate template and ABI conformance") is marked complete with only synthetic ports. The AC "the fixture port passes ABI conformance checks" is satisfied by `crates/utsushi-core/tests/engine_port.rs`'s in-file `ReferencePort`. The _intent_ — that a real engine port wires the template — is owned by **UTSUSHI-160** (still planned). This is _not_ theater because UTSUSHI-160 explicitly exists to close the loop, but the orchestrator should be careful not to count UTSUSHI-103 as evidence that a real engine port works.

- **UTSUSHI-120** (substrate facade) AC4 says "this node does not implement new VFS, clock, snapshot, recording, or reference-recorder behavior beyond exposing and testing the stable facade." Good — the negative criterion is explicit. **Recommended pattern for other nodes:** every substrate-style node should have an AC of the form "this node does NOT implement X" to prevent scope creep.

**No splits proposed for substrate nodes.**

---

## C. Conformance / fixture nodes

UTSUSHI-027 / 028 / 029 / 030 / 060 / 062 / 063 / 064 — all complete.

These nodes test _the conformance system_, which is the right scope:
without UTSUSHI-160 (a non-synthetic adapter registered through them),
they prove only that the schemas reject malformed input. That is
genuinely useful — engine ports cannot smuggle inflated evidence
tiers through ingestion — but the orchestrator should not let
"conformance is complete" act as evidence that "the engines work."

**Verdict:** ok with one tightening.

**Proposed tightening (UTSUSHI-030):** the acceptance criterion
"Itotori ingests conformance reports while preserving adapter evidence
tier and fidelity tier separately" is currently checked by typed TS
validators against fixture JSON. Add an AC: "an integration test
ingests a conformance report whose adapter*id was \_not* defined inside
the test crate" — i.e., import a fixture from another crate. This
guards against the worker pattern of declaring the adapter in the same
file as the assertion.

UTSUSHI-062/063/064 are similar — narrow, well-specified, with negative
fixtures. No splits needed.

---

## D. Engine adapter nodes (Kaifuu)

### D.1 KAIFUU-038 — KiriKiri XP3 profile proof command

**Verdict:** ok. The AC names a specific command, exact profile
categories (plain, encrypted, helper-required, protected executable),
and exact diagnostic outputs. The node will pass only when the four
distinct capability outcomes appear. No split.

### D.2 KAIFUU-039 — MV/MZ encrypted media readiness command

**Verdict:** ok. AC names specific file extensions (`.rpgmvp`,
`.rpgmvm`, `.rpgmvo`), exact media kinds, and a clear negative
condition ("never claims dialogue extraction or script patch support
based only on media-key detection"). No split.

### D.3 KAIFUU-115 / KAIFUU-116 — MV/MZ encrypted image / audio decrypt and re-encrypt

**Verdict:** ok. These are scoped to _exactly one codec each_ with a
declared engine_family/variant/container/crypto/codec/surface tuple and
proof-hash AC. They are deliberately small. The AC pattern here is the
gold standard the rest of the DAG should imitate.

### D.4 KAIFUU-007 — RPG Maker MV/MZ adapter integration shell

**Verdict:** vague. AC "The integration composes readiness records,
map/common-event JSON, database/system/terms JSON, and plugin-profile
diagnostics" lets a worker stitch existing readiness fixtures together
without writing the JSON adapter logic.

**Proposed tightening (no split):** require AC that names byte-level
JSON round-trip — "a representative `data/Map001.json` from the public
MV/MZ fixture extracts N message events and patches them back to a
byte-identical file modulo the translated string slots." Without that,
"composes" is theater.

### D.5 KAIFUU-090 / KAIFUU-129 — Wine Proton / native helper dry-run

**Verdict:** ok. Dry-run scope is honestly stated. AC names the helper
binary id, command argv, working-directory policy, redaction policy.
No split.

---

## E. Workflow nodes (Itotori agents)

### E.1 ITOTORI-013 / 014 / 015 / 016 — scene summary / character / route / terminology agents

ITOTORI-013 is in_progress; ITOTORI-014/015/016 are complete.

The four agents share an identical file layout
(`apps/itotori/src/agents/<name>/{agent,cli,index,persistence,prompt-template,shapes,staleness}.ts`),
totaling 2,254 LOC for just two of them. This is the cross-cutting
pattern the user asked us to surface.

**Verdict (ITOTORI-014/015/016 complete):** the acceptance criteria are
vague but the implementation appears genuine. AC like "Character claims
cite scenes or lines," "Static bridge edges and runtime branch
observations can coexist," "Candidates include evidence and frequency"
are satisfied by mock-model tests in
`apps/itotori/test/{character-relationship,route-choice-map,terminology-candidate}-agent.test.ts`.

**The vagueness lets the LLM-gating defenses go untested.** The "manual:
Mock model tests" verification is honest about what it tests (mocks),
but the AC "No character relationship or route mapping scope creep" or
"Human escalation is reserved for material conflicts" can be passed by
fixture-only assertions. There is no current AC that requires the agent
to refuse invalid LLM output in a way that survives an adversarial
prompt.

**Proposed action:** do not re-open the complete nodes; instead add one
continuous-tier hardening node per agent (or one umbrella node):

- `ITOTORI-013/014/015/016 hardening`: "Each agent rejects adversarial structured outputs — empty citations, citations referencing nonexistent source unit ids, citations referencing source units outside the requested scene window, and prompt-injection-style fields embedded in summary text — with named error types." AC names specific error class names so a worker cannot dilute "rejected" to "logged a warning."

### E.2 ITOTORI-013 (in_progress) — specific tightening

ITOTORI-013 has AC "Summaries cite covered units." The agent already
emits `cited_unit_ids: string[]`; the gap is that "covered units"
isn't defined. Tighten before merge: "every cited unit id must resolve
to a source unit referenced by the prompt's bridge window, and an
agent output containing zero cited units fails persistence with
`SceneSummaryUncitedError`." This is a single AC tightening, not a
split.

### E.3 ITOTORI-018 — Batch planner and context packer

**Verdict:** ok (complete). The AC "Works for tiny games and
million-character projects" is met by
`apps/itotori/src/batch-planner/planner.ts` (374 LOC) plus the
large-synthetic fixture test. Token budgeting is explicit. Keep.

### E.4 ITOTORI-074 — Draft job schema and repository

**Verdict:** ok. AC is concrete: enumerates `draft_jobs`,
`draft_job_attempts`, foreign keys, retry-state constraints. This is
the right granularity. No split.

### E.5 ITOTORI-019 — Translation drafting fixture command

**Verdict:** vague. AC "The command writes drafts through the same
repository and event path used by normal localization jobs" requires no
LLM to actually translate. A fixture command that echoes source text
into the draft repository would pass.

**Proposed tightening (no split):** "Drafts must (a) be produced by a
real model invocation through the LLM provider abstraction
(ITOTORI-009), not by an in-test stub, and (b) pass protected-span
validation (ITOTORI-076) before persistence. The recorded fixture used
in CI must contain at least one provider response with intentionally
malformed structured output, and the corresponding draft must NOT land
in the repository." This blocks the echo-back implementation.

### E.6 ITOTORI-021 — LLM QA agents and scored findings

**Verdict:** vague. AC "Each agent owns a narrow issue class" and
"Scores require findings that explain the gap" are subjective enough to
pass with any LLM call that returns a finding-shaped object.

**Proposed action — split into 4 sub-nodes** (one per issue class):

- `ITOTORI-021a`: Style-adherence QA agent. AC: against the seeded-defect corpus (ITOTORI-032), the agent detects at least the named seeded style violations and emits NO findings outside the style class.
- `ITOTORI-021b`: Semantic-drift QA agent. AC: seeded semantic-drift defects are detected; style-only mutations do NOT produce semantic findings.
- `ITOTORI-021c`: Tone/register QA agent.
- `ITOTORI-021d`: Unresolved-terminology QA agent.

Each sub-node has a concrete precision/recall floor against the seeded
corpus. This is the only way to enforce "each agent owns a narrow class"
because today the seam is not testable.

### E.7 ITOTORI-022 — Finding triage and root-cause router

**Verdict:** vague. AC "Root-cause hypotheses cite evidence" passes
trivially.

**Proposed tightening:** "For each of the seven hypothesis classes
(translator, stale_context, source_annotation, glossary_conflict,
style_guide, kaifuu_patching, runtime_evidence), the seeded corpus
contains at least one fixture, and the router classifies it to the
correct class in N% of cases declared in the AC." Without a seeded
classifier corpus, the AC is not falsifiable.

### E.8 ITOTORI-035 — Asset localization decision workflow

**Verdict:** ok. The AC is honest about the scope (policy decisions,
not asset patching). The "metadata-only assets can be tracked without
patch support" carveout is good. No split.

---

## F. Patching nodes

### F.1 KAIFUU-010 — Patch result and verification v0.2

**Verdict:** ok (complete). AC enumerates exact enum members, exact
field names, exact failure categories, exact negative fixture file
names. Negative fixtures live at
`packages/localization-bridge-schema/test/examples/invalid/`. This is
the gold-standard contract node. Keep.

### F.2 KAIFUU-011 — Binary patcher composed smoke command

**Verdict:** theater (mild). The smoke command exists at
`crates/kaifuu-cli/src/binary_patch_smoke.rs` (580 LOC). It composes
KAIFUU-174 (RealLive apply_patches) + KAIFUU-084 (transaction harness)

- KAIFUU-010 (PatchResultV02 emission). But the default fixture is a
  **deterministic 47-byte SEEN.TXT envelope** with a fixed
  length-preserving patch
  (`crates/kaifuu-cli/src/binary_patch_smoke.rs:66-72`). The
  `fixture_dir` parameter is optional. The AC "exercises the shared
  binary patcher API rather than duplicating primitive behavior" is met,
  but the AC says nothing about the input size or surface variety.

**Proposed action — add one alpha follow-up node:**

- `KAIFUU-011b` ("Binary patcher real-archive smoke"): "Run the
  composed smoke against the Sweetie HD `Seen.txt` (3.8 MB, vault
  adapter). Patch a named scene's first text slot to a longer
  translation; the v0.2 PatchResult records `patch_write_failed` →
  `protected_span_violation` → `output_hash_mismatch` paths under
  test-seam failure injection; non-patched bytes are byte-identical
  to the input." This proves the patcher on actual game bytes.

### F.3 KAIFUU-084 — Binary patch rollback and no-write preflight harness

**Verdict:** ok. AC names specific transaction states (preflight,
staged write, verify, promote, rollback) and specific failure modes
(byte-budget, relocation, hash, transform). The negative fixtures are
real. Keep.

### F.4 KAIFUU-174 — RealLive AVG32-variant text inventory adapter

Already covered under section A — verdict theater (in part) on
"engine-generic across AVG32-variant titles." Follow-up node proposed
in §A.3 covers the gap.

---

## G. Cross-cutting findings

### G.1 Synthetic-fixture-as-engine-evidence pattern

Multiple "engine" nodes (KAIFUU-173, KAIFUU-174, KAIFUU-011's default,
UTSUSHI-103) prove themselves on tiny synthetic fixtures authored
alongside the test. The orchestrator should not count a node as
"engine evidence" until a follow-up node has driven it against bytes
the author did not control. UTSUSHI-160 is the only existing node that
encodes this principle; it should be replicated for every adapter.

### G.2 Identical 7-file agent scaffold proves nothing about narrowness

Every workflow agent (ITOTORI-013/014/015/016) ships with the same
seven files: `agent.ts`, `cli.ts`, `index.ts`, `persistence.ts`,
`prompt-template.ts`, `shapes.ts`, `staleness.ts`. The AC for "narrow
issue class" or "no scope creep" is enforced today by file boundaries,
not by the AC. A cross-cutting refactor opportunity exists — extract
the citation / staleness / prompt-version surface as a shared module
and let agents differ only in shapes + prompt — but more importantly,
the _acceptance criteria pattern_ should be a seeded-corpus precision /
recall floor, not a file layout.

### G.3 "Smoke command" nodes default to synthetic fixtures

`patcher-smoke`, the RealLive smoke, the conformance "smoke" tests —
all default to inline fixtures. The phrase "smoke" has come to mean
"happy path with author-controlled bytes." Suggested DAG hygiene: every
node titled `<X> smoke` must declare in its AC either (a) the path of a
non-author fixture it runs against, or (b) an explicit negative AC
"this node does NOT prove behavior against non-synthetic input; see
`<follow-up node id>`."

### G.4 "Composes" / "integrates" titles hide the work that wasn't done

ITOTORI-026 ("Benchmark harness integration") AC: "the integration
does not implement provider routing, corpus selection, QA scoring, or
report rendering beyond composing prerequisite outputs." This is honest
and good. By contrast, KAIFUU-007 ("RPG Maker MV/MZ adapter
integration shell") AC: "The integration composes readiness records,
map/common-event JSON, database/system/terms JSON, and plugin-profile
diagnostics" without saying what "composes" actually produces. Prefer
the ITOTORI-026 pattern: state explicitly what the node does _not_
implement.

### G.5 LLM gating defenses are not currently testable

ITOTORI-013/014/015/016/021/022/078 all reference structured-output
validation, retry policy, citation enforcement, but the AC for these
behaviors is satisfiable by fixture/mock-model tests. The seeded
defect corpus (ITOTORI-032, complete) exists but is not currently
the gate for any LLM-facing node. Hardening node proposed in §E.1.

### G.6 Substrate facade pattern works — replicate it

UTSUSHI-120's AC4 ("this node does not implement new behavior beyond
exposing and testing the stable facade") is the cleanest negative AC
in the DAG. The corresponding pattern for engine ports would be:
"this node does not implement opcode handlers / dispatch / state
beyond the declared subset; out-of-subset behavior fails with named
diagnostics." UTSUSHI-146d/e/f drafted in §A.1 use this pattern.

---

## H. DAG hygiene recommendations

### H.1 Audit reviewer must reject single-node engine ports

Add to `docs/dev/audit-playbook.md`: "An engine runtime port must not be
audited as a single node. If a node's deliverables include both a VM
dispatch loop and substrate sink wiring, the audit must return a P1
finding requesting a split. Reference UTSUSHI-146 as the prior
example." This codifies the user's complaint as a permanent guardrail.

### H.2 `spec-dag.mjs` validator should require concrete acceptance criteria

`scripts/spec-dag.mjs validate` already enforces schema. Add a soft
lint (warning, not error) for acceptance criteria that:

- mention "the command writes" / "the integration composes" without naming an output artifact path;
- reference "deterministic" without naming a hash field or fixture id;
- contain "narrow" / "focused" / "appropriate" without a measurable bound;
- mention a corpus or fixture without naming its directory or fixture id.

UNIV-021 ("Spec-DAG implementability lint") already exists and is
complete. Extend it with these lints as a follow-up node, e.g.
`UNIV-021b`.

### H.3 Every engine-evidence node must depend on a real-bytes node

When an engine adapter or port node is created, its `dependsOn` must
include at least one node whose fixture is a non-author byte stream
(real game extracted via KAIFUU-176, or a publicly-redistributable
fixture that the worker did not generate). Today
`crates/kaifuu-reallive/tests/fixtures/` is 100% author-generated.
KAIFUU-176 is complete and gives access to the vault — engine work
should now exercise it.

### H.4 The "smoke" word should be reserved

Three different concepts share the word "smoke" in the current DAG:
(a) contract smoke (synthetic input through schemas), (b) integration
smoke (real components wired together with synthetic input), (c)
engine smoke (real bytes through real components). These have very
different evidence value. Recommendation: introduce stable AC prefixes
`contract:`, `integration:`, `engine:` for the verification entries,
and require `engine:` entries to name the source of the bytes.

### H.5 Adapter neutrality must be tested by a second adapter, not asserted

UTSUSHI-027/028/029/030 ACs say things like "trace-only conformance
remains distinct from screenshot conformance" — but with only the
synthetic fixture engine in the test suite, that is asserted by
review, not by code. Until UTSUSHI-160 lands a non-synthetic adapter,
no completion of those nodes should be cited as evidence of "engine
agnostic." Reflect this in `project-readiness.md`'s
`ALPHA-CHECK-004` ("Engine readiness breadth"): list UTSUSHI-160 as
a hard prerequisite.

### H.6 Avoid "real-world" claims in nodes whose only fixtures are synthetic

KAIFUU-173 AC says "RLDEV-style instructions are recognized with named
opcodes, not opaque byte ranges." That is true for the ~10 opcodes
exercised by the smoke fixture. Add a paired follow-up requirement:
"the opcode table coverage is bounded by an explicit list, and any
opcode encountered outside the list is recorded as `unknown_opcode`
with the byte offset." Without that, "recognized" can silently mean
"the ones the author wrote."

---

## Summary of proposed actions

- **1 alpha node to split** before claim: UTSUSHI-146 → 7 sub-nodes
  (146a-g).
- **1 alpha node to split** before claim: ITOTORI-021 → 4 sub-nodes
  (021a-d).
- **5 alpha nodes to tighten AC** before claim: ITOTORI-013 (in_progress),
  ITOTORI-019, ITOTORI-022, KAIFUU-007, UTSUSHI-147.
- **1 substrate node to gate** before "engine-agnostic" claims: UTSUSHI-160
  (already planned) — promote in `ALPHA-CHECK-004` as a prerequisite.
- **3 follow-up nodes to add** (continuous tier): KAIFUU-173b,
  KAIFUU-174b, KAIFUU-011b — real-bytes round-trips against the
  Sweetie HD vault.
- **1 hardening node** for LLM-facing agents:
  ITOTORI-013/014/015/016/021/022/078 adversarial-output rejection
  (cross-cutting).
- **Process changes:**
  - audit playbook H.1 (no single-node engine ports),
  - spec-dag lint H.2 (UNIV-021b),
  - dependency convention H.3 (real-bytes prerequisite),
  - `smoke` vocabulary H.4,
  - `ALPHA-CHECK-004` prereq tightening H.5,
  - bounded-opcode-table convention H.6.

No nodes proposed for demotion to research tier. No nodes proposed for
upgrade from continuous to alpha. No nodes proposed for retroactive
"actually done" reclassification — KAIFUU-173/174 are genuinely
landed for what they claim, the gap is in what the claim covers, not
the implementation.
