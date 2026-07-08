# Itotori Product Workflow

This document defines Itotori's product-level workflow for human-in-the-loop
localization review before UX-heavy decision flows are implemented. Itotori owns
locale branches, drafts, policy, QA findings, feedback, runtime evidence
ingestion, and patch-ready exports. Kaifuu owns source extraction and patching.
Utsushi owns runtime traces, captures, replay sessions, and evidence tiers.

The workflow must keep human attention on decisions that benefit from human
judgment. It must not create a random-line review queue that asks a reviewer to
judge isolated text without source, draft, scene context, runtime evidence, and
reasoning.

## Inputs And Boundaries

The product workflow consumes these existing contracts:

- [Localization surfaces](localization-surfaces.md): neutral source identity,
  surface kinds, locale-scoped policy actions, protected spans, patch refs, and
  runtime expectations.
- [Utsushi fidelity policy](utsushi-fidelity-policy.md): E0 through E4 evidence
  tiers and wording rules. Itotori must preserve the tier and limitations when
  showing evidence to reviewers.
- [ADR 0002](adrs/0002-provider-routing-and-recording.md): provider routing,
  fake/recorded provider defaults, cost recording, privacy, prompt/output
  logging, and live-call opt-in rules.
- [Orchestration operating model](dev/orchestration-operating-model.md): durable
  audit disposition, P0/P1 blocking behavior, P2/P3 follow-up handling, and
  offline CI expectations.

Non-goals for this product spec:

- It does not define final database tables or API schemas.
- It does not require live provider calls for style-guide creation, drafting, QA,
  feedback triage, or review.
- It does not claim runtime correctness beyond the Utsushi evidence tier shown
  with the decision.

## Workflow Stages

1. **Project import**: Kaifuu emits neutral localization surfaces with stable
   source identity, source revision, protected spans, patch refs, and runtime
   expectations. Itotori imports them into a project and one or more locale
   branches.
2. **Policy setup**: A reviewer creates or updates the locale-branch style
   guide, glossary, romanization rules, and do-not-translate rules before broad
   drafting. The setup flow can use deterministic prompts, forms, recorded
   suggestions, or fake providers.
3. **Context construction**: Itotori groups units by scene, route, speaker,
   asset, UI area, database entry, and repeated occurrences. It records the
   context bundle version used by draft and QA runs.
4. **Drafting**: Drafts are produced against a source revision, target locale,
   locale branch, style-guide version, glossary version, context bundle, and
   provider run identity when a provider was used. Draft output stays patchable
   only if source revision and protected-span checks still match.
5. **Deterministic QA**: Static checks catch stale source revisions, corrupted
   protected spans, missing variables, length limits, glossary conflicts, and
   export blockers before human review.
6. **Agent or rule QA**: Optional fake, recorded, local, or live agents can
   produce findings for style, tone, semantic drift, unresolved terminology,
   context mismatch, and likely root cause. Findings must cite source units,
   style or glossary rules, runtime evidence, or feedback records.
7. **Runtime evidence ingestion**: Utsushi reports are attached without
   weakening their tier language. An E2 frame capture can show observed rendered
   text, but it is not described as engine-compatible or fully verified.
8. **Decision queue triage**: Itotori creates queue records only for decisions
   that need human judgment or durable policy choice. Obvious deterministic
   defects become repair jobs where possible.
9. **Human decision**: Reviewers accept, reject, edit, defer, batch, or escalate
   decisions while seeing source, draft, context, screenshots/evidence, and
   reasoning together.
10. **Consequences and reruns**: Accepted decisions update drafts, policy,
    glossary, feedback state, or repair jobs. Consequences are durable and can
    trigger affected reruns without rerunning the whole project unless needed.
11. **Patch export and runtime review**: Patch-ready exports include only units
    whose source revision, policy, protected spans, and required decisions are
    current. Playable or runtime-reviewed draft feedback re-enters the same
    triage and decision model.

## Rejected Interaction Model

Itotori explicitly rejects random line review.

A queue item must not present only a source line, only a draft line, or a
source/draft pair without surrounding context. A reviewer cannot be asked to
approve, reject, rewrite, or choose style policy for an isolated line unless the
record also carries the source identity, locale branch, surface kind, nearby or
scene context, current policy, evidence tier where available, findings or
reasoning, impact, available options, and consequences of each option.

If context is unavailable, the queue item state is `needs_context`, not
`ready_for_human`. The next action is context construction, source annotation,
runtime probe, duplicate grouping, or triage, not reviewer approval.

## Decision Queue Information Architecture

The decision queue is organized around decision consequences, not raw findings.
The default reviewer view groups items by:

- project, target locale, and locale branch;
- decision type: style dispute, glossary conflict, policy choice, draft edit,
  runtime evidence issue, feedback adjudication, asset policy, or export blocker;
- impact: blocks export, affects many units, affects visible/playable content,
  affects only low-traffic copy, or informational;
- source context: scene, route, speaker, UI area, database kind, asset, choice
  group, or repeated occurrence cluster;
- evidence tier: E0 static, E1 trace-reachable, E2 captured, E3 replayable, or
  E4 fidelity-targeted;
- age, duplicate count, affected unit count, and rerun cost.

Primary queue views:

| View               | Purpose                                          | Default contents                                                                                           |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Export blockers    | Decisions that prevent patch-ready export        | Stale source, protected-span failures, unresolved high-impact policy, required screenshot evidence missing |
| Style and glossary | Human policy choices that can affect many drafts | Style disputes, terminology conflicts, romanize/preserve choices, proposed style-guide amendments          |
| Draft review       | High-impact draft choices and batchable edits    | Scene-level draft groups, repeated-line clusters, QA-backed edits, player-facing UI strings                |
| Runtime evidence   | Decisions linked to Utsushi reports              | Clipping, missing glyphs, wrong branch, stale patch, low-tier evidence caveats                             |
| Feedback triage    | Playtest and community feedback                  | Contextual reports, duplicates, style preferences, objective defects, privacy-sensitive attachments        |
| Deferred           | Low-value or unresolved items kept traceable     | Deferred ambiguity, awaiting better context, non-blocking P2/P3 work                                       |

The item detail view must show these panels together on one screen or in a
stable split view:

- **Source**: source text, source locale, surface kind, spans, source location,
  source hash/revision, speaker/scene/route/UI/asset context, and nearby units.
- **Draft**: current draft, previous approved text when available, target
  locale, locale branch, draft status, style-guide and glossary versions, and
  protected-span mapping.
- **Context**: scene synopsis, route position, speaker notes, term history,
  related repeated lines, prior decisions, and source annotations.
- **Evidence**: Utsushi tier, screenshots or replay links when available,
  environment and limitations, capture position, and artifact hashes or paths.
- **Reasoning and findings**: deterministic check results, QA findings, agent
  rationale summaries, cited style/glossary rules, feedback reports, and root
  cause hypothesis.
- **Impact and options**: blast radius, export or rerun effect, cost impact,
  affected dependency scope, available actions, and durable consequences.

The queue may offer compact rows for scanning, but every action that changes
draft, policy, glossary, feedback, export state, or rerun scheduling must open or
otherwise reveal the full decision context first.

## Decision Queue Record Shape

This is the product-level shape a future implementation should support. Field
names are illustrative and should be refined by schema work.

```json
{
  "decisionId": "decision_...",
  "projectId": "project_...",
  "localeBranchId": "branch_...",
  "targetLocale": "en-US",
  "state": "ready_for_human",
  "decisionType": "style_dispute",
  "priority": "P1",
  "source": {
    "surfaceId": "surface_...",
    "surfaceKind": "dialogue",
    "sourceUnitKey": "scene001.msg0004",
    "occurrenceId": "occurrence_...",
    "sourceLocale": "ja-JP",
    "sourceText": "...",
    "sourceHash": "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1",
    "sourceRevision": "rev_...",
    "sourceLocation": {
      "assetId": "asset_...",
      "containerKey": "scene001",
      "range": "..."
    },
    "spans": [
      {
        "spanKind": "variable_placeholder",
        "startByte": 12,
        "endByte": 18,
        "raw": "\\V[1]"
      }
    ],
    "patchRef": "patch_ref_..."
  },
  "draft": {
    "draftId": "draft_...",
    "targetText": "...",
    "draftStatus": "qa_flagged",
    "styleGuideVersion": "style_v7",
    "glossaryVersion": "glossary_v3",
    "contextBundleId": "context_...",
    "providerRunId": "provider_run_...",
    "protectedSpanStatus": "valid"
  },
  "context": {
    "sceneRef": "scene_...",
    "routeRef": "route_...",
    "speakerRef": "speaker_...",
    "choiceGroupId": null,
    "uiArea": null,
    "assetRef": null,
    "nearbyUnitIds": ["surface_prev", "surface_next"],
    "sceneSummary": "...",
    "priorDecisionIds": ["decision_..."],
    "termRefs": ["term_..."]
  },
  "evidence": {
    "tier": "E2",
    "claim": "E2 captured",
    "artifactIds": ["runtime_report_...", "screenshot_..."],
    "screenshots": [
      {
        "artifactId": "screenshot_...",
        "caption": "message window after patch",
        "capturePosition": "scene001:frame0042"
      }
    ],
    "environmentSummary": "Ubuntu 24.04, Chromium headless, software rendering",
    "limitations": ["fixture adapter does not validate reference engine timing"]
  },
  "reasoningAndFindings": {
    "summary": "QA found tone conflict with current protagonist voice rule.",
    "findings": [
      {
        "findingId": "finding_...",
        "taxonomyId": "itotori-lqa-1",
        "taxonomyVersion": "itotori-quality-taxonomy-0.1.0",
        "detectorKind": "llm_qa",
        "subjectRefs": {
          "surfaceIds": ["surface_..."],
          "spanIds": ["span_..."],
          "runtimeEvidenceIds": ["runtime_report_..."]
        },
        "referenceRefs": {
          "styleRuleIds": ["style_rule_hero_voice"],
          "sceneRefs": ["scene_..."],
          "speakerRefs": ["speaker_..."]
        },
        "category": "style",
        "subcategory": "style_guide_violation",
        "qualitySeverity": "major",
        "rootCause": "style_guide_gap",
        "evidence": {
          "expected": {
            "styleRuleId": "style_rule_hero_voice",
            "summary": "Protagonist lines use the direct voice rule."
          },
          "observed": {
            "surfaceId": "surface_...",
            "summary": "Draft shifts into a softened voice that conflicts with the rule."
          },
          "artifactRefs": ["screenshot_...", "qa_run_..."],
          "provenance": {
            "detectorRunRef": "qa_run_...",
            "evidenceTier": "E2"
          }
        },
        "adjudicationState": "confirmed",
        "reviewerRationale": "Runtime capture and the current style rule show the draft violates the protagonist voice policy."
      }
    ],
    "agentRunRefs": ["qa_run_..."],
    "deterministicCheckRefs": ["span_check_..."],
    "feedbackRefs": ["feedback_..."]
  },
  "impact": {
    "exportBlocking": true,
    "affectedUnitCount": 42,
    "affectedSurfaceKinds": ["dialogue", "choice_label"],
    "playerVisibility": "main_route",
    "rerunScope": "affected_context_cluster",
    "estimatedReviewCost": "medium"
  },
  "options": [
    {
      "optionId": "accept_style_a",
      "label": "Use direct protagonist voice",
      "changes": ["style_guide_amendment", "rerun_affected_drafts"],
      "consequence": "Creates style_v8 and reruns 42 affected units."
    },
    {
      "optionId": "defer",
      "label": "Defer until route review",
      "changes": ["defer_decision"],
      "consequence": "Keeps current drafts blocked for export in this cluster."
    }
  ],
  "batch": {
    "batchKey": "style:hero_voice:branch_en_US",
    "batchable": true,
    "batchOperationIds": ["apply_same_option", "defer_all", "split_outliers"],
    "outlierPolicy": "require_individual_review"
  },
  "durableConsequences": {
    "stateChanges": ["decision_resolved"],
    "policyChanges": ["style_guide_version_created"],
    "draftChanges": ["affected_drafts_invalidated"],
    "feedbackChanges": ["duplicates_marked_addressed"],
    "jobs": ["rerun_affected_drafts", "rerun_qa"],
    "auditTrail": "event_outbox_required"
  }
}
```

Required record invariants:

- `source.sourceRevision` and `source.sourceHash` must be present for patchable
  decisions so stale exports can be rejected.
- `draft.styleGuideVersion`, `draft.glossaryVersion`, and
  `draft.contextBundleId` must be visible for draft or style decisions.
- `evidence.tier` must use the Utsushi E0 through E4 vocabulary when runtime
  evidence is attached.
- `reasoningAndFindings` must cite concrete findings, checks, feedback, or
  policy rules. Unsupported confidence text is not enough.
- `impact` must state whether the decision blocks export and what rerun scope is
  expected.
- `options` must state durable consequences before the reviewer chooses.
- `batch.batchable` must be false when items do not share source revision,
  locale branch, decision type, policy version, and consequence shape.

## Batch Review Model

Batch review is allowed when it reduces repetitive human work without hiding
meaningful differences.

Batchable groups should be created from:

- repeated or near-duplicate source lines with the same locale branch and
  compatible source revision;
- one glossary or romanization decision affecting many cited units;
- one style-guide rule dispute affecting many drafts;
- a deterministic repair option that has the same protected-span status and
  rerun consequence for each item;
- duplicate feedback reports attached to the same surface, screenshot, save
  context, or route position.

Batch operations:

- `apply_same_option`: choose one option for all non-outlier items.
- `approve_all_visible`: approve the current draft or policy for items visible
  in the batch preview.
- `reject_all_with_reason`: reject findings or feedback with one durable
  rationale and duplicate suppression.
- `defer_all`: move low-value ambiguity to deferred state with a revisit trigger.
- `split_outliers`: remove items whose context, source revision, evidence tier,
  severity, or consequence differs from the batch.
- `create_policy_amendment`: convert a style or terminology batch into a
  versioned style-guide or glossary change.
- `rerun_affected`: schedule affected drafting, QA, or runtime evidence jobs
  after a batch decision.

Batch review safeguards:

- The batch preview must show representative source/draft/context/evidence rows
  plus the full outlier list.
- A batch action must disclose the affected unit count, affected surface kinds,
  export effect, rerun effect, and policy version change.
- Items with different source revisions, locale branches, protected-span status,
  evidence tiers, or durable consequences are not silently batched.
- A reviewer can inspect any item in full detail before applying the batch.
- Batch rejection of feedback must keep rationale and duplicate grouping so the
  same unresolved report does not keep resurfacing.

## Translation Memory Reuse

Translation memory is locale-branch scoped. A reusable segment must store the
locale branch, target locale, source bundle revision, source hash, source unit
key, occurrence id, source text, target text, and provenance that created the
memory entry. Reuse lookup must not fall back to another locale branch, and an
entry whose source revision no longer matches the branch must be rejected before
it can prefill a draft.

Repeated source lines may produce multiple reusable memory entries. Selection is
deterministic: exact hash matches rank before fuzzy matches, and ties use source
unit key, occurrence id, and memory id ordering. Fuzzy matching, when enabled,
is bounded and lexical only; it uses normalized source text similarity, exposes
the score and match kind, and must not depend on opaque provider or ML calls.

Draft prefill must leave an audit trail. Applying or suggesting a translation
memory candidate records the selected memory segment, target bridge unit, match
kind, score, source hash, candidate source hash, target text, provenance, and
deterministic cost-impact estimate. This makes reuse visible in review and cost
reporting instead of silently replacing a provider draft.

## Style-Guide Conversation Flow

The style-guide builder is inspired by product/persona/behavior creation flows:
start from product identity, identify target audiences and characters, then turn
desired behavior into structured rules. Itotori should use the same shape, but
it must be implementable with forms, deterministic templates, fake providers, or
recorded provider suggestions. Live provider calls are optional and must follow
ADR 0002.

The builder produces a versioned, locale-branch-scoped style guide. Each answer
is structured, reviewable, and rerunnable.

1. **Project brief**
   - Capture source work title, genre, platform, content rating assumptions,
     target locale, locale branch, intended audience, localization goal, and
     strict non-goals.
   - Output: `project_voice`, `audience`, `localization_goal`, and
     `forbidden_claims` fields.
2. **Canon and source constraints**
   - Capture official terminology, character names, franchise terms, honorific
     policy, song title policy, UI constraints, image-text policy, and known
     non-translatable or romanized terms.
   - Output: initial glossary seeds and policy records for `localize`,
     `romanize`, and `do_not_translate`.
3. **Persona and speaker model**
   - Define recurring speakers, narrator stance, register, relationship shifts,
     dialect constraints, and how source-specific speech markers should be
     carried into the target locale.
   - Output: speaker style cards with examples and anti-examples.
4. **Behavior rules**
   - Convert desired behavior into enforceable guidance: tone, formality,
     humor, profanity, honorifics, pronouns, names, UI brevity, tutorial
     clarity, choice-label style, and asset text handling.
   - Output: typed rules with scope, rationale, examples, and severity.
5. **Conflict checks**
   - Surface contradictions before saving: glossary versus style, romanization
     versus localization, speaker voice versus UI brevity, or community
     preference versus project goal.
   - Output: queue decisions only for material conflicts, not every uncertain
     line.
6. **Preview on representative units**
   - Show how the style guide would affect selected scenes, UI strings, choice
     labels, database entries, and asset-text examples. Representative units
     must include source, draft or sample rewrite, context, and policy effects.
   - Output: proposed examples attached to the style-guide version.
7. **Approval and versioning**
   - Save as a draft version, approve as active, or defer with blockers. Approval
     records the actor, rationale, source sample set, affected locale branch,
     and expected rerun scope.
   - Output: immutable `styleGuideVersion`, event history, and affected-work
     invalidation record.
8. **Amendment loop**
   - Decision queue items, QA findings, and feedback can propose amendments.
     Amendments must state affected rules, sample evidence, option choices,
     export impact, and rerun scope before approval.
   - Output: new version, rejected amendment rationale, or deferred style
     dispute.

Conversation guardrails:

- The builder must not ask reviewers to write broad prose blobs with no schema.
- Every final rule must have scope, rationale, examples or citations, and
  expected QA behavior.
- Suggestions generated by fake, recorded, local, or live providers are drafts,
  not policy, until a human or project owner accepts them.
- Style-guide changes must not silently mutate prior approved drafts. They mark
  affected drafts and QA findings stale, then schedule targeted reruns.

## Escalation Policy

Escalation is for decisions that benefit from human judgment. It is not a
fallback for missing context, weak automation, or every low-confidence model
result.

| Situation                                                                            | Default handling                                                              | Human escalation                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Missing source context, no scene, no speaker, no nearby units                        | Mark `needs_context`; request source annotation or context construction       | No                                                       |
| Stale source revision or hash mismatch                                               | Block export and repair/import latest source                                  | No, unless source identity cannot be reconciled          |
| Protected span, variable, markup, or patch constraint failure                        | Deterministic repair job or export blocker                                    | No, unless multiple valid policy choices exist           |
| Low-value wording uncertainty on one non-critical line                               | Defer or leave to batch draft review                                          | No                                                       |
| Objective runtime defect such as clipping or missing glyph                           | Route to repair with Utsushi evidence tier and affected surfaces              | No, unless repair implies style or asset policy tradeoff |
| Glossary conflict affecting many units or player-facing canon                        | Create decision queue item with options and affected count                    | Yes                                                      |
| Style dispute, tone/register conflict, honorific policy, or speaker voice ambiguity  | Create style decision with representative examples and consequences           | Yes                                                      |
| Asset policy choice: localize, romanize, preserve, edit image, or metadata-only      | Create policy decision with patchability and runtime evidence limits          | Yes when high impact or irreversible                     |
| Community preference that conflicts with approved style                              | Aggregate feedback, label style preference, route to style dispute workflow   | Yes only after duplicate grouping and impact estimate    |
| High-value ambiguity in main-route, UI, tutorial, choice, or export-blocking content | Create decision with source, draft, context, evidence, reasoning, and options | Yes                                                      |
| Provider output uncertainty with no cited finding                                    | Re-run with deterministic checks, recorded provider, or better context        | No                                                       |

Escalation gates:

- A human-visible decision must include source, draft, context, evidence or
  explicit evidence absence, reasoning/findings, impact, options, and
  consequences.
- The queue must aggregate duplicates and repeated patterns before escalation.
- Escalation requires an impact reason: export blocker, many affected units,
  visible/playable content, style-policy ambiguity, glossary/canon conflict,
  asset-policy consequence, or high-value ambiguity.
- Items that cannot state a decision consequence remain triage records, not
  reviewer decisions.
- Human choices must be durable events that update draft state, policy versions,
  glossary records, feedback disposition, repair jobs, or deferred queues.

Human involvement should be minimized by routing common cases elsewhere:

- deterministic defects go to repair jobs;
- low-impact ambiguity is deferred or batched;
- duplicates are grouped before review;
- repeated prior decisions are reused when source revision, locale branch,
  policy version, and context match;
- agent or QA uncertainty without evidence does not become a human task.

## Feedback Ingestion

Feedback is part of the same product workflow as QA findings, but feedback is
not truth by default. It is evidence that may point to objective defects, style
preferences, context gaps, or duplicate reports.

Initial feedback sources:

- manual playtest reports entered by a reviewer;
- imported spreadsheet, form, issue, forum, or chat exports after privacy review;
- annotations from a runtime or playable review package;
- internal reviewer notes attached to source/draft/context/evidence.

Feedback records should include:

- source identity or best-known line reference;
- screenshot, save, route position, replay annotation, or runtime artifact when
  available;
- reporter note and reporter role;
- target locale and locale branch;
- feedback type: objective defect, style preference, glossary/canon issue,
  unclear context, runtime issue, asset issue, or duplicate;
- privacy classification and redaction state;
- dedupe key based on source/evidence/context/report text;
- triage disposition and linked decision, finding, repair job, or rejection
  rationale.

Community feedback ingestion should start with manual/imported records and
dedupe before external integrations. Public or semi-public feedback may contain
spoilers, private save data, harassment, copyrighted screenshots, or inaccurate
claims, so imports must preserve source channel metadata and redaction status.

The initial DB-backed intake model stores feedback sources, canonical feedback
reports, and report evidence separately:

- `feedback_sources` identifies the channel, such as manual playtest, internal
  review note, runtime review package, or later imported community export.
- `feedback_reports` is the canonical triage item keyed by a deterministic
  dedupe key and labeled as an objective-defect candidate, style-dispute
  candidate, glossary/canon candidate, runtime issue candidate, asset issue
  candidate, or `needs_context`.
- `feedback_report_evidence` appends each imported report, screenshot, save
  context, route/context attachment, line reference, reporter role, and note to
  the canonical report.

The dedupe key is scoped to project, locale branch, target locale, feedback
type, normalized report text, and the best available anchor. The anchor prefers
source identity or line reference, then save/context/runtime/screenshot
attachments, then a missing-context marker. Reimporting the same evidence does
not create a new unresolved item; new duplicate evidence increments the
canonical report count and appends a duplicate-aggregation event.

Style preference feedback is routed differently from objective defects. A typo
with a screenshot and source reference can become a repair job or batch draft
edit. A preference such as "this character should sound harsher" becomes a
style dispute only when it is contextual, non-duplicate, and high-impact enough
to justify human policy review.

## Playable Draft Feedback

Playable and runtime-reviewed drafts should submit feedback into the same queue
model rather than a separate inbox.

Playable feedback should carry:

- project, build, patch export, source revision, locale branch, style-guide
  version, glossary version, and runtime evidence artifact ids;
- current route, scene, save/context token, speaker, visible text, screenshot or
  replay annotation, and capture timestamp;
- reviewer action: typo, bad tone, wrong term, overflow, missing glyph, wrong
  branch, mistranslation, untranslated asset text, or other;
- suggested edit when provided;
- whether the report affects one unit, a cluster, a style rule, or a glossary
  term.

The triage outcome is one of:

- direct draft correction with affected QA rerun;
- deterministic repair job;
- grouped duplicate feedback;
- style dispute decision;
- glossary or canon decision;
- asset policy decision;
- rejected feedback with rationale;
- deferred low-value ambiguity.

Playable feedback must preserve the Utsushi evidence tier. A screenshot from an
E2 capture supports a visible-frame claim; an E3 replay supports a reviewable
playback claim; neither should be relabeled as complete engine fidelity.

## Durable Consequences

Every decision action must have an event trail. The event trail is the product
source of truth for why a draft, style guide, glossary entry, feedback record,
or rerun job changed.

Durable consequences include:

- draft accepted, edited, rejected, invalidated, or marked patch-ready;
- style-guide draft created, version approved, amendment rejected, or affected
  drafts invalidated;
- glossary term created, scoped, merged, rejected, or marked conflict-resolved;
- policy action set to `localize`, `romanize`, or `do_not_translate` for a
  locale branch;
- feedback accepted, grouped as duplicate, rejected with rationale, redacted, or
  escalated;
- runtime evidence linked, superseded, or marked insufficient;
- repair, draft rerun, QA rerun, runtime probe, or export rerun scheduled;
- deferred item assigned a revisit trigger or converted into P2/P3 follow-up.

Decision consequences must be shown before confirmation. The reviewer should
know whether an action will unblock export, create a new style-guide version,
invalidate drafts, suppress duplicate feedback, or schedule reruns.

## Alpha Product Bar

The alpha workflow is acceptable when:

- random line review is impossible by product contract;
- reviewers see source, draft, context, screenshots/evidence, and reasoning
  together before taking consequential action;
- evidence tiers remain visible and precise;
- style-guide creation produces structured, versioned policy without requiring
  live provider calls;
- batch operations disclose affected units, outliers, and durable consequences;
- human escalation is reserved for style disputes, glossary/canon conflicts,
  asset policy choices, and high-value ambiguity;
- community and playable feedback enter the same triage model with context,
  dedupe, privacy, and disposition;
- every accepted, rejected, deferred, or escalated decision has an event trail
  that can drive affected reruns and audit.
