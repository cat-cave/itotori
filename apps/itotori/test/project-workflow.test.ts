import { readFileSync } from "node:fs";
import type {
  AuthorizationActor,
  ItotoriModelLedgerRepositoryPort,
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  ProjectCostReport,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "@itotori/db";
import type {
  BenchmarkReportV02,
  BridgeBundle,
  BridgeBundleV02,
  RuntimeVerificationReport,
} from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  ModelProviderError,
  openRouterDefaultCapabilities,
  type ModelInvocationRequest,
  type ModelProvider,
  type ProviderRunRecord,
} from "../src/providers/index.js";
import {
  ItotoriProjectWorkflowService,
  type ProjectState,
} from "../src/services/project-workflow.js";

const actor: AuthorizationActor = { userId: "user-test" };

describe("ItotoriProjectWorkflowService", () => {
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

  it("drafts deterministic translations before saving drafts", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor, undefined, ledger);
    const project = projectFixture({ drafts: {} });

    const drafted = await service.draftProject(project, "fr-FR");

    expect(drafted.targetLocale).toBe("fr-FR");
    expect(drafted.drafts["bridge-unit-test"]).toBe("Hello, {player}.");
    expect(repository.saveDrafts).toHaveBeenCalledWith(actor, drafted);
    expect(ledger.recordProviderRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        provider: expect.objectContaining({
          providerFamily: "fake",
          requestedModelId: "itotori-fake-draft-v0",
          actualModelId: "itotori-fake-draft-v0",
        }),
        prompt: expect.objectContaining({
          promptPresetId: "itotori-draft-default-v1",
          promptTemplateVersion: "1.0.0",
          promptHash: expect.stringMatching(/^sha256:/u),
        }),
        cost: expect.objectContaining({ costKind: "zero" }),
      }),
    );
    expect(project.drafts).toEqual({});
  });

  it("uses distinct provider run ids when drafts are rerun", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor, undefined, ledger);
    const project = projectFixture({ drafts: {} });

    await service.draftProject(project, "fr-FR");
    await service.draftProject(project, "fr-FR");

    const runIds = vi.mocked(ledger.recordProviderRun).mock.calls.map((call) => {
      return call[1].providerRunId;
    });
    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);
  });

  it("records failed provider runs before rethrowing invocation errors", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const provider = failingProvider();
    const service = new ItotoriProjectWorkflowService(repository, actor, provider, ledger);

    await expect(
      service.draftProject(projectFixture({ drafts: {} }), "fr-FR"),
    ).rejects.toMatchObject({
      code: "provider_http_error",
    });

    expect(ledger.recordProviderRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        providerRunId: "provider-run-failed",
        status: "failed",
        errorClasses: ["http_500"],
        cost: { costKind: "unknown", currency: "USD" },
      }),
    );
    expect(repository.saveDrafts).not.toHaveBeenCalled();
  });

  it("records failed provider runs for invocation errors without embedded run records", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const provider = failingProviderWithoutRun();
    const service = new ItotoriProjectWorkflowService(repository, actor, provider, ledger);

    await expect(
      service.draftProject(projectFixture({ drafts: {} }), "fr-FR"),
    ).rejects.toMatchObject({
      code: "provider_response_invalid",
    });

    expect(ledger.recordProviderRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        status: "failed",
        errorClasses: ["provider_response_invalid"],
        cost: { costKind: "unknown", currency: "USD" },
        provider: expect.objectContaining({
          providerFamily: "fake",
          requestedModelId: "itotori-fake-draft-v0",
          actualModelId: "itotori-fake-draft-v0",
        }),
        prompt: expect.objectContaining({
          promptPresetId: "itotori-draft-default-v1",
        }),
      }),
    );
    expect(repository.saveDrafts).not.toHaveBeenCalled();
  });

  it("rejects drafting provider policy violations before provider execution", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const invoke = vi.fn(async () => {
      throw new Error("provider execution should have been guarded");
    });
    const provider = policyBlockedProvider(invoke);
    const service = new ItotoriProjectWorkflowService(repository, actor, provider, ledger);

    await expect(
      service.draftProject(projectFixture({ drafts: {} }), "fr-FR"),
    ).rejects.toMatchObject({
      code: "policy_blocked",
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(ledger.recordProviderRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        status: "failed",
        errorClasses: ["policy_blocked"],
        provider: expect.objectContaining({
          providerFamily: "fake",
          requestedModelId: "itotori-fake-draft-v0",
        }),
      }),
    );
    expect(repository.saveDrafts).not.toHaveBeenCalled();
  });

  it("records null draft content as a failed unknown-cost provider run", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const provider = nullContentProvider();
    const service = new ItotoriProjectWorkflowService(repository, actor, provider, ledger);

    await expect(
      service.draftProject(projectFixture({ drafts: {} }), "fr-FR"),
    ).rejects.toMatchObject({
      code: "provider_response_invalid",
    });

    expect(ledger.recordProviderRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        providerRunId: "provider-run-null-content",
        status: "failed",
        errorClasses: ["provider_response_invalid"],
        cost: { costKind: "unknown", currency: "USD" },
      }),
    );
    expect(repository.saveDrafts).not.toHaveBeenCalled();
  });

  it("drafts two target locales with ledger-enabled immutable prompt presets", async () => {
    const repository = repositoryFixture();
    const ledger = driftDetectingLedgerFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor, undefined, ledger);
    const project = projectFixture({ drafts: {} });

    await service.draftProject(project, "fr-FR");
    await service.draftProject(project, "es-ES");

    const prompts = vi.mocked(ledger.recordProviderRun).mock.calls.map((call) => call[1].prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({
      promptPresetId: "itotori-draft-default-v1",
      promptTemplateVersion: "1.0.0",
    });
    expect(prompts[1]).toMatchObject({
      promptPresetId: prompts[0]?.promptPresetId,
      promptTemplateVersion: prompts[0]?.promptTemplateVersion,
      promptHash: prompts[0]?.promptHash,
      configSnapshot: prompts[0]?.configSnapshot,
    });
    expect(JSON.stringify(prompts[0]?.configSnapshot)).not.toContain("fr-FR");
    expect(JSON.stringify(prompts[1]?.configSnapshot)).not.toContain("es-ES");
  });

  it("drafts through the provider-neutral model boundary when one is supplied", async () => {
    const repository = repositoryFixture();
    const generate = vi.fn(() => "Bonjour, {player}.");
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider({ modelId: "fixture-provider-model", generate }),
    );
    const project = projectFixture({ drafts: {} });

    const drafted = await service.draftProject(project, "fr-FR");

    expect(drafted.drafts["bridge-unit-test"]).toBe("Bonjour, {player}.");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskKind: "draft_translation",
        modelId: "fixture-provider-model",
        inputClassification: "private_corpus",
      }),
    );
  });

  it("drafts v0.2 bridges using normalized protected span raws", async () => {
    const repository = repositoryFixture();
    const seenProtectedSpans: string[][] = [];
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider({
        generate: (request) => {
          const message = request.messages.findLast((candidate) => candidate.role === "user");
          const payload = JSON.parse(String(message?.content)) as {
            sourceText: string;
            protectedSpans: string[];
          };
          seenProtectedSpans.push(payload.protectedSpans);
          return payload.sourceText;
        },
      }),
    );
    const project = projectFixture({ bridge: bridgeV02Fixture(), drafts: {} });

    const drafted = await service.draftProject(project, "fr-FR");

    expect(seenProtectedSpans).toContainEqual(["{player}"]);
    expect(drafted.drafts["019ed001-0000-7000-8000-000000000201"]).toBe("Hello, {player}.");
    expect(repository.saveDrafts).toHaveBeenCalledWith(actor, drafted);
  });

  it("validates protected spans before writing patch exports", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);

    await expect(
      service.exportPatch(projectFixture({ drafts: { "bridge-unit-test": "Hello." } })),
    ).rejects.toThrow("lost protected span {player}");

    expect(repository.savePatchExport).not.toHaveBeenCalled();
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
      prompt: {
        ...benchmarkReport.providerModelCostRecords[1]!.prompt,
        remotePresetSlug: "openrouter/itotori-draft",
        remotePresetVersion: "2026-06-17",
        remotePresetConfigHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    };

    await service.recordBenchmarkReport("project-test", {
      localeBranchId: "locale-en-us",
      benchmarkReport,
    });

    expect(ledger.recordProviderRun).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        providerRunId: benchmarkReport.providerModelCostRecords[1]!.providerRunId,
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
    );
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
    getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
    getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
  };
}

function ledgerFixture(): ItotoriModelLedgerRepositoryPort {
  return {
    recordProviderRun: vi.fn(async () => costReportFixture.recentRuns[0]!),
    getProjectCostReport: vi.fn(async () => costReportFixture),
  };
}

function driftDetectingLedgerFixture(): ItotoriModelLedgerRepositoryPort {
  const snapshots = new Map<string, string>();
  return {
    recordProviderRun: vi.fn(async (_actor, input) => {
      const key = `${input.prompt.promptPresetId}@${input.prompt.promptTemplateVersion}`;
      const snapshot = JSON.stringify({
        presetSchemaVersion: input.prompt.presetSchemaVersion,
        promptHash: input.prompt.promptHash,
        configSnapshot: input.prompt.configSnapshot ?? {},
      });
      const existing = snapshots.get(key);
      if (existing !== undefined && existing !== snapshot) {
        throw new Error(`prompt preset ${key} is immutable`);
      }
      snapshots.set(key, snapshot);
      return {
        ...costReportFixture.recentRuns[0]!,
        providerRunId: input.providerRunId,
        status: input.status,
        promptPresetId: input.prompt.promptPresetId,
        promptTemplateVersion: input.prompt.promptTemplateVersion,
        promptHash: input.prompt.promptHash,
        costKind: input.cost.costKind,
        amountMicrosUsd: input.cost.amountMicrosUsd ?? null,
        tokenCountSource: input.tokenUsage.tokenCountSource,
        totalTokens: input.tokenUsage.totalTokens ?? null,
      };
    }),
    getProjectCostReport: vi.fn(async () => costReportFixture),
  };
}

function failingProvider(): ModelProvider {
  const descriptor = new FakeModelProvider().descriptor;
  return {
    descriptor,
    invoke: vi.fn(async (request: ModelInvocationRequest) => {
      throw new ModelProviderError(
        "fixture provider failure",
        "provider_http_error",
        true,
        failedProviderRun(request, descriptor.defaultModelId),
      );
    }),
  };
}

function failingProviderWithoutRun(): ModelProvider {
  const descriptor = new FakeModelProvider().descriptor;
  return {
    descriptor,
    invoke: vi.fn(async () => {
      throw new ModelProviderError("fixture invalid response", "provider_response_invalid", false);
    }),
  };
}

function nullContentProvider(): ModelProvider {
  const descriptor = new FakeModelProvider().descriptor;
  return {
    descriptor,
    invoke: vi.fn(async (request: ModelInvocationRequest) => {
      const run = failedProviderRun(request, descriptor.defaultModelId);
      run.runId = "provider-run-null-content";
      run.status = "succeeded";
      run.errorClasses = [];
      run.tokenUsage = {
        tokenCountSource: "deterministic_counter",
        promptTokens: 10,
        completionTokens: 0,
        totalTokens: 10,
      };
      run.cost = {
        costKind: "zero",
        currency: "USD",
        amountMicrosUsd: 0,
      };
      return {
        content: null,
        toolCalls: [],
        finishReason: "stop",
        providerRun: run,
      };
    }),
  };
}

function policyBlockedProvider(invoke: ModelProvider["invoke"]): ModelProvider {
  const descriptor = new FakeModelProvider().descriptor;
  return {
    descriptor: {
      ...descriptor,
      capabilities: {
        ...descriptor.capabilities,
        dataHandling: openRouterDefaultCapabilities.dataHandling,
        accountPrivacy: openRouterDefaultCapabilities.accountPrivacy,
      },
    },
    invoke,
  };
}

function failedProviderRun(request: ModelInvocationRequest, modelId: string): ProviderRunRecord {
  return {
    runId: "provider-run-failed",
    taskKind: request.taskKind,
    startedAt: "2026-06-17T00:00:00.000Z",
    completedAt: "2026-06-17T00:00:01.000Z",
    latencyMs: 1000,
    status: "failed",
    provider: {
      providerFamily: "fake",
      endpointFamily: "chat-completions",
      providerName: "itotori-fixture",
      requestedModelId: modelId,
      actualModelId: modelId,
    },
    structuredOutputMode: "none",
    retryCount: 0,
    errorClasses: ["http_500"],
    fallbackUsed: false,
    fallbackPlan: [modelId],
    tokenUsage: {
      tokenCountSource: "unknown",
    },
    cost: {
      costKind: "unknown",
      currency: "USD",
    },
    prompt: request.prompt,
    dataHandling: descriptorDataHandling(),
  };
}

function descriptorDataHandling(): ProviderRunRecord["dataHandling"] {
  return new FakeModelProvider().descriptor.capabilities.dataHandling;
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
  estimatedMicrosUsd: 0,
  zeroRunCount: 1,
  unknownRunCount: 0,
  includesUnknownCost: false,
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
      costKind: "provider_estimate",
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    {
      costKind: "local_estimate",
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
    {
      costKind: "unknown",
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  ],
  recentRuns: [
    {
      providerRunId: "provider-run-test",
      taskKind: "draft_translation",
      status: "succeeded",
      startedAt: "2026-06-17T00:00:00.000Z",
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
      totalTokens: 14,
    },
  ],
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
  importStatus: importStatusFixture,
  cost: costReportFixture,
  localeBranches: [],
};

const runtimeStatusFixture: RuntimeDashboardStatus = {
  finalStatus: "hello_world_passed",
  runtimeReportId: "runtime-test",
  runtimeStatus: "passed",
  fidelityTier: "layout_probe",
  evidenceTier: null,
  textEventCount: 0,
  frameCaptureCount: 0,
  screenshotArtifactCount: 0,
  recordingArtifactCount: 0,
  validationFindingCount: 0,
};
