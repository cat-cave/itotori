import { readFileSync } from "node:fs";
import {
  AuthorizationError,
  localUserId,
  permissionValues,
  type AuthorizationActor,
  type CostDrilldownPage,
  type DashboardDecisionReadModel,
  type ItotoriModelLedgerRepositoryPort,
  type ItotoriProjectRecord,
  type ItotoriProjectRepositoryPort,
  type ProjectCostReport,
  type ProjectDashboardStatus,
  type RuntimeDashboardStatus,
} from "@itotori/db";
import type {
  BenchmarkReportV02,
  BridgeBundle,
  BridgeBundleV02,
  RuntimeVerificationReport,
} from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import {
  ItotoriProjectWorkflowService,
  type ItotoriProjectWorkflowPort,
  type ProjectState,
} from "../src/services/project-workflow.js";
import { ITOTORI_API_ROUTE_IDS } from "../src/api-contract.js";

const actor: AuthorizationActor = { userId: localUserId };

describe("ItotoriProjectWorkflowService", () => {
  it("does not expose the retired projects.draft route or draftProject method", () => {
    // The dead refusal-only projects.draft route (branches.draft HTTP +
    // CLI `draft`) was retired — real drafting is done by the
    // localize-fullproject driver. This test proves the retire is complete:
    // the route id is gone from the API contract, and the draftProject method
    // is gone from the workflow port (type-level @ts-expect-error).
    expect(ITOTORI_API_ROUTE_IDS).not.toContain("branches.draft");
    // @ts-expect-error — draftProject was removed from the port; the
    // property access is a type error, proving the method is gone.
    void ({} as ItotoriProjectWorkflowPort).draftProject;
  });

  it("imports source bundles through the repository boundary", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);

    const project = await service.importBridge(bridgeFixture());

    expect(project).toMatchObject({
      projectId: "019ed000-0000-7000-8000-project00001",
      localeBranchId: "019ed000-0000-7000-8000-locale000001",
      targetLocale: "en-US",
      drafts: {},
      importStatus: importStatusFixture,
    });
    expect(repository.importSourceBundle).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        projectId: "019ed000-0000-7000-8000-project00001",
        localeBranchId: "019ed000-0000-7000-8000-locale000001",
        targetLocale: "en-US",
        drafts: {},
      }),
    );
  });

  it("threads the workflow actor into the ledger cost read and propagates a denial (defense in depth)", async () => {
    const repository = repositoryFixture();
    // A ledger that only serves the cost report to an actor holding the
    // catalog.read gate — mirrors the real repository-layer permission
    // check that lives where the data is read.
    const gatedLedger: ItotoriModelLedgerRepositoryPort = {
      recordProviderRun: vi.fn(async () => costReportFixture.recentRuns[0]!),
      getProjectCostReport: vi.fn(async (readActor: AuthorizationActor) => {
        if (readActor.userId !== actor.userId) {
          throw new AuthorizationError(readActor, permissionValues.catalogRead);
        }
        return costReportFixture;
      }),
      getCostLedgerDrilldown: vi.fn(async () => emptyDrilldownPageFixture()),
    };

    const authorizedService = new ItotoriProjectWorkflowService(repository, actor, gatedLedger);
    await expect(authorizedService.getCostReport("project-test")).resolves.toMatchObject({
      projectId: costReportFixture.projectId,
    });
    expect(gatedLedger.getProjectCostReport).toHaveBeenCalledWith(actor, "project-test");

    // An internal caller running as an unprivileged actor is rejected at
    // the read site, not silently served the ledger internals.
    const unprivilegedService = new ItotoriProjectWorkflowService(
      repository,
      { userId: "workflow-actor-without-catalog-read" },
      gatedLedger,
    );
    await expect(unprivilegedService.getCostReport("project-test")).rejects.toMatchObject({
      name: "AuthorizationError",
      permission: permissionValues.catalogRead,
    });
  });

  it("threads the workflow actor into the runtime status read and propagates a denial (defense in depth)", async () => {
    // A repository that only serves the runtime evidence report to an actor
    // holding the catalog.read gate — mirrors the real repository-layer
    // permission check that lives where the data is read.
    const gatedRuntimeRead = vi.fn(
      async (readActor: AuthorizationActor, _runtimeRunId?: string) => {
        if (readActor.userId !== actor.userId) {
          throw new AuthorizationError(readActor, permissionValues.catalogRead);
        }
        return runtimeStatusFixture;
      },
    );
    const gatedRepository: ItotoriProjectRepositoryPort = {
      ...repositoryFixture(),
      getRuntimeStatus: gatedRuntimeRead,
    };

    const authorizedService = new ItotoriProjectWorkflowService(gatedRepository, actor);
    await expect(authorizedService.getRuntimeStatus("runtime-1")).resolves.toMatchObject({
      runtimeRunId: runtimeStatusFixture.runtimeRunId,
    });
    expect(gatedRuntimeRead).toHaveBeenCalledWith(actor, "runtime-1");

    // An internal caller running as an unprivileged actor is rejected at the
    // read site, not silently served the evidence-text previews / finding
    // free text / artifact URIs.
    const unprivilegedService = new ItotoriProjectWorkflowService(gatedRepository, {
      userId: "workflow-actor-without-catalog-read",
    });
    await expect(unprivilegedService.getRuntimeStatus("runtime-1")).rejects.toMatchObject({
      name: "AuthorizationError",
      permission: permissionValues.catalogRead,
    });
  });

  it("validates protected spans before writing patch exports", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);

    await expect(
      service.exportPatch(projectFixture({ drafts: { "bridge-unit-test": "Hello." } })),
    ).rejects.toThrow("protected-span-missing bridge-unit-test");

    expect(repository.recordFinding).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        finding: expect.objectContaining({
          findingKind: "protected_span_issue",
          qualityCategory: "protected_content",
          description: expect.stringContaining("Repair hint: Restore protected span {player}"),
        }),
        status: "open",
      }),
    );
    expect(repository.savePatchExport).not.toHaveBeenCalled();
  });

  it("runs deterministic QA before rejecting unsupported v0.2 patch exports", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const bridge = bridgeV02Fixture();
    bridge.units = [bridge.units[0]!];

    await expect(
      service.exportPatch(
        projectFixture({
          bridge,
          drafts: { "019ed001-0000-7000-8000-000000000201": "Bonjour." },
        }),
      ),
    ).rejects.toThrow("protected-span-missing 019ed001-0000-7000-8000-000000000201");

    expect(repository.recordFinding).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        finding: expect.objectContaining({
          findingKind: "protected_span_issue",
          description: expect.stringContaining(
            "Repair hint: Restore protected span {player} exactly in script/prologue#line-001",
          ),
        }),
        status: "open",
      }),
    );
    expect(repository.savePatchExport).not.toHaveBeenCalled();
  });

  it("requires duplicate protected span raw text to appear once per source occurrence", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const bridge = bridgeFixture();
    bridge.units = [
      {
        ...bridge.units[0]!,
        sourceText: "こんにちは、{player}と{player}。",
        protectedSpans: [
          { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
          { kind: "placeholder", raw: "{player}", start: 15, end: 23, preserveMode: "exact" },
        ],
      },
    ];

    await expect(
      service.exportPatch(
        projectFixture({
          bridge,
          drafts: { "bridge-unit-test": "Hello, {player}." },
        }),
      ),
    ).rejects.toThrow("The target contains 1 occurrence(s), but 2 are required.");

    expect(repository.recordFinding).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        finding: expect.objectContaining({
          description: expect.stringContaining(
            "The target contains 1 occurrence(s), but 2 are required.",
          ),
        }),
        status: "open",
      }),
    );
    expect(repository.savePatchExport).not.toHaveBeenCalled();
  });

  it("emits deterministic pre-export findings with exact units and repair hints", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const bridge = bridgeFixture();
    bridge.units = [
      bridge.units[0]!,
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-empty",
        sourceUnitKey: "empty.unit",
        sourceText: "空欄",
        protectedSpans: [],
      },
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-charset",
        sourceUnitKey: "charset.unit",
        sourceText: "制御文字",
        protectedSpans: [],
      },
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-length",
        sourceUnitKey: "length.unit",
        sourceText: "長い行",
        protectedSpans: [],
      },
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-punctuation",
        sourceUnitKey: "punctuation.unit",
        sourceText: "終わり。",
        protectedSpans: [],
      },
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-glossary-term",
        sourceUnitKey: "database.glossary.yorishiro.term",
        sourceText: "依代",
        protectedSpans: [],
      },
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-glossary-use",
        sourceUnitKey: "glossary.use",
        sourceText: "依代の灯り",
        protectedSpans: [],
      },
    ];
    const project = projectFixture({
      bridge,
      drafts: {
        "bridge-unit-test": "Hello.",
        "bridge-unit-empty": " ",
        "bridge-unit-charset": "Bad\u0007text",
        "bridge-unit-length": "x".repeat(161),
        "bridge-unit-punctuation": "Finished",
        "bridge-unit-glossary-term": "Yorishiro",
        "bridge-unit-glossary-use": "The vessel light",
      },
    });

    await expect(service.exportPatch(project)).rejects.toThrow(
      "deterministic pre-export QA failed for 6 finding(s)",
    );

    const findingInputs = vi.mocked(repository.recordFinding).mock.calls.map((call) => call[1]);
    expect(findingInputs).toHaveLength(6);
    expect(
      findingInputs.map((input) => ({
        unit: input.finding.affectedRefs[0]?.subjectId,
        check: input.finding.provenance[0]?.checkName,
        hint: input.finding.description,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unit: "bridge-unit-test",
          check: "protected-span-missing",
          hint: expect.stringContaining("Repair hint: Restore protected span {player} exactly"),
        }),
        expect.objectContaining({
          unit: "bridge-unit-empty",
          check: "empty-translation",
          hint: expect.stringContaining("Repair hint: Replace the empty target"),
        }),
        expect.objectContaining({
          unit: "bridge-unit-charset",
          check: "charset-invalid",
          hint: expect.stringContaining("Repair hint: Remove or replace U+0007"),
        }),
        expect.objectContaining({
          unit: "bridge-unit-length",
          check: "line-length-exceeded",
          hint: expect.stringContaining("Repair hint: Shorten or manually wrap line 1"),
        }),
        expect.objectContaining({
          unit: "bridge-unit-punctuation",
          check: "punctuation-missing",
          hint: expect.stringContaining("Repair hint: Add appropriate terminal punctuation"),
        }),
        expect.objectContaining({
          unit: "bridge-unit-glossary-use",
          check: "glossary-exact-mismatch",
          hint: expect.stringContaining("Repair hint: Use glossary term Yorishiro exactly"),
        }),
      ]),
    );
    expect(repository.savePatchExport).not.toHaveBeenCalled();
  });

  it("does not flag deterministic QA false-positive calibration cases", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const bridge = bridgeFixture();
    bridge.units = [
      bridge.units[0]!,
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-short-label",
        sourceUnitKey: "choice.ok",
        sourceText: "OK",
        protectedSpans: [],
      },
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-glossary-term",
        sourceUnitKey: "database.glossary.yorishiro.term",
        sourceText: "依代",
        protectedSpans: [],
      },
      {
        ...bridge.units[0]!,
        bridgeUnitId: "bridge-unit-glossary-use",
        sourceUnitKey: "glossary.use",
        sourceText: "依代の灯り",
        protectedSpans: [],
      },
    ];

    const { patchExport } = await service.exportPatch(
      projectFixture({
        bridge,
        drafts: {
          "bridge-unit-test": "Hello, {player}.",
          "bridge-unit-short-label": "OK",
          "bridge-unit-glossary-term": "Yorishiro",
          "bridge-unit-glossary-use": "Yorishiro\tlight\ncontinues.",
        },
      }),
    );

    expect(repository.recordFinding).not.toHaveBeenCalled();
    expect(repository.savePatchExport).toHaveBeenCalled();
    expect(patchExport.entries).toHaveLength(4);
  });

  it("exports protected span mappings as UTF-8 byte offsets", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);

    const { patchExport } = await service.exportPatch(
      projectFixture({ drafts: { "bridge-unit-test": "翻訳 {player}." } }),
    );

    expect(patchExport.entries[0]?.protectedSpanMappings).toEqual([
      { raw: "{player}", targetStart: 7, targetEnd: 15 },
    ]);
  });

  it("stores runtime reports through the repository and returns CLI output", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const project = projectFixture();
    const report = runtimeReportFixture();

    const result = await service.ingestRuntimeReport(project, report);

    expect(repository.saveRuntimeReport).toHaveBeenCalledWith(
      actor,
      result.project,
      report,
      "runtime-test:patch-result",
    );
    expect(result.result).toMatchObject({
      status: "hello_world_passed",
      bridgeId: "bridge-test",
      localeBranchId: "locale-en-us",
      patchResultId: "runtime-test:patch-result",
      runtimeReportId: "runtime-test",
      dashboard: dashboardStatusFixture,
    });
  });

  it("maps benchmark remote preset identity into provider preset snapshots", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor, undefined, ledger);
    const benchmarkReport = benchmarkReportFixture();
    benchmarkReport.providerModelCostRecords[1] = {
      ...benchmarkReport.providerModelCostRecords[1]!,
      provider: {
        ...benchmarkReport.providerModelCostRecords[1]!.provider,
        actualModelId: "fixture-model-v2",
      },
      retryCount: 1,
      errorClasses: ["provider_timeout_retry"],
      fallbackUsed: true,
      fallbackPlan: ["fixture-model-v1", "fixture-model-v2"],
      prompt: {
        ...benchmarkReport.providerModelCostRecords[1]!.prompt,
        remotePresetSlug: "openrouter/itotori-draft",
        remotePresetVersion: "2026-06-17",
        remotePresetConfigHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    };

    await service.recordBenchmarkReport("project-test", {
      benchmarkReport,
    });

    expect(repository.recordBenchmarkArtifactWithProviderLedger).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        artifact: expect.objectContaining({
          artifactId: benchmarkReport.benchmarkRunId,
          artifactKind: "benchmark_report",
        }),
        providerRuns: expect.arrayContaining([
          expect.objectContaining({
            providerRunId: benchmarkReport.providerModelCostRecords[1]!.providerRunId,
            fallbackPlan: expect.arrayContaining([
              benchmarkReport.providerModelCostRecords[1]!.provider.requestedModelId,
              benchmarkReport.providerModelCostRecords[1]!.provider.actualModelId,
            ]),
            // ITOTORI-230 — benchmark ingest writes the
            // pre-ITOTORI-230 sentinel into routing_posture because the
            // bridge schema (BenchmarkReportV02) does not carry the
            // captured posture today. Telemetry queries correctly do
            // NOT count these rows toward ZDR-enforcement.
            routingPosture: { _pre_itotori_230: true },
            providerPreset: expect.objectContaining({
              slug: "openrouter/itotori-draft",
              version: "2026-06-17",
              configHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              configSnapshot: expect.objectContaining({
                source: "benchmark_report",
                remotePresetSlug: "openrouter/itotori-draft",
              }),
            }),
          }),
        ]),
      }),
    );
    expect(ledger.recordProviderRun).not.toHaveBeenCalled();
  });

  it("passes skipped benchmark runs with omitted timing to atomic repository ingestion", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      undefined,
      ledgerFixture(),
    );
    const benchmarkReport = benchmarkReportFixture();
    const [firstRun] = benchmarkReport.providerModelCostRecords;
    if (firstRun === undefined) {
      throw new Error("benchmark fixture must contain provider runs");
    }
    delete firstRun.completedAt;
    delete firstRun.latencyMs;
    firstRun.status = "skipped";
    firstRun.tokenUsage = { tokenCountSource: "unknown" };
    // The cross-app BenchmarkReportV02 still emits the legacy enum; the
    // benchmark records a skipped run with no upstream charge. Itotori's
    // ingest boundary (narrowBenchmarkCostToItotoriShape) maps this onto
    // the narrowed `'billed' | 'zero'` enum — see ITOTORI-225.
    firstRun.cost = { costKind: "unknown", currency: "USD" }; // itotori-225-audit-allow: cross-app BenchmarkCostAmountV02 still emits the legacy enum; this test verifies the itotori ingest boundary narrows it.

    await service.recordBenchmarkReport("project-test", {
      benchmarkReport,
    });

    expect(repository.recordBenchmarkArtifactWithProviderLedger).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        providerRuns: expect.arrayContaining([
          expect.objectContaining({
            providerRunId: firstRun.providerRunId,
            status: "skipped",
            tokenUsage: { tokenCountSource: "unknown" },
            // The legacy `unknown` benchmark cost narrows to `zero` at
            // the itotori ingest boundary; we no longer carry forward
            // "I don't know" into the ledger.
            cost: { costKind: "zero", currency: "USD", amountMicrosUsd: 0 },
          }),
        ]),
      }),
    );
    const providerRuns = vi.mocked(repository.recordBenchmarkArtifactWithProviderLedger).mock
      .calls[0]?.[1].providerRuns;
    const mappedRun = providerRuns?.find((run) => run.providerRunId === firstRun.providerRunId);
    expect(mappedRun).not.toHaveProperty("completedAt");
    expect(mappedRun).not.toHaveProperty("latencyMs");
  });
});

function repositoryFixture(): ItotoriProjectRepositoryPort {
  return {
    reset: vi.fn(async () => {}),
    importSourceBundle: vi.fn(
      async (_actor: AuthorizationActor, _project: ItotoriProjectRecord) => importStatusFixture,
    ),
    saveDrafts: vi.fn(async (_actor: AuthorizationActor, _project: ItotoriProjectRecord) => {}),
    savePatchExport: vi.fn(async () => {}),
    saveRuntimeReport: vi.fn(async () => dashboardStatusFixture),
    appendEvent: vi.fn(async () => {}),
    recordFinding: vi.fn(async () => {}),
    linkArtifact: vi.fn(async () => {}),
    recordBenchmarkArtifactWithProviderLedger: vi.fn(async () => {}),
    listLocaleBranchIdentities: vi.fn(async () => []),
    listBenchmarkReports: vi.fn(async () => []),
    getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
    getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
    getDashboardDecisions: vi.fn(async () => dashboardDecisionsFixture),
  };
}

function emptyDrilldownPageFixture(): CostDrilldownPage {
  return {
    filter: { projectId: "project-test", systemId: null, from: null, to: null },
    pagination: {
      total: 0,
      limit: 20,
      offset: 0,
      page: 1,
      pageCount: 0,
      hasMore: false,
      nextOffset: null,
    },
    rows: [],
  };
}

function ledgerFixture(): ItotoriModelLedgerRepositoryPort {
  return {
    recordProviderRun: vi.fn(async () => costReportFixture.recentRuns[0]!),
    getProjectCostReport: vi.fn(async () => costReportFixture),
    getCostLedgerDrilldown: vi.fn(async () => emptyDrilldownPageFixture()),
  };
}

function projectFixture(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    bridge: bridgeFixture(),
    drafts: { "bridge-unit-test": "Hello, {player}." },
    ...overrides,
  };
}

function bridgeFixture(): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-test",
    sourceBundleHash: "hash-test",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "bridge-unit-test",
        sourceUnitKey: "hello.scene.001.line.001",
        occurrenceId: "occurrence-1",
        sourceHash: "source-hash",
        sourceLocale: "ja-JP",
        sourceText: "こんにちは、{player}。",
        textSurface: "dialogue",
        protectedSpans: [
          { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
        ],
        patchRef: {
          assetId: "source.json",
          writeMode: "replace",
          sourceUnitKey: "hello.scene.001.line.001",
        },
      },
    ],
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

function benchmarkReportFixture(): BenchmarkReportV02 {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as BenchmarkReportV02;
}

function runtimeReportFixture(): RuntimeVerificationReport {
  return {
    schemaVersion: "0.1.0",
    runtimeReportId: "runtime-test",
    adapterName: "utsushi-fixture",
    fidelityTier: "layout_probe",
    status: "passed",
    textEvents: [],
    frameCaptures: [],
    approximations: [],
  };
}

const costReportFixture: ProjectCostReport = {
  projectId: "project-test",
  currency: "USD",
  runCount: 1,
  billedMicrosUsd: 0,
  zeroRunCount: 1,
  totalsByCostKind: [
    {
      costKind: "billed",
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    {
      costKind: "zero",
      runCount: 1,
      amountMicrosUsd: 0,
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    },
  ],
  recentRuns: [
    {
      providerRunId: "provider-run-test",
      taskKind: "draft_translation",
      status: "succeeded",
      startedAt: "2026-06-17T00:00:00.000Z",
      structuredOutputMode: "json_schema",
      retryCount: 0,
      errorClasses: [],
      providerFamily: "fake",
      endpointFamily: "chat-completions",
      providerName: "itotori-fixture",
      requestedModelId: "itotori-fake-draft-v0",
      actualModelId: "itotori-fake-draft-v0",
      upstreamProvider: null,
      routeSettingsHash: null,
      promptPresetId: "itotori-draft-default-v1",
      promptTemplateVersion: "1.0.0",
      promptHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      fallbackUsed: false,
      fallbackPlan: ["itotori-fake-draft-v0"],
      costKind: "zero",
      amountMicrosUsd: 0,
      tokenCountSource: "deterministic_counter",
      promptTokens: 10,
      completionTokens: 4,
      reasoningTokens: null,
      cachedInputTokens: null,
      totalTokens: 14,
      // ITOTORI-230 — fixture posture for a fake-provider draft run.
      routingPosture: {
        order: ["itotori-fixture"],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
    },
  ],
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

const importStatusFixture = {
  bridgeImportId: "bridge-import:project-test:bridge-test:revision-test",
  projectId: "project-test",
  bridgeId: "bridge-test",
  sourceBundleId: "bridge-test",
  sourceBundleHash: "hash-test",
  sourceBundleRevisionId: "revision-test",
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
};

const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-test",
  projectKey: "project-test",
  name: "project-test",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
  sourceBundleId: "bridge-test",
  sourceBundleHash: "hash-test",
  sourceBundleRevisionId: "revision-test",
  branchCount: 1,
  unitCount: 1,
  findingCount: 0,
  artifactCount: 0,
  latestEventKind: null,
  latestEventAt: null,
  selectedLocaleBranchId: null,
  currentStyleGuidePolicyVersionId: null,
  importStatus: importStatusFixture,
  cost: costReportFixture,
  localeBranches: [],
};

const runtimeStatusFixture: RuntimeDashboardStatus = {
  finalStatus: "hello_world_passed",
  runtimeRunId: "runtime-test",
  runtimeReportId: "runtime-test",
  runtimeStatus: "passed",
  fidelityTier: "layout_probe",
  evidenceTier: null,
  textEventCount: 0,
  frameCaptureCount: 0,
  screenshotArtifactCount: 0,
  recordingArtifactCount: 0,
  validationFindingCount: 0,
  traceEvents: [],
  findings: [],
  artifacts: [],
  approximations: [],
  unsupportedCapabilities: [],
  limitations: [],
};

const dashboardDecisionsFixture: DashboardDecisionReadModel = {
  projectId: "project-test",
  counts: {
    pendingDecisionCount: 0,
    projectFindingDecisionCount: 0,
    localeBranchFindingDecisionCount: 0,
    runtimeValidationDecisionCount: 0,
  },
  pendingDecisions: [],
};
