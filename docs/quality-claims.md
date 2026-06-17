# Quality Claims

This repository does not yet claim superiority over raw MTL, generic LLM translation, or human localization workflows.

Public quality claims require named benchmarks, fixture data, model/provider
versions, cost reporting, seeded-defect results, and a human evaluation
protocol.

## Canonical Taxonomy

Localization quality evidence uses the `itotori-lqa-1` taxonomy accepted in
[ADR 0003](adrs/0003-localization-quality-taxonomy.md). The machine-readable
taxonomy lives in
[localization-quality-taxonomy.json](localization-quality-taxonomy.json) and is
validated by
[localization-quality-taxonomy.schema.json](localization-quality-taxonomy.schema.json).

Quality reports must not use DAG `P0`-`P3` values as translation severities.
Those values are implementation and audit consequences. Translation findings
use `qualitySeverity` with these values:

| Quality severity | Weight | Use                                                                                    |
| ---------------- | ------ | -------------------------------------------------------------------------------------- |
| `critical`       | 25     | Broken, unsafe, unusable, or export/release-blocking localization defect.              |
| `major`          | 5      | Material meaning, policy, term, tone, or locale defect that should be repaired.        |
| `minor`          | 1      | Low-impact defect that may ship only with reviewer rationale.                          |
| `neutral`        | 0      | Note, duplicate, false positive, intentional accepted deviation, or reviewer question. |

Reports must also record one primary category, optional subcategory, one primary
root cause, concrete evidence, and reviewer adjudication state for each
finding. The required top-level categories are:

- `accuracy`
- `terminology`
- `style`
- `tone_register`
- `locale_convention`
- `protected_content`
- `layout`
- `technical_integrity`

## Benchmark Report Requirements

A benchmark or quality report may support public wording only when it includes:

- fixture or private-local corpus identity, hashes, source/target locales,
  engine profile, and benchmark split;
- git commit, tool versions, command lines, deterministic seed, and bridge
  schema version;
- systems compared, such as raw MTL baseline, Itotori draft, repaired Itotori
  draft, or human reference;
- provider/model/preset identity, token, cost, latency, retry, and fallback
  metadata when model calls are involved;
- seeded-defect oracle records and seed injection scope;
- finding records with `qualitySeverity`, category, subcategory when known,
  root cause, evidence, detector kind, and adjudication state;
- aggregate counts by quality severity, category, root cause, detector kind,
  and adjudication state;
- penalty totals using the taxonomy weights, normalized per 1000 source
  characters and per 100 source units;
- QA-agent precision, recall, F1, category accuracy, quality-severity accuracy,
  root-cause accuracy, critical recall, and unscorable rate;
- human-review sample counts and reviewer agreement notes when more than one
  reviewer adjudicates the same sample.

Public reports may cite private-local corpora only by aggregate stats and
hashes allowed by [fixtures-and-corpora.md](fixtures-and-corpora.md). They must
not include raw private source text, screenshots, local paths, or filenames that
reveal restricted story content.

## Claim Wording

Allowed wording is report-scoped:

- "On benchmark `<id>` at commit `<sha>`, Itotori draft `<system>` had `<n>`
  confirmed major terminology findings and `<m>` critical protected-content
  findings after adjudication."
- "QA agent `<agent>` reached `<x>` seeded recall and `<y>` seeded precision on
  public fixture `<fixture-id>`."
- "The run is not comparable to private corpus `<label>` because the fixture
  mix, target locale, or evidence tier differs."

Disallowed wording includes:

- broad claims that Itotori is better than human localization, raw MTL, or
  generic LLM translation without named benchmark and adjudicated evidence;
- claims that collapse category, severity, root cause, and adjudication into one
  score;
- claims based on unreviewed QA-agent findings, confidence-only outputs, or
  reports that reuse `P0`-`P3` as translation severities;
- cost or quality claims whose provider routing, fallback, token, or cost
  metadata is missing.
