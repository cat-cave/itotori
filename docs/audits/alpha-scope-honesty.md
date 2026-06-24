# Alpha Scope Honesty — What Alpha Actually Requires

This audit reassesses what "alpha-ready" honestly means against the **current
committed state** of the monorepo. It is the alpha-scope sibling of
[`dag-critique.md`](dag-critique.md). The DAG critique flags single nodes that
are over-scoped or vague; this document is one level up — it asks whether the
*milestone* itself describes what the toolchain can actually do.

**No code, no DAG, no doc edits in this commit.** Proposals are concrete and
citable so they can be executed in follow-ups.

## Inputs consulted

- [`docs/alpha-localization-project-readiness.md`](../alpha-localization-project-readiness.md) — current alpha scope spec.
- [`roadmap/spec-dag.json`](../../roadmap/spec-dag.json) — 563 nodes; 273 `target: alpha` (165 complete, 106 planned, 2 in_progress); 10 `ALPHA-*` nodes (1 complete, 9 planned).
- [`docs/audits/dag-critique.md`](dag-critique.md) — landed on main as `40106e5`.
- [`crates/kaifuu-reallive/src/lib.rs`](../../crates/kaifuu-reallive/src/lib.rs) — 3,318 LOC pure-Rust parser; module doc explicitly states "deliberately small, named-opcode bytecode... intentionally narrower than the real RealLive opcode space."
- [`crates/utsushi-core/src/port/`](../../crates/utsushi-core/src/port/) — substrate facade (UTSUSHI-103/120) complete; `EnginePort` trait shipped; **no engine port crate (`utsushi-reallive`, `utsushi-rpgmaker-mv`, etc.) exists yet**.
- [`docs/subprojects-kaifuu.md`](../subprojects-kaifuu.md):14 — claimed-support definition: "An engine variant enters claimed-support only when detect, extract, decrypt (if needed), decompile, patch, verify, and delta-apply all work on real owned inputs."
- [`docs/subprojects-utsushi.md`](../subprojects-utsushi.md):73 — runtime claimed-support bar: "wrap the original runtime and call it Utsushi evidence... an engine in that state is not yet claimed-support."
- Ground-truth game bytes at `/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/` — `Seen.txt` is 3.7 MB; the synthetic fixture at `crates/kaifuu-reallive/tests/fixtures/smoke-scene-001/SEEN.TXT` is 50 bytes (79,000× smaller).

**Sibling audits landed during drafting:** `docs/audits/dag-critique.md`,
`docs/audits/substrate-honesty.md`. **Missing at commit time:**
`docs/research/reallive-engine.md`, `docs/research/reallive-engine-dag-proposal.md`,
`docs/audits/code-criticism.md`, `docs/audits/test-quality.md`. Findings below
are anchored on the two landed audits and on direct inspection of code,
fixtures, the DAG, and the real Sweetie HD bytes. Where a finding depends on a
missing sibling audit it is marked **[depends on missing sibling — confirm]**.

---

## A. Current claim vs reality

### A.1 The headline claim

> *"Alpha readiness is achieved when the suite can run the same product loop on
> public synthetic fixtures and at least one real-engine fixture profile, then
> show that the engine boundary remains generic across the alpha
> engine/readiness set."* — `alpha-localization-project-readiness.md`:28

> *"The first real-engine end-to-end vertical is Sukara's Oshioki Sweetie HD
> Remaster + Sweets fandisc (RealLive engine), sourced from the vault-curation
> catalog at /archive/vault/. That vertical is what proves the suite on real
> owned content: detect, extract, decrypt, decompile, patch, verify,
> delta-apply, and Utsushi runtime evidence through a native RealLive port."*
> — `alpha-localization-project-readiness.md`:57

**Verdict: aspirational.** Of the seven stages the doc names as required for
the Sweetie HD vertical, the toolchain can credibly deliver only "detect" today.

| Stage | Status | Evidence |
| --- | --- | --- |
| detect | genuine | `KAIFUU-172` complete; `kaifuu.reallive` detector ships with positive + Siglus/AVG32 negative fixtures (`docs/kaifuu-adapters/reallive.md`). |
| extract | partial | `KAIFUU-173`/`KAIFUU-174` complete but explicitly scoped to a **synthetic** 8-opcode bytecode (`crates/kaifuu-reallive/src/lib.rs`:62-100). Real `Seen.txt` opens with a different envelope (real: `00 00 00 00 ...`; synthetic: `01 00 00 00 ...`). Real-archive parse path is untested. |
| decrypt | n/a for this title | Sweetie HD's `Seen.txt` and `Gameexe.ini` are plaintext on disk; voice/image archive decryption is excluded from this vertical scope. |
| decompile | aspirational | The "AST" produced today is a flat instruction list with named opcodes for the synthetic 8. Real RealLive has on the order of ~500 opcodes documented in RLDEV. Anything beyond the 8 is `Unrecognized`. |
| patch | partial (length-preserving only) | `crates/kaifuu-reallive/src/patchback.rs` ships length-preserving edits + `FixedBudget` returning fatal `unsupported_length_policy`. No offset-table rewriting. Most JA→EN translation pairs will violate length-preservation. |
| verify | genuine for the slice it covers | `KAIFUU-010` (PatchResult v0.2) is genuinely concrete and gold-standard. Verify can report pass/fail for the slice patchback supports. |
| delta-apply | genuine for fixture inputs | `KAIFUU-048`/`KAIFUU-049`/`KAIFUU-074` complete; delta apply works against fixture bytes. Not yet exercised against `Seen.txt`. |
| Utsushi runtime evidence | **forbidden-state risk** | `UTSUSHI-146` is planned and is the single node that represents "Pure-Rust RealLive runtime port" — the substrate facade documentation explicitly says wrappers do not count as claimed-support, but `UTSUSHI-146`'s AC ("Scene/SEEN replay produces deterministic trace and snapshot evidence") could be satisfied today by a thin wrapper around the 8-opcode parser. See `dag-critique.md` §A.1. |

### A.2 The product loop (13 steps in §1.1)

Of the 13 product-loop steps, the *machinery* exists end-to-end **for the
synthetic `hello-game` fixture** (`fixtures/hello-game`, `synthetic-json`
engine). That is a real and load-bearing demonstration: `ALPHA-CHECK-002`
("Synthetic loop") is genuinely demonstrable today via `just hello` and the
`synthetic-json` adapter.

For any real engine (Sweetie HD / RealLive included), most steps fall apart at
step 3 (extract) because the parser is a synthetic-shape clean-room toy rather
than a generic RealLive decompiler.

**Grade per step on real engines (RealLive, Sweetie HD):**

1. Identify a work — **genuine** (vault-source adapter `KAIFUU-176` shipped).
2. Inventory — **partial** (detector ships; `Gameexe.ini` inventory ships).
3. Extract source surfaces — **aspirational** (synthetic shape only).
4. Import into Itotori — **genuine** (engine-neutral; works once a bridge exists).
5. Draft target text — **partial** (deterministic and recorded paths work; live LLM proof gated on `ITOTORI-116`/`117`, planned).
6. Deterministic QA + QA-agent pass — **partial** (deterministic works; QA-agent is gated on `ITOTORI-021` — flagged vague in `dag-critique.md` §E.6, no precision/recall floor).
7. Export patchable package — **genuine** (`.kaifuu` schema is solid).
8. Patch / verify / diff / apply — **partial** (length-preserving only for RealLive; no offset rewrite).
9. Utsushi runtime evidence — **aspirational** (no engine port crate exists).
10. Ingest runtime evidence — **genuine** (when evidence exists).
11. Dashboard decision — **partial → genuine** (workflow nodes exist for many; ITOTORI agent surfaces in progress).
12. Apply repair and rerun affected work — **partial** (no scope-of-effect tracking proved on a real engine).
13. Benchmark / quality / cost reports — **partial** (`alpha-readiness-benchmark/quality/cost-report` are named slots; the report machinery exists but has not run against a real game).

### A.3 Engine readiness matrix (§2 table)

The matrix at `alpha-localization-project-readiness.md`:105-112 lists six rows
and conflates two very different evidence postures:

- **Readiness-only rows** (`tyranoscript-null-key`, `kirikiri-xp3-readiness`,
  `rpg-maker-vx-ace-rgss3-readiness`, `bgi-ethornell-readiness`) — these are
  honest about being detector/profile-only. **Genuine for the scope they
  claim.**
- **Engine vertical rows** (`synthetic-json`, `rpg-maker-mv-mz-json`) — these
  claim end-to-end through Utsushi evidence. `synthetic-json` is **genuine**.
  `rpg-maker-mv-mz-json` is **aspirational** — `KAIFUU-007` (adapter integration
  shell) is planned, `UTSUSHI-031`/`032`/`033`/`102`/`119` all planned. Only
  `UTSUSHI-148` (browser launch contract tightening) is complete. There is no
  RPG Maker JSON adapter yet — only a detector readiness slice (`KAIFUU-039`,
  encrypted media readiness).

### A.4 Specific forbidden-state risk

`alpha-localization-project-readiness.md`:374-405 lists "Known Non-Goals." Two
of them are at risk of being violated by accepting the current scope:

- *"No claim of engine-perfect... fidelity unless a specific E4 report exists."*
  Risk is low — the evidence-tier vocabulary is well enforced.
- *"No support claim for engines outside the named positive adapters and
  readiness profiles."* — **Risk is high.** The doc declares
  "SiglusEngine + RealLive" as a claimed-support row (line 77), but
  the only RealLive code that exists is a clean-room toy parser; SiglusEngine
  has no adapter at all. Per `subprojects-kaifuu.md`:14 ("claimed-support only
  when detect, extract, decrypt, decompile, patch, verify, and delta-apply all
  work on real owned inputs"), declaring "RealLive + SiglusEngine"
  claimed-support today is a forbidden-state violation by the project's own
  definition.

---

## B. The "claimed engines" list, honest current status

The doc lists three claimed-support engine families:

### B.1 SiglusEngine + RealLive (single Rust port scope)

> *"single Rust port scope. RealLive carries the first real-engine vertical;
> Siglus shares the port substrate."* — `alpha-localization-project-readiness.md`:77

**Reality:**

- **Substrate facade is architecturally credible but functionally
  fixture-shaped.** Per `docs/audits/substrate-honesty.md` §0: "the only
  production consumer of any substrate type in the workspace is `utsushi_core`
  itself plus its in-tree `tests/substrate_conformance.rs`." All
  `UTSUSHI-020/021/022/023/024/025/056/103/120` are complete, but the substrate
  audit grades 8 of 11 subsystems "substantial-gap" or "wrong-shape" against a
  hypothetical Sweetie HD RealLive port. The `EnginePort` trait still emits
  legacy `ObservationHookEvent` rather than the new sink contracts — the
  substrate's most-polished work (sinks) and its official port trait do not
  connect (`substrate-honesty.md` §L.1). Snapshot envelope is 16 KiB; real
  RealLive saves are 24 KiB raw (§E). `MomentId` is opaque; no
  scenario-position primitive (§I.3). No composite/archive package kind for
  RealLive's try-dir-then-archive resolution (§A.1).
- **No `utsushi-reallive` crate exists.** `find crates -name '*reallive*'` finds only `crates/kaifuu-reallive` (the extraction parser). The substrate has tested itself against *only* synthetic ports defined inline in test files (`crates/utsushi-core/tests/engine_port.rs:1-80`). This is what `dag-critique.md` §A.1 calls out: `UTSUSHI-160` ("first production engine port consumes ConformanceManifest") is planned and is the only node that would force a non-synthetic adapter through the conformance system.
- **The RealLive parser is a clean-room toy.** `crates/kaifuu-reallive/src/lib.rs`:62 explicitly states "deliberately small, named-opcode bytecode that the synthetic fixtures use." Eight opcodes (`TextDisplay`, `SetSpeaker`, `Choice`, `SetVar`, `Jump`, `Return`, `ClearScreen`, `Pause`). Real RealLive (per Haeleth's RLDEV) has on the order of 500 opcodes plus complex window-rule/GAN animation/audio sink semantics.
- **The real `Seen.txt` does not match the synthetic envelope.** First 16 bytes of real Sweetie HD `Seen.txt`: `00 00 00 00 00 00 00 00 80 38 01 00 fa 05 00 00`. First 16 bytes of synthetic smoke fixture: `01 00 00 00 0c 00 00 00 26 00 00 00 23 02 01 73`. The "count + offset/size table" envelope `parse_archive` decodes does not match the real bytes' first u32 (`0` — would be treated as empty archive).
- **SiglusEngine has zero claimed-support code.** No SiglusEngine adapter, no `kaifuu-siglus`, no `utsushi-siglus`, no Siglus detector beyond the cross-check used to negate the RealLive detector.
- **Patchback only supports length-preserving edits.** `crates/kaifuu-reallive/src/patchback.rs`:7 — "Length-preserving edits only at this slice. FixedBudget returns `kaifuu.reallive.patchback_unsupported_length_policy` Fatal until a future node ratifies offset rewriting against per-game evidence." JA→EN translations are almost always length-changing.

**Honest sub-claim that survives:**
"Detector + readiness profile + clean-room parser-boundary smoke for the
RealLive engine family on synthetic AVG32-variant fixtures. No runtime
evidence on real RealLive bytes. SiglusEngine is detector-overlap-only,
not a claimed engine." This is dramatically narrower than the current
claim, but it is accurate.

### B.2 RPG Maker MV/MZ

> *"JSON-text adapter plus encrypted asset decrypt/replace, with browser/NW.js
> instrumentation as the runtime path."*

**Reality:**

- **KAIFUU-007** (RPG Maker MV/MZ adapter integration shell) — planned. Flagged
  vague by `dag-critique.md` §D.4 ("composes" without specifying byte-level
  round-trip).
- **KAIFUU-039** (MV/MZ encrypted media readiness command) — complete.
  Detector-only; explicit AC "never claims dialogue extraction or script patch
  support based only on media-key detection."
- **KAIFUU-115/KAIFUU-116** (MV/MZ encrypted image / audio decrypt and
  re-encrypt) — gold-standard contract nodes per `dag-critique.md` §D.3, but
  status is one-codec-each scope. **[depends on missing sibling — confirm status]**
- **UTSUSHI-031/032/033** (MV/MZ instrumented runtime smoke, JSON event replay
  skeleton, message/choice command pack) — **all planned**.
- **UTSUSHI-148** (browser launch alpha contract tightening) — complete. This
  alone does not constitute claimed-support.
- **UTSUSHI-119** (MV/MZ patched-output runtime proof) — planned. This is the
  node that would close the loop.

**Honest sub-claim that survives:**
"Detector + encrypted-media readiness for MV/MZ; browser launch contract
tightening done. The JSON adapter for events, common events, choices, database
text, UI terms, and plugin-profiled text is **not yet implemented**. The
instrumented runtime probe is **not yet implemented**." Effectively: MV/MZ has
the same readiness posture as TyranoScript or KiriKiri/XP3 today — it is *not*
end-to-end claimed-support.

### B.3 Plain XP3 + KAG plaintext

> *"the unencrypted KiriKiri case as the null-key/identity-container slice of
> the layered pipeline."*

**Reality:**

- **KAIFUU-097** (Plain XP3 reader and inventory) — complete.
- **KAIFUU-098** (Plain XP3 deterministic writer and rebuild) — **planned**.
  Without the writer, there is no patch-back path.
- **KAIFUU-009** (KiriKiri KAG plaintext reference adapter) — **planned**.
- **KAIFUU-071** (Plain XP3 reader and writer smoke command) — planned; depends on KAIFUU-098.
- **UTSUSHI-037/038/039** (KAG plaintext parser replay skeleton, macro and
  storage subset, KiriKiri XP3 VFS handoff smoke) — **all planned**.
- **KAIFUU-171** (Synthetic encrypted-XP3 contract scaffolding fixture) — planned.

**Honest sub-claim that survives:**
"Plain XP3 read + inventory shipped; deterministic writer planned; KAG
plaintext adapter planned; XP3 runtime evidence planned." Same posture as MV/MZ
— *not* end-to-end claimed-support today.

### B.4 Summary

**Of the three claimed-support engine families, zero meet the project's own
claimed-support bar today** (`subprojects-kaifuu.md`:14: detect + extract +
decrypt + decompile + patch + verify + delta-apply on real owned inputs). The
only end-to-end thing the toolchain demonstrably does is run the synthetic
`hello-game` fixture through `synthetic-json`. That is what the synthetic-loop
machinery proves; it does not prove the engine boundary remains generic across
even one real engine, because no real engine adapter exists.

---

## C. Recommended scope adjustments

### C.1 Demotions from alpha to continuous

These are alpha-tier nodes today that should be **promoted to continuous-tier
or post-alpha** because they are not load-bearing for the (redefined) alpha
milestone proposed in §D:

- `ALPHA-002` (Playable draft feedback loop) — depends on `ALPHA-001`. Until a
  real engine runs, "playable" is moot. Demote to continuous.
- `ALPHA-003` (Alpha readiness cost and quality benchmark run) — keep if and
  only if the redefined alpha milestone in §D includes the recorded-LLM
  baseline. Otherwise demote.
- `ALPHA-004` (Alpha engine capability matrix generator) — useful but not
  blocking. The matrix is generated from per-engine readiness records, all of
  which are already shipped or planned. The generator can be a continuous
  deliverable.
- `ALPHA-007` (Suite public fixture vertical run) — overlaps `ALPHA-CHECK-002`
  (synthetic loop) and `ALPHA-009`. Pick one as the alpha exit; demote the
  others to continuous.
- `ALPHA-009` (Retire literal Hello World CI into alpha proof workflow) —
  cosmetic; demote.
- `UTSUSHI-147` (RealLive/Siglus shared substrate alignment) — depends on
  `UTSUSHI-146`. Once `UTSUSHI-146` is split per `dag-critique.md` §A.1, the
  alignment node belongs in continuous tier.

### C.2 Demotions from alpha to research-tier (do not claim for alpha)

These capabilities should not be claimed for the alpha milestone at all:

- **Native pure-Rust RealLive runtime port** (`UTSUSHI-146`, including all 7
  proposed sub-nodes in `dag-critique.md` §A.1). The combined scope is
  realistically 6+ months of engine-focused work; treating it as alpha-blocking
  prevents alpha from ever shipping. Move to **research-tier** with a
  decomposed plan (see §C.3) and call the alpha milestone in §D the practical
  exit point that does not require it.
- **SiglusEngine claimed-support.** Already excluded by the doc
  (`alpha-localization-project-readiness.md`:391: "No SiglusEngine production
  adapter before the first real localization project"), but the engine row at
  line 77 still groups it with RealLive. Excise SiglusEngine from the
  claimed-support row in §B language; keep it as a research-tier readiness
  profile.
- **RealLive runtime evidence on real `Seen.txt`** as an *alpha* gate. Keep it
  as the project's North Star and as the proof point for the first real
  localization project; do not block alpha on it.

### C.3 Decompositions (only stage 1 in alpha)

- **RealLive runtime port (`UTSUSHI-146`)**: decompose per `dag-critique.md`
  §A.1 into 146a–146g. **Alpha includes only 146a** (clean-room attestation +
  crate scaffold; zero opcode handlers permitted). The remaining stages (b–g)
  ship continuously after alpha. This is the smallest honest milestone that
  proves the substrate facade is engine-extensible.
- **RealLive parser/inventory (`KAIFUU-173`/`174`)**: already complete on
  synthetic bytes. Add `KAIFUU-173b` and `KAIFUU-174b` per `dag-critique.md`
  §A.3 (real-bytes Sweetie HD round-trip), but **place them in continuous tier**.
  They are not alpha-blocking — they are how the parser stops being theater
  *after* alpha.
- **RealLive patchback length policy** (`crates/kaifuu-reallive/src/patchback.rs`):
  current state is `LengthPreserving` only; `FixedBudget` returns fatal.
  Decompose into:
  1. Length-preserving edits with control-byte preservation (current — done).
  2. `FixedBudget` with offset-table rewrite for a single declared scene
     subset (post-alpha).
  3. Generalized offset rewrite with jump-target recalculation (post-alpha).
  Stage 1 is what alpha legitimately covers.
- **RPG Maker MV/MZ adapter (`KAIFUU-007`)**: tighten per `dag-critique.md`
  §D.4 (byte-level `Map001.json` round-trip). Decompose:
  1. JSON adapter for map events and choices (alpha if claimed).
  2. Database/system/terms JSON (continuous).
  3. Plugin-profiled text (continuous).
  4. Encrypted media decrypt/replace via `KAIFUU-115`/`116` (continuous).
- **Plain XP3 + KAG plaintext**: same pattern. Stage 1 = reader + writer
  + smoke (`KAIFUU-097` + `KAIFUU-098` + `KAIFUU-071`). Stage 2 = KAG plaintext
  adapter (`KAIFUU-009`). Stage 3 = runtime evidence (`UTSUSHI-037/038/039`).
  Decide which stages alpha actually requires (see §D).

### C.4 Honest substitutes

Where a full capability is not achievable for alpha, the smallest honest
demonstration is:

- **Engine port architecture proof**: 146a alone — a `utsushi-reallive` crate
  that wires `EnginePort` to a no-op port emitting clean-room attestation and
  one synthetic-fixture conformance report. This proves the substrate's
  generic-engine claim with a *second* adapter beyond the in-test synthetic
  port (closes the §B.4 gap).
- **Real-bytes parser smoke**: KAIFUU-173b (inventory the real `Seen.txt`,
  report opcode frequency, surface 3+ unknown opcodes by RLDEV mnemonic). This
  proves the parser meets bytes the author did not write, even if no patch is
  applied.
- **Real-bytes patch smoke**: KAIFUU-011b per `dag-critique.md` §F.2 (apply
  a length-preserving edit to one named Sweetie HD scene slot, byte-identical
  non-patched regions). This proves the *patchback path* works on real bytes
  for the slice the patcher actually supports.
- **MV/MZ JSON round-trip**: a public MV/MZ JSON fixture (no real game) with a
  byte-identical map-event round-trip per `dag-critique.md` §D.4. Proves the
  RPG Maker claim at the byte level on a fixture the project can ship in CI.
- **Recorded LLM proof bundle**: `ALPHA-008` against the synthetic loop —
  proves the live-LLM contract on a non-engine surface so it is not blocked on
  any engine port.

These five together would be the honest alpha proof set.

---

## D. Alpha milestone redefinition

### D.1 What "alpha-ready" should mean

**Recommended redefinition (alpha = "architecture proven; first real engine is
the post-alpha North Star"):**

> *"The Itotori suite is alpha-ready when (a) the synthetic loop runs
> end-to-end through every product-loop stage, (b) the substrate facade has at
> least one non-synthetic engine port crate registered through the
> conformance manifest, (c) the RealLive extraction stack demonstrates
> real-bytes parser and patchback smoke on the Sweetie HD `Seen.txt` from the
> vault, even if no runtime evidence is produced, (d) at least one MV/MZ JSON
> public fixture round-trips byte-identically through the integration shell,
> (e) the recorded-LLM proof bundle exists, and (f) every report and dashboard
> workflow surface enumerated in `alpha-localization-project-readiness.md` §3
> is reachable against synthetic-loop state. The first **runtime** evidence
> on a real RealLive game is a post-alpha first-project milestone."*

### D.2 Tradeoffs

**What this redefinition keeps:**
- Strategic purpose intact — proves the architecture (substrate + adapter +
  bridge + dashboard + reports + LLM gating) is real and ships end-to-end.
- Sweetie HD is still load-bearing — the parser and patchback meet *its bytes*,
  just not its runtime.
- The "engine boundary remains generic across the alpha engine/readiness set"
  language survives, because UTSUSHI-146a delivers a second adapter through
  the conformance system. `UTSUSHI-160` (the only existing node enforcing
  this) folds in.
- The forbidden-state risk in §A.4 is resolved: no claim that any non-synthetic
  engine is claimed-support runtime-wise until evidence exists.

**What this redefinition gives up:**
- Loses the "first real-engine end-to-end vertical" headline. Replaces it with
  "first real-engine parser/patchback on real bytes, runtime evidence
  follows." The marketing story is less punchy.
- Loses the "playable feedback loop on a real game" item. `ALPHA-002` demotes
  to continuous; the first playable-feedback proof becomes a post-alpha
  milestone.
- Requires accepting that the *first localization project* (not alpha) is when
  end-to-end runtime evidence on a real game ships. This is honest given the
  ~6-month scope of `UTSUSHI-146` and is consistent with how
  `alpha-localization-project-readiness.md`:1-13 already frames alpha ("not a
  terminal product state... the first full-game localization project should
  discover scale, content, engine-variant, and workflow issues").

### D.3 What the alpha milestone language should claim, verbatim

Replace `alpha-localization-project-readiness.md`:1-31 with:

> *"This document defines the feature set that makes the Itotori suite ready
> to start a first real localization project. Alpha readiness means the suite
> has already proven the **architecture** on public fixtures and on the
> real-game bytes of one declared RealLive title (Sukara's Oshioki Sweetie HD
> Remaster + Sweets fandisc): the extraction stack meets real bytes, the
> substrate facade has at least one non-synthetic engine port registered
> through conformance, the recorded-LLM proof bundle exists, and every
> dashboard workflow is reachable against synthetic state. The first **runtime
> evidence on a real game** ships in the first real localization project, not
> at alpha. That sequencing is deliberate: a runtime port is a 6+ month
> investment; alpha is the moment we have proven the architecture is real and
> the first-project work has a non-toy floor to build on."*

### D.4 What the engine matrix should say

Reduce the §2 table (lines 105-112) to **two postures** instead of conflating
end-to-end and readiness:

- **Architecture-proof row (one entry)**: `synthetic-json` — exercises every
  product-loop stage at the substrate, adapter, bridge, dashboard, and report
  level.
- **Engine readiness rows**: `rpg-maker-mv-mz-json`, `tyranoscript-null-key`,
  `kirikiri-xp3-readiness`, `rpg-maker-vx-ace-rgss3-readiness`,
  `bgi-ethornell-readiness`, **and add** `reallive-readiness` —
  detector/profile/parser-boundary smoke + (for RealLive only) real-bytes
  parser smoke on Sweetie HD. None of these claim runtime support.

The line 77 "Alpha claimed-support engines" subsection becomes a single
row (`synthetic-json`) plus the readiness matrix above.

---

## E. Hard re-cuts on what stays/goes (section-by-section)

References below are to current `alpha-localization-project-readiness.md`
line ranges.

| Section | Action | Rationale |
| --- | --- | --- |
| Headline (lines 1-13) | **EDIT** per §D.3 | Replace "the theory" with concrete architecture-proof language; drop "real-engine fixture profile" headline. |
| Readiness Scope (lines 27-52) | **EDIT** | Keep all 13 product-loop steps as the loop definition. Add: "Step 9 (Utsushi runtime evidence) requires E2 evidence only for `synthetic-json` at alpha; readiness rows produce E0/E1 only." |
| Alpha Engine and Readiness Set — First real-engine vertical (lines 55-70) | **CUT** | Move the Sweetie HD vertical to "first real localization project" milestone. Replace with: "The first real-bytes parser and patchback proof for the RealLive engine family is the Sukara/Oshioki Sweetie HD `Seen.txt` extracted via the vault adapter (KAIFUU-176); see `KAIFUU-173b` and `KAIFUU-011b` continuous-tier nodes." |
| Claimed-support engine families (lines 72-97) | **EDIT (cut to one entry)** | Replace the three-row list with: "`synthetic-json` is the alpha claimed-support engine. RealLive, RPG Maker MV/MZ, Plain XP3 + KAG, TyranoScript, KiriKiri/XP3 encrypted, RPG Maker VX Ace/RGSS3, and BGI/Ethornell are readiness-tier for alpha; first-project work promotes one of them to claimed-support." |
| Engine matrix (lines 99-112) | **EDIT** per §D.4 | Reduce to one architecture-proof row + six readiness rows. Drop the `Required alpha support` and `Runtime evidence bar` columns for readiness rows; they cannot meet either without first-project work. |
| §3 Fixture/Corpus (lines 128-174) | **KEEP (with edits)** | Keep the required-fixtures list. Edit the synthetic encrypted XP3 fixture line (148-149) to clarify it is *contract scaffolding*, not a vertical claim — it is for `KAIFUU-171`. |
| §4 Dashboard Workflows (lines 176-208) | **KEEP** | Dashboard workflows are reachable today against synthetic loop state. This is a real and load-bearing alpha proof. |
| §5 Quality/Cost/Benchmark reports (lines 210-247) | **KEEP** | The reports are alpha-blocking and the report machinery is real. Tighten `ALPHA-CHECK-019` (real LLM proof) to require recorded fixtures + one opt-in live run before "first real game starts." |
| §6 Alpha Readiness Check Matrix (lines 249-275) | **EDIT** | Re-grade each `ALPHA-CHECK-*` per §F below. Specifically: `ALPHA-CHECK-003` (RPG Maker vertical) — **CUT** until first-project. `ALPHA-CHECK-004` (engine readiness breadth) — add `UTSUSHI-160` as hard prerequisite per `dag-critique.md` §H.5. `ALPHA-CHECK-020` (encrypted patch vertical) — **EDIT** to scope to synthetic encrypted XP3 fixture (KAIFUU-171), not a real-game proof. |
| §7 Validation Checks (lines 277-323) | **KEEP** | Concrete and verifiable. |
| §8 Demo Script (lines 325-372) | **EDIT** | Demo step 3 (RPG Maker vertical slice) becomes "MV/MZ JSON fixture round-trip" (no runtime evidence). Demo step 5 (synthetic XP3 vertical) keeps as-is. Demo step 9 (feedback loop from runtime/playable review) becomes "feedback loop from recorded/agent-derived findings." Add a demo step: "Show the `utsushi-reallive` crate scaffold conformance report against the substrate facade." |
| §9 Known Non-Goals (lines 374-405) | **ADD** | Add explicit non-goal: "Pure-Rust RealLive runtime port producing trace/snapshot evidence on a real RealLive game is NOT an alpha milestone. It is a first-project milestone. The substrate is alpha-proven by a non-synthetic engine port crate (146a) producing conformance evidence only." |
| §10 Continuous Expansion (lines 407-431) | **ADD** | Add: "146b–146g (RealLive VM dispatch loop through Gameexe wiring and snapshot/replay against Sweetie HD)" and "KAIFUU-173b/174b/011b (real-bytes RealLive smoke)." |

---

## F. Required next steps (DAG order-of-operations)

The minimum ordered DAG path to reach alpha as redefined in §D:

0. **Land substrate extensions M.1, M.2, M.3** from
   `docs/audits/substrate-honesty.md` §M as alpha-tier prerequisites of
   146a:
   - **M.1** (composite asset package + try-dir-then-archive resolver):
     RealLive's Gameexe `#FOLDNAME.G00 = "G00" = 0 : "G00.PAK"` syntax is in
     13/13 Sweetie HD folders. No real port can ship without this; the
     substrate today provides only `PlaintextDirPackage`.
   - **M.2** (snapshot envelope size class — tier the 16 KiB ceiling to
     16 KiB / 256 KiB / 4 MiB at manifest level). Without it, 146a can't
     even round-trip the synthetic conformance fixture for a port that
     declares state.
   - **M.3** (EnginePort→sinks bridge): wire `EnginePort` to
     `TextSurfaceSink`/`FrameArtifactSink`/`AudioEventSink` instead of legacy
     `ObservationHookEvent`. Today the sinks have no production producer
     anywhere. 146a needs this to make a non-trivial claim.
   These three are the load-bearing pre-requisites the substrate audit
   identifies as blockers for a real port; M.4 (pixel-bound mouse) and M.5
   (frame-as-layer-composition) can follow post-alpha.
1. **Split `UTSUSHI-146`** per `dag-critique.md` §A.1 into 146a–146g.
   Re-tier 146b–146g to **research/continuous**. Keep **146a** as alpha-tier.
   146a depends on M.1–M.3.
2. **Tighten `KAIFUU-007`** acceptance criteria per `dag-critique.md` §D.4
   (byte-level public-fixture `Map001.json` round-trip). Keep as alpha-tier.
3. **Promote `UTSUSHI-160`** to a hard prerequisite of `ALPHA-CHECK-004` per
   `dag-critique.md` §H.5. Tie it explicitly to `UTSUSHI-146a`.
4. **Add `KAIFUU-011b`** (binary patcher real-archive smoke) per
   `dag-critique.md` §F.2 as **alpha-tier** (this is the real-bytes parser
   /patchback proof for RealLive). Depends on `KAIFUU-176` (complete) and the
   tightened length-policy AC of `KAIFUU-174`.
5. **Add `KAIFUU-173b`** (Sweetie HD real-bytes opcode-frequency inventory) as
   **alpha-tier**. Depends on `KAIFUU-176`.
6. **Demote `ALPHA-001`/`ALPHA-002`/`ALPHA-006`/`ALPHA-007`/`ALPHA-009`** to
   continuous-tier or first-project-tier per §C.1. Keep `ALPHA-003`/`ALPHA-005`
   /`ALPHA-008` alpha-tier (cost/quality, readiness hardening, live-provider
   proof).
7. **Edit `alpha-localization-project-readiness.md`** per §E. This includes
   removing the "claimed-support engines" three-row block and replacing the
   engine matrix.
8. **Update the demo script (§8 of the readiness doc)** to remove the real-game
   runtime evidence step and add the conformance-evidence step for the new
   non-synthetic engine port crate.
9. **Update the `ALPHA-CHECK-*` rows** per §E table.
10. **Add audit-playbook entry H.1** from `dag-critique.md` (no single-node
    engine ports).

Once steps 1–10 land, the redefined alpha milestone is reachable. Estimated
sequencing: 146a + KAIFUU-007 tightening + KAIFUU-011b + KAIFUU-173b can run
in parallel (different crates); the doc edits and demo script revisions can
land alongside; the DAG splits/demotions are a single repair PR. Total
calendar estimate: weeks, not months — versus an unknown-but-multi-month
estimate for the current "real RealLive runtime" framing.

---

## G. What is genuinely demonstrable end-to-end now (one-page summary)

| Capability | End-to-end? | Notes |
| --- | --- | --- |
| `hello-game` → bridge → draft → patch → delta → apply → trace → capture → ingest → dashboard | **Yes** | Synthetic loop, `synthetic-json` engine. This is real. |
| RealLive detector + readiness profile | **Yes** | KAIFUU-172 / synthetic + cross-engine negatives. |
| RealLive Scene/SEEN parser on synthetic 8-opcode bytecode | **Yes** | KAIFUU-173/174. |
| RealLive Scene/SEEN parser on real Sweetie HD `Seen.txt` | **No** | Real envelope shape differs; parser is clean-room toy. |
| Length-preserving patchback on synthetic SEEN | **Yes** | KAIFUU-174 patchback. |
| Length-preserving patchback on real `Seen.txt` | **No** | Untested. Would also require length-policy generalization for actual JA→EN edits. |
| RPG Maker MV/MZ detector + encrypted-media readiness | **Yes** | KAIFUU-039 (readiness only). |
| RPG Maker MV/MZ JSON adapter and patch | **No** | KAIFUU-007 planned. |
| RPG Maker MV/MZ runtime evidence | **No** | UTSUSHI-031/032/033/119 planned. UTSUSHI-148 alone (browser launch) does not constitute runtime evidence. |
| Plain XP3 read | **Yes** | KAIFUU-097. |
| Plain XP3 write | **No** | KAIFUU-098 planned. |
| KAG plaintext adapter | **No** | KAIFUU-009 planned. |
| KAG/XP3 runtime evidence | **No** | UTSUSHI-037/038/039 planned. |
| Substrate facade (VFS, clock, sinks, snapshot, replay, recorder, conformance) | **Yes** | UTSUSHI-020–120 complete; exercised by synthetic ports in tests only. |
| Substrate proves engine-boundary is generic | **No** | No non-synthetic adapter is registered through it; UTSUSHI-160 planned. |
| `.kaifuu` delta package contract, apply, verify | **Yes** | KAIFUU-010/048/049/074 complete. |
| Itotori bridge import + locale-branch state | **Yes** | Plumbed through completed ITOTORI work. |
| Itotori dashboard workflows (project/corpus, locale branch, decision queue, runtime review, patch/delta, feedback, cost/quality) | **Yes** | Workflow surfaces reachable against current state. |
| Recorded LLM proof / live-provider opt-in | **No** | ITOTORI-116/117 planned, ALPHA-008 planned. |
| QA-agent precision/recall against seeded defects | **No** | ITOTORI-021 vague per `dag-critique.md` §E.6; no precision/recall floor exists. |

---

## H. Open questions for the missing sibling audits

When `code-criticism.md`, `test-quality.md`, `reallive-engine.md`, and
`reallive-engine-dag-proposal.md` land, this audit should be reconciled
against:

1. ~~**Substrate honesty**~~ **Resolved.** `docs/audits/substrate-honesty.md`
   landed during drafting (commit `e4b9d53`) and confirms the substrate is
   "architecturally credible but functionally fixture-shaped." A
   non-synthetic port cannot land cleanly today — M.1–M.3 are pre-requisites.
   This audit's §F now includes those as step 0.
2. **Test quality**: are the seeded-defect corpora (`ITOTORI-032`) actually
   load-bearing for any LLM-facing gate today? If not, `ALPHA-CHECK-012` is
   theater.
3. **Code criticism**: are there latent bugs in the patchback path, the
   conformance schema, or the snapshot/replay system that block 146a's
   conformance evidence from being trustworthy?
4. **RealLive engine research**: does the proposed sub-node decomposition
   (146a–g per `dag-critique.md` §A.1) match what's actually needed? Or does
   the research suggest a different ordering (e.g., Gameexe before opcode
   dispatch, or a partial-VM-first approach)?
5. **RealLive DAG proposal**: does the research-driven DAG proposal align with
   §F's order-of-operations, or does it suggest a different splitting?

---

## Bottom line

The alpha milestone as currently written promises end-to-end on a real game
(Sweetie HD) through a runtime engine port that does not exist and would take
6+ months to build. The substrate facade and the synthetic loop are genuinely
done — but the substrate-honesty audit shows the substrate is functionally
fixture-shaped in 8 of 11 subsystems (M.1–M.5 extensions identified as needed
before a real port can land). The RealLive parser is a clean-room toy on a
synthetic envelope shape that does not match the real `Seen.txt` first bytes.
RPG Maker MV/MZ and Plain XP3 + KAG plaintext are detector + readiness only.

**The honest alpha milestone is: "architecture proven by landing substrate
extensions M.1–M.3 plus a non-synthetic engine port crate (UTSUSHI-146a) that
registers conformance, plus a real-bytes parser/patchback smoke on Sweetie HD
(KAIFUU-173b/011b), plus a recorded-LLM bundle, plus dashboard reachable
against synthetic state." Runtime evidence on a real game is post-alpha
first-project work.** This redefinition makes alpha reachable in weeks of
focused substrate-extension and crate-scaffold work, preserves the project's
strategic purpose (proving the architecture and validating direction), and
does not require any of the proven-impossible-to-fake commitments the current
doc accidentally makes against its own claimed-support definition.
