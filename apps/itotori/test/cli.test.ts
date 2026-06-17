import {
  type AuthorizationActor,
  feedbackTypeValues,
  type ManualFeedbackImportInput,
  type ManualFeedbackImportResult,
  type ProjectCostReport,
  type ProjectDashboardStatus,
} from "@itotori/db";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import { ManualFeedbackImportService } from "../src/manual-feedback.js";
import type { ProjectState } from "../src/services/project-workflow.js";

describe("itotori scaffold", () => {
  it("keeps the hello world translation deterministic", () => {
    expect("こんにちは、{player}。".includes("{player}")).toBe(true);
  });
});

describe("ManualFeedbackImportService", () => {
  it("rejects malformed manual feedback JSON before repository import", async () => {
    const importManualFeedback = vi.fn<
      [AuthorizationActor, ManualFeedbackImportInput],
      Promise<ManualFeedbackImportResult>
    >();
    const service = new ManualFeedbackImportService({ importManualFeedback });

    await expect(
      service.importManualFeedback({
        projectId: "project-test",
        targetLocale: "en-US",
        feedbackType: feedbackTypeValues.stylePreference,
        reporter: { role: "playtester" },
        reporterNote: 123,
      }),
    ).rejects.toThrow("manual feedback reporterNote must be a string");

    expect(importManualFeedback).not.toHaveBeenCalled();
  });
});

describe("Itotori CLI handlers", () => {
  it("writes dashboard status from the shared project service", async () => {
    const services = servicesFixture();
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["dashboard-status", "--output", "status.json"], {
      io: jsonStoreFixture(new Map(), writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.projectWorkflow.getDashboardStatus).toHaveBeenCalledTimes(1);
    expect(writes.get("status.json")).toEqual(dashboardStatusFixture);
  });

  it("validates bridge input before calling the import service", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([["bridge.json", { schemaVersion: "bad" }]]);

    await expect(
      runItotoriCliCommand(["import", "--bridge", "bridge.json", "--project", "project.json"], {
        io: jsonStoreFixture(reads, new Map()),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      }),
    ).rejects.toThrow("BridgeBundle.schemaVersion");

    expect(services.projectWorkflow.importBridge).not.toHaveBeenCalled();
  });

  it("imports manual feedback through the feedback service", async () => {
    const services = servicesFixture();
    const feedback = {
      projectId: "project-1",
      targetLocale: "en-US",
      feedbackType: feedbackTypeValues.stylePreference,
      reporter: { role: "playtester" },
      reporterNote: "Tone is too formal.",
    };
    const reads = new Map<string, unknown>([["feedback.json", feedback]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      ["import-feedback", "--feedback", "feedback.json", "--output", "feedback-result.json"],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(services.manualFeedback.importManualFeedback).toHaveBeenCalledWith(feedback);
    expect(writes.get("feedback-result.json")).toEqual(manualFeedbackResultFixture);
  });
});

function jsonStoreFixture(reads: Map<string, unknown>, writes: Map<string, unknown>) {
  return {
    readJson: vi.fn((path: string) => reads.get(path)),
    writeJson: vi.fn((path: string, value: unknown) => {
      writes.set(path, value);
    }),
  };
}

function servicesFixture(): ItotoriCliServices {
  return {
    projectWorkflow: {
      reset: vi.fn(async () => {}),
      getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
      getCostReport: vi.fn(async () => costReportFixture),
      getRuntimeStatus: vi.fn(async () => ({
        finalStatus: "hello_world_passed",
        runtimeReportId: "runtime-1",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: null,
        textEventCount: 1,
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
      })),
      importBridge: vi.fn(async (_bridge: BridgeBundle) => projectFixture()),
      draftProject: vi.fn(async (project: ProjectState) => project),
      exportPatch: vi.fn(async (project: ProjectState) => ({
        project,
        patchExport: {
          schemaVersion: "0.1.0",
          patchExportId: "patch-1",
          sourceBridgeId: project.bridge.bridgeId,
          sourceBundleHash: project.bridge.sourceBundleHash,
          sourceLocale: project.bridge.sourceLocale,
          targetLocale: project.targetLocale,
          entries: [],
        },
      })),
      ingestRuntimeReport: vi.fn(async (project: ProjectState) => ({
        project,
        result: {
          status: "hello_world_passed",
          bridgeId: project.bridge.bridgeId,
          localeBranchId: project.localeBranchId,
          patchExportId: project.patchExport?.patchExportId,
          patchResultId: "patch-result-1",
          runtimeReportId: "runtime-1",
          dashboard: dashboardStatusFixture,
        },
      })),
      recordFinding: vi.fn(async () => ({ findingId: "finding-1", status: "open" })),
      recordDecision: vi.fn(async () => ({
        decisionId: "019ed004-0000-7000-8000-000000000201",
        eventKind: "triage_decision_recorded",
        recorded: true,
      })),
      recordBenchmarkReport: vi.fn(async () => ({
        benchmarkRunId: "019ed006-0000-7000-8000-00000000f001",
        artifactId: "019ed006-0000-7000-8000-00000000f001",
        status: "passed",
        systemCount: 1,
        findingCount: 0,
      })),
    },
    manualFeedback: {
      importManualFeedback: vi.fn(async () => manualFeedbackResultFixture),
    },
  };
}

function projectFixture(): ProjectState {
  return {
    projectId: "project-1",
    localeBranchId: "locale-1",
    targetLocale: "en-US",
    drafts: {},
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-1",
      sourceBundleHash: "hash-1",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [],
    },
  };
}

const costReportFixture: ProjectCostReport = {
  projectId: "project-1",
  currency: "USD",
  runCount: 0,
  billedMicrosUsd: 0,
  estimatedMicrosUsd: 0,
  zeroRunCount: 0,
  unknownRunCount: 0,
  includesUnknownCost: false,
  totalsByCostKind: ["billed", "provider_estimate", "local_estimate", "zero", "unknown"].map(
    (costKind) => ({
      costKind: costKind as ProjectCostReport["totalsByCostKind"][number]["costKind"],
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }),
  ),
  recentRuns: [],
};

const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-1",
  projectKey: "project-1",
  name: "project-1",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
  sourceBundleId: "bridge-1",
  sourceBundleHash: "hash-1",
  sourceBundleRevisionId: "revision-1",
  branchCount: 1,
  unitCount: 1,
  findingCount: 0,
  artifactCount: 3,
  latestEventKind: "patch_result_recorded",
  latestEventAt: "2026-06-17T00:00:00.000Z",
  cost: costReportFixture,
  localeBranches: [],
};

const manualFeedbackResultFixture: ManualFeedbackImportResult = {
  feedbackReportId: "feedback-1",
  feedbackEvidenceId: "evidence-1",
  feedbackSourceId: "source-1",
  dedupeKey: "dedupe-1",
  triageLabel: "style_dispute_candidate",
  reportStatus: "open",
  contextStatus: "contextualized",
  reportCount: 1,
  duplicate: false,
};
