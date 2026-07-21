# Itotori Translation-Benchmark Methodology

**Status:** design / alignment reference (not yet fully built).
**Role:** this document records our INTENTIONS for the translation benchmark.
It is the alignment reference that every benchmark build-out node must conform
to. Build-out proceeds without per-node review **so long as each component
aligns with the intentions documented here.** If a builder needs to deviate
from this doc, that is a methodology change and must be raised, not silently
implemented.

**Source of truth for intent:** Trevor's 2026-07-05 direction (the
"car-testing-facility" pivot and the diagnostic-instrument refinement). This
doc is downstream of that; where they disagree, the direction wins and this
doc is wrong and must be fixed.

**Copyright boundary (governs the whole facility):** all copyrighted tiers
(official-EN, fan-TL, JP prose) are held PRIVATELY for evaluation only,
read-only-never-publish, identical to the vault policy. The benchmark commits
only hashes, metadata, alignment tables, scores, and rationale — **never raw
copyrighted game text or private screenshots.** This is enforced by the
`benchmarkReportFields.forbidden` set in the `itotori-lqa-1` taxonomy
(`rawPrivateSourceText`, `rawPrivateScreenshot`).

---

## 1. Purpose and framing — a dyno, not a leaderboard

The benchmark is a **diagnostic instrument** (a dynamometer), not a leaderboard.

- **PRIMARY purpose:** tell US where Itotori's localization is lacking and how
  to improve it. **A benchmark without actionable conclusions is useless.** The
  design center of gravity is ACTIONABLE RESOLUTION, not fair ranking.
- **SECONDARY purpose (a byproduct):** external credibility — a defensible,
  honest, hard benchmark that others can trust. We get this for free if the
  instrument is rigorous, but we never trade internal-diagnostic value for it.

Consequences that bind every component:

- Optimize for **decomposition, not a single vanity score.** Every run
  resolves into per-failure-mode findings, each tied to a cause and a
  fix-candidate (§10). The judges' cited reasoning IS the deliverable; the
  numbers are secondary.
- The benchmark is **legitimately hard and NOT favorable to Itotori.** It must
  be able to show Itotori losing where it deserves to. If it cannot, it is
  broken and its verdicts are thrown out (§9).
- We **use the pilot only after** the facility exists, so the real "road trip"
  is fuel-efficient (cost), fast (latency), and luxury-quality. Cost and
  latency are first-class dimensions (§11.1), not afterthoughts.

### 1.1 Declared bias (the honesty mechanism)

Itotori's flow IS a QA / edit / problem-identification / revision cycle, so
this benchmark will **naturally reward QA-and-revision-style work.** We DECLARE
that up front rather than pretend it away. "Cheating on the test" and
overfitting only matter when you care about generalization outside train/test;
for a diagnostic tool used to improve, transparency plus held-out anchors cut
that concern to the side.

The rigor that makes the declaration honest is **three anchors that are
independent of any LLM-judge bias**, reported separately on every run:

1. **The locked held-out split** (§7) — never used to tune Itotori or design
   the rubric; gains there are reported separately.
2. **Blind human ratings** (§8) — the one signal fully outside the LLM/pipeline
   loop.
3. **The deterministic metrics** (§3) — glossary consistency, wrap-fit,
   residue, speaker/branch correctness; objective regardless of judge bias.

Declare the bias, then show results INCLUDING on these bias-independent
anchors. The same instrument then serves internal diagnosis (top priority) and
external credibility (byproduct) honestly.

---

## 2. The quality rubric

_(Aligns build-out node: `benchmark-quality-rubric`.)_

The rubric is what the retired blind-judge proposal (§4) scored against. Each dimension
has explicit criteria and objective anchors so judges score DEFENSIBLY and so
runs are comparable over time. Dimensions map onto the existing MQM-derived
`itotori-lqa-1` taxonomy categories (`docs/localization-quality-taxonomy.json`)
so panel scores, deterministic findings, and QA-agent findings share one
vocabulary — the rubric is the human-scored VIEW of that taxonomy, not a rival
one.

### 2.1 Scoring scale

Every dimension is scored on a **0–4 anchored scale** (not a vague 1–10):

| Score | Anchor                                                                                     | Rough MQM-severity correspondence |
| ----- | ------------------------------------------------------------------------------------------ | --------------------------------- |
| 4     | Ideal for this dimension in context; a careful pro would sign off.                         | no defect                         |
| 3     | Minor issue a target-language player might notice; core intent intact.                     | `minor`                           |
| 2     | Material defect a player would notice; should be repaired before a quality claim.          | `major`                           |
| 1     | Serious defect; meaning, voice, or usability substantially harmed.                         | between `major` and `critical`    |
| 0     | Broken/unusable for this dimension: meaning inversion, unreadable, protected-content loss. | `critical`                        |

Judges MUST attach cited reasoning (source span + decoded context + rationale,
§4.3) to any score below 4. A score without a citation is unscorable and
dropped (mirrors `unscorable_rate` in the taxonomy metrics).

### 2.2 Dimensions

**Adequacy / accuracy group**

- **Adequacy (in-context meaning):** does the target preserve the source
  proposition GIVEN the decoded scene/speaker/branch context? Penalize
  mistranslation, omission, addition, over/under-specification, context
  misread. (taxonomy: `accuracy`)
- **Callbacks / foreshadowing consistency:** are setups, running gags,
  foreshadowed lines, and later payoffs rendered consistently ACROSS the work?
  This is a long-range accuracy dimension, scored only when the corpus
  alignment links a callback to its origin.

**Fluency group**

- **Fluency / naturalness:** grammatical, idiomatic, readable target-language
  prose that fits the genre and narrative mode. (taxonomy: `style`)

**Localization-craft group**

- **Register + politeness (keigo → English):** is Japanese formality/politeness
  (keigo, plain form, rough speech) rendered with an appropriate English
  register for the relationship and scene? (taxonomy: `tone_register`)
- **Character-voice consistency (LONG-RANGE):** does a character keep a
  coherent, distinct English voice ACROSS the whole work, not just within a
  line? This is the marquee dimension — it exercises Itotori's structure-
  informed context advantage — and it is scored against multiple sampled lines
  for the same speaker drawn from different scenes/routes. (taxonomy:
  `tone_register.speaker_voice_drift`)
- **Honorifics handling:** are `-san/-chan/-senpai/...` and address forms
  handled per a declared, CONSISTENT policy (kept, dropped, or mapped), and
  applied uniformly? The policy choice is not scored; consistency and
  appropriateness to it are. (taxonomy: `tone_register.honorific_misuse`)
- **Wordplay / puns / songs:** are puns, rhymes, acrostics, dialect jokes, and
  song lyrics adapted so the EFFECT survives, rather than flattened or
  footnoted away? Highest-difficulty, lowest-frequency dimension.
- **Cultural adaptation:** are culture-bound references handled so a target
  player gets the intended intent without confusion or lost meaning?
  (taxonomy: `locale_convention`)

**Technical group** (also covered deterministically in §3 — the rubric scores
the judgment call, the metrics score the mechanical fact)

- **Text-box fit / word-wrap:** does the line fit its presentation slot without
  overflow/truncation, and wrap readably? (taxonomy: `layout`)
- **Speaker attribution:** is the line attributed to the correct speaker per
  decoded ground truth?
- **Choice / branch correctness:** does a menu choice or branch option preserve
  the player's intended action and route? (taxonomy:
  `accuracy.choice_semantics_shift`)

### 2.3 Weighting

Dimension weighting into any roll-up score is an **OPEN DECISION for Trevor**
(§12). Until decided, the benchmark reports **per-dimension vectors, never a
single weighted total**, so no premature weighting distorts the diagnostic
readout. When weights are set, they are recorded in the run metadata and the
per-dimension vector is still always reported alongside.

---

## 3. Deterministic metric suite

_(Aligns build-out node: `benchmark-deterministic-metric-suite`.)_

The reproducible, judgment-free metrics — the anti-overfit anchor. Each is
computed per contestant output, is bias-independent, reproducible, unit-tested,
and comparable across MTL / fan-MTL / official / Itotori. These are objective
REGARDLESS of any LLM-judge bias and are among the three honesty anchors
(§1.1).

| Metric                                     | Computation                                                                                                                                                                                                                                                                                                                                | Ground truth                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **Glossary / terminology consistency**     | For each canon term with a declared target form, fraction of occurrences rendered with the declared form; also intra-contestant consistency (same source term → same target) even where no glossary entry exists.                                                                                                                          | Corpus glossary + self-consistency                |
| **Named-entity consistency**               | Character/place/item names: consistent romanization + spelling within a contestant, and against the corpus canon-name list.                                                                                                                                                                                                                | Corpus canon-name list                            |
| **Text-box length / word-wrap compliance** | Per unit, does the rendered target fit the engine's box metrics (columns/px) via the Utsushi word-wrap capability? Report overflow count + worst-case overrun.                                                                                                                                                                             | Decoded box metrics (Utsushi capability contract) |
| **Speaker-attribution correctness**        | Fraction of units whose attributed speaker matches the Kaifuu-decoded speaker.                                                                                                                                                                                                                                                             | Kaifuu decode                                     |
| **Choice / branch correctness**            | For choice units, does the target preserve the branch target / player action (structural, not stylistic)?                                                                                                                                                                                                                                  | Kaifuu decoded choice→goto graph                  |
| **Untranslated-residue detection**         | Fraction of units still containing untranslated source script (residual JP kana/kanji) outside protected spans.                                                                                                                                                                                                                            | Script/codepoint scan                             |
| **Character-voice style metrics**          | Per speaker, quantitative style fingerprint (e.g. mean sentence length, contraction rate, politeness-marker rate, function-word distribution) computed across that speaker's lines; report intra-speaker VARIANCE across scenes as a drift proxy. Deterministic and reference-free; complements the subjective long-range voice dimension. | Self, per speaker                                 |
| **Back-translation adequacy**              | Machine back-translate the target to JP (real `usage.cost`, ZDR) and score semantic similarity to the decoded source; a low-cost mechanical adequacy signal. NOT a primary score (it launders one MT model's opinion) — it is a cheap tripwire for gross meaning loss, reported as a signal.                                               | Decoded JP source                                 |

All deterministic outputs are emitted as `itotori-lqa-1` findings with a
`deterministic_qa` / `patch_verify` / `runtime_probe` detector kind, so they
compose with the panel findings in one report (`BenchmarkReportV02`).

**Reference-overlap metrics (BLEU / chrF / TER) are REJECTED as scores** — see
§6.3. Back-translation similarity is the only reference-comparison signal we
keep, and only as a tripwire, never as a ranking.

---

## 4. Retired blind-judge protocol (historical)

> Historical design only. The live blind-judge implementation was retired; the
> current acceptance surface is the deterministic scorecard plus frozen human
> calibration labels.

The subjective scoring layer: multiple LLM judges, blind, cross-family,
producing rubric scores WITH cited reasoning.

### 4.1 Panel composition

- **Multiple judges from ≥2 DIFFERENT model families** (target ≥3 families when
  the ZDR allow-list permits). Cross-family is mandatory to defuse
  self-preference bias (a judge favoring its own family's output). Every
  invocation declares its `(model id, provider id)` pair and records the pair
  actually SERVED (OpenRouter fallback may reroute; ZDR is enforced by account
  posture, not by strict pinning).
- **ZDR-routed only.** Same posture as the pipeline (`zdr:true`,
  `data_collection:deny`, `require_parameters:true`). Any judge model/provider
  outside the ZDR allow-list is disqualified from the panel.
- **Cost is real.** Judge cost is measured from OpenRouter `usage.cost` only,
  never approximated, and is itself reported (a hidden facility cost).

### 4.2 Blinding and bias guards

- **Provenance anonymization:** contestant outputs are stripped of any
  provenance (no "official", "Itotori", "MTL" labels; no giveaway
  formatting/metadata). Judges score anonymized candidates `A/B/C/...`.
- **Order randomization:** contestant order is randomized per unit per judge to
  defuse position bias.
- **Verbosity guard:** the rubric anchors reward correctness-in-context, not
  length; judges are instructed that longer ≠ better, and a verbosity control
  is included in the meta-validity swaps (§9).
- **Self-preference guard:** cross-family panel + provenance anonymization; a
  judge never learns which candidate (if any) its own family produced.

### 4.3 Output contract

Each judge emits, per unit per dimension: a **0–4 score** plus **cited
reasoning** = `{ source span, decoded context used, rationale }`. The cited
reasoning is the actionable deliverable (§10); a score without a citation for a
sub-4 rating is dropped as unscorable. Judge findings are emitted in the
`itotori-lqa-1` finding shape (`detectorKind: llm_qa`) so they compose with
deterministic findings.

### 4.4 Inter-judge agreement

Every run reports **inter-judge agreement** per dimension (e.g. Krippendorff's
alpha or pairwise correlation over the 0–4 scores). Low agreement on a
dimension is itself a diagnostic: either the dimension is ill-anchored (fix the
rubric) or the case is genuinely contested (route to human adjudication, §11.2).
Agreement is reported, never hidden behind an averaged score.

---

## 5. Decoded-context feed (anti-circularity)

_(Aligns build-out node: `benchmark-decoded-context-feed`.)_

Judges get the DETERMINISTIC Kaifuu/Utsushi-decoded context — speaker, scene,
branch, source line, position in the dispatch graph — so their decisions are
informed and defensible.

**Two enforced boundaries:**

1. **Equal context:** the identical decoded-ground-truth context is attached to
   EVERY contestant's candidate for a given unit. No contestant gets richer
   context than another.
2. **No Itotori-interpretive leakage (anti-circularity):** the context fed to
   judges is decoded GROUND TRUTH ONLY — speaker/scene/branch/source from the
   deterministic decode. It MUST NOT include Itotori-generated interpretive
   artifacts (scene summaries, character-arc write-ups, glossaries, style notes
   produced by Itotori's context-building stage). Feeding those would let
   Itotori grade itself against its own interpretation — circular and
   self-favorable.

This is enforced IN CODE: a test asserts (a) byte-identical context across
contestants per unit, and (b) that no field sourced from Itotori's
context-building pipeline appears in the judge input. The boundary is between
**decode** (allowed: deterministic structure) and **interpretation** (forbidden
in the judge feed: Itotori's summaries). Note this is distinct from §6:
Itotori's interpretive context is legitimately fed to Itotori-the-CONTESTANT
during drafting; it is the JUDGE feed that must stay ground-truth-only.

---

## 6. Contestants

_(Aligns build-out node: `benchmark-contestant-harness`.)_

### 6.1 The contestant set

Per source unit, collect and blind-score:

- **Raw MTL baseline** — generated fresh (a plain machine-translation prompt, no
  Itotori machinery), real `usage.cost`. The floor.
- **Fan-edited MTL** — from the corpus fan-TL tier (sourced privately).
- **Official professional localization** — from the corpus official-EN tier
  (sourced privately).
- **Itotori — context ON** — full structure-informed-context pipeline.
- **Itotori — context OFF** — the ABLATION: Itotori WITHOUT structure-informed
  context. The ON/OFF pair measures whether our core advantage (consuming the
  decoded structure — scenes, routes, character arcs) actually helps, and by
  how much, per dimension.

All contestants are provenance-anonymized before scoring (§4.2).

### 6.2 Pro is a BLIND CONTESTANT, not the reference

The official localization is scored anonymized, side by side, exactly like the
others. It is usually the ceiling, but rushed / censored / error-laden pro
localizations exist and the benchmark MUST be able to reveal a dimension where
pro loses. **Never treat the official text as the gold reference** the others
are measured against — that is the reference-overlap error (§6.3) and it also
bakes in one studio's subjective choices as "truth".

### 6.3 Reference-overlap metrics REJECTED as primary

BLEU / chrF / TER and any "closeness to the official translation" metric are
**rejected as primary scores**, because they:

- reward matching ONE subjective localization, treating it as ground truth when
  §6.2 says it is a contestant that can be wrong;
- are gameable (optimize surface n-gram overlap, not quality);
- are wrong for creative/localization work, where many correct renderings share
  little surface form with any single reference.

The only reference-comparison signal retained is back-translation adequacy
(§3), and only as a gross-meaning-loss tripwire, never as a ranking.

---

## 7. Train/test hygiene — the locked held-out split

_(Aligns build-out node: `benchmark-corpus-kanon-triple-tier`.)_

- The corpus is split into a **tuning-visible** portion and a **LOCKED held-out
  evaluation subset.**
- The held-out subset is **NEVER used to tune Itotori** (prompts, glossary,
  style guide, context builder) **and NEVER used to design or calibrate the
  rubric.** It is opened only to REPORT results, and gains on it are reported
  SEPARATELY from tuning-visible gains.
- The split is **recorded and locked** (committed as unit-id lists + hashes; no
  raw text) so that "held-out" is auditable and cannot silently drift into the
  tuning set. Any change to the split is a deliberate, logged event.
- Rationale: this is the rigor that makes the declared bias (§1.1) honest — the
  held-out set is the anchor for "did Itotori actually get better, or did we
  just fit the test?"

Corpus alignment: all three tiers (JP decode / fan-TL / official-EN) are
aligned PER SOURCE UNIT (scene + line) so contestants are comparable
line-for-line. Only hashes/metadata/alignment are committed; copyrighted tiers
stay private (§ copyright boundary).

### 7.1 Triple-tier corpus admission

`apps/itotori/src/benchmark-corpus/` is the metadata-only admission boundary.
Its private builder accepts a Kaifuu decode record plus aligned source, fan, and
official text from a local read-only payload, then emits a reviewable manifest
containing only unit identities, scene keys, source hashes, tier hashes,
aggregate character counts, Kaifuu artifact fingerprints, and the two locked
unit-id lists. The builder never places source or translation text in that
manifest.

Before a runner receives text, it verifies every per-unit tier hash, every tier
projection hash, the complete one-to-one source-unit alignment, the zero-unknown
Kaifuu decode evidence, and the manifest content address. There are only two
selection modes: `tuning` and `held_out_evaluation`. The former returns no
held-out unit; the latter returns only the held-out units. No all-units mode is
provided, and the manifest rejects a policy that permits held-out model tuning
or rubric calibration. The resulting in-memory projections give a contestant
runner the source and fixed fan/official candidates and give deterministic
metrics the same source-unit identities and candidate text.

---

## 8. Human calibration anchors

_(Aligns build-out node: `benchmark-human-calibration-anchors`.)_

The external anchor fully OUTSIDE the LLM/pipeline loop.

- **Blind human-rating capture:** Trevor (and any additional raters) rate
  provenance-anonymized contestant outputs on the SAME rubric (§2), through a
  capture mechanism that presents candidates blind and in randomized order.
- **Calibration report:** quantify LLM-panel-vs-human agreement per dimension
  (correlation + where the panel systematically diverges — e.g. panel too
  lenient on register). This is what proves the panel tracks human judgment and
  bounds its bias.
- **Locked anchor:** the human ratings are an external anchor and are **not used
  to tune Itotori.** (They MAY be used to calibrate/​adjust the PANEL — e.g.
  reweight or re-anchor a judge that diverges — but that is calibration of the
  instrument, logged as such, never Itotori tuning.)
- **Volume** (how many human-anchored ratings) is an OPEN DECISION for Trevor
  (§12); the design target is "a few dozen anchored ratings prove the panel
  tracks humans," but the exact N and rater pool are Trevor's call.

---

## 9. Meta-validity — the benchmark must pass its own tests

_(Aligns build-out node: `benchmark-meta-validity-harness`.)_

The benchmark validates ITSELF; a run that fails any meta-validity check is
**flagged INVALID** and its verdicts are not used.

1. **Sensitivity (sabotage test):** a deliberately-SABOTAGED Itotori output
   (seeded defects per the taxonomy's `seededDefectKinds` — meaning shifts,
   dropped placeholders, voice drift, overflow) MUST rank **BELOW fan-MTL.** If
   the instrument cannot show a degraded Itotori losing where it deserves to,
   it is broken and thrown out. This is the single most important guardrail
   against a self-favorable benchmark.

   **Sensitivity honesty — which sabotage kinds carry judge-independent weight:**

   | Sabotage kind family                                                                                 | Detection surface                                                                                                      | Judge-independent?                                                                                                                  |
   | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
   | **Residue / overflow** (`untranslated_residue`, `layout_overflow`, and other §3-metric-backed seeds) | Real deterministic metrics (§3): source-script residue scan, text-box / wrap compliance, live gates such as `byte-box` | **Yes.** Demotion is earned by the worse text under a pure metric, with no LLM and no scripted judge.                               |
   | **Meaning / voice** (`meaning_shift`, `speaker_voice_drift` / `voice_drift`)                         | LLM QA / human review only (taxonomy `expectedDetectorKinds`: `llm_qa`, `human_review` — not `deterministic_qa`)       | **No** under current metrics. There is no real deterministic metric that scores inverted propositions or out-of-character register. |

   A fixture-only sensitivity run that demotes meaning/voice **only** because a
   hand-scripted fixture `qualityScoreFn` recognizes injected markers
   (historically `SABOTAGE_MEANING_MARKER` / `SABOTAGE_REGISTER_MARKER`, e.g.
   `[[NEGATED]]` / `[[FORMAL-DIRECTIVE]]`) is a **test double**: it proves the
   ranking machinery can respond to a score drop, **not** that a live LLM
   judge would catch those defects. Treat such a run as **judge-scripted** for
   meaning/voice. Live sensitivity for those kinds requires a real multi-family
   LLM judge panel (or human ratings) reading the degraded text.

   Therefore the sensitivity check **must assert the metric-caught kinds
   (residue / overflow) independently of any scripted judge** — e.g. by
   re-scoring with metrics alone (or a constant/no-op judge) and still seeing
   the sabotaged contestant lose standing. Meaning/voice may still appear in a
   full sabotage set for panel/live runs, but they do **not** carry the
   judge-independent weight of the meta-validity claim.

   **Machine pins (path b):**
   - `apps/itotori/src/benchmark-sensitivity/` — pure sabotage injector +
     `runMetricCaughtSensitivityCheck` (residue codepoint scan + wrap-compliance
     only; no `qualityScoreFn`). Tests in
     `apps/itotori/test/benchmark-sensitivity-metric-caught.test.ts` assert
     residue/overflow sabotage is metric-caught and meaning/voice is not.
   - `packages/localization-bridge-schema/test/benchmark-sensitivity-honesty.test.ts`
     freezes the taxonomy `expectedDetectorKinds` split (meaning/voice =
     judge-only; layout_overflow = metric/runtime).

2. **Robustness (swap tests):** verdicts must be stable under **judge-swap**
   (drop/replace a judge family) and **contestant-order-swap** (re-randomize
   order). A ranking that flips under a benign swap is not trustworthy;
   instability is reported and, past a threshold, invalidates the run.
3. **Calibration (human correlation):** the benchmark ranking must correlate
   with the human ratings (§8). Below a correlation floor, the run is flagged as
   uncalibrated.

Meta-validity is run-gating: the harness runs all three, and the run's report
carries a `valid | invalid` verdict with the failing check named. This keeps us
honest — the benchmark earns the right to make claims only by passing its own
tests each run.

---

## 10. Actionable output — the primary artifact

_(Aligns build-out node: `benchmark-actionable-backlog-output`.)_

The diagnostic deliverable, and the TOP requirement. A run decomposes results
into a **ranked improvement backlog**, not a score.

### 10.1 Per-failure-mode schema

Each finding is emitted as:

```
{
  failure_mode:   "<what, concretely>",     // e.g. "register too formal in casual scenes"
  dimension:      "<rubric dimension>",     // §2 dimension + itotori-lqa-1 category
  scope:          "<where>",                // scenes/route/speaker/N lines affected
  evidence:       [ cited unit + span + judge rationale, ... ],   // §4.3 citations
  cause:          "<root cause>",           // itotori-lqa-1 rootCause vocabulary
  fix_candidate:  "<candidate fix>",        // glossary enforcement / style-guide+context
                                            //   tuning / draft-prompt length constraint / ...
  rank:           "<priority>",             // per §10.2
  regression_ref: "<prior-run delta, if any>"
}
```

Examples of the target resolution: "trails pro on register-adaptation in casual
scenes 38% of the time"; "drifts on character-X terminology across route Y";
"overflows the text box in 12 lines." Each is tied to a cause and a
fix-candidate with cited evidence.

### 10.2 Ranking rule (the priority ladder)

- **Trailing even fan-MTL on a dimension → TOP priority** (a genuine blind
  spot; we lose to the cheap tier).
- **Trailing pro (but beating fan-MTL) → improvement backlog** (normal
  catch-up work).
- **Beating fan-MTL / matching pro → regression protection** (lock it in; watch
  for regressions).

### 10.3 DAG emission + regression telemetry

- Findings are **routable straight into the DAG** as findings/nodes (the
  improvement backlog is the artifact, not a number).
- Every run records **per-dimension regression telemetry** vs prior runs — the
  dyno readout: re-running after a change shows per-dimension deltas so we can
  see whether a change helped, hurt, or regressed another dimension.

---

## 11. Cost/latency dimensions, corpus, and bias declaration

### 11.1 Cost + latency (the car metrics)

_(Aligns build-out node: `benchmark-cost-latency-dims`.)_

Cost and latency are first-class dimensions reported ALONGSIDE quality, so
improvements are judged on the quality/cost/speed frontier (fuel-efficient +
fast + luxury-quality).

- **Per-unit cost** is measured from real OpenRouter `usage.cost` ONLY — never
  approximated, never hardcoded (must stay `audit-no-hardcoded-cost` clean).
  Reference point: the full localization chain runs ~$0.0000757/unit on the
  DEV_PAIR (~$2 for a full ~27k-unit game), so the facility's own model spend is
  small — but it is still measured and reported, including judge-panel cost
  (§4.1).
- **Per-unit latency** is measured per contestant/config and reported next to
  cost and the quality vector.
- These dims apply to the CONFIGURABLE contestants (MTL baseline, Itotori
  on/off); the fixed corpus tiers (fan-TL, official) have no meaningful runtime
  cost/latency and report N/A.

### 11.2 Corpus

_(Aligns build-out nodes: `benchmark-corpus-kanon-triple-tier`,
`benchmark-fan-corrected-calibration-cases`, `nexas-engine-support`.)_

- **Kanon (RealLive) — the confirmed starter, first stand-up target.** Our
  primary engine, byte-confirmed decodable, resolves in the vault, same family
  as the Sweetie HD testbed. Triple-tier: JP decode + fan-TL (private) +
  official-EN (private). Ground the design and the first real run here.
- **Fan-corrected-official calibration cases — Chaos;Head NOAH (Committee of
  Zero), Steins;Gate.** MAGES engine, UNSUPPORTED → **text-only quality
  scoring, no decode/patchback.** These are the CRUCIBLE for Trevor's principle:
  **do not assume pro = good and fan = bad, but also do not lock in
  fans-know-best.** The "right" answer on the contested lines is CONTESTED and
  HUMAN-ADJUDICATED, not readable from provenance — so they serve as the
  panel's contested-quality CALIBRATION anchors (they pair with §8/§9).
- **Majikoi — hard flagship, GATED on NeXAS support.** Majikoi is NeXAS
  (byte-verified), NOT Softpal — the vault `softpal` tag was a mis-tag. It is
  brutally hard (Kansai-ben, samurai/chuuni register, puns) and is the ideal
  hard-language target, BUT it needs the `nexas-engine-support` Kaifuu adapter
  (NeXAS `PAC\0`+Deflate vs Softpal `PAC `+uncompressed, GARbro as oracle)
  before it can be a decoded triple-tier contestant. **The benchmark does NOT
  block on NeXAS;** Majikoi rejoins as the hard flagship once the adapter lands.
- **Caveat (all owned titles):** the vault holds JP + official-EN but NOT the
  fan-TL patch text; the fan tier requires external PRIVATE sourcing (patch
  archives), held read-only-never-publish.

### 11.3 Bias declaration (restated as a facility invariant)

Per §1.1: the benchmark rewards QA/revision-style work; we DECLARE it. The
honesty mechanism is the three bias-independent anchors — locked held-out set
(§7), blind human ratings (§8), deterministic metrics (§3) — reported on every
run. External-credibility claims are only ever made with those anchors shown.

---

## 12. Open decisions (surfaced, not buried — need Trevor input)

These are genuine judgment calls the intentions did not fully pin down. Build-
out may proceed on the reasoned defaults noted, but these should be confirmed:

1. **Dimension weighting (§2.3).** How (or whether) to weight rubric dimensions
   into any roll-up. _Default until decided:_ report per-dimension vectors
   only, no single weighted score.
2. **Human-rating volume + rater pool (§8).** How many blind human-anchored
   ratings, and who besides Trevor rates. _Default target:_ "a few dozen"
   anchored ratings; exact N and pool are Trevor's.
3. **Fan-TL sourcing specifics (§7, §11.2).** WHICH fan-TL/fan-edited-MTL
   patches for Kanon (and later Majikoi), and the private-sourcing/storage
   mechanism (read-only-never-publish). Existence is confirmed; specifics are
   Trevor's.
4. **Judge panel size + exact families (§4.1).** ≥2 families is the floor,
   ≥3 the target; which specific ZDR-allow-listed families/models, and how many
   judges, is a cost/robustness tradeoff for Trevor.
5. **Meta-validity thresholds (§9).** The numeric floors — how much ranking
   instability under a swap invalidates a run; the minimum human-correlation for
   "calibrated." _Default:_ start strict, relax only with evidence.
6. **NeXAS timing (§11.2).** File `nexas-engine-support` now (to bring Majikoi
   in as the hard flagship) or hold and run the benchmark on Kanon + the
   fan-corrected cases first. The benchmark itself does not block on it either
   way.

---

## Appendix A — build-out node → section map (the alignment reference)

Each benchmark build-out node's acceptance criteria must conform to the
referenced section. Builders align to these; deviation is a methodology change
(raise it, do not silently implement).

| Build-out node                              | Methodology section(s)                                |
| ------------------------------------------- | ----------------------------------------------------- |
| `benchmark-quality-rubric`                  | §2 (dimensions, anchors, 0–4 scale)                   |
| `benchmark-deterministic-metric-suite`      | §3 (metric table + computations)                      |
| `benchmark-decoded-context-feed`            | §5 (equal context + anti-circularity boundary)        |
| `benchmark-contestant-harness`              | §6 (contestant set, ablation, pro-as-contestant)      |
| `benchmark-corpus-kanon-triple-tier`        | §7 (held-out split) + §11.2 (Kanon starter)           |
| `benchmark-human-calibration-anchors`       | §8 (human anchor + calibration report)                |
| `benchmark-meta-validity-harness`           | §9 (sensitivity / robustness / calibration)           |
| `benchmark-actionable-backlog-output`       | §10 (schema, ranking, DAG emission, telemetry)        |
| `benchmark-cost-latency-dims`               | §11.1 (real `usage.cost` + latency)                   |
| `benchmark-fan-corrected-calibration-cases` | §11.2 (Chaos;Head NOAH / Steins;Gate crucible)        |
| `nexas-engine-support`                      | §11.2 (Majikoi gated on NeXAS; benchmark not blocked) |

## Appendix B — related artifacts

- `docs/localization-quality-taxonomy.json` (`itotori-lqa-1`) — the MQM-derived
  category / severity / root-cause / seeded-defect vocabulary the rubric and
  findings map onto.
- `packages/localization-bridge-schema` — `BenchmarkReportV02` /
  `assertBenchmarkReportV02`, the machine-readable run/cost report shape;
  benchmark runs emit into it.
- `docs/quality-claims.md` — the public-claim gate (named benchmark, fixtures,
  model/provider versions, cost, seeded-defect results, human protocol) this
  facility is designed to satisfy.
- `project_full_stack_structure_informed_context` — the decoded structure fed as
  Itotori context (contestant side) and, as GROUND TRUTH only, to judges (§5).
- `project_at_scale_readiness_verdict_and_cost_curve` — the real cost/latency
  curve underpinning §11.1.
