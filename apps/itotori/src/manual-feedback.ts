import { createHash } from "node:crypto";
import {
  contextCorrectionAuthorityValues,
  type AuthorizationActor,
  type ItotoriFeedbackRepositoryPort,
  type ManualFeedbackCorrectionContext,
  type ManualFeedbackImportInput,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportResult,
  feedbackContextStatusValues,
  feedbackTypeValues,
} from "@itotori/db";
import { localUserActor } from "./auth.js";
import {
  playTesterContextKindValues,
  type ApplyContextCorrectionInput,
  type ContextCorrectionResult,
} from "./orchestrator/context-correction-service.js";

/** The actual correction result, not an inferred routing status. */
export type ManualFeedbackImportOutcome = ManualFeedbackImportResult & {
  contextCorrection: ContextCorrectionResult | null;
};

export interface ManualFeedbackImportPort {
  importManualFeedback(input: unknown): Promise<ManualFeedbackImportOutcome>;
}

/**
 * Narrow, actor-bound correction seam. Keeping it structural lets bare
 * feedback importers retain their audit-only behavior in callers that do not
 * own canonical-context mutation wiring.
 */
export interface ManualFeedbackContextCorrectionPort {
  apply(input: ApplyContextCorrectionInput): Promise<ContextCorrectionResult>;
}

export class ManualFeedbackImportService implements ManualFeedbackImportPort {
  constructor(
    private readonly repository: Pick<ItotoriFeedbackRepositoryPort, "importManualFeedback"> &
      Partial<Pick<ItotoriFeedbackRepositoryPort, "loadManualFeedbackCorrectionContext">>,
    private readonly actor: AuthorizationActor = localUserActor,
    private readonly contextCorrections?: ManualFeedbackContextCorrectionPort,
  ) {}

  async importManualFeedback(input: unknown): Promise<ManualFeedbackImportOutcome> {
    const parsed = parseManualFeedbackImportInput(input);
    const result = await this.repository.importManualFeedback(this.actor, parsed);
    const contextCorrection = await this.applyContextCorrection(result);
    return { ...result, contextCorrection };
  }

  private async applyContextCorrection(
    result: ManualFeedbackImportResult,
  ): Promise<ContextCorrectionResult | null> {
    if (
      this.contextCorrections === undefined ||
      this.repository.loadManualFeedbackCorrectionContext === undefined ||
      result.contextStatus !== feedbackContextStatusValues.contextualized
    ) {
      return null;
    }

    // Deliberately do not short-circuit duplicates. The correction service owns
    // idempotency atomically, and an aggregated report must still reach that
    // durable path rather than silently remaining unprocessed.
    const context = await this.repository.loadManualFeedbackCorrectionContext(
      this.actor,
      result.feedbackReportId,
      result.feedbackEvidenceId,
    );
    if (
      context === null ||
      context.contextStatus !== feedbackContextStatusValues.contextualized ||
      context.affectedUnitIds.length === 0
    ) {
      return null;
    }

    return await this.contextCorrections.apply(contextCorrectionInputForFeedback(context));
  }
}

/**
 * Build an idempotent canonical-context write entirely from persisted feedback
 * state. A caller cannot redirect a duplicate report by changing raw request
 * fields after its feedback report has already been created.
 */
export function contextCorrectionInputForFeedback(
  context: ManualFeedbackCorrectionContext,
): ApplyContextCorrectionInput {
  return {
    projectId: context.projectId,
    localeBranchId: context.localeBranchId,
    sourceRevisionId: context.sourceRevisionId,
    contextArtifactId: manualFeedbackContextArtifactId(context.feedbackReportId),
    correctionId: manualFeedbackCorrectionId(context.feedbackReportId),
    authority: contextCorrectionAuthorityValues.feedbackImport,
    kind: contextKindForFeedback(context),
    title: `Feedback correction for ${context.feedbackReportId}`,
    body: correctionBodyForFeedback(context),
    reason: context.reporterNote,
    affectedUnitIds: context.affectedUnitIds,
    data: {
      feedbackReportId: context.feedbackReportId,
      feedbackEvidenceId: context.feedbackEvidenceId,
      feedbackType: context.feedbackType,
      triageLabel: context.triageLabel,
      reporterNote: context.reporterNote,
      suggestedEdit: context.suggestedEdit,
    },
  };
}

export function manualFeedbackContextArtifactId(feedbackReportId: string): string {
  return `feedback-context-artifact-${shortHash(feedbackReportId)}`;
}

export function manualFeedbackCorrectionId(feedbackReportId: string): string {
  return `feedback-context-correction-${shortHash(feedbackReportId)}`;
}

function contextKindForFeedback(context: ManualFeedbackCorrectionContext) {
  if (context.feedbackType === feedbackTypeValues.glossaryCanonIssue) {
    return playTesterContextKindValues.glossary;
  }
  if (context.feedbackType === feedbackTypeValues.stylePreference) {
    return playTesterContextKindValues.style;
  }
  return playTesterContextKindValues.context;
}

function correctionBodyForFeedback(context: ManualFeedbackCorrectionContext): string {
  const suggestedEdit = context.suggestedEdit?.trim();
  return [
    ...(suggestedEdit === undefined || suggestedEdit.length === 0
      ? []
      : [`Suggested draft:\n${suggestedEdit}`]),
    `Reporter feedback:\n${context.reporterNote}`,
  ].join("\n\n");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export type { ManualFeedbackImportInput };
