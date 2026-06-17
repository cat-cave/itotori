# ADR 0003: Localization Quality Taxonomy And Benchmark Protocol

## Status

Accepted for SHARED-009.

## Context

Itotori needs quality evidence that agents, deterministic QA, benchmark reports,
and human reviewers can score the same way. The suite already has DAG and audit
severities named `P0` through `P3`; those labels describe implementation and
orchestration consequence, not translation quality. Reusing them for
localization findings would make reports ambiguous and could let a severe
translation defect look like a merge-blocking repository defect, or let a
repository audit finding look like a translation defect.

The benchmark protocol also needs seeded defects and QA-agent metrics that are
machine-readable. A finding that says "bad translation" without a severity,
category, root cause, evidence span, and reviewer decision is not scorable and
cannot support a quality claim.

[MQM](https://themqm.org/) is the strongest fit as the base model because it is
an analytic translation quality evaluation framework with structured issue
types, severity levels, scoring, root-cause analysis, and reliability guidance.
MQM-Core includes top-level dimensions such as terminology, accuracy, linguistic
conventions, style, locale conventions, audience appropriateness, and design and
markup. MQM guidance also treats implementer-selected subsets and calibrated
scorecards as normal parts of the model.

Raw automatic metrics such as BLEU, chrF, COMET-like scores, or LLM preferences
are useful regression signals, but they do not give Itotori repairable root
causes or deterministic QA-agent precision/recall against seeded defects. A
pure human preference rubric would be easy to read but too weak for future
agent output, because it would not force issue classification or evidence.

## Decision

Itotori uses `itotori-lqa-1`, an MQM-derived game-localization profile, as the
canonical localization quality taxonomy for benchmarks, QA findings, seeded
defects, and human evaluation.

The top-level categories are:

| Category              | Meaning                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `accuracy`            | Target content changes source meaning through mistranslation, omission, addition, specificity drift, or choice semantic drift.           |
| `terminology`         | Target content violates glossary, canon name, term consistency, or romanization policy.                                                  |
| `style`               | Target content violates style guidance, genre fit, idiomaticity, readability, or consistency expectations.                               |
| `tone_register`       | Target content gives a speaker, relationship, formality level, honorific, or emotional stance the wrong voice.                           |
| `locale_convention`   | Target content violates locale formatting, cultural reference, currency, measurement, shortcut, or sensitivity requirements.             |
| `protected_content`   | Target content corrupts, drops, translates, or invents placeholders, control codes, markup, variables, or do-not-translate spans.        |
| `layout`              | Target content fails in its presentation slot: overflow, truncation, hidden text, bad wrapping, image-text mismatch, or script/font fit. |
| `technical_integrity` | Patch, encoding, schema, asset binding, or runtime integration breaks the localized artifact independent of ordinary wording quality.    |

These category ids match the current `LOCALIZATION_QUALITY_CATEGORIES` exported
by `packages/localization-bridge-schema`. Game-localization extensions are
modeled as subcategories and evidence requirements, not as extra top-level
categories. This keeps future agent output stable while still covering dialogue
continuity, choices, speaker voice, protected spans, and runtime layout.

Localization quality severities are:

| Quality severity | Weight | Meaning                                                                                                                                                                                                    |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical`       | 25     | The localized artifact is unsafe or unusable for the target context: broken rendering, protected content loss, meaning inversion, or a defect that blocks export/release without an explicit human waiver. |
| `major`          | 5      | The defect materially changes meaning, violates a required policy, or would be noticed by a target-language player and should be repaired before a quality claim.                                          |
| `minor`          | 1      | The defect is noticeable but low impact; it does not change core meaning and may ship only when the reviewer records the tradeoff.                                                                         |
| `neutral`        | 0      | A note, reviewer question, waived intentional deviation, duplicate, or false positive; it is retained for traceability but does not count as a defect.                                                     |

Do not serialize localization quality severity in a field named `severity` when
the surrounding contract already uses DAG or audit severity. Use
`qualitySeverity`. DAG and audit records continue to use `severity: "P0" |
"P1" | "P2" | "P3"` for orchestration consequence only.

Every benchmark finding must carry:

- taxonomy id and version;
- detector kind: deterministic QA, LLM QA, human review, runtime probe, or
  seeded-defect oracle;
- affected subject references, normally bridge unit/span ids or runtime
  evidence ids;
- one top-level `category` and one optional `subcategory`;
- one `qualitySeverity`;
- one primary `rootCause`;
- evidence with expected value, observed value, provenance, and enough context
  for a reviewer to reproduce the judgment;
- reviewer adjudication state.

Findings may include secondary categories or contributing root causes, but the
primary values are required so aggregate benchmark tables are scorable.

## Root Causes

Itotori report records use a small root-cause set:

| Root cause                          | Use when                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `source_content_defect`             | The source text or asset is wrong, ambiguous, corrupt, or internally inconsistent.                   |
| `source_annotation_gap`             | Source annotations, protected-span metadata, speaker data, or context markings are missing or wrong. |
| `style_guide_gap`                   | The style guide is missing, contradictory, stale, or wrong for the target branch.                    |
| `glossary_policy_gap`               | Glossary, canon-name, do-not-translate, or romanization policy is missing, contradictory, or stale.  |
| `prompt_or_context_pack_error`      | The drafting or QA task assembled incomplete, stale, or misleading context.                          |
| `model_draft_error`                 | The model output is wrong despite adequate context and policy.                                       |
| `human_edit_error`                  | A human reviewer, editor, or post-editor introduced or failed to catch the defect.                   |
| `deterministic_qa_rule_error`       | A rule produced a false positive/negative or encoded the wrong policy.                               |
| `patch_application_error`           | Kaifuu patching, delta application, or verification changed or lost localized content.               |
| `runtime_environment_or_i18n_limit` | Utsushi/runtime evidence exposes engine, font, fixed-size UI, BiDi, input, or other i18n limits.     |
| `benchmark_seed`                    | The defect was deliberately injected for seeded-defect evaluation.                                   |
| `unknown_unadjudicated`             | Temporary value before human adjudication; publish only in draft/internal reports.                   |

Root cause is assigned after evidence review. A QA agent may propose it, but a
human or deterministic oracle adjudicates it before benchmark claims use the
record.

## Seeded Defects

Seeded-defect fixtures use the same taxonomy as normal findings. A seed record
must include:

- seed id, fixture/corpus id, target locale, and deterministic seed when used;
- injected bridge unit/span or runtime evidence target;
- category, subcategory, quality severity, and expected root cause;
- expected detector families;
- expected evidence fields and accepted near-match rules;
- whether the seed is public or private-local;
- adjudication status after a benchmark run.

The required seed kinds are:

| Seed kind                        | Category              | Expected detectors                             |
| -------------------------------- | --------------------- | ---------------------------------------------- |
| `meaning_shift`                  | `accuracy`            | LLM QA and human review                        |
| `omission`                       | `accuracy`            | deterministic QA when span/count based, LLM QA |
| `choice_semantics_flip`          | `accuracy`            | LLM QA and human review                        |
| `wrong_glossary_term`            | `terminology`         | deterministic QA, LLM QA, human review         |
| `term_inconsistency`             | `terminology`         | deterministic QA and human review              |
| `style_guide_violation`          | `style`               | deterministic QA when rule-backed, LLM QA      |
| `speaker_voice_drift`            | `tone_register`       | LLM QA and human review                        |
| `locale_format_error`            | `locale_convention`   | deterministic QA and human review              |
| `cultural_reference_mismatch`    | `locale_convention`   | LLM QA and human review                        |
| `placeholder_dropped`            | `protected_content`   | deterministic QA, patch verify, human review   |
| `control_markup_corrupted`       | `protected_content`   | deterministic QA and patch verify              |
| `do_not_translate_violation`     | `protected_content`   | deterministic QA and human review              |
| `layout_overflow`                | `layout`              | runtime probe, deterministic QA when bounded   |
| `hidden_or_missing_runtime_text` | `layout`              | runtime probe and human review                 |
| `encoding_garble`                | `technical_integrity` | deterministic QA, patch verify, runtime probe  |
| `schema_or_patch_breakage`       | `technical_integrity` | schema guard, patch verify                     |

Seeded-defect reports must separate:

- seed recall: expected seeds detected at least once;
- seed precision: detected seeded findings that match a real seed;
- category accuracy;
- quality-severity accuracy;
- root-cause accuracy;
- unscorable finding rate.

No seeded-defect result may be counted if the finding lacks evidence, category,
quality severity, root cause, or adjudication state.

## Human Evaluation Rubric

Human evaluation is analytic review, not a freeform preference survey.

Reviewers evaluate a sampled source/target pair with visible source text,
target text, protected spans, speaker/context notes, style guide, glossary,
runtime evidence when applicable, and detector findings. When a public report
claims a blind review, detector identity and system identity are hidden until
after the first decision pass.

For each defect candidate, reviewers must:

1. Decide whether there is one defect, multiple defects, a duplicate, a false
   positive, or not enough context.
2. Assign one primary category and optional subcategory.
3. Assign `qualitySeverity` using only target-player impact and artifact
   usability, never DAG priority.
4. Assign one primary root cause after evidence review.
5. Record an adjudication state.
6. Leave a short rationale that cites the visible evidence, not model
   confidence.

Adjudication states are:

| State                     | Meaning                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `unreviewed`              | The finding exists but has not been reviewed; draft reports only.                         |
| `confirmed`               | Reviewer agrees this is a real defect and keeps or corrects the taxonomy fields.          |
| `rejected_false_positive` | Reviewer finds no defect or no supported evidence.                                        |
| `duplicate`               | The finding repeats another active finding; metrics should credit only the canonical one. |
| `needs_more_context`      | Reviewer cannot judge from available source, target, policy, or runtime evidence.         |
| `intentional_or_accepted` | The issue is intentional, policy-approved, or explicitly accepted with rationale.         |
| `fixed_verified`          | The defect was repaired and the reviewer verified the new evidence.                       |

Benchmark reports count only adjudicated records in quality metrics. They may
show unreviewed counts separately, but unreviewed findings cannot support public
quality claims.

## Benchmark Protocol

Benchmarks compare systems, not anecdotes. A benchmark report must include:

- fixture or private-local corpus identity, hashes, source/target locales,
  engine profile, and benchmark split;
- git commit, tool versions, command lines, deterministic seed, and bridge
  schema version;
- compared systems, such as raw MTL baseline, Itotori draft, repaired Itotori
  draft, and human reference when available;
- provider/model/preset identity, cost, token, latency, retry, and fallback
  metadata for every live or recorded model run;
- seeded-defect injection list and expected oracle mapping;
- finding records with category, quality severity, root cause, and
  adjudication state;
- aggregate counts by category, quality severity, root cause, detector kind,
  and adjudication state;
- penalty totals using the `critical=25`, `major=5`, `minor=1`, `neutral=0`
  weights, normalized per 1000 source characters and per 100 source units;
- QA-agent precision, recall, F1, category accuracy, quality-severity accuracy,
  root-cause accuracy, critical recall, and unscorable rate;
- human-review sample counts and reviewer agreement notes when more than one
  reviewer adjudicates the same sample.

The primary quality output is the structured distribution and adjudicated
finding set. A single quality score may be reported for trend dashboards, but it
must not replace the category/quality-severity/root-cause/adjudication tables.

## Alternatives Considered

### Full MQM Without An Itotori Profile

Full MQM is too broad for early agent contracts. It would expose many categories
that future agents could choose inconsistently, and it would not name
game-specific subcategories such as choice semantic drift, speaker voice drift,
protected-span loss, and runtime overflow.

### Automatic MT Metrics As The Primary Benchmark

Automatic metrics can be cheap trend signals, but they do not explain why a
game string failed, whether the defect came from a glossary gap, prompt/context
construction, patching, runtime layout, or model output, and whether the finding
was adjudicated.

### Binary Human Preference

Preference review can rank systems, but it does not produce repairable findings
or seeded-defect precision/recall. It is allowed only as supplemental context.

### Pure In-House Categories

A fully custom taxonomy would fit games but lose MQM's existing analytic
evaluation model, severity weighting, root-cause guidance, and reviewer
training vocabulary. Itotori keeps MQM as the foundation and narrows it.

## Consequences

- Future benchmark and finding schemas should add `qualitySeverity`,
  `qualityCategory` or `category`, `qualitySubcategory`, `rootCause`, and
  `adjudicationState` fields rather than overloading DAG `severity`.
- QA agents must emit scorable records with evidence and taxonomy fields, not
  confidence-only prose.
- Deterministic QA and seeded-defect fixtures can share the same category and
  root-cause vocabulary.
- Quality dashboards must show quality severity, category, root cause, and
  reviewer adjudication separately.
- Public quality claims remain disallowed until reports follow this protocol
  and cite fixture/corpus hashes, provider/model metadata, cost, seeded-defect
  results, and human evaluation scope.
