import { readFileSync } from "node:fs";
import {
  AuthorizationError,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  ItotoriTranslationMemoryRepository,
  ItotoriTranslationMemoryService,
  localUserId,
  permissionValues,
  translationMemoryMatchKindValues,
  translationMemoryReuseStatusValues,
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
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
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
  type ModelInvocationRequest,
  type ModelProvider,
  type ProviderRunRecord,
} from "../src/providers/index.js";
import {
  DraftProviderNotConfiguredError,
  ItotoriProjectWorkflowService,
  type ProjectState,
} from "../src/services/project-workflow.js";

const actor: AuthorizationActor = { userId: localUserId };
const dbBackedIt = process.env.DATABASE_URL ? it : it.skip;

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

  it("refuses to draft with a typed error when no real provider is configured", async () => {
    // itotori-purge-fakemodelprovider-from-production — the production wiring
    // no longer silently defaults to a zero-cost FakeModelProvider. With no
    // provider injected, draftProject must refuse LOUDLY rather than draft a
    // fake translation. It must refuse BEFORE touching the repository.
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const project = projectFixture({ drafts: {} });

    await expect(service.draftProject(project, "fr-FR")).rejects.toBeInstanceOf(
      DraftProviderNotConfiguredError,
    );
    expect(repository.saveDrafts).not.toHaveBeenCalled();
  });

  it("drafts deterministic translations before saving drafts", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    // itotori-purge-fakemodelprovider-from-production — the service no longer
    // defaults to a fake; the test injects the test double explicitly.
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider(),
      ledger,
    );
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
      getProjectTelemetryTimeseries: vi.fn(async () => emptyTelemetryTimeseriesFixture()),
    };

    const authorizedService = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider(),
      gatedLedger,
    );
    await expect(authorizedService.getCostReport("project-test")).resolves.toMatchObject({
      projectId: costReportFixture.projectId,
    });
    expect(gatedLedger.getProjectCostReport).toHaveBeenCalledWith(actor, "project-test");

    // An internal caller running as an unprivileged actor is rejected at
    // the read site, not silently served the ledger internals.
    const unprivilegedService = new ItotoriProjectWorkflowService(
      repository,
      { userId: "workflow-actor-without-catalog-read" },
      new FakeModelProvider(),
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

    const authorizedService = new ItotoriProjectWorkflowService(
      gatedRepository,
      actor,
      new FakeModelProvider(),
    );
    await expect(authorizedService.getRuntimeStatus("runtime-1")).resolves.toMatchObject({
      runtimeRunId: runtimeStatusFixture.runtimeRunId,
    });
    expect(gatedRuntimeRead).toHaveBeenCalledWith(actor, "runtime-1");

    // An internal caller running as an unprivileged actor is rejected at the
    // read site, not silently served the evidence-text previews / finding
    // free text / artifact URIs.
    const unprivilegedService = new ItotoriProjectWorkflowService(
      gatedRepository,
      { userId: "workflow-actor-without-catalog-read" },
      new FakeModelProvider(),
    );
    await expect(unprivilegedService.getRuntimeStatus("runtime-1")).rejects.toMatchObject({
      name: "AuthorizationError",
      permission: permissionValues.catalogRead,
    });
  });

  it("uses translation memory prefill results to skip provider calls for reused units", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const bridge = repeatedLineBridgeFixture();
    const prefillDrafts = vi.fn(async () => ({
      status: "completed" as const,
      diagnostics: [],
      appliedCount: 1,
      suggestedCount: 0,
      skippedCount: 1,
      reuses: [
        {
          target: {
            projectId: "project-test",
            localeBranchId: "locale-en-us",
            targetLocale: "en-US",
            bridgeUnitId: "bridge-unit-repeat",
            sourceRevisionId: "revision-test",
            sourceUnitKey: "hello.scene.001.line.002",
            sourceOccurrenceId: "occurrence-repeat",
            sourceHash: "source-hash-repeat",
            sourceText: "こんにちは、{player}。",
            currentTargetText: null,
          },
          match: {} as never,
          event: {
            reuseEventId: "tm-reuse-test",
            projectId: "project-test",
            localeBranchId: "locale-en-us",
            targetBridgeUnitId: "bridge-unit-repeat",
            sourceRevisionId: "revision-test",
            memorySegmentId: "tm-bridge-unit-memory",
            matchKind: translationMemoryMatchKindValues.exact,
            matchScore: 1000,
            reuseStatus: translationMemoryReuseStatusValues.applied,
            sourceHash: "source-hash-repeat",
            candidateSourceHash: "source-hash-repeat",
            targetText: "Hello, {player}.",
            provenance: {
              requestId: "draft:project-test:locale-en-us:en-US",
              selectedMemorySegmentId: "tm-bridge-unit-memory",
            },
            costImpact: {
              providerCallAvoided: true,
              estimatedPromptTokensSaved: 5,
              estimatedCompletionTokensSaved: 4,
              estimatedTotalTokensSaved: 9,
              estimatedCostUsdSaved: null,
              calculation: "deterministic_character_estimate_v1",
            },
            createdAt: "2026-06-17T00:00:00.000Z",
          },
        },
      ],
      skipped: [],
    }));
    const generate = vi.fn(() => "Provider draft");
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider({ generate }),
      ledger,
      { prefillDrafts } as Pick<ItotoriTranslationMemoryService, "prefillDrafts">,
    );

    const drafted = await service.draftProject(projectFixture({ bridge, drafts: {} }), "en-US");

    expect(prefillDrafts).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        requestedTargetLocale: "en-US",
        bridgeUnitIds: ["bridge-unit-memory", "bridge-unit-repeat"],
        applyDrafts: true,
        includeFuzzy: false,
        requestId: "draft:project-test:locale-en-us:en-US",
      }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(drafted.drafts).toEqual({
      "bridge-unit-memory": "Provider draft",
      "bridge-unit-repeat": "Hello, {player}.",
    });
    expect(repository.saveDrafts).toHaveBeenCalledWith(actor, drafted);
    expect(ledger.recordProviderRun).toHaveBeenCalledTimes(1);
  });

  dbBackedIt(
    "prefills repeated exact lines from translation memory before provider drafting",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectRepository = new ItotoriProjectRepository(context.db);
        const modelLedger = new ItotoriModelLedgerRepository(context.db);
        const translationMemoryRepository = new ItotoriTranslationMemoryRepository(context.db);
        const translationMemory = new ItotoriTranslationMemoryService(translationMemoryRepository);
        const bridge = repeatedLineBridgeFixture();
        const importedProject = projectFixture({
          bridge,
          drafts: {
            "bridge-unit-memory": "Hello, {player}.",
          },
        });
        await projectRepository.importSourceBundle(actor, importedProject);
        await translationMemoryRepository.upsertSegment(actor, {
          projectId: importedProject.projectId,
          localeBranchId: importedProject.localeBranchId,
          sourceBridgeUnitId: "bridge-unit-memory",
          memorySegmentId: "tm-bridge-unit-memory",
          targetText: "Hello, {player}.",
          expectedSourceHash: "source-hash-repeat",
          expectedTargetLocale: "en-US",
          provenance: { source: "approved_draft" },
        });

        const generate = vi.fn(() => "Provider draft");
        const service = new ItotoriProjectWorkflowService(
          projectRepository,
          actor,
          new FakeModelProvider({ generate }),
          modelLedger,
          translationMemory,
        );
        const drafted = await service.draftProject(
          { ...importedProject, drafts: {}, importStatus: importStatusFixture },
          "en-US",
        );

        expect(generate).toHaveBeenCalledTimes(1);
        expect(drafted.drafts["bridge-unit-repeat"]).toBe("Hello, {player}.");
        expect(drafted.drafts["bridge-unit-memory"]).toBe("Provider draft");

        const events = await translationMemoryRepository.listReuseEvents({
          projectId: importedProject.projectId,
          localeBranchId: importedProject.localeBranchId,
          targetBridgeUnitId: "bridge-unit-repeat",
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          memorySegmentId: "tm-bridge-unit-memory",
          matchKind: translationMemoryMatchKindValues.exact,
          matchScore: 1000,
          reuseStatus: translationMemoryReuseStatusValues.applied,
          targetText: "Hello, {player}.",
          provenance: expect.objectContaining({
            requestId: "draft:project-test:locale-en-us:en-US",
            selectedMemorySegmentId: "tm-bridge-unit-memory",
            targetSourceUnitKey: "hello.scene.001.line.002",
          }),
          costImpact: expect.objectContaining({
            providerCallAvoided: true,
            calculation: "deterministic_character_estimate_v1",
          }),
        });

        const costReport = await modelLedger.getProjectCostReport(actor, importedProject.projectId);
        expect(costReport.translationMemoryReuse).toMatchObject({
          reuseEventCount: 1,
          appliedCount: 1,
          providerCallAvoidedCount: 1,
          estimatedTotalTokensSaved: events[0]?.costImpact.estimatedTotalTokensSaved,
        });
        expect(costReport.translationMemoryReuse.recentEvents[0]).toMatchObject({
          targetBridgeUnitId: "bridge-unit-repeat",
          memorySegmentId: "tm-bridge-unit-memory",
          providerCallAvoided: true,
          calculation: "deterministic_character_estimate_v1",
        });
      } finally {
        await context.close();
      }
    },
  );

  dbBackedIt(
    "does not reuse old-locale memory when drafting a different requested target locale",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectRepository = new ItotoriProjectRepository(context.db);
        const modelLedger = new ItotoriModelLedgerRepository(context.db);
        const translationMemoryRepository = new ItotoriTranslationMemoryRepository(context.db);
        const translationMemory = new ItotoriTranslationMemoryService(translationMemoryRepository);
        const bridge = repeatedLineBridgeFixture();
        const importedProject = projectFixture({
          bridge,
          targetLocale: "en-US",
          drafts: {
            "bridge-unit-memory": "Hello, {player}.",
          },
        });
        await projectRepository.importSourceBundle(actor, importedProject);
        await translationMemoryRepository.upsertSegment(actor, {
          projectId: importedProject.projectId,
          localeBranchId: importedProject.localeBranchId,
          sourceBridgeUnitId: "bridge-unit-memory",
          memorySegmentId: "tm-bridge-unit-memory",
          targetText: "Hello, {player}.",
          expectedSourceHash: "source-hash-repeat",
          expectedTargetLocale: "en-US",
          provenance: { source: "approved_draft" },
        });

        const generate = vi.fn((request: ModelInvocationRequest) => {
          const message = request.messages.findLast((candidate) => candidate.role === "user");
          const body = JSON.parse(String(message?.content)) as {
            targetLocale: string;
            sourceText: string;
          };
          return `[${body.targetLocale}] ${body.sourceText}`;
        });
        const service = new ItotoriProjectWorkflowService(
          projectRepository,
          actor,
          new FakeModelProvider({ generate }),
          modelLedger,
          translationMemory,
        );
        const drafted = await service.draftProject(
          { ...importedProject, drafts: {}, importStatus: importStatusFixture },
          "fr-FR",
        );

        expect(generate).toHaveBeenCalledTimes(2);
        expect(drafted.targetLocale).toBe("fr-FR");
        expect(drafted.drafts["bridge-unit-repeat"]).toBe("[fr-FR] こんにちは、{player}。");
        expect(drafted.drafts["bridge-unit-memory"]).toBe("[fr-FR] こんにちは、{player}。");

        const requestBodies = generate.mock.calls.map((call) => {
          const message = call[0].messages.findLast((candidate) => candidate.role === "user");
          return JSON.parse(String(message?.content)) as {
            targetLocale: string;
            sourceText: string;
          };
        });
        expect(requestBodies).toEqual([
          expect.objectContaining({ targetLocale: "fr-FR", sourceText: "こんにちは、{player}。" }),
          expect.objectContaining({ targetLocale: "fr-FR", sourceText: "こんにちは、{player}。" }),
        ]);
        await expect(
          translationMemoryRepository.listReuseEvents({
            projectId: importedProject.projectId,
            localeBranchId: importedProject.localeBranchId,
            targetBridgeUnitId: "bridge-unit-repeat",
          }),
        ).resolves.toHaveLength(0);
      } finally {
        await context.close();
      }
    },
  );

  it("drafts explicit non-Japanese-to-English locale pairs", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const provider = new FakeModelProvider({
      generate: (request) => {
        const message = request.messages.findLast((candidate) => candidate.role === "user");
        const body = JSON.parse(String(message?.content)) as {
          sourceLocale: string;
          targetLocale: string;
          sourceText: string;
        };
        expect(body.sourceLocale).toBe("de-DE");
        expect(body.targetLocale).toBe("en-US");
        return `[${body.targetLocale}] ${body.sourceText}`;
      },
    });
    const service = new ItotoriProjectWorkflowService(repository, actor, provider, ledger);
    const project = nonJapaneseSourceProjectFixture({ drafts: {} });

    const drafted = await service.draftProject(project, "en-US");

    expect(drafted.targetLocale).toBe("en-US");
    expect(drafted.drafts["bridge-unit-test"]).toBe("[en-US] Guten Tag, {player}.");
    expect(repository.saveDrafts).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        targetLocale: "en-US",
        bridge: expect.objectContaining({ sourceLocale: "de-DE" }),
      }),
    );
  });

  it("uses distinct provider run ids when drafts are rerun", async () => {
    const repository = repositoryFixture();
    const ledger = ledgerFixture();
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider(),
      ledger,
    );
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
        cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
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
        cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
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

  // ITOTORI-227 — the per-pair `policy_blocked` failure mode was
  // deleted along with the rest of itotori's reinvented privacy
  // registry. Privacy posture is enforced account-wide
  // (assertOpenRouterZdrAccount at process startup) plus per-request
  // (`provider.zdr=true` for non-public input); failures surface as the
  // ZDR account-assertion error at construction or as the OpenRouter
  // 404 "No endpoints found matching your data policy" envelope from
  // the wire. Neither requires a workflow-level gate, so the test that
  // used to assert the gate is gone.

  it("records null draft content as a failed zero-cost provider run", async () => {
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
        cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
      }),
    );
    expect(repository.saveDrafts).not.toHaveBeenCalled();
  });

  it("drafts two target locales with ledger-enabled immutable prompt presets", async () => {
    const repository = repositoryFixture();
    const ledger = driftDetectingLedgerFixture();
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider(),
      ledger,
    );
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

  // SHARED-020 — the Itotori-side normalization must carry each expanded
  // surface kind into the draft request WITHOUT collapsing it to generic
  // dialogue. Regression guard: if the request builder dropped surfaceKind or
  // reduced every unit to "dialogue", this fails.
  it("carries the expanded surface kind through draft normalization (no collapse)", async () => {
    const repository = repositoryFixture();
    const seen: Array<{ sourceText: string; surfaceKind: string }> = [];
    const service = new ItotoriProjectWorkflowService(
      repository,
      actor,
      new FakeModelProvider({
        generate: (request) => {
          const message = request.messages.findLast((candidate) => candidate.role === "user");
          const payload = JSON.parse(String(message?.content)) as {
            sourceText: string;
            surfaceKind: string;
          };
          seen.push({ sourceText: payload.sourceText, surfaceKind: payload.surfaceKind });
          return payload.sourceText;
        },
      }),
    );
    const bridge = bridgeV02Fixture();
    await service.draftProject(projectFixture({ bridge, drafts: {} }), "fr-FR");

    // Every request carried a surface kind (never undefined/collapsed away).
    expect(
      seen.every((entry) => typeof entry.surfaceKind === "string" && entry.surfaceKind.length > 0),
    ).toBe(true);
    // The full expanded vocabulary the fixture exercises survives to the request.
    const seenKinds = new Set(seen.map((entry) => entry.surfaceKind));
    const expectedKinds = new Set(bridge.units.map((unit) => unit.surfaceKind));
    expect(seenKinds).toEqual(expectedKinds);
    // A non-dialogue surface must NOT be reduced to dialogue: the count of
    // "dialogue" requests equals the count of genuinely-dialogue units.
    const dialogueUnits = bridge.units.filter((unit) => unit.surfaceKind === "dialogue").length;
    expect(seen.filter((entry) => entry.surfaceKind === "dialogue")).toHaveLength(dialogueUnits);
    // Spot-check a specific expanded kind rode through intact.
    const choiceUnit = bridge.units.find((unit) => unit.surfaceKind === "choice_label")!;
    expect(seen).toContainEqual({ sourceText: choiceUnit.sourceText, surfaceKind: "choice_label" });
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

function emptyTelemetryTimeseriesFixture() {
  return {
    projectId: "project-test",
    bucket: "day" as const,
    rows: [],
    throughputSeries: [],
    costPerRunSeries: [],
  };
}

function ledgerFixture(): ItotoriModelLedgerRepositoryPort {
  return {
    recordProviderRun: vi.fn(async () => costReportFixture.recentRuns[0]!),
    getProjectCostReport: vi.fn(async () => costReportFixture),
    getCostLedgerDrilldown: vi.fn(async () => emptyDrilldownPageFixture()),
    getProjectTelemetryTimeseries: vi.fn(async () => emptyTelemetryTimeseriesFixture()),
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
        structuredOutputMode: input.structuredOutputMode,
        retryCount: input.retryCount,
        errorClasses: input.errorClasses,
        costKind: input.cost.costKind,
        amountMicrosUsd: input.cost.amountMicrosUsd ?? null,
        tokenCountSource: input.tokenUsage.tokenCountSource,
        promptTokens: input.tokenUsage.promptTokens ?? null,
        completionTokens: input.tokenUsage.completionTokens ?? null,
        reasoningTokens: input.tokenUsage.reasoningTokens ?? null,
        cachedInputTokens: input.tokenUsage.cachedInputTokens ?? null,
        totalTokens: input.tokenUsage.totalTokens ?? null,
        routingPosture: input.routingPosture,
      };
    }),
    getProjectCostReport: vi.fn(async () => costReportFixture),
    getCostLedgerDrilldown: vi.fn(async () => emptyDrilldownPageFixture()),
    getProjectTelemetryTimeseries: vi.fn(async () => emptyTelemetryTimeseriesFixture()),
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
        amountUsd: "0",
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
    // ITOTORI-225 — failed runs incur no upstream charge.
    cost: {
      costKind: "zero",
      currency: "USD",
      amountUsd: "0",
      amountMicrosUsd: 0,
    },
    prompt: request.prompt,
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

function repeatedLineBridgeFixture(): BridgeBundle {
  const bridge = bridgeFixture();
  const baseUnit = bridge.units[0]!;
  return {
    ...bridge,
    units: [
      {
        ...baseUnit,
        bridgeUnitId: "bridge-unit-memory",
        sourceUnitKey: "hello.scene.001.line.001",
        occurrenceId: "occurrence-memory",
        sourceHash: "source-hash-repeat",
        protectedSpans: [],
      },
      {
        ...baseUnit,
        bridgeUnitId: "bridge-unit-repeat",
        sourceUnitKey: "hello.scene.001.line.002",
        occurrenceId: "occurrence-repeat",
        sourceHash: "source-hash-repeat",
        protectedSpans: [],
      },
    ],
  };
}

function nonJapaneseSourceProjectFixture(overrides: Partial<ProjectState> = {}): ProjectState {
  return projectFixture({
    targetLocale: "en-US",
    bridge: {
      ...bridgeFixture(),
      sourceLocale: "de-DE",
      units: [
        {
          ...bridgeFixture().units[0]!,
          sourceLocale: "de-DE",
          sourceText: "Guten Tag, {player}.",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 11, end: 19, preserveMode: "exact" },
          ],
        },
      ],
    },
    ...overrides,
  });
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
