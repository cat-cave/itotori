// Production adapter: ManualFeedbackImport / unit-feedback list over the
// ItotoriFeedbackRepository. Synthesizes the contextCorrection id the flag
// handler expects (report-stable, not a second parallel correction store).

import type {
  AuthorizationActor,
  ItotoriFeedbackRepositoryPort,
  ManualFeedbackImportInput,
} from "@itotori/db";
import type {
  ListUnitFeedbackQuery,
  UnitBoundFeedbackPort,
  UnitFeedbackImportResult,
  UnitFeedbackNote,
} from "./unit-feedback.js";
import { UNIT_FEEDBACK_SCHEMA_VERSION } from "./unit-feedback.js";

export function createRepositoryUnitFeedbackPort(input: {
  readonly repository: ItotoriFeedbackRepositoryPort;
  readonly actor: AuthorizationActor;
}): UnitBoundFeedbackPort {
  const { repository, actor } = input;
  return {
    async importManualFeedback(raw: unknown): Promise<UnitFeedbackImportResult> {
      const result = await repository.importManualFeedback(actor, raw as ManualFeedbackImportInput);
      return {
        feedbackReportId: result.feedbackReportId,
        feedbackEvidenceId: result.feedbackEvidenceId,
        triageLabel: result.triageLabel,
        contextStatus: result.contextStatus,
        duplicate: result.duplicate,
        contextCorrection: {
          correctionId: `context-correction:${result.feedbackReportId}`,
        },
      };
    },
    async listUnitFeedback(query: ListUnitFeedbackQuery): Promise<UnitFeedbackNote[]> {
      const rows = await repository.listUnitBoundFeedback(actor, query);
      return rows.map((row) => ({
        schemaVersion: UNIT_FEEDBACK_SCHEMA_VERSION,
        feedbackReportId: row.feedbackReportId,
        feedbackEvidenceId: row.feedbackEvidenceId,
        projectId: row.projectId,
        localeBranchId: row.localeBranchId,
        bridgeUnitId: row.bridgeUnitId,
        sceneId: row.sceneId,
        note: row.note,
        severity: row.severity,
        category: row.category,
        triageLabel: row.triageLabel,
        contextStatus: row.contextStatus,
        contextCorrectionId: `context-correction:${row.feedbackReportId}`,
        reportedAt: row.reportedAt,
        duplicate: row.duplicate,
      }));
    },
  };
}
