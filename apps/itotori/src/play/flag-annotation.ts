// play-flag-composer — pure mapping from an in-the-moment playtest flag
// (AnnotationComposer value) into the ManualFeedbackImportInput that creates
// a canonical context correction via ManualFeedbackImportService.
//
// Backend path (the canonical context-correction intake):
//   ManualFeedbackImportPort.importManualFeedback
//     → feedback report + evidence
//     → canonical context correction (target unit required)
//
// Permission: `feedback.import` (canFlag). Severity is the design-system
// annotation-severity ramp (blocker/critical/warning/note), carried on
// metadata so the correction path preserves its severity provenance.

import {
  feedbackSourceKindValues,
  feedbackTypeValues,
  type FeedbackType,
  type ManualFeedbackImportInput,
} from "@itotori/db";
import {
  ANNOTATION_SEVERITIES,
  type AnnotationSeverity,
  isAnnotationSeverity,
} from "../annotation.js";

/** Closed ordinal severity scale — mirrors `@itotori/ds` AnnotationComposer. */
export const PLAY_FLAG_SEVERITIES = ANNOTATION_SEVERITIES;
export type PlayFlagSeverity = AnnotationSeverity;

export type PlayFlagAnnotationInput = {
  projectId: string;
  localeBranchId: string;
  /** Free-text note from the AnnotationComposer. */
  note: string;
  severity: PlayFlagSeverity;
  /** Free-form category (tone / layout / glossary / …). */
  category?: string;
  /** Persisted bridge unit the flag is anchored to. */
  bridgeUnitId: string;
  sourceUnitKey?: string;
  sourceBundleId?: string;
  sourceRevisionId?: string;
  /** Optional scene identity for canonical context (game-agnostic key). */
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
  if (!isAnnotationSeverity(input.severity)) {
    throw new Error(`play flag severity must be one of: ${PLAY_FLAG_SEVERITIES.join(", ")}`);
  }
  if (input.bridgeUnitId.trim().length === 0) {
    throw new Error("play flag bridgeUnitId must be a non-empty string");
  }

  const category = (input.category ?? "").trim();
  const feedbackType = feedbackTypeForFlagCategory(category);
  const reporterName = input.actorDisplayName ?? input.actorUserId;

  const payload: ManualFeedbackImportInput = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    feedbackType,
    reporter: {
      role: "playtester",
      reporterId: input.actorUserId,
      displayName: reporterName,
    },
    reporterNote: note,
    lineReference: {
      bridgeUnitId: input.bridgeUnitId.trim(),
      ...(input.sourceUnitKey !== undefined && input.sourceUnitKey.length > 0
        ? { sourceUnitKey: input.sourceUnitKey }
        : {}),
      ...(input.sceneId !== undefined && input.sceneId.length > 0
        ? { sourceLocation: { sceneId: input.sceneId } }
        : {}),
    },
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
  return payload;
}
