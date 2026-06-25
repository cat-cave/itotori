// ITOTORI-022 — Suggested-action templates.
//
// For each `RootCauseClass` the router produces a concrete next action
// that the orchestrator (ITOTORI-222) can hand straight to a worker.
// The text is intentionally specific — it names the repair surface
// (retranslation, glossary editor URL, Kaifuu issue) so the orchestrator
// does not need to invent free text. Adding a new `RootCauseClass`
// without extending the switch here is a compile error
// (`assertNever`).
//
// These templates are PURE — they consult only the routing context, not
// I/O. The orchestrator is free to embellish the action with project /
// draft / bridge-unit ids before surfacing it in the dashboard.

import type { RootCauseClass } from "./root-cause.js";

export type SuggestedActionContext = {
  /**
   * Short human-readable summary of the underlying finding. Producers
   * typically pass `finding.recommendation` (QA) or `finding.summary`
   * (human). Used in the retranslation prompt context.
   */
  findingSummary: string;
  /**
   * Optional offending term / span / variable name. Drives the
   * glossary-editor URL fragment for `glossary_conflict` actions.
   */
  offendingTerm?: string;
  /**
   * Optional bridge-unit id for the failing unit. Drives the Kaifuu
   * issue body for `kaifuu_patching` actions.
   */
  bridgeUnitId?: string;
};

/**
 * Build the suggested-action string for one root-cause class + context.
 * One switch arm per `RootCauseClass`; the `default` calls `assertNever`
 * so the compiler refuses to build if a new class is added without an
 * action.
 */
export function buildSuggestedAction(
  rootCauseClass: RootCauseClass,
  context: SuggestedActionContext,
): string {
  switch (rootCauseClass) {
    case "translator_mistake": {
      const escaped = sanitizeForPromptContext(context.findingSummary);
      return [
        "Trigger retranslation with translated_context:",
        `{ previousAttemptError: ${JSON.stringify(escaped)} }`,
        "consider regrade with a fresh judge.",
      ].join(" ");
    }
    case "stale_context": {
      return [
        "Refresh the bridge context (speaker label, scene summary, glossary snapshot)",
        "before retranslating; if the context source is stale, reseed it from the",
        "current source revision before queuing the retry.",
      ].join(" ");
    }
    case "source_annotation_issue": {
      return [
        "Open a source-annotation review ticket against the upstream catalog;",
        "the source unit contains content the agent should not have processed",
        "(e.g. a redaction marker or a variable that was not declared).",
      ].join(" ");
    }
    case "glossary_conflict": {
      const term = context.offendingTerm ?? "<offending-term>";
      const queryTerm = encodeURIComponent(term);
      return [
        `Open the glossary editor at /projects/:projectId/glossary?term=${queryTerm};`,
        "re-add the term with the agreed translation;",
        "flag the draft as `awaitingGlossaryUpdate`.",
      ].join(" ");
    }
    case "style_guide_issue": {
      return [
        "Surface the finding to the style-guide reviewer queue;",
        "if the rule is missing, add it via the style-guide builder",
        "and re-emit the rule pack before re-running QA.",
      ].join(" ");
    }
    case "kaifuu_patching": {
      const unit = context.bridgeUnitId ?? "<bridge-unit-id>";
      return [
        "Open a Kaifuu issue with the bridge unit id",
        `(${unit}) and the span ref;`,
        "the source markup is corrupt.",
      ].join(" ");
    }
    case "runtime_evidence": {
      return [
        "Attach the runtime evidence (save state, screenshot, log) to the draft",
        "decision record; if reproducible, file a runtime-bridge bug and",
        "enqueue a re-render against the engine's latest snapshot.",
      ].join(" ");
    }
    case "unknown": {
      return [
        "Escalate to a human triager: no routing rule matched.",
        "Capture the finding shape so a new rule can be added.",
      ].join(" ");
    }
    default: {
      return assertNever(rootCauseClass);
    }
  }
}

/**
 * Affected component label per root cause. Used by the router when no
 * more specific component name is available from the finding payload.
 */
export function defaultAffectedComponent(rootCauseClass: RootCauseClass): string {
  switch (rootCauseClass) {
    case "translator_mistake":
      return "TranslationAgent";
    case "stale_context":
      return "ContextRefreshService";
    case "source_annotation_issue":
      return "SourceAnnotationCatalog";
    case "glossary_conflict":
      return "GlossaryService";
    case "style_guide_issue":
      return "StyleGuideBuilder";
    case "kaifuu_patching":
      return "kaifuu-reallive::bridge";
    case "runtime_evidence":
      return "RuntimeFeedbackIntake";
    case "unknown":
      return "UnknownTriageComponent";
    default:
      return assertNever(rootCauseClass);
  }
}

/**
 * The retranslation prompt embeds the finding summary as a JSON string.
 * Strip control characters that would break the embedding without
 * silently truncating semantic content.
 */
function sanitizeForPromptContext(value: string): string {
  // Replace ASCII control characters (incl. NUL) with a space. Preserve
  // everything else verbatim so non-Latin scripts pass through unchanged.
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

function assertNever(value: never): never {
  throw new Error(`exhaustiveness check failed: unexpected RootCauseClass ${String(value)}`);
}
