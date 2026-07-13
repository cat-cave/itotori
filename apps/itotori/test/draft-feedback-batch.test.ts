// ALPHA-002 — Playable draft feedback batches are direct canonical corrections.

import { describe, expect, it } from "vitest";
import {
  feedbackContextStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  type ManualFeedbackImportInput,
} from "@itotori/db";
import type {
  ManualFeedbackImportOutcome,
  ManualFeedbackImportPort,
} from "../src/manual-feedback.js";
import type { ContextCorrectionResult } from "../src/orchestrator/context-correction-service.js";
import { DraftFeedbackBatchError, DraftFeedbackBatchService } from "../src/draft-feedback/index.js";

const PROJECT_ID = "project-fixture";
const BRANCH_ID = "branch-fixture";

class StubFeedbackImportPort implements ManualFeedbackImportPort {
  private counter = 0;

  async importManualFeedback(
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportOutcome> {
    this.counter += 1;
    const id = String(this.counter);
    return {
      feedbackReportId: `feedback-report-${id}`,
      feedbackEvidenceId: `feedback-evidence-${id}`,
      feedbackSourceId: `feedback-source-${id}`,
      dedupeKey: `dedupe-${id}`,
      triageLabel:
        input.feedbackType === feedbackTypeValues.stylePreference
          ? feedbackTriageLabelValues.styleDisputeCandidate
          : feedbackTriageLabelValues.objectiveDefectCandidate,
      reportStatus: "open",
      contextStatus: feedbackContextStatusValues.contextualized,
      reportCount: 1,
      duplicate: false,
      contextCorrection: {
        correctionId: `context-correction-${id}`,
      } as ContextCorrectionResult,
    };
  }
}

function submission(
  bridgeUnitId: string,
  feedbackType: ManualFeedbackImportInput["feedbackType"],
  note: string,
): ManualFeedbackImportInput {
  return {
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    feedbackType,
    reporter: { role: "playtester", displayName: "Alice" },
    reporterNote: note,
    suggestedEdit: `${note} (corrected)`,
    lineReference: { bridgeUnitId },
  };
}

function buildBatch(): DraftFeedbackBatchService {
  return new DraftFeedbackBatchService(new StubFeedbackImportPort());
}

describe("DraftFeedbackBatchService", () => {
  it("writes one canonical context correction for every target-scoped submission", async () => {
    const result = await buildBatch().submitBatch({
      batchLabel: "oshioki-slice-1",
      submissions: [
        submission("unit-a", feedbackTypeValues.objectiveDefect, "Teh hero speaks"),
        submission("unit-b", feedbackTypeValues.objectiveDefect, "recieve the sword"),
        submission("unit-c", feedbackTypeValues.stylePreference, "honorifics should stay"),
      ],
    });

    expect(result.submittedCount).toBe(3);
    expect(result.items.map((item) => item.submissionIndex)).toEqual([0, 1, 2]);
    expect(result.items.map((item) => item.contextCorrectionId)).toEqual([
      "context-correction-1",
      "context-correction-2",
      "context-correction-3",
    ]);
    expect(result.items[0]?.bridgeUnitIds).toEqual(["unit-a"]);
    expect(result.items[0]?.suggestedEdit).toBe("Teh hero speaks (corrected)");
    expect(result.contextCorrectionReportIds).toEqual([
      "feedback-report-1",
      "feedback-report-2",
      "feedback-report-3",
    ]);
    expect(result.contextCorrectionIds).toEqual([
      "context-correction-1",
      "context-correction-2",
      "context-correction-3",
    ]);
    expect(result.affectedBridgeUnitIds).toEqual(["unit-a", "unit-b", "unit-c"]);
  });

  it("rejects an empty batch with a typed error", async () => {
    await expect(buildBatch().submitBatch({ submissions: [] })).rejects.toBeInstanceOf(
      DraftFeedbackBatchError,
    );
  });

  it("is deterministic: the same batch yields the same batchId", async () => {
    const submissions = [
      submission("unit-a", feedbackTypeValues.objectiveDefect, "Teh hero speaks"),
    ];
    const first = await buildBatch().submitBatch({ submissions });
    const second = await buildBatch().submitBatch({ submissions });
    expect(first.batchId).toBe(second.batchId);
  });
});
