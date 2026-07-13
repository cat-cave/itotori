// ALPHA-002 — Playable draft feedback loop tests.
//
// Drives the real batched intake composition end to end with no DB:
//   batched intake → triage labels → feedback audit results
//   (real `ManualFeedbackImportService` path, with no reviewer-queue sink).
//
// Only the feedback repository leaf port is an in-memory stub.

import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  ItotoriFeedbackRepositoryPort,
  ManualFeedbackImportInput,
  ManualFeedbackImportResult,
} from "@itotori/db";
import {
  feedbackContextStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
} from "@itotori/db";
import { ManualFeedbackImportService } from "../src/manual-feedback.js";
import {
  DraftFeedbackBatchError,
  DraftFeedbackBatchService,
  dispositionFor,
} from "../src/draft-feedback/index.js";

const actor: AuthorizationActor = { userId: "local-user" };
const PROJECT_ID = "project-fixture";
const BRANCH_ID = "branch-fixture";
// ---------------------------------------------------------------------------
// In-memory feedback port (mirrors real triage-label mapping).
// ---------------------------------------------------------------------------

function triageLabelFor(type: ManualFeedbackImportInput["feedbackType"]) {
  switch (type) {
    case feedbackTypeValues.objectiveDefect:
      return feedbackTriageLabelValues.objectiveDefectCandidate;
    case feedbackTypeValues.stylePreference:
      return feedbackTriageLabelValues.styleDisputeCandidate;
    default:
      return feedbackTriageLabelValues.needsContext;
  }
}

class StubFeedbackRepository implements Pick<
  ItotoriFeedbackRepositoryPort,
  "importManualFeedback"
> {
  private counter = 0;

  async importManualFeedback(
    _actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult> {
    this.counter += 1;
    const feedbackReportId = `feedback-report-${this.counter}`;
    const feedbackEvidenceId = `feedback-evidence-${this.counter}`;
    const triageLabel = triageLabelFor(input.feedbackType);
    return {
      feedbackReportId,
      feedbackEvidenceId,
      feedbackSourceId: `feedback-source-${this.counter}`,
      dedupeKey: `dedupe-${this.counter}`,
      triageLabel,
      reportStatus: "open",
      contextStatus: feedbackContextStatusValues.contextualized,
      reportCount: 1,
      duplicate: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Submission fixtures.
// ---------------------------------------------------------------------------

function typoSubmission(bridgeUnitId: string, note: string): ManualFeedbackImportInput {
  return {
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    targetLocale: "en-US",
    feedbackType: feedbackTypeValues.objectiveDefect,
    reporter: { role: "playtester", displayName: "Alice" },
    reporterNote: note,
    suggestedEdit: `${note} (corrected)`,
    lineReference: { bridgeUnitId },
  };
}

function styleSubmission(bridgeUnitId: string, note: string): ManualFeedbackImportInput {
  return {
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    targetLocale: "en-US",
    feedbackType: feedbackTypeValues.stylePreference,
    reporter: { role: "reviewer", displayName: "Bob" },
    reporterNote: note,
    lineReference: { bridgeUnitId },
  };
}

function buildLoop(): { batch: DraftFeedbackBatchService } {
  const feedbackRepo = new StubFeedbackRepository();
  const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor);
  return { batch: new DraftFeedbackBatchService(manualFeedback) };
}

describe("DraftFeedbackBatchService — batched intake + triage", () => {
  it("collects multiple typo corrections with context while retaining style triage as audit data", async () => {
    const { batch } = buildLoop();

    const result = await batch.submitBatch({
      batchLabel: "oshioki-slice-1",
      submissions: [
        typoSubmission("unit-a", "Teh hero speaks"),
        typoSubmission("unit-b", "recieve the sword"),
        styleSubmission("unit-c", "honorifics should stay"),
      ],
    });

    // Batched: every submission collected in order.
    expect(result.submittedCount).toBe(3);
    expect(result.items.map((item) => item.submissionIndex)).toEqual([0, 1, 2]);

    // Typo corrections carry their context (the bridge unit they target)
    // and the proposed correction.
    expect(result.items[0]?.disposition).toBe("repair_candidate");
    expect(result.items[0]?.bridgeUnitIds).toEqual(["unit-a"]);
    expect(result.items[0]?.suggestedEdit).toBe("Teh hero speaks (corrected)");
    expect(result.items[1]?.bridgeUnitIds).toEqual(["unit-b"]);
    expect(result.repairCandidateReportIds).toHaveLength(2);
    expect(result.affectedBridgeUnitIds).toEqual(["unit-a", "unit-b", "unit-c"]);

    // Style feedback retains its triage disposition for downstream audit; this
    // batch path itself does not create a reviewer-queue item.
    expect(result.items[2]?.disposition).toBe("decision_queue");
    expect(result.decisionQueueReportIds).toHaveLength(1);
  });

  it("rejects an empty batch with a typed error", async () => {
    const { batch } = buildLoop();
    await expect(batch.submitBatch({ submissions: [] })).rejects.toBeInstanceOf(
      DraftFeedbackBatchError,
    );
  });

  it("is deterministic: the same batch yields the same batchId", async () => {
    const submissions = [typoSubmission("unit-a", "Teh hero speaks")];
    const first = await buildLoop().batch.submitBatch({ submissions });
    const second = await buildLoop().batch.submitBatch({ submissions });
    expect(first.batchId).toBe(second.batchId);
  });
});

describe("dispositionFor — exhaustive triage-label mapping", () => {
  it("maps every triage label to a disposition", () => {
    expect(dispositionFor(feedbackTriageLabelValues.styleDisputeCandidate)).toBe("decision_queue");
    expect(dispositionFor(feedbackTriageLabelValues.needsContext)).toBe("needs_context");
    expect(dispositionFor(feedbackTriageLabelValues.objectiveDefectCandidate)).toBe(
      "repair_candidate",
    );
    expect(dispositionFor(feedbackTriageLabelValues.glossaryCanonCandidate)).toBe(
      "repair_candidate",
    );
    expect(dispositionFor(feedbackTriageLabelValues.runtimeIssueCandidate)).toBe(
      "repair_candidate",
    );
    expect(dispositionFor(feedbackTriageLabelValues.assetIssueCandidate)).toBe("repair_candidate");
  });
});
