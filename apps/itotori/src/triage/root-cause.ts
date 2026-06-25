// ITOTORI-022 — Root-cause taxonomy.
//
// A finding (QA agent or human) is routed to exactly one `RootCause` by
// `FindingTriageRouter`. The `class` enum is the closed set of hypotheses
// the orchestrator branches on when deciding whether to retry a draft,
// open a glossary editor, file a Kaifuu bug, or escalate to a human
// reviewer. Each value names a distinct *system* that owns the fix —
// translator vs. context vs. source-annotation vs. glossary vs. style
// guide vs. Kaifuu vs. runtime evidence vs. unknown.
//
// Hard rules enforced elsewhere (`router.ts`):
//   - Routing is exhaustive. The router's `default` calls `assertNever`,
//     so adding a QA category or protected-span violation kind without a
//     routing rule is a compile-time error.
//   - `unknown` is a typed class, not a silent fallback. It carries the
//     same shape as every other root cause (class + confidence + rationale
//     + suggestedAction + affectedComponent) and is only emitted with
//     `confidence: 'low'` and an explicit rationale.
//
// The `affectedComponent` string names the system that owns the fix in
// human-readable form (e.g. 'TranslationAgent', 'SpeakerLabelAgent',
// 'kaifuu-reallive::bridge'). Workers route their repair plans by this
// component name; the orchestrator surfaces it in the triage queue UI.

/**
 * Closed enum of root-cause classes. Adding a value requires:
 *   1. A routing rule in `FindingTriageRouter`.
 *   2. A suggested-action template in `./suggested-action.ts`.
 *   3. A positive test in `triage-router.test.ts`.
 */
export const ROOT_CAUSE_CLASSES = [
  "translator_mistake",
  "stale_context",
  "source_annotation_issue",
  "glossary_conflict",
  "style_guide_issue",
  "kaifuu_patching",
  "runtime_evidence",
  "unknown",
] as const;
export type RootCauseClass = (typeof ROOT_CAUSE_CLASSES)[number];

/**
 * Confidence the router has in the routing. `high` means a deterministic
 * 1:1 rule fired (e.g. QA `mistranslation` → `translator_mistake`).
 * `medium` means the rule fired but the QA category is ambiguous in
 * intent (e.g. `tone` could be either translator or style guide).
 * `low` is reserved for `unknown` and for cases where the router
 * deliberately downranks a noisy heuristic.
 */
export const ROOT_CAUSE_CONFIDENCES = ["high", "medium", "low"] as const;
export type RootCauseConfidence = (typeof ROOT_CAUSE_CONFIDENCES)[number];

export type RootCause = {
  class: RootCauseClass;
  confidence: RootCauseConfidence;
  /**
   * Why the router picked this class. The rationale cites the finding's
   * category or violation kind explicitly so a human reading the triage
   * report can re-derive the decision without reading the router source.
   */
  rationale: string;
  /**
   * Concrete next action the orchestrator should consider. Produced by
   * `./suggested-action.ts` per class; the router does not invent free
   * text here.
   */
  suggestedAction: string;
  /**
   * System / agent / module that owns the fix. Examples:
   *   - 'TranslationAgent'           — translator-side mistake.
   *   - 'SpeakerLabelAgent'          — speaker-label drift.
   *   - 'kaifuu-reallive::bridge'    — Kaifuu RealLive bridge unit.
   *   - 'GlossaryService'            — glossary editor.
   *   - 'StyleGuideBuilder'          — style guide rule update.
   *   - 'RuntimeFeedbackIntake'      — runtime evidence intake.
   *   - 'UnknownTriageComponent'     — unknown class (carries the
   *                                    fallback so the dashboard can
   *                                    still group by component).
   */
  affectedComponent: string;
};
