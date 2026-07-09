// ITOTORI-040 — localization workspace read-model service tests.
//
// Deterministic: an in-memory `LocalizationWorkspaceReadPort` stands in
// for the DB-backed repositories. The tests prove the workspace composes
// existing read-models, scopes strictly to a single locale branch (never
// conflating ITOTORI-059 branches), surfaces translated scene summaries
// for no-source-language navigation, projects source/draft/final from the
// reviewer detail read-model, and refuses to surface opaque search hits.

import { describe, expect, it } from "vitest";
import type {
  AssetDecisionRecord,
  BridgeUnitTextRecord,
  CandidateAssetRecord,
  JobsRunTableReadModel,
  LoadSceneSummariesQuery,
  LocaleBranchIdentity,
  ProjectDashboardStatus,
  SceneSummaryRecord,
  SearchExactInput,
  SearchExactToolResult,
  TerminologySearchInput,
  TerminologySearchReadModel,
} from "@itotori/db";
import {
  LocalizationWorkspaceApiService,
  workspaceDiagnosticCodeValues,
  type LocalizationWorkspaceReadPort,
  type WorkspacePermissionView,
} from "../src/workspace/index.js";
import { readyContextFixture, staleContextFixture } from "../src/reviewer/index.js";
import type {
  ReviewerDetailContext,
  ReviewerQueueDashboardReadModel,
} from "../src/reviewer/index.js";

const PROJECT_ID = "project-itotori-040";
const BRANCH_ID = "locale-branch-en";
const OTHER_BRANCH_ID = "locale-branch-fr";
const SOURCE_REVISION_ID = "source-revision-1";
const NOW = new Date("2026-06-26T00:00:00Z");

function permission(overrides: Partial<WorkspacePermissionView> = {}): WorkspacePermissionView {
  return {
    actorUserId: "local-user",
    canReadQueue: true,
    canManageQueue: false,
    denialReasons: [],
    ...overrides,
  };
}

function dashboardStatus(): ProjectDashboardStatus {
  return {
    projectId: PROJECT_ID,
    projectKey: "sweetie-hd",
    name: "Oshioki Sweetie HD",
    status: "drafting",
    sourceLocale: "ja-JP",
    sourceBundleId: "source-bundle-1",
    sourceBundleHash: "sha256:bundle",
    sourceBundleRevisionId: SOURCE_REVISION_ID,
    branchCount: 2,
    unitCount: 42,
    findingCount: 3,
    artifactCount: 5,
    latestEventKind: null,
    latestEventAt: null,
    selectedLocaleBranchId: BRANCH_ID,
    currentStyleGuidePolicyVersionId: "style-guide-version-1",
    importStatus: {
      projectId: PROJECT_ID,
      status: "imported",
      sourceBundleId: "source-bundle-1",
      sourceBundleHash: "sha256:bundle",
      sourceRevisionId: SOURCE_REVISION_ID,
      addedUnitCount: 42,
      changedUnitCount: 0,
      removedUnitCount: 0,
      unitCount: 42,
      addedAssetCount: 1,
      changedAssetCount: 0,
      removedAssetCount: 0,
      assetCount: 1,
      futureReferenceCount: 0,
      importedAt: NOW.toISOString(),
    },
    cost: {
      projectId: PROJECT_ID,
      currency: "USD",
      totalAmountMicrosUsd: 0,
      entryCount: 0,
      byStage: [],
      byModel: [],
    },
    localeBranches: [
      {
        localeBranchId: BRANCH_ID,
        targetLocale: "en-US",
        status: "drafting",
        currentStyleGuidePolicyVersionId: "style-guide-version-1",
        unitCount: 42,
        translatedUnitCount: 18,
        openFindingCount: 3,
        artifactCount: 5,
      },
      {
        localeBranchId: OTHER_BRANCH_ID,
        targetLocale: "fr-FR",
        status: "drafting",
        currentStyleGuidePolicyVersionId: null,
        unitCount: 42,
        translatedUnitCount: 4,
        openFindingCount: 0,
        artifactCount: 1,
      },
    ],
  };
}

function localeBranchIdentities(): LocaleBranchIdentity[] {
  return [
    {
      localeBranchId: BRANCH_ID,
      projectId: PROJECT_ID,
      sourceBundleId: "source-bundle-1",
      sourceBundleRevisionId: SOURCE_REVISION_ID,
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      branchName: "English (informal)",
      status: "drafting",
    },
    {
      localeBranchId: OTHER_BRANCH_ID,
      projectId: PROJECT_ID,
      sourceBundleId: "source-bundle-1",
      sourceBundleRevisionId: SOURCE_REVISION_ID,
      sourceLocale: "ja-JP",
      targetLocale: "fr-FR",
      branchName: "French",
      status: "drafting",
    },
  ];
}

function sceneSummary(overrides: Partial<SceneSummaryRecord> = {}): SceneSummaryRecord {
  return {
    sceneSummaryId: "scene-summary-1",
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    sceneId: "scene.001",
    summaryLocale: "en-US",
    summaryText: "The heroine greets the protagonist at the school gate.",
    modelProviderFamily: "fake",
    modelId: "itotori-fake-scene-summary-v0",
    modelContextWindowTokens: 16000,
    modelMaxOutputTokens: null,
    promptTemplateVersion: "v1",
    promptHash: "sha256:prompt",
    inputTokenEstimate: 0,
    completionTokens: 0,
    status: "Fresh",
    invalidatedAt: null,
    invalidatedReason: null,
    generatedAt: NOW,
    createdAt: NOW,
    citations: [{ bridgeUnitId: "bridge-unit-1", citedSourceHash: "sha256:u1", citeOrdinal: 0 }],
    ...overrides,
  };
}

function bridgeUnit(): BridgeUnitTextRecord {
  return {
    bridgeUnitId: "bridge-unit-1",
    sourceUnitKey: "scene.001.line.001",
    sourceText: "こんにちは、世界。",
    sourceHash: "sha256:u1",
    speaker: "Heroine",
    occurrenceId: "occurrence-1",
  };
}

function exactResult(localeBranchId = BRANCH_ID): SearchExactToolResult {
  return {
    status: "completed",
    toolName: "search_exact",
    toolVersion: "1.0.0",
    projectId: PROJECT_ID,
    localeBranchId,
    sourceRevisionId: SOURCE_REVISION_ID,
    query: "世界",
    normalizedQuery: "世界",
    matches: [
      {
        searchDocumentId: "search-doc-1",
        projectId: PROJECT_ID,
        localeBranchId,
        sourceRevisionId: SOURCE_REVISION_ID,
        sourceArtifactType: "source_unit",
        sourceArtifactId: "bridge-unit-1",
        exactTerm: "世界",
        normalizedExactTerm: "世界",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        provenance: {
          toolName: "search_exact",
          toolVersion: "1.0.0",
          searchDocumentId: "search-doc-1",
          sourceArtifactType: "source_unit",
          sourceArtifactId: "bridge-unit-1",
          sourceRevisionId: SOURCE_REVISION_ID,
          bridgeUnitId: "bridge-unit-1",
        },
        refreshedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    diagnostics: [],
  };
}

function terminologyResult(opts: {
  withBridgeUnit: boolean;
  localeBranchId?: string;
}): TerminologySearchReadModel {
  const localeBranchId = opts.localeBranchId ?? BRANCH_ID;
  return {
    query: "世界",
    normalizedQuery: "世界",
    localeBranchId,
    results: [
      {
        score: 0.9,
        matchKinds: ["exact_source"],
        term: {
          termId: "term-1",
          projectId: PROJECT_ID,
          localeBranchId,
          sourceTerm: "世界",
          normalizedSourceTerm: "世界",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          preferredTranslation: "world",
          normalizedPreferredTranslation: "world",
          termKind: "noun",
          partOfSpeech: null,
          status: "approved",
          caseSensitive: false,
          notes: null,
          metadata: {},
          createdByUserId: null,
          createdAt: NOW,
          updatedAt: NOW,
          aliases: [],
          sourceReferences: opts.withBridgeUnit
            ? [
                {
                  sourceRefId: "source-ref-1",
                  termId: "term-1",
                  sourceRevisionId: SOURCE_REVISION_ID,
                  bridgeUnitId: "bridge-unit-1",
                  sourceProvenanceId: null,
                  referenceKind: "definition",
                  citation: "scene.001.line.001",
                  context: null,
                  metadata: {},
                  createdAt: NOW,
                },
              ]
            : [],
          semanticIndex: null,
        },
      },
    ],
  };
}

function runTable(): JobsRunTableReadModel {
  return {
    schemaVersion: "jobs.run_table.v0.1",
    generatedAt: NOW.toISOString(),
    filter: { projectId: PROJECT_ID },
    pagination: {
      total: 1,
      limit: 25,
      offset: 0,
      page: 1,
      pageCount: 1,
      hasMore: false,
      nextOffset: null,
    },
    rows: [
      {
        runId: "run-draft-1",
        ledgerEntryId: "ledger-run-1",
        draftJobId: "draft-job-1",
        draftJobAttemptId: "draft-job-attempt-1",
        providerRunId: "provider-run-1",
        jobId: "job-1",
        projectId: PROJECT_ID,
        localeBranchId: BRANCH_ID,
        task: "draft scene greeting",
        status: "succeeded",
        servedModel: "model-fixture",
        servedProvider: "provider-fixture",
        zdr: true,
        cost: { unit: "USD", amount: "0.000001" },
        tokens: { in: 10, out: 5, total: 15 },
        fallback: { used: false, plan: [], chain: [] },
        createdAt: NOW.toISOString(),
      },
    ],
  };
}

function reviewerDashboard(): ReviewerQueueDashboardReadModel {
  return {
    schemaVersion: "reviewer.queue_dashboard.v0.1",
    localeBranchId: BRANCH_ID,
    generatedAt: NOW,
    permission: permission(),
    rows: [
      {
        reviewItemId: "reviewer-queue-finding-1",
        projectId: PROJECT_ID,
        localeBranchId: BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        itemKind: "qa",
        sourceItemRef: "bridge-unit-1",
        summary: "Major semantic drift in the greeting line",
        priority: 10,
        state: "pending",
        dashboardState: "pending",
        lastAction: null,
        batchActionId: null,
        findingId: "finding-semantic-drift-1",
        decisionId: null,
        detailPath: "/reviewer/queue/reviewer-queue-finding-1/detail",
        selectedForBatch: false,
        createdAt: NOW,
        updatedAt: NOW,
        resolvedAt: null,
      },
    ],
    aggregate: {
      pending: 1,
      resolved: 0,
      deferred: 0,
      escalated: 0,
      batch_applied: 0,
    },
    defaultBatchRequest: {
      action: "approve",
      actorUserId: "local-user",
      selections: [],
    },
  };
}

type StubOverrides = Partial<LocalizationWorkspaceReadPort>;

function makeService(overrides: StubOverrides = {}): LocalizationWorkspaceApiService {
  const readPort: LocalizationWorkspaceReadPort = {
    getDashboardStatus: async () => dashboardStatus(),
    listLocaleBranchIdentities: async () => localeBranchIdentities(),
    loadSceneSummaries: async (_query: LoadSceneSummariesQuery) => [sceneSummary()],
    loadBridgeUnitsForSummary: async () => new Map([["bridge-unit-1", bridgeUnit()]]),
    loadActiveAssetDecisions: async (): Promise<AssetDecisionRecord[]> => [],
    loadCandidateAssets: async (): Promise<CandidateAssetRecord[]> => [
      {
        assetRef: { kind: "bridgeAssetRef", ref: "asset-image-1" },
        assetKind: "ui_art",
        displayLabel: "cg/title.png",
      },
    ],
    searchExact: async (_input: SearchExactInput) => exactResult(),
    searchTerminology: async (_input: TerminologySearchInput) =>
      terminologyResult({ withBridgeUnit: true }),
    loadRunTable: async () => runTable(),
    loadReviewerDashboard: async ({ permission: view }) => ({
      ...reviewerDashboard(),
      permission: view,
    }),
    loadComparisonContext: async () => readyContextFixture(),
    ...overrides,
  };
  return new LocalizationWorkspaceApiService({ readPort, now: () => NOW });
}

describe("LocalizationWorkspaceApiService.loadProjectBrowse", () => {
  it("composes dashboard status + locale-branch identity into a project tree", async () => {
    const model = await makeService().loadProjectBrowse({ permission: permission() });
    expect(model.schemaVersion).toBe("workspace.project_browse.v0.1");
    expect(model.projects).toHaveLength(1);
    const branches = model.projects[0]!.localeBranches;
    expect(branches.map((branch) => branch.localeBranchId)).toEqual([BRANCH_ID, OTHER_BRANCH_ID]);
    // ITOTORI-059: branches that share a project keep distinct names/locales.
    expect(branches[0]!.branchName).toBe("English (informal)");
    expect(branches[1]!.branchName).toBe("French");
    expect(branches[0]!.targetLocale).toBe("en-US");
    expect(branches[1]!.targetLocale).toBe("fr-FR");
    expect(branches[0]!.sceneBrowsePath).toContain(encodeURIComponent(BRANCH_ID));
  });

  it("emits an unresolved-identity diagnostic and drops a status-present branch whose identity fails to resolve", async () => {
    // Only the primary branch has an identity; OTHER_BRANCH_ID is present in
    // dashboard status but missing from the identity list — a REQUIRED
    // identity that fails to resolve must never be substituted by the raw
    // branch id / project source locale.
    const service = makeService({
      listLocaleBranchIdentities: async () => [localeBranchIdentities()[0]!],
    });
    const model = await service.loadProjectBrowse({ permission: permission() });
    const branches = model.projects[0]!.localeBranches;
    // The unresolvable branch is dropped, not fabricated with a raw-id name.
    expect(branches.map((branch) => branch.localeBranchId)).toEqual([BRANCH_ID]);
    expect(branches.some((branch) => branch.branchName === OTHER_BRANCH_ID)).toBe(false);
    expect(
      model.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === workspaceDiagnosticCodeValues.unresolvedLocaleBranchIdentity,
      ),
    ).toBe(true);
  });

  it("does not emit an unresolved-identity diagnostic when every status branch resolves (legitimate case)", async () => {
    const model = await makeService().loadProjectBrowse({ permission: permission() });
    expect(
      model.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === workspaceDiagnosticCodeValues.unresolvedLocaleBranchIdentity,
      ),
    ).toBe(false);
    // Identity resolved → real branch name + source locale, never fabricated.
    expect(model.projects[0]!.localeBranches[0]!.branchName).toBe("English (informal)");
    expect(model.projects[0]!.localeBranches[0]!.sourceLocale).toBe("ja-JP");
  });

  it("returns a permission-denied diagnostic and never touches the read port", async () => {
    let touched = false;
    const service = makeService({
      getDashboardStatus: async () => {
        touched = true;
        return dashboardStatus();
      },
    });
    const model = await service.loadProjectBrowse({
      permission: permission({ canReadQueue: false }),
    });
    expect(touched).toBe(false);
    expect(model.projects).toHaveLength(0);
    expect(model.diagnostics[0]!.code).toBe(workspaceDiagnosticCodeValues.permissionDenied);
  });
});

describe("LocalizationWorkspaceApiService.loadSceneBrowse", () => {
  it("surfaces the translated summary and cited units for no-source-language navigation", async () => {
    const model = await makeService().loadSceneBrowse({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      permission: permission(),
    });
    expect(model.scenes).toHaveLength(1);
    const scene = model.scenes[0]!;
    expect(scene.summaryLocale).toBe("en-US");
    expect(scene.summaryText).toContain("heroine greets");
    expect(scene.stale).toBe(false);
    expect(scene.units[0]!.sourceUnitKey).toBe("scene.001.line.001");
    expect(scene.units[0]!.speaker).toBe("Heroine");
  });

  it("drops summaries from other locale branches and records a conflation guard diagnostic", async () => {
    const service = makeService({
      loadSceneSummaries: async () => [
        sceneSummary(),
        sceneSummary({
          sceneSummaryId: "scene-summary-other",
          sceneId: "scene.002",
          localeBranchId: OTHER_BRANCH_ID,
        }),
      ],
    });
    const model = await service.loadSceneBrowse({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      permission: permission(),
    });
    expect(model.scenes.map((scene) => scene.sceneId)).toEqual(["scene.001"]);
    expect(
      model.diagnostics.some(
        (diagnostic) => diagnostic.code === workspaceDiagnosticCodeValues.branchConflationGuard,
      ),
    ).toBe(true);
  });

  it("emits an unresolved-cited-unit diagnostic and never fabricates identity for a cited bridge unit that fails to resolve", async () => {
    // The summary cites bridge-unit-1 but the unit lookup returns nothing:
    // its REQUIRED identity (sourceUnitKey / occurrenceId) must never be
    // substituted with the raw bridgeUnitId and marked cited:true.
    const service = makeService({
      loadBridgeUnitsForSummary: async () => new Map<string, BridgeUnitTextRecord>(),
    });
    const model = await service.loadSceneBrowse({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      permission: permission(),
    });
    const scene = model.scenes[0]!;
    // No fabricated citation survives: the raw-id unit is dropped, not surfaced.
    expect(scene.units).toHaveLength(0);
    expect(scene.citedUnitCount).toBe(0);
    expect(
      scene.units.some(
        (unit) => unit.sourceUnitKey === "bridge-unit-1" || unit.occurrenceId === "bridge-unit-1",
      ),
    ).toBe(false);
    expect(
      model.diagnostics.some(
        (diagnostic) => diagnostic.code === workspaceDiagnosticCodeValues.unresolvedCitedUnit,
      ),
    ).toBe(true);
  });

  it("does not emit an unresolved-cited-unit diagnostic when a resolved unit has a legitimately-absent speaker", async () => {
    const service = makeService({
      loadBridgeUnitsForSummary: async () =>
        new Map<string, BridgeUnitTextRecord>([
          ["bridge-unit-1", { ...bridgeUnit(), speaker: null }],
        ]),
    });
    const model = await service.loadSceneBrowse({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      permission: permission(),
    });
    const scene = model.scenes[0]!;
    // Identity resolved; speaker legitimately null → real key, no false diagnostic.
    expect(scene.units).toHaveLength(1);
    expect(scene.units[0]!.sourceUnitKey).toBe("scene.001.line.001");
    expect(scene.units[0]!.speaker).toBeNull();
    expect(
      model.diagnostics.some(
        (diagnostic) => diagnostic.code === workspaceDiagnosticCodeValues.unresolvedCitedUnit,
      ),
    ).toBe(false);
  });

  it("flags a stale scene summary", async () => {
    const service = makeService({
      loadSceneSummaries: async () => [sceneSummary({ status: "Stale" })],
    });
    const model = await service.loadSceneBrowse({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      permission: permission(),
    });
    expect(model.scenes[0]!.stale).toBe(true);
    expect(
      model.diagnostics.some(
        (diagnostic) => diagnostic.code === workspaceDiagnosticCodeValues.staleSceneSummary,
      ),
    ).toBe(true);
  });
});

describe("LocalizationWorkspaceApiService.loadAssetBrowse", () => {
  it("merges candidate assets with active decisions", async () => {
    const decision: AssetDecisionRecord = {
      decisionId: "asset-decision-1",
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      assetRef: { kind: "bridgeAssetRef", ref: "asset-image-1" },
      assetKind: "ui_art",
      decisionPolicy: "localize",
      decisionRationale: "Burned-in source text.",
      decidedByUserId: "local-user",
      decidedAt: NOW,
      supersededAt: null,
      supersededByDecisionId: null,
      createdAt: NOW,
    };
    const service = makeService({ loadActiveAssetDecisions: async () => [decision] });
    const model = await service.loadAssetBrowse({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      permission: permission(),
    });
    expect(model.assets).toHaveLength(1);
    expect(model.assets[0]!.decided).toBe(true);
    expect(model.assets[0]!.decisionPolicy).toBe("localize");
  });
});

describe("LocalizationWorkspaceApiService.loadComparison", () => {
  it("projects source / draft / final cells + runtime evidence from reviewer detail", async () => {
    const model = await makeService().loadComparison({
      reviewItemId: "reviewer-queue-1",
      permission: permission(),
    });
    expect(model.cells.map((cell) => cell.side)).toEqual(["source", "draft"]);
    expect(model.hasFinal).toBe(false);
    expect(model.runtimeEvidenceLinks.length).toBeGreaterThan(0);
    expect(model.runtimeEvidenceLinks[0]!.providerProofRefs[0]).toContain("provider:");
  });

  it("renders a final cell when the reviewer draft carries an approved patch", async () => {
    const context: ReviewerDetailContext = readyContextFixture({
      draft: {
        draftId: "draft-1",
        draftAttemptId: "draft-attempt-1",
        targetLocale: "en-US",
        draftText: "Hello, world.",
        approvedPatchText: "Hello there, world!",
        draftStatus: "accepted",
        attemptCount: 1,
      },
    });
    const service = makeService({ loadComparisonContext: async () => context });
    const model = await service.loadComparison({
      reviewItemId: "reviewer-queue-1",
      permission: permission(),
    });
    expect(model.cells.map((cell) => cell.side)).toEqual(["source", "draft", "final"]);
    expect(model.hasFinal).toBe(true);
    expect(model.cells[2]!.text).toBe("Hello there, world!");
  });

  it("carries the stale-source diagnostic from the reviewer detail read-model", async () => {
    const service = makeService({ loadComparisonContext: async () => staleContextFixture() });
    const model = await service.loadComparison({
      reviewItemId: "reviewer-queue-1",
      permission: permission(),
    });
    expect(
      model.diagnostics.some(
        (diagnostic) => diagnostic.code === workspaceDiagnosticCodeValues.comparisonUnavailable,
      ),
    ).toBe(true);
  });
});

describe("LocalizationWorkspaceApiService.loadSearch", () => {
  it("cites source artifact id, locale branch id, and bridge unit ref on every hit", async () => {
    const model = await makeService().loadSearch({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      query: "世界",
      canReadCatalog: true,
      permission: permission(),
    });
    expect(model.results.length).toBeGreaterThanOrEqual(2);
    for (const result of model.results) {
      expect(result.localeBranchId).toBe(BRANCH_ID);
      expect(result.sourceArtifactId.length).toBeGreaterThan(0);
      expect(result.bridgeUnitRef.length).toBeGreaterThan(0);
    }
    expect(model.results.some((result) => result.matchKind === "exact")).toBe(true);
    expect(model.results.some((result) => result.matchKind === "terminology")).toBe(true);
    expect(model.droppedOpaqueCount).toBe(0);
  });

  it("builds a unified palette index across scenes, units, characters, terms, runs, findings, and actions", async () => {
    const model = await makeService().loadSearch({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      query: "",
      canReadCatalog: true,
      permission: permission({ canManageQueue: true }),
    });
    expect(new Set(model.results.map((result) => result.resultKind))).toEqual(
      new Set(["scene", "unit", "character", "term", "run", "finding", "action"]),
    );
    expect(model.results.find((result) => result.resultKind === "scene")?.title).toBe("scene.001");
    expect(model.results.find((result) => result.resultKind === "character")?.title).toBe(
      "Heroine",
    );
    expect(model.results.find((result) => result.resultKind === "run")?.id).toBe("run-draft-1");
    expect(model.results.find((result) => result.resultKind === "finding")?.id).toBe(
      "finding-semantic-drift-1",
    );
  });

  it("omits run-table hits for queue.read-only callers without leaking run identifiers", async () => {
    let runTableLoaded = false;
    const service = makeService({
      loadRunTable: async () => {
        runTableLoaded = true;
        return runTable();
      },
    });

    const model = await service.loadSearch({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      query: "",
      canReadCatalog: false,
      permission: permission({ canManageQueue: true }),
    });

    expect(runTableLoaded).toBe(false);
    expect(model.results.some((result) => result.resultKind === "run")).toBe(false);
    expect(new Set(model.results.map((result) => result.resultKind))).toEqual(
      new Set(["scene", "unit", "character", "term", "finding", "action"]),
    );
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("provider-run-1");
    expect(serialized).not.toContain("run-draft-1");
  });

  it("returns an offset-paginated search page", async () => {
    const model = await makeService().loadSearch({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      query: "",
      limit: 3,
      offset: 3,
      canReadCatalog: true,
      permission: permission(),
    });
    expect(model.results).toHaveLength(3);
    expect(model.pagination).toMatchObject({
      total: expect.any(Number),
      limit: 3,
      offset: 3,
      page: 2,
      hasMore: true,
      nextOffset: 6,
    });
  });

  it("drops opaque terminology hits without a bridge-unit citation", async () => {
    const service = makeService({
      searchTerminology: async () => terminologyResult({ withBridgeUnit: false }),
    });
    const model = await service.loadSearch({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      query: "世界",
      mode: "terminology",
      canReadCatalog: true,
      permission: permission(),
    });
    expect(model.results).toHaveLength(0);
    expect(model.droppedOpaqueCount).toBe(1);
    expect(
      model.diagnostics.some(
        (diagnostic) => diagnostic.code === workspaceDiagnosticCodeValues.opaqueSearchResultDropped,
      ),
    ).toBe(true);
  });

  it("guards against conflating an exact match from another locale branch", async () => {
    const service = makeService({
      searchExact: async () => exactResult(OTHER_BRANCH_ID),
      searchTerminology: async () => terminologyResult({ withBridgeUnit: true }),
    });
    const model = await service.loadSearch({
      projectId: PROJECT_ID,
      localeBranchId: BRANCH_ID,
      query: "世界",
      mode: "exact",
      canReadCatalog: true,
      permission: permission(),
    });
    expect(model.results).toHaveLength(0);
    expect(
      model.diagnostics.some(
        (diagnostic) => diagnostic.code === workspaceDiagnosticCodeValues.branchConflationGuard,
      ),
    ).toBe(true);
  });
});
