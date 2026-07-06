// ALPHA-002 — Typed contract for feedback-submission bridge-unit metadata.
//
// Guards the fix for `bridgeUnitIdsForSubmission`, which used to scan a
// submission's loosely-typed `metadata` with bare string-literal keys. The
// access now goes through `readBridgeUnitMetadata` (a typed contract), so a
// rename/reshape of the recognized keys is a compile error and a malformed
// value is thrown rather than silently mis-scanned.

import { readFileSync } from "node:fs";
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
import {
  BRIDGE_UNIT_METADATA_KEYS,
  BridgeUnitMetadataError,
  DraftFeedbackBatchService,
  readBridgeUnitMetadata,
} from "../src/draft-feedback/index.js";
import { ManualFeedbackImportService } from "../src/manual-feedback.js";

const batchServiceSourceUrl = new URL("../src/draft-feedback/batch-service.ts", import.meta.url);

describe("readBridgeUnitMetadata — typed contract over loose metadata", () => {
  it("maps every recognized key of a well-formed shape 1:1", () => {
    const typed = readBridgeUnitMetadata({
      affectedUnitIds: ["unit-a"],
      affectedBridgeUnitIds: ["unit-b"],
      bridgeUnitIds: ["unit-c"],
      unitIds: ["unit-d"],
      // Unrecognized keys are ignored, not an error.
      unrelated: 42,
    });
    expect(typed).toEqual({
      affectedUnitIds: ["unit-a"],
      affectedBridgeUnitIds: ["unit-b"],
      bridgeUnitIds: ["unit-c"],
      unitIds: ["unit-d"],
    });
  });

  it("treats absent metadata and absent keys as empty (no throw)", () => {
    expect(readBridgeUnitMetadata(undefined)).toEqual({});
    expect(readBridgeUnitMetadata({})).toEqual({});
    expect(readBridgeUnitMetadata({ affectedUnitIds: undefined })).toEqual({});
  });

  it("throws when a recognized key is present but is not an array", () => {
    expect(() => readBridgeUnitMetadata({ affectedUnitIds: "unit-a" })).toThrow(
      BridgeUnitMetadataError,
    );
  });

  it("throws when a recognized key holds a non-string entry", () => {
    expect(() => readBridgeUnitMetadata({ bridgeUnitIds: ["unit-a", 7] })).toThrow(
      BridgeUnitMetadataError,
    );
  });

  it("names the offending key on the error", () => {
    try {
      readBridgeUnitMetadata({ unitIds: { nope: true } });
      expect.unreachable("malformed metadata must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeUnitMetadataError);
      expect((error as BridgeUnitMetadataError).key).toBe("unitIds");
    }
  });
});

describe("batch-service metadata access — discipline guard", () => {
  it("reads bridge-unit ids through the typed contract, never a raw key scan", () => {
    const source = readFileSync(batchServiceSourceUrl, "utf8");
    // The typed contract is used…
    expect(source).toContain("readBridgeUnitMetadata");
    expect(source).toContain("BRIDGE_UNIT_METADATA_KEYS");
    // …and the old loose string-literal key scan is gone. Reverting to it
    // would reintroduce the silent-breakage risk this fix removed.
    expect(source).not.toMatch(/for \(const key of \[\s*"affectedUnitIds"/);
    expect(source).not.toMatch(/submission\.metadata\?\.\[key\]/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through submitBatch: well-formed metadata is unchanged; a
// malformed shape is caught rather than silently producing wrong ids.
// ---------------------------------------------------------------------------

const actor: AuthorizationActor = { userId: "local-user" };

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
    return {
      feedbackReportId: `feedback-report-${this.counter}`,
      feedbackEvidenceId: `feedback-evidence-${this.counter}`,
      feedbackSourceId: `feedback-source-${this.counter}`,
      dedupeKey: `dedupe-${this.counter}`,
      triageLabel:
        input.feedbackType === feedbackTypeValues.objectiveDefect
          ? feedbackTriageLabelValues.objectiveDefectCandidate
          : feedbackTriageLabelValues.needsContext,
      reportStatus: "open",
      contextStatus: feedbackContextStatusValues.contextualized,
      reportCount: 1,
      duplicate: false,
    };
  }
}

function submissionWithMetadata(metadata: Record<string, unknown>): ManualFeedbackImportInput {
  return {
    projectId: "project-fixture",
    localeBranchId: "branch-fixture",
    targetLocale: "en-US",
    feedbackType: feedbackTypeValues.objectiveDefect,
    reporter: { role: "playtester", displayName: "Alice" },
    reporterNote: "note",
    lineReference: { bridgeUnitId: "unit-line" },
    metadata,
  };
}

function buildBatch(): DraftFeedbackBatchService {
  return new DraftFeedbackBatchService(
    new ManualFeedbackImportService(new StubFeedbackRepository(), actor),
  );
}

describe("submitBatch — bridge-unit metadata behavior", () => {
  it("collects the bridge-unit ids from well-formed metadata plus the line reference", async () => {
    const result = await buildBatch().submitBatch({
      submissions: [
        submissionWithMetadata({
          affectedUnitIds: ["unit-a"],
          bridgeUnitIds: ["unit-b", "unit-a"],
        }),
      ],
    });
    // Line-reference id + metadata ids, deduped + sorted (unchanged behavior).
    expect(result.items[0]?.bridgeUnitIds).toEqual(["unit-a", "unit-b", "unit-line"]);
    expect(result.affectedBridgeUnitIds).toEqual(["unit-a", "unit-b", "unit-line"]);
  });

  it("catches a malformed metadata shape instead of silently mis-scanning", async () => {
    await expect(
      buildBatch().submitBatch({
        submissions: [submissionWithMetadata({ affectedUnitIds: "unit-a" })],
      }),
    ).rejects.toBeInstanceOf(BridgeUnitMetadataError);
  });
});

describe("BRIDGE_UNIT_METADATA_KEYS", () => {
  it("pins exactly the recognized bridge-unit metadata keys", () => {
    expect([...BRIDGE_UNIT_METADATA_KEYS]).toEqual([
      "affectedUnitIds",
      "affectedBridgeUnitIds",
      "bridgeUnitIds",
      "unitIds",
    ]);
  });
});
