// play-flag-composer — pure mapping from an in-the-moment playtest flag
// (AnnotationComposer value) into the ManualFeedbackImportInput that creates
// a reviewer queue item via ManualFeedbackImportService.
//
// Backend path (same intake the workspace correction service uses):
//   ManualFeedbackImportPort.importManualFeedback
//     → feedback report + evidence
//     → reviewer-queue item (when contextualized)
//
// Permission: `feedback.import` (canFlag). Severity is the design-system
// annotation-severity ramp (blocker/critical/warning/note), carried on
// metadata so the queue UI can severity-scale the finding.

import {
  feedbackSourceKindValues,
  feedbackTypeValues,
  type FeedbackType,
  type ManualFeedbackImportInput,
} from "@itotori/db";

/** Closed ordinal severity scale — mirrors `@itotori/ds` AnnotationComposer. */
export const PLAY_FLAG_SEVERITIES = ["blocker", "critical", "warning", "note"] as const;
export type PlayFlagSeverity = (typeof PLAY_FLAG_SEVERITIES)[number];

export type PlayFlagAnnotationInput = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  /** Free-text note from the AnnotationComposer. */
  note: string;
  severity: PlayFlagSeverity;
  /** Free-form category (tone / layout / glossary / …). */
  category?: string;
  /** Optional bridge unit the flag is anchored to. */
  bridgeUnitId?: string;
  sourceUnitKey?: string;
  sourceBundleId?: string;
  sourceRevisionId?: string;
  /** Optional scene identity for coverage / context (game-agnostic key). */
  sceneId?: string;
  actorUserId: string;
  actorDisplayName?: string;
  /** Optional proposed rewrite (when the playtester suggests a fix). */
  suggestedEdit?: string;
};

/**
 * Map a free-form category string onto the closed FeedbackType vocabulary.
 * Unknown / empty categories fall through to objective_defect so a playtest
 * flag always enters triage.
 */
export function feedbackTypeForFlagCategory(category: string | undefined): FeedbackType {
  const normalized = (category ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    return feedbackTypeValues.objectiveDefect;
  }
  if (
    normalized.includes("style") ||
    normalized.includes("tone") ||
    normalized.includes("voice") ||
    normalized.includes("wording")
  ) {
    return feedbackTypeValues.stylePreference;
  }
  if (
    normalized.includes("glossary") ||
    normalized.includes("term") ||
    normalized.includes("name") ||
    normalized.includes("canon")
  ) {
    return feedbackTypeValues.glossaryCanonIssue;
  }
  if (
    normalized.includes("layout") ||
    normalized.includes("asset") ||
    normalized.includes("image") ||
    normalized.includes("ui")
  ) {
    return feedbackTypeValues.assetIssue;
  }
  if (
    normalized.includes("runtime") ||
    normalized.includes("crash") ||
    normalized.includes("engine")
  ) {
    return feedbackTypeValues.runtimeIssue;
  }
  if (
    normalized.includes("context") ||
    normalized.includes("unclear") ||
    normalized.includes("ambiguous")
  ) {
    return feedbackTypeValues.unclearContext;
  }
  return feedbackTypeValues.objectiveDefect;
}

/**
 * Build the ManualFeedbackImportInput for a playtest flag. Pure + synchronous;
 * the caller hands the result to ManualFeedbackImportPort.
 */
export function buildPlayFlagFeedbackInput(
  input: PlayFlagAnnotationInput,
): ManualFeedbackImportInput {
  const note = input.note.trim();
  if (note.length === 0) {
    throw new Error("play flag note must be a non-empty string");
  }
  if (!(PLAY_FLAG_SEVERITIES as readonly string[]).includes(input.severity)) {
    throw new Error(`play flag severity must be one of: ${PLAY_FLAG_SEVERITIES.join(", ")}`);
  }

  const category = (input.category ?? "").trim();
  const feedbackType = feedbackTypeForFlagCategory(category);
  const reporterName = input.actorDisplayName ?? input.actorUserId;

  const payload: ManualFeedbackImportInput = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    targetLocale: input.targetLocale,
    feedbackType,
    reporter: {
      role: "playtester",
      reporterId: input.actorUserId,
      displayName: reporterName,
    },
    reporterNote: note,
    feedbackSource: {
      sourceKind: feedbackSourceKindValues.manualPlaytest,
      label: "Playtest flag",
      sourceChannel: "play.flagAnnotation",
    },
    metadata: {
      origin: "playtest",
      severity: input.severity,
      category: category.length > 0 ? category : null,
      sceneId: input.sceneId ?? null,
      source: "play-flag-composer",
      ...(input.sourceRevisionId !== undefined && input.sourceRevisionId.length > 0
        ? { sourceRevisionId: input.sourceRevisionId }
        : {}),
    },
  };

  if (input.sourceBundleId !== undefined && input.sourceBundleId.length > 0) {
    payload.sourceBundleId = input.sourceBundleId;
  }
  if (input.suggestedEdit !== undefined && input.suggestedEdit.trim().length > 0) {
    payload.suggestedEdit = input.suggestedEdit.trim();
  }
  if (input.bridgeUnitId !== undefined && input.bridgeUnitId.length > 0) {
    payload.lineReference = {
      bridgeUnitId: input.bridgeUnitId,
      ...(input.sourceUnitKey !== undefined && input.sourceUnitKey.length > 0
        ? { sourceUnitKey: input.sourceUnitKey }
        : {}),
      ...(input.sceneId !== undefined && input.sceneId.length > 0
        ? { sourceLocation: { sceneId: input.sceneId } }
        : {}),
    };
  }

  return payload;
}
