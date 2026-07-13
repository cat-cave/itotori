# Itotori Product Workflow

This document defines the operating model for a localization project. Itotori
ships complete, scoped patch versions, then improves them through play and
iteration:

```
frozen run scope
  → written outcomes for every in-scope unit
  → complete patch version
  → play-test evidence and feedback
  → result revisions and canonical-context changes
  → refinement run
  → next complete patch version
```

Quality is measured and made legible; coverage is what gates a patch. A quality
finding is an annotation on a written result, not permission to omit that
result from the configured scope.

## Product guarantees

- A successful run writes a non-blank selected result for every unit in its
  frozen scope.
- A patch version contains exactly that scope and is complete within it.
- QA findings, confidence, and contested checks stay attached to the selected
  result and are visible in Play and Results.
- No interface action claims it changed localization unless it wrote either a
  result revision or canonical context.
- An operational pause (such as a cost cap, provider outage, or product defect)
  is a resumable run-level state. It is never converted into an incomplete
  patch or an unwritten unit outcome.

## Roles

**Operator** configures scope, routing, cost, and launch conditions. The
operator resolves operational pauses and resumes the durable run.

**Play tester** uses a complete patch in its target language. They can edit a
localized result, add or correct context, edit the wiki, and contribute
evidence-backed feedback. These changes are inputs to the next iteration, not
gates inside the run that produced the patch.

## Run to patch

| Stage                             | Durable output                                                                               | Rule                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Scope and launch                  | Frozen project, branch, source revision, cost/routing policy, and unit set                   | Scope is explicit before drafting starts.                                    |
| Context resolution                | Revision-valid context packet for each unit                                                  | Context is resolved from canonical versions and frozen for the unit attempt. |
| Draft and self-correction         | Candidates, selected non-blank result, and candidate-scoped QA findings                      | Candidate repair is bounded and automatic; findings remain annotations.      |
| Written-outcome finalization      | One selected written result for every in-scope unit                                          | A run cannot call itself complete with a missing result.                     |
| Patch construction and validation | Patch version, artifact hashes, replay/runtime evidence, and coverage record                 | The patch contains exactly the frozen-scope results.                         |
| Play and refinement               | Versioned observations, result revisions, context changes, and a later frozen refinement run | A new run is intentional and traceable to its base version and inputs.       |

Deterministic checks and QA inspect the real selected candidate. If an automatic
repair produces a later candidate, its QA record is scoped to that candidate;
the selected result keeps the evidence that actually judged it. This prevents a
stale finding set from being represented as current quality evidence.

## Play-test changes

The play surface is target-first, with source, provenance, QA annotations, and
runtime evidence available for drill-down. It has two kinds of localization
change:

1. **Result revision.** A play tester changes the target text for a concrete
   result. It creates a versioned result revision with actor and patch-version
   provenance, then contributes to a deterministic child patch revision.
2. **Context correction.** A play tester records a missing or incorrect fact:
   speaker, route condition, terminology, canon, scene meaning, style context,
   or another source-grounded constraint. The correction writes canonical
   context, identifies its affected scope, and is available to the next
   refinement run.

A note, screenshot, replay observation, or imported report is evidence, not an
acknowledgement action. When it changes localization, it is linked to one of
the two durable changes above. When it does not yet change localization, it
remains an evidence-bearing feedback record and does not claim success.

## Canonical context and wiki

The wiki is the project’s versioned context brain. Character, term, scene,
style, and glossary entries are canonical context rather than loose notes.
Each edit carries provenance, revision identity, and the affected units it can
invalidate.

Context updates must be specific enough to resolve into a future context packet.
For example, a terminology correction records the term, target treatment,
scope, source support, and relevant branch; a speaker correction records the
speaker/scene fact and its evidence. The next run freezes the wiki heads it
uses, which makes its inputs reproducible even as the wiki continues to grow.

## Feedback intake and evidence

Feedback can originate from in-product play, runtime captures, imported forms
or issue exports, and project-internal notes. An intake record preserves:

- project, target locale, branch, patch version, and best available source or
  unit anchor;
- observation text, reporter provenance, privacy classification, and redaction
  state;
- screenshot, replay, save, route, or runtime artifact identifiers when
  available;
- a dedupe key and links to the result revision or context correction that
  eventually acts on it.

Duplicate reports aggregate evidence without fabricating multiple localization
changes. Runtime evidence retains its Utsushi tier: an E2 frame supports a
visible-frame claim, while an E3 replay supports a replayable observation. The
system does not promote either claim beyond the evidence actually captured.

## Refinement runs and patch lineage

A refinement run freezes:

- its base patch version;
- selected feedback or revision inputs;
- the context/wiki heads it resolves;
- the new or affected scope; and
- routing and cost policy.

Unaffected valid results may be reused from the base version. Affected and
newly in-scope units are redrafted against the frozen context. The same coverage
rule applies: the resulting patch is complete within its declared scope.

This lineage makes the flywheel inspectable:

```
patch v1 → play observation → result revision/context correction → refinement → patch v2
```

It also makes it possible to compare a result or patch version without
pretending that later context was available to an earlier run.

## Quality, validation, and operational handling

Quality findings guide the play tester and refinement work. They do not withhold
a written result from a patch merely because a model or heuristic is uncertain.
Patch construction still requires the real structural conditions: complete
configured scope, byte-correct patchback, and the validation evidence demanded
by the selected engine/workflow.

The system distinguishes those conditions from an operational problem:

| Condition                          | Handling                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Content or transient model failure | Bounded corrective retry until a valid written result is produced.                                         |
| QA concern after a written result  | Preserve it as a finding and continue with the selected result.                                            |
| Cost cap or provider outage        | Pause the run with durable progress; an operator resolves the condition and resumes.                       |
| Product or engine defect           | Fail visibly with structured diagnostics; fix the defect rather than manufacture a source-text substitute. |
| Play-test issue                    | Record evidence, then create a result revision or context correction as appropriate.                       |

## Mutation and audit rules

Every localization-affecting action records actor, time, project/branch,
source or patch identity, and causal evidence. The durable event trail explains
why a selected result, canonical fact, or patch lineage changed.

The user-visible consequence must be clear before a mutation:

- a result revision changes target text and patch lineage;
- a context correction changes canonical inputs and affected scope;
- a wiki edit changes a versioned context entry;
- a refinement launch freezes those inputs for a new run.

Read-only inspection, annotation, and evidence capture remain valuable, but
they do not report a localization change until one of those durable writes
occurs.

## Alpha product bar

The workflow is acceptable when:

- a supported-engine run produces a complete patch for its configured scope;
- Play exposes result history, QA annotations, and runtime evidence without
  disguising quality annotations as release blockers;
- target edits create result revisions and context facts create canonical
  corrections;
- wiki edits are versioned and feed resolved context into later runs;
- feedback has source/evidence/privacy provenance and can drive an explicit
  refinement run;
- patch lineage makes v1 → play → v2 understandable; and
- an operational pause is resumable and never treated as a legitimate partial
  localization outcome.
