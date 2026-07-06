import { readFileSync } from "node:fs";
import {
  type AuthorizationActor,
  type CatalogExactExternalIdLinkRequest,
  type CatalogExactExternalIdLinkResult,
  type CatalogFuzzyCandidateRequest,
  type CatalogFuzzyCandidateResult,
  type CatalogResolverFixtureInput,
  type CreateReviewerQueueItemInput,
  catalogFuzzyCandidateDiagnosticCodeValues,
  catalogResolverFixtureDiagnosticCodeValues,
  catalogExactExternalIdLinkStatusValues,
  catalogExactExternalIdLinkSchemaVersion,
  catalogFuzzyCandidateSchemaVersion,
  catalogFuzzyCandidateStatusValues,
  ItotoriCatalogExactExternalIdLinkerService,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  feedbackContextStatusValues,
  feedbackTriageLabelValues,
  type DashboardDecisionReadModel,
  feedbackTypeValues,
  type ManualFeedbackImportInput,
  type ManualFeedbackImportResult,
  type ProjectCostReport,
  type ProjectDashboardStatus,
  type ReviewerQueueItemRecord,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  StyleGuideFixtureFlowRerunError,
  styleGuideFixtureFlowSchemaVersion,
  type StyleGuideFixtureFlowResult,
} from "@itotori/db";
import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
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

  it("enqueues contextual imported style disputes as style reviewer items", async () => {
    const importManualFeedback = vi.fn(async () => manualFeedbackResultFixture);
    const loadManualFeedbackReviewerQueueContext = vi.fn(async () => ({
      feedbackReportId: "feedback-1",
      feedbackEvidenceId: "evidence-1",
      projectId: "project-1",
      localeBranchId: "locale-1",
      sourceRevisionId: "source-revision-from-bundle",
      feedbackType: feedbackTypeValues.stylePreference,
      triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
      contextStatus: feedbackContextStatusValues.contextualized,
      reporterNote: "The protagonist sounds too formal here.",
      context: {
        lineReference: {
          bridgeUnitId: "unit-1",
          sourceUnitKey: "scene.001",
          path: "/private/tmp/source.json",
          line: 7,
          sourceLocation: {
            fileUri: "file:///private/tmp/source.json",
            localPath: "/private/tmp/source.json",
          },
          quotedText: "raw captured line",
        },
        attachmentSignals: [
          {
            attachmentKind: "screenshot",
            artifactId: "artifact-shot-1",
            uri: "private://captures/shot.png",
          },
        ],
      },
      attachments: [
        {
          attachmentKind: "screenshot",
          artifactId: "artifact-shot-1",
          uri: "private://captures/shot.png",
          hash: "sha256:shot",
          evidenceTier: "E2",
          metadata: { localPath: "/private/tmp/shot.png" },
        },
      ],
      affectedArtifactIds: ["artifact-shot-1"],
    }));
    const createItem = vi.fn(
      async (_actor: AuthorizationActor, input: CreateReviewerQueueItemInput) =>
        reviewerQueueItemRecord(input),
    );
    const service = new ManualFeedbackImportService(
      { importManualFeedback, loadManualFeedbackReviewerQueueContext },
      { userId: "local-user" },
      { createItem },
    );

    await service.importManualFeedback(manualFeedbackInputFixture());

    expect(createItem).toHaveBeenCalledTimes(1);
    expect(createItem.mock.calls[0]?.[1]).toMatchObject({
      itemKind: reviewerQueueItemKindValues.style,
      sourceItemRef: "feedback-1",
      sourceRevisionId: "source-revision-from-bundle",
      affectedArtifactIds: ["artifact-shot-1"],
      payload: {
        feedbackReportId: "feedback-1",
        feedbackEvidenceId: "evidence-1",
        evidenceId: "evidence-1",
        styleDisputeKey: "feedback-1",
        feedbackType: feedbackTypeValues.stylePreference,
        triageLabel: "style_dispute_candidate",
        affectedUnitIds: ["unit-1"],
        bridgeUnitIds: ["unit-1"],
        context: {
          lineReference: { bridgeUnitId: "unit-1", sourceUnitKey: "scene.001", line: 7 },
        },
        attachments: [
          {
            attachmentKind: "screenshot",
            artifactId: "artifact-shot-1",
            evidenceTier: "E2",
          },
        ],
      },
      metadata: {
        feedbackReportId: "feedback-1",
        feedbackEvidenceId: "evidence-1",
        evidenceId: "evidence-1",
        styleDisputeKey: "feedback-1",
        triageLabel: "style_dispute_candidate",
        affectedUnitIds: ["unit-1"],
        bridgeUnitIds: ["unit-1"],
      },
    });
    expect(JSON.stringify(createItem.mock.calls[0]?.[1])).not.toContain("private://");
    expect(JSON.stringify(createItem.mock.calls[0]?.[1])).not.toContain("/private/tmp");
    expect(JSON.stringify(createItem.mock.calls[0]?.[1])).not.toContain("file:///private");
    expect(JSON.stringify(createItem.mock.calls[0]?.[1])).not.toContain("raw captured line");
    expect(JSON.stringify(createItem.mock.calls[0]?.[1])).not.toContain("playtester@example.com");
  });

  it("keeps contextual objective feedback as feedback reviewer items", async () => {
    const importManualFeedback = vi.fn(async () => ({
      ...manualFeedbackResultFixture,
      triageLabel: feedbackTriageLabelValues.objectiveDefectCandidate,
    }));
    const loadManualFeedbackReviewerQueueContext = vi.fn(async () => ({
      feedbackReportId: "feedback-objective-1",
      feedbackEvidenceId: "evidence-objective-1",
      projectId: "project-1",
      localeBranchId: "locale-1",
      sourceRevisionId: "source-revision-from-bundle",
      feedbackType: feedbackTypeValues.objectiveDefect,
      triageLabel: feedbackTriageLabelValues.objectiveDefectCandidate,
      contextStatus: feedbackContextStatusValues.contextualized,
      reporterNote: "The translated line has a typo.",
      context: {
        lineReference: {
          bridgeUnitId: "unit-1",
          sourceUnitKey: "scene.001",
          line: 7,
        },
      },
      attachments: [],
      affectedArtifactIds: [],
    }));
    const createItem = vi.fn(
      async (_actor: AuthorizationActor, input: CreateReviewerQueueItemInput) =>
        reviewerQueueItemRecord(input),
    );
    const service = new ManualFeedbackImportService(
      { importManualFeedback, loadManualFeedbackReviewerQueueContext },
      { userId: "local-user" },
      { createItem },
    );

    await service.importManualFeedback(
      manualFeedbackInputFixture({
        feedbackType: feedbackTypeValues.objectiveDefect,
        reporterNote: "The translated line has a typo.",
      }),
    );

    expect(createItem).toHaveBeenCalledTimes(1);
    expect(createItem.mock.calls[0]?.[1]).toMatchObject({
      itemKind: reviewerQueueItemKindValues.feedback,
      sourceItemRef: "feedback-objective-1",
      payload: {
        feedbackReportId: "feedback-objective-1",
        feedbackEvidenceId: "evidence-objective-1",
        feedbackType: feedbackTypeValues.objectiveDefect,
        triageLabel: "objective_defect_candidate",
      },
      metadata: {
        feedbackReportId: "feedback-objective-1",
        feedbackEvidenceId: "evidence-objective-1",
        triageLabel: "objective_defect_candidate",
      },
    });
    expect(createItem.mock.calls[0]?.[1].payload).not.toHaveProperty("styleDisputeKey");
    expect(createItem.mock.calls[0]?.[1].metadata).not.toHaveProperty("styleDisputeKey");
  });

  it("does not enqueue duplicate imported feedback twice", async () => {
    const duplicateResult: ManualFeedbackImportResult = {
      ...manualFeedbackResultFixture,
      duplicate: true,
      reportCount: 2,
    };
    const importManualFeedback = vi
      .fn<[AuthorizationActor, ManualFeedbackImportInput], Promise<ManualFeedbackImportResult>>()
      .mockResolvedValueOnce(manualFeedbackResultFixture)
      .mockResolvedValueOnce(duplicateResult);
    const loadManualFeedbackReviewerQueueContext = vi.fn(async () => ({
      feedbackReportId: "feedback-1",
      feedbackEvidenceId: "evidence-1",
      projectId: "project-1",
      localeBranchId: "locale-1",
      sourceRevisionId: "source-revision-from-bundle",
      feedbackType: feedbackTypeValues.stylePreference,
      triageLabel: "style_dispute_candidate" as const,
      contextStatus: feedbackContextStatusValues.contextualized,
      reporterNote: "The protagonist sounds too formal here.",
      context: { lineReference: { bridgeUnitId: "unit-1" } },
      attachments: [],
      affectedArtifactIds: [],
    }));
    const createItem = vi.fn(
      async (_actor: AuthorizationActor, input: CreateReviewerQueueItemInput) =>
        reviewerQueueItemRecord(input),
    );
    const service = new ManualFeedbackImportService(
      { importManualFeedback, loadManualFeedbackReviewerQueueContext },
      { userId: "local-user" },
      { createItem },
    );

    const first = await service.importManualFeedback(manualFeedbackInputFixture());
    const second = await service.importManualFeedback(manualFeedbackInputFixture());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(createItem).toHaveBeenCalledTimes(1);
    expect(createItem.mock.calls[0]?.[1].sourceItemRef).toBe("feedback-1");
  });

  it("does not re-enqueue a legacy rejected feedback-kind style dispute", async () => {
    const importManualFeedback = vi.fn(async () => manualFeedbackResultFixture);
    const loadManualFeedbackReviewerQueueContext = vi.fn(async () => ({
      feedbackReportId: "feedback-legacy-style-1",
      feedbackEvidenceId: "evidence-legacy-style-1",
      projectId: "project-1",
      localeBranchId: "locale-1",
      sourceRevisionId: "source-revision-from-bundle",
      feedbackType: feedbackTypeValues.stylePreference,
      triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
      contextStatus: feedbackContextStatusValues.contextualized,
      reporterNote: "The protagonist sounds too formal here.",
      context: { lineReference: { bridgeUnitId: "unit-1" } },
      attachments: [],
      affectedArtifactIds: [],
    }));
    const legacyRejectedItem: ReviewerQueueItemRecord = {
      ...reviewerQueueItemRecord({
        projectId: "project-1",
        localeBranchId: "locale-1",
        sourceRevisionId: "source-revision-from-bundle",
        itemKind: reviewerQueueItemKindValues.feedback,
        sourceItemRef: "feedback-legacy-style-1",
        summary: "Manual feedback: legacy style dispute",
        payload: {
          feedbackReportId: "feedback-legacy-style-1",
          triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
        },
        metadata: {
          rejectionReason: "Existing style guide already covers this.",
          triageLabel: feedbackTriageLabelValues.styleDisputeCandidate,
        },
      }),
      state: reviewerQueueItemStateValues.rejected,
      resolvedAt: new Date("2026-06-17T00:00:00.000Z"),
    };
    const loadItemsByBranch = vi.fn(async () => [legacyRejectedItem]);
    const createItem = vi.fn(
      async (_actor: AuthorizationActor, input: CreateReviewerQueueItemInput) =>
        reviewerQueueItemRecord(input),
    );
    const service = new ManualFeedbackImportService(
      { importManualFeedback, loadManualFeedbackReviewerQueueContext },
      { userId: "local-user" },
      { createItem, loadItemsByBranch },
    );

    await service.importManualFeedback(manualFeedbackInputFixture());

    expect(loadItemsByBranch).toHaveBeenCalledWith({ userId: "local-user" }, "locale-1");
    expect(createItem).not.toHaveBeenCalled();
  });

  it("does not enqueue missing-context feedback", async () => {
    const importManualFeedback = vi.fn(async () => ({
      ...manualFeedbackResultFixture,
      triageLabel: "needs_context" as const,
      reportStatus: "needs_context" as const,
      contextStatus: feedbackContextStatusValues.needsContext,
    }));
    const loadManualFeedbackReviewerQueueContext = vi.fn(async () => null);
    const createItem = vi.fn(
      async (_actor: AuthorizationActor, input: CreateReviewerQueueItemInput) =>
        reviewerQueueItemRecord(input),
    );
    const service = new ManualFeedbackImportService(
      { importManualFeedback, loadManualFeedbackReviewerQueueContext },
      { userId: "local-user" },
      { createItem },
    );

    await service.importManualFeedback({
      ...manualFeedbackInputFixture(),
      lineReference: undefined,
      attachments: undefined,
    });

    expect(loadManualFeedbackReviewerQueueContext).not.toHaveBeenCalled();
    expect(createItem).not.toHaveBeenCalled();
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

  it("writes imported project JSON with bridge import status", async () => {
    const services = servicesFixture();
    const bridge = projectFixture().bridge;
    const reads = new Map<string, unknown>([["bridge.json", bridge]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["import", "--bridge", "bridge.json", "--project", "project.json"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.projectWorkflow.importBridge).toHaveBeenCalledWith(bridge);
    expect(writes.get("project.json")).toMatchObject({
      projectId: "project-1",
      importStatus: dashboardStatusFixture.importStatus,
    });
  });

  it("accepts v0.2 bridge input before calling the import service", async () => {
    const services = servicesFixture();
    const bridge = bridgeV02Fixture();
    const reads = new Map<string, unknown>([["bridge.json", bridge]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["import", "--bridge", "bridge.json", "--project", "project.json"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.projectWorkflow.importBridge).toHaveBeenCalledWith(bridge);
    expect(writes.get("project.json")).toMatchObject({
      projectId: "project-1",
      importStatus: dashboardStatusFixture.importStatus,
    });
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

  it("writes exact catalog external-id link results from fixture requests", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([
      ["catalog-link-request.json", exactLinkRequestFixture],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      [
        "catalog-link-exact",
        "--request",
        "catalog-link-request.json",
        "--output",
        "catalog-link-result.json",
      ],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(services.catalogExactExternalIdLinker.linkExactExternalIds).toHaveBeenCalledWith(
      exactLinkRequestFixture,
    );
    expect(writes.get("catalog-link-result.json")).toEqual(exactLinkResultFixture);
  });

  it.each([
    ["malformed object", { schemaVersion: catalogExactExternalIdLinkSchemaVersion }],
    ["null", null],
    ["array", []],
    ["scalar", "not-a-request"],
  ])(
    "writes structured exact-link invalid diagnostics for %s request payloads",
    async (_name, payload) => {
      const services = servicesFixture();
      const repository = {
        getWorkByExternalId: vi.fn(),
      };
      services.catalogExactExternalIdLinker = new ItotoriCatalogExactExternalIdLinkerService(
        repository,
        { userId: "local-user" },
      );
      const reads = new Map<string, unknown>([["catalog-link-request.json", payload]]);
      const writes = new Map<string, unknown>();

      await runItotoriCliCommand(
        [
          "catalog-link-exact",
          "--request",
          "catalog-link-request.json",
          "--output",
          "catalog-link-result.json",
        ],
        {
          io: jsonStoreFixture(reads, writes),
          migrateDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(services),
        },
      );

      expect(writes.get("catalog-link-result.json")).toMatchObject({
        status: catalogExactExternalIdLinkStatusValues.unsupported,
        subject: null,
        workId: null,
        matches: [],
        diagnostics: [
          expect.objectContaining({
            code: "catalog.exact_external_id.invalid_request",
            severity: "error",
          }),
        ],
      });
      expect(repository.getWorkByExternalId).not.toHaveBeenCalled();
    },
  );

  it("writes fuzzy catalog candidates from fixture requests", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([
      ["catalog-fuzzy-request.json", fuzzyCandidateRequestFixture],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      [
        "catalog-fuzzy-candidates",
        "--request",
        "catalog-fuzzy-request.json",
        "--output",
        "catalog-fuzzy-result.json",
      ],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(services.catalogFuzzyCandidateGenerator.generateFuzzyCandidates).toHaveBeenCalledWith(
      fuzzyCandidateRequestFixture,
    );
    expect(writes.get("catalog-fuzzy-result.json")).toEqual(fuzzyCandidateResultFixture);
  });

  it("writes structured fuzzy invalid diagnostics for malformed JSON input", async () => {
    const services = servicesFixture();
    const repository = {
      getWorkByExternalId: vi.fn(),
      listCatalogCandidateTargetWorks: vi.fn(),
      recordCatalogCandidateMatch: vi.fn(),
      listCatalogCandidateMatches: vi.fn(),
    };
    services.catalogFuzzyCandidateGenerator = new ItotoriCatalogFuzzyCandidateGeneratorService(
      repository,
      { userId: "local-user" },
    );
    const reads = new Map<string, unknown>([
      [
        "catalog-fuzzy-request.json",
        {
          schemaVersion: catalogFuzzyCandidateSchemaVersion,
          sourceFacts: [
            {
              catalogSource: "egs",
              sourceId: "egs-malformed-001",
              title: "Moonlight Refrain",
              externalIds: [null],
            },
          ],
        },
      ],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      [
        "catalog-fuzzy-candidates",
        "--request",
        "catalog-fuzzy-request.json",
        "--output",
        "catalog-fuzzy-result.json",
      ],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(writes.get("catalog-fuzzy-result.json")).toEqual(
      expect.objectContaining({
        status: catalogFuzzyCandidateStatusValues.invalid,
        candidates: [],
        diagnostics: [
          expect.objectContaining({
            code: catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
            field: "externalIds",
            reasonCode: "invalid_external_id",
          }),
        ],
      }),
    );
    expect(repository.listCatalogCandidateTargetWorks).not.toHaveBeenCalled();
    expect(repository.recordCatalogCandidateMatch).not.toHaveBeenCalled();
  });

  it("writes the combined catalog resolver fixture artifact without database services", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([
      ["fixtures/catalog-resolver/fixture.json", resolverFixture],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["catalog-resolve-fixture"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.catalogExactExternalIdLinker.linkExactExternalIds).not.toHaveBeenCalled();
    expect(services.catalogFuzzyCandidateGenerator.generateFuzzyCandidates).not.toHaveBeenCalled();
    expect(writes.get("artifacts/catalog/resolver-integration.json")).toMatchObject({
      schemaVersion: "catalog.resolver_fixture.v0.1",
      artifactId: "catalog-resolver-integration-001",
      review: {
        exactLinkIds: ["exact-link:dlsite:RJ349517", "exact-link:dlsite:rj-no-match"],
        exactLinkedWorkIds: ["work-dlsite"],
        fuzzyCandidateIds: ["candidate:egs-moonlight-001:work-moonlight-hd"],
        conflictIds: ["catalog-conflict:manual-duplicate-external-id"],
      },
      diagnostics: [
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.unsupportedSourcePayload,
        }),
        expect.objectContaining({
          code: "catalog.resolver_fixture.no_match",
          exactLinkId: "exact-link:dlsite:rj-no-match",
        }),
      ],
    });
  });

  it("invokes the batch planner CLI handler and writes the plan output", async () => {
    const services = servicesFixture();
    const project = projectFixture();
    const bridge = {
      ...project.bridge,
      units: [
        {
          bridgeUnitId: "bridge-unit-cli",
          sourceUnitKey: "cli.line.001",
          occurrenceId: "occ-cli",
          sourceHash: "hash-cli",
          sourceLocale: "ja-JP" as const,
          sourceText: "こんにちは",
          textSurface: "dialogue" as const,
          protectedSpans: [],
          patchRef: {
            assetId: "asset.json",
            writeMode: "replace" as const,
            sourceUnitKey: "cli.line.001",
          },
        },
      ],
    };
    const projectWithUnit = { ...project, bridge };
    const reads = new Map<string, unknown>([["project.json", projectWithUnit]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      [
        "plan-batches",
        "--project",
        "project.json",
        "--locale",
        "en-US",
        "--model",
        "cli-test-model",
        "--provider-id",
        "cli-test-provider",
        "--output",
        "plan.json",
        "--dry-run",
      ],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(services.batchPlanner.loadContext).toHaveBeenCalledTimes(1);
    expect(services.batchPlanner.persist).not.toHaveBeenCalled();
    const result = writes.get("plan.json") as {
      batches: unknown[];
      summary: { batchCount: number };
    };
    expect(result.summary.batchCount).toBe(1);
    expect(result.batches).toHaveLength(1);
  });

  it("runs the recorded style-guide fixture flow and writes the persisted summary", async () => {
    const services = servicesFixture();
    const fixture = styleGuideConversationFixture();
    const reads = new Map<string, unknown>([
      ["fixtures/itotori-style-guide/conversations/accepted.json", fixture],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["style-guide-fixture-flow"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.styleGuideFixtureFlow.run).toHaveBeenCalledWith({
      transcript: fixture,
      fixtureId: undefined,
    });
    expect(writes.get("artifacts/itotori/style-guide-fixture-flow.json")).toEqual(
      styleGuideFixtureFlowResult,
    );
  });

  it("emits a typed diagnostic and writes nothing when a fixture-flow rerun is rejected", async () => {
    const services = servicesFixture();
    const rerunError = new StyleGuideFixtureFlowRerunError({
      projectId: "019ed063-0000-7000-8000-000000000001",
      localeBranchId: "019ed063-0000-7000-8000-000000000010",
      fixtureId: "style-guide-conversation-accepted",
      existingLatestVersionId: "019ed063-0000-7000-8000-000000000030",
    });
    services.styleGuideFixtureFlow.run = vi.fn(async () => {
      throw rerunError;
    });
    const fixture = styleGuideConversationFixture();
    const reads = new Map<string, unknown>([
      ["fixtures/itotori-style-guide/conversations/accepted.json", fixture],
    ]);
    const writes = new Map<string, unknown>();

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const priorExitCode = process.exitCode;
    try {
      await runItotoriCliCommand(["style-guide-fixture-flow"], {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      });

      expect(process.exitCode).toBe(1);
      const emitted = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(emitted).toContain("rerun rejected");
      expect(emitted).toContain(rerunError.code);
      expect(emitted).toContain("019ed063-0000-7000-8000-000000000030");
      // No artifact is written when the rerun is rejected.
      expect(writes.has("artifacts/itotori/style-guide-fixture-flow.json")).toBe(false);
    } finally {
      stderr.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  async function loadAgenticLoopSmokeFixtures() {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "../../..");
    const bridgeJson = JSON.parse(
      readFileSync(
        resolve(repoRoot, "apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json"),
        "utf8",
      ),
    );
    const pairPolicyJson = JSON.parse(
      readFileSync(
        resolve(repoRoot, "apps/itotori/test/fixtures/agentic-loop-smoke-pair-policy.json"),
        "utf8",
      ),
    );
    const reads = new Map<string, unknown>([
      ["fixtures/agentic-loop-smoke-bridge.json", bridgeJson],
      ["fixtures/agentic-loop-smoke-pair-policy.json", pairPolicyJson],
    ]);
    return reads;
  }

  const AGENTIC_LOOP_SMOKE_ARGS = [
    "agentic-loop-smoke",
    "--bridge",
    "fixtures/agentic-loop-smoke-bridge.json",
    "--unit-index",
    "0",
    "--pair-policy",
    "fixtures/agentic-loop-smoke-pair-policy.json",
    "--output",
    "out/agentic-loop-bundle.json",
  ];

  it("agentic-loop-smoke refuses without the explicit ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT opt-in", async () => {
    const reads = await loadAgenticLoopSmokeFixtures();
    const writes = new Map<string, unknown>();
    const services = servicesFixture();
    const prior = process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT;
    delete process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT;
    try {
      await expect(
        runItotoriCliCommand(AGENTIC_LOOP_SMOKE_ARGS, {
          io: jsonStoreFixture(reads, writes),
          migrateDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(services),
        }),
      ).rejects.toThrow("ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1");
      // No fake-default: nothing is written when the opt-in is absent.
      expect(writes.has("out/agentic-loop-bundle.json")).toBe(false);
    } finally {
      if (prior === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT = prior;
      }
    }
  });

  it("agentic-loop-smoke uses the fake and writes an AgenticLoopBundle under the opt-in", async () => {
    const reads = await loadAgenticLoopSmokeFixtures();
    const writes = new Map<string, unknown>();
    const services = servicesFixture();
    const prior = process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT;
    process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT = "1";
    try {
      await runItotoriCliCommand(AGENTIC_LOOP_SMOKE_ARGS, {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      });
    } finally {
      if (prior === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT = prior;
      }
    }
    const written = writes.get("out/agentic-loop-bundle.json") as
      | { schemaVersion: string; stages: Array<{ stageName: string }> }
      | undefined;
    expect(written).toBeDefined();
    if (written === undefined) return;
    expect(written.schemaVersion).toBe("itotori.agentic-loop-bundle.v2");
    expect(written.stages.map((s) => s.stageName)).toEqual([
      "context",
      "pre_translation",
      "translation",
      "deterministic_checks",
      "qa_findings",
      "routing",
      "repair",
      "final_draft",
    ]);
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
      getDashboardDecisions: vi.fn(async () => dashboardDecisionsFixture),
      getCostReport: vi.fn(async () => costReportFixture),
      getBenchmarkReports: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => ({
        finalStatus: "hello_world_passed",
        runtimeRunId: "runtime-1",
        runtimeReportId: "runtime-1",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: null,
        textEventCount: 1,
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
        traceEvents: [],
        findings: [],
        artifacts: [],
        approximations: [],
        unsupportedCapabilities: [],
        limitations: [],
      })),
      importBridge: vi.fn(async (_bridge: BridgeBundle | BridgeBundleV02) => projectFixture()),
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
      ingestPatchResult: vi.fn(async (project: ProjectState) => ({
        project,
        result: {
          patchResultId: "019ed001-0000-7000-8000-000000000950",
          patchExportId: "019ed001-0000-7000-8000-000000000901",
          status: "passed",
          diagnostics: [],
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
    draftFeedbackBatch: {
      submitBatch: vi.fn(async () => ({
        batchId: "draft-feedback-batch-fixture",
        submittedCount: 0,
        items: [],
        repairCandidateReportIds: [],
        decisionQueueReportIds: [],
        affectedBridgeUnitIds: [],
      })),
    },
    catalogExactExternalIdLinker: {
      linkExactExternalIds: vi.fn(async () => exactLinkResultFixture),
    },
    catalogFuzzyCandidateGenerator: {
      generateFuzzyCandidates: vi.fn(async () => fuzzyCandidateResultFixture),
      listCatalogCandidateMatches: vi.fn(async () => fuzzyCandidateResultFixture.candidates),
    },
    styleGuideFixtureFlow: {
      run: vi.fn(async () => styleGuideFixtureFlowResult),
    },
    batchPlanner: {
      loadContext: vi.fn(async () => ({
        sourceRevisionId: "bridge-1:bundle-revision",
        glossary: [],
      })),
      persist: vi.fn(async () => {}),
    },
  };
}

function projectFixture(): ProjectState {
  return {
    projectId: "project-1",
    localeBranchId: "locale-1",
    targetLocale: "en-US",
    drafts: {},
    importStatus: dashboardStatusFixture.importStatus,
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

function bridgeV02Fixture(): BridgeBundleV02 {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/localization-bridge-schema/test/examples/bridge-v0.2.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as BridgeBundleV02;
}

const costReportFixture: ProjectCostReport = {
  projectId: "project-1",
  currency: "USD",
  runCount: 0,
  billedMicrosUsd: 0,
  zeroRunCount: 0,
  totalsByCostKind: (["billed", "zero"] as const).map((costKind) => ({
    costKind,
    runCount: 0,
    amountMicrosUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  })),
  recentRuns: [],
  translationMemoryReuse: {
    reuseEventCount: 0,
    appliedCount: 0,
    suggestedCount: 0,
    providerCallAvoidedCount: 0,
    estimatedPromptTokensSaved: 0,
    estimatedCompletionTokensSaved: 0,
    estimatedTotalTokensSaved: 0,
    estimatedCostUsdSaved: null,
    recentEvents: [],
  },
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
  selectedLocaleBranchId: null,
  currentStyleGuidePolicyVersionId: null,
  importStatus: {
    bridgeImportId: "bridge-import:project-1:bridge-1:revision-1",
    projectId: "project-1",
    bridgeId: "bridge-1",
    sourceBundleId: "bridge-1",
    sourceBundleHash: "hash-1",
    sourceBundleRevisionId: "revision-1",
    schemaVersion: "0.1.0",
    sourceLocale: "ja-JP",
    importedAt: "2026-06-17T00:00:00.000Z",
    unitCount: 1,
    assetCount: 1,
    sourceRevisionCount: 4,
    validationFailureCount: 0,
    units: { added: 1, updated: 0, removed: 0, unchanged: 0 },
    assets: { added: 1, updated: 0, removed: 0, unchanged: 0 },
    sourceRevisions: { added: 4, existing: 0 },
    futureReferences: {
      catalogWorkId: null,
      localCorpusEntryId: null,
      readinessProfileId: null,
      completenessStatusId: null,
    },
  },
  cost: costReportFixture,
  localeBranches: [],
};

const dashboardDecisionsFixture: DashboardDecisionReadModel = {
  projectId: "project-1",
  counts: {
    pendingDecisionCount: 0,
    projectFindingDecisionCount: 0,
    localeBranchFindingDecisionCount: 0,
    runtimeValidationDecisionCount: 0,
  },
  pendingDecisions: [],
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

function manualFeedbackInputFixture(
  overrides: Partial<ManualFeedbackImportInput> = {},
): ManualFeedbackImportInput {
  return {
    projectId: "project-1",
    localeBranchId: "locale-1",
    sourceBundleId: "source-bundle-1",
    targetLocale: "en-US",
    feedbackType: feedbackTypeValues.stylePreference,
    reporter: {
      role: "playtester",
      displayName: "Fixture tester",
      contact: "playtester@example.com",
    },
    reporterNote: "The protagonist sounds too formal here.",
    lineReference: {
      bridgeUnitId: "unit-1",
      sourceUnitKey: "scene.001",
    },
    attachments: [
      {
        attachmentKind: "screenshot",
        artifactId: "artifact-shot-1",
        uri: "private://captures/shot.png",
        evidenceTier: "E2",
      },
    ],
    ...overrides,
  };
}

function reviewerQueueItemRecord(input: CreateReviewerQueueItemInput): ReviewerQueueItemRecord {
  const createdAt = input.createdAt ?? new Date("2026-06-17T00:00:00.000Z");
  return {
    reviewItemId: "review-item-1",
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    itemKind: input.itemKind,
    sourceItemRef: input.sourceItemRef,
    state: reviewerQueueItemStateValues.pending,
    priority: input.priority ?? 0,
    summary: input.summary,
    affectedArtifactIds: input.affectedArtifactIds ?? [],
    evidenceTier: null,
    observationEventIds: null,
    artifactHashes: null,
    payload: input.payload ?? {},
    metadata: input.metadata ?? {},
    createdByUserId: input.createdByUserId ?? null,
    assignedToUserId: input.assignedToUserId ?? null,
    createdAt,
    updatedAt: createdAt,
    resolvedAt: null,
  };
}

const exactLinkRequestFixture: CatalogExactExternalIdLinkRequest = {
  schemaVersion: catalogExactExternalIdLinkSchemaVersion,
  subject: {
    kind: "fixture",
    id: "catalog-008-exact-match",
  },
  externalIds: [
    {
      catalogSource: "dlsite",
      sourceId: "RJ349517",
      externalIdKind: "store_product",
    },
  ],
};

const exactLinkResultFixture: CatalogExactExternalIdLinkResult = {
  schemaVersion: catalogExactExternalIdLinkSchemaVersion,
  status: catalogExactExternalIdLinkStatusValues.linked,
  subject: {
    kind: "fixture",
    id: "catalog-008-exact-match",
  },
  workId: "work-dlsite",
  matches: [
    {
      inputIndex: 0,
      catalogSource: "dlsite",
      sourceId: "RJ349517",
      externalIdKind: "store_product",
      workId: "work-dlsite",
      canonicalTitle: "DLsite-only fixture",
    },
  ],
  diagnostics: [],
};

const fuzzyCandidateRequestFixture: CatalogFuzzyCandidateRequest = {
  schemaVersion: catalogFuzzyCandidateSchemaVersion,
  sourceFacts: [
    {
      catalogSource: "egs",
      sourceId: "egs-777",
      title: "Moonlight Refrain",
      releaseYear: 2021,
    },
  ],
};

const fuzzyCandidateResultFixture: CatalogFuzzyCandidateResult = {
  schemaVersion: catalogFuzzyCandidateSchemaVersion,
  generatorVersion: "deterministic-title-year.v0.1",
  status: catalogFuzzyCandidateStatusValues.generated,
  candidates: [
    {
      candidateId: "candidate-1",
      sourceCatalogSource: "egs",
      sourceId: "egs-777",
      sourceTitle: "Moonlight Refrain",
      sourceProvenanceId: null,
      targetWorkId: "work-moonlight",
      score: 820,
      matchedFields: {},
      status: "review_pending",
      diagnosticCode: "catalog.fuzzy_candidate.generated",
      generatorVersion: "deterministic-title-year.v0.1",
      metadata: { autoMerge: false },
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    },
  ],
  diagnostics: [],
};

const resolverFixture: CatalogResolverFixtureInput = {
  schemaVersion: "catalog.resolver_fixture.v0.1",
  artifactId: "catalog-resolver-integration-001",
  generatedAt: "2026-06-18T18:00:00.000Z",
  sourceRegistry: [
    {
      sourceRegistryId: "source-registry:dlsite:RJ349517",
      catalogSource: "dlsite",
      sourceId: "RJ349517",
      sourceRecordKind: "recorded_fixture",
      payloadHash: "sha256:payload",
      provenanceHash: "sha256:provenance",
      payloadSchemaVersion: "catalog-source-fixture.v0.1",
      payloadShape: "catalog_source_record",
    },
    {
      sourceRegistryId: "source-registry:unsupported:legacy-payload",
      catalogSource: "steam",
      sourceId: "legacy-payload",
      sourceRecordKind: "recorded_fixture",
      payloadHash: "sha256:unsupported",
      provenanceHash: "sha256:unsupported-provenance",
      payloadSchemaVersion: "legacy-source.v0",
      payloadShape: "legacy_unstructured_dump",
    },
  ],
  exactLinks: [
    {
      exactLinkId: "exact-link:dlsite:RJ349517",
      result: exactLinkResultFixture,
    },
    {
      exactLinkId: "exact-link:dlsite:rj-no-match",
      result: {
        schemaVersion: catalogExactExternalIdLinkSchemaVersion,
        status: "no_match",
        subject: { kind: "fixture", id: "catalog-resolver-no-match" },
        workId: null,
        matches: [],
        diagnostics: [
          {
            code: "catalog.exact_external_id.no_match",
            severity: "info",
            message: "No catalog work has an exact external-id match.",
          },
        ],
      },
    },
  ],
  fuzzyCandidates: {
    ...fuzzyCandidateResultFixture,
    candidates: [
      {
        ...fuzzyCandidateResultFixture.candidates[0],
        candidateId: "candidate:egs-moonlight-001:work-moonlight-hd",
      },
    ],
  },
  conflicts: {
    rows: [
      {
        reviewId: "catalog-conflict:manual-duplicate-external-id",
        catalogRecordId: "work-conflict-a",
        conflictId: "manual-duplicate-external-id",
        candidateIds: [],
        candidateCatalogIds: ["work-conflict-a", "work-conflict-b"],
        exactLinkRefs: [],
        fuzzyScores: [],
        sourceIds: [{ catalogSource: "dlsite", sourceId: "RJCAT010" }],
        provenance: [],
        severity: "error",
        status: "open",
        reasonCode: "duplicate_external_id",
        reasonDetail: "Manual review required.",
        conflictKind: "external_id",
        detectedAt: new Date("2026-06-18T18:00:00.000Z"),
        resolution: null,
      },
    ],
  },
};

function styleGuideConversationFixture(): unknown {
  return JSON.parse(
    readFileSync(
      new URL("../../../fixtures/itotori-style-guide/conversations/accepted.json", import.meta.url),
      "utf8",
    ),
  );
}

const styleGuideFixtureFlowResult: StyleGuideFixtureFlowResult = {
  schemaVersion: styleGuideFixtureFlowSchemaVersion,
  fixtureId: "style-guide-conversation-accepted",
  projectId: "019ed063-0000-7000-8000-000000000001",
  localeBranchId: "019ed063-0000-7000-8000-000000000010",
  baseStyleGuideVersionId: "019ed063-0000-7000-8000-000000000020",
  projectedStyleGuideVersionId: "019ed063-0000-7000-8000-000000000030",
  suggestionArtifactId: "style-guide-suggestions:style-guide-conversation-accepted",
  acceptedProposalIds: [
    "019ed063-0000-7000-8000-000000000201",
    "019ed063-0000-7000-8000-000000000202",
    "019ed063-0000-7000-8000-000000000203",
    "019ed063-0000-7000-8000-000000000204",
    "019ed063-0000-7000-8000-000000000205",
  ],
  policyRuleCounts: {
    tone: 1,
    terminology: 1,
    honorifics: 1,
    formatting: 1,
    protectedSpans: 1,
  },
  dashboard: {
    selectedLocaleBranchId: "019ed063-0000-7000-8000-000000000010",
    currentStyleGuidePolicyVersionId: "019ed063-0000-7000-8000-000000000030",
    branchCount: 1,
    artifactCount: 3,
    localeBranches: [],
  },
  outbox: {
    styleGuideVersionChangedEventIds: ["event-1", "event-2", "event-3", "event-4"],
    affectedWorkInvalidatedEventIds: ["event-5", "event-6", "event-7", "event-8"],
    affectedSurfaces: ["drafts", "qa_findings", "exports", "benchmarks"],
  },
};
