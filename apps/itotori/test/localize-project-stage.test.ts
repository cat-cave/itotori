// UTSUSHI-228 — unit tests for the localize-project-stage handler.
//
// Covers:
//   - The pair-policy parser accepts the production preset shape.
//   - Missing/malformed pair-policy fields hard-fail (no defaulting).
//   - Per-stage pair must byte-equal the top-level pair (single-game
//     alpha invariant).
//   - Injecting a deterministic provider via the `liveFactoryOverride`
//     test seam writes all three artifacts AND the agentic-loop-bundle.v0
//     carries the (modelId, providerId) pair pinned on every invocation
//     (matching the pair-policy). There is NO shipped fake-provider mode:
//     a fake translation is never reachable on the production localize
//     surface, so tests inject the fake through the override seam.
//   - The synthesised translated bundle's `target.text` field contains the
//     selected non-blank candidate body, wrapped with the SJIS bracket pair
//     (`「…」`) so the KAIFUU-191 lexer classifies it as a Textout run.
//   - The synthesised patch-report.json carries the (modelId,
//     providerId) pair byte-for-byte.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  LocalizeProjectContextStoreRequiredError,
  LocalizeProjectMissingProviderRunArtifactsDirectoryError,
  LocalizeProjectPairPolicyError,
  assertEngineVisibleTargetText,
  parseLocalizeProjectPairPolicy,
  runLocalizeProjectStageCommand,
  type LocalizeProjectStageIo,
  type LocalizeProjectStageSupervision,
} from "../src/orchestrator/localize-project-stage-command.js";
import { runLocalizeProjectStageLive } from "../src/orchestrator/localize-project-stage-live.js";
import { ItotoriLocalizationJournalRepository, localUserId } from "@itotori/db";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { PairPolicyVersionMismatchError } from "@itotori/localization-bridge-schema";
import {
  createProviderRunId,
  localOnlyRoutingPosture,
  ModelProviderError,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ProviderDescriptor,
  type ProviderRunArtifact,
  type ProviderRunRecord,
} from "../src/providers/types.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
  type PairChoice,
} from "../src/orchestrator/agentic-loop.js";
import { InvocationOperationalPauseError } from "../src/orchestrator/invocation-supervisor.js";
import { InMemoryContextArtifactRepository } from "../src/orchestrator/context-brain.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PAIR_POLICY_PATH = resolve(REPO_ROOT, "presets/localize-project.pair-policy.json");
const SMOKE_BRIDGE_PATH = resolve(
  REPO_ROOT,
  "apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json",
);
const VALID_STAGE_BRIDGE_PATH = resolve(
  REPO_ROOT,
  "packages/localization-bridge-schema/test/examples/bridge-v0.2.json",
);
const WRITTEN_TARGET_TEXT = "Good morning, Kazu.";

function loadPreset(): unknown {
  return JSON.parse(readFileSync(PAIR_POLICY_PATH, "utf8"));
}

function loadSmokeBridge(): unknown {
  return JSON.parse(readFileSync(SMOKE_BRIDGE_PATH, "utf8"));
}

function loadValidStageBridge(): unknown {
  return JSON.parse(readFileSync(VALID_STAGE_BRIDGE_PATH, "utf8"));
}

function ioFixture(reads: Map<string, unknown>): {
  io: LocalizeProjectStageIo;
  writes: Map<string, unknown>;
} {
  const writes = new Map<string, unknown>();
  const io: LocalizeProjectStageIo = {
    readJson: vi.fn((path: string) => {
      if (!reads.has(path)) {
        throw new Error(`unexpected read: ${path}`);
      }
      return reads.get(path);
    }),
    writeJson: vi.fn((path: string, value: unknown) => {
      writes.set(path, value);
    }),
  };
  return { io, writes };
}

/** The command core requires a supervision boundary even under a fake provider. */
function testSupervision(): LocalizeProjectStageSupervision {
  return {
    runId: "localize-project-stage-test-run",
    lifecycle: {
      attemptStarted: async () => undefined,
      attemptCompleted: async () => undefined,
      pauseRun: async () => undefined,
    },
    costAdmission: { admit: async () => ({ admitted: true }) },
  };
}

describe("UTSUSHI-228 parseLocalizeProjectPairPolicy", () => {
  it("accepts the production preset shape and exposes the pair + sceneId", () => {
    const parsed = parseLocalizeProjectPairPolicy(loadPreset());
    expect(parsed.policyId).toBeTypeOf("string");
    expect(parsed.policyId.length).toBeGreaterThan(0);
    expect(parsed.pair).toEqual({
      modelId: "deepseek/deepseek-v4-flash",
      providerId: "fireworks",
    });
    expect(parsed.sceneId).toBe(1017);
    // The obsolete planted-sentinel field is gone from the schema.
    expect(parsed).not.toHaveProperty("enUsSentinel");
  });

  it("rejects an object without policyId", () => {
    const preset = loadPreset() as Record<string, unknown>;
    delete preset.policyId;
    expect(() => parseLocalizeProjectPairPolicy(preset)).toThrow(LocalizeProjectPairPolicyError);
  });

  it("rejects when a stage pair drifts from the top-level pair", () => {
    const preset = loadPreset() as {
      stages: {
        translation: { primary: { pair: { modelId: string; providerId: string } } };
      };
    };
    preset.stages.translation.primary = {
      pair: { modelId: "anthropic/claude-sonnet-4", providerId: "anthropic" },
    };
    expect(() => parseLocalizeProjectPairPolicy(preset)).toThrow(LocalizeProjectPairPolicyError);
  });

  it("rejects a live policy leaf without an explicit hard billing ceiling", () => {
    const preset = loadPreset() as {
      stages: {
        translation: { primary: Record<string, unknown> };
      };
    };
    delete preset.stages.translation.primary.maximumBillableCostUsd;

    expect(() => parseLocalizeProjectPairPolicy(preset)).toThrow(
      /translation\.primary\.maximumBillableCostUsd is required/u,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseLocalizeProjectPairPolicy("not an object")).toThrow(
      LocalizeProjectPairPolicyError,
    );
    expect(() => parseLocalizeProjectPairPolicy(null)).toThrow(LocalizeProjectPairPolicyError);
    expect(() => parseLocalizeProjectPairPolicy([1, 2, 3])).toThrow(LocalizeProjectPairPolicyError);
  });

  it("rejects v0.1 schemaVersion with PairPolicyVersionMismatchError (ITOTORI-234 / ITOTORI-238 no-legacy-compat)", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.schemaVersion = "0.1";
    expect(() => parseLocalizeProjectPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects 'itotori.pair-policy.v0.1' schemaVersion with PairPolicyVersionMismatchError", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.schemaVersion = "itotori.pair-policy.v0.1";
    expect(() => parseLocalizeProjectPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects v0.2 schemaVersion with PairPolicyVersionMismatchError (ITOTORI-238 no-legacy-compat)", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.schemaVersion = "itotori.pair-policy.v0.2";
    expect(() => parseLocalizeProjectPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects absent schemaVersion with PairPolicyVersionMismatchError", () => {
    const preset = loadPreset() as Record<string, unknown>;
    delete preset.schemaVersion;
    expect(() => parseLocalizeProjectPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("resolves per-leaf zdr=true + deterministic seed defaults from the v0.2 file", () => {
    const parsed = parseLocalizeProjectPairPolicy(loadPreset());
    // Spot-check: translation.primary defaults to zdr=true and a seed
    // derived from sha256('translation.primary')[:8].
    expect(parsed.pairPolicy.translation.primary.zdr).toBe(true);
    expect(Number.isInteger(parsed.pairPolicy.translation.primary.seed)).toBe(true);
    expect(parsed.pairPolicy.translation.primary.seed).toBeGreaterThanOrEqual(0);
    // Default maxPriceUsd is DEFAULT_COST_CAP_USD / 11 leaves; we don't
    // assert the exact float because that hard-codes the divisor — but
    // it must be positive + finite.
    expect(Number.isFinite(parsed.pairPolicy.translation.primary.maxPriceUsd)).toBe(true);
    expect(parsed.pairPolicy.translation.primary.maxPriceUsd).toBeGreaterThan(0);
    expect(parsed.pairPolicy.translation.primary.maximumBillableCostUsd).toBe(0.5);
    // fallbackModels defaults to [].
    expect(parsed.pairPolicy.translation.primary.fallbackModels).toEqual([]);
  });
});

describe("engine-visible selected target invariant", () => {
  it("rejects a source-repeated body after out-of-band markup is removed", () => {
    expect(() =>
      assertEngineVisibleTargetText({
        body: "こんにちは",
        sourceText: "こんにちは",
        label: "fixture target",
      }),
    ).toThrow(/repeats source text/u);
  });

  it("rejects an empty body after control-markup normalization", () => {
    expect(() =>
      assertEngineVisibleTargetText({
        body: "",
        sourceText: "こんにちは",
        label: "fixture target",
      }),
    ).toThrow(/non-blank/u);
  });
});

describe("UTSUSHI-228 runLocalizeProjectStageCommand", () => {
  it("refuses the real live OpenRouter path without a provider-run artifact directory", async () => {
    const reads = new Map<string, unknown>([
      ["bridge.json", loadSmokeBridge()],
      ["pair-policy.json", loadPreset()],
    ]);
    const { io } = ioFixture(reads);
    await expect(
      runLocalizeProjectStageCommand({
        bridgePath: "bridge.json",
        pairPolicyPath: "pair-policy.json",
        outputPath: "out/agentic-loop-bundle.v0.json",
        translatedBundleOutputPath: "out/translated-bridge.json",
        patchReportOutputPath: "out/patch-report.json",
        io,
        actor: { userId: "test" },
        supervision: testSupervision(),
        contextArtifactRepository: new InMemoryContextArtifactRepository(),
      }),
    ).rejects.toBeInstanceOf(LocalizeProjectMissingProviderRunArtifactsDirectoryError);
  });

  it("pauses before a paid stage dispatch when durable cost admission denies the cap", async () => {
    const smokeBridge = loadSmokeBridge() as {
      units: ReadonlyArray<{ bridgeUnitId: string; sourceLocale?: string }>;
    };
    const firstUnit = smokeBridge.units[0];
    if (firstUnit === undefined) {
      throw new Error("smoke bridge fixture must carry a first unit");
    }
    const reads = new Map<string, unknown>([
      ["bridge.json", smokeBridge],
      ["pair-policy.json", loadPreset()],
    ]);
    const { io } = ioFixture(reads);
    let paidDispatches = 0;
    const blockers: Array<{ kind: string }> = [];
    const deniedSupervision: LocalizeProjectStageSupervision = {
      runId: "localize-project-stage-capped-test",
      lifecycle: {
        attemptStarted: async () => undefined,
        attemptCompleted: async () => undefined,
        pauseRun: async (_runId, blocker) => void blockers.push(blocker),
      },
      costAdmission: {
        admit: async () => ({
          admitted: false,
          detail: "test cap leaves no room for the next paid call",
          evidence: "test:stage-cost-cap",
        }),
      },
    };
    const liveFactoryOverride = () => {
      const source = writtenTranslationFactory({
        bridgeUnitId: firstUnit.bridgeUnitId,
        sourceLocale: firstUnit.sourceLocale ?? "ja-JP",
      });
      return (factoryInput: Parameters<AgenticLoopProviderFactory>[0]) => {
        const provider = source(factoryInput);
        return {
          descriptor: provider.descriptor,
          invoke: async (request: ModelInvocationRequest) => {
            paidDispatches += 1;
            return await provider.invoke(request);
          },
        };
      };
    };

    await expect(
      runLocalizeProjectStageCommand({
        bridgePath: "bridge.json",
        pairPolicyPath: "pair-policy.json",
        outputPath: "out/agentic-loop-bundle.v0.json",
        translatedBundleOutputPath: "out/translated-bridge.json",
        patchReportOutputPath: "out/patch-report.json",
        liveFactoryOverride,
        io,
        actor: { userId: "test" },
        supervision: deniedSupervision,
        contextArtifactRepository: new InMemoryContextArtifactRepository(),
      }),
    ).rejects.toBeInstanceOf(InvocationOperationalPauseError);
    expect(paidDispatches).toBe(0);
    expect(blockers).toEqual([expect.objectContaining({ kind: "budget_cap" })]);
  });

  it("refuses a provider override when no central context repository is injected", async () => {
    const smokeBridge = loadSmokeBridge() as {
      units: ReadonlyArray<{ bridgeUnitId: string; sourceLocale?: string }>;
    };
    const firstUnit = smokeBridge.units[0];
    if (firstUnit === undefined) {
      throw new Error("smoke bridge fixture must carry a first unit");
    }
    const { io } = ioFixture(
      new Map<string, unknown>([
        ["bridge.json", smokeBridge],
        ["pair-policy.json", loadPreset()],
      ]),
    );
    await expect(
      runLocalizeProjectStageCommand({
        bridgePath: "bridge.json",
        pairPolicyPath: "pair-policy.json",
        outputPath: "out/agentic-loop-bundle.v0.json",
        translatedBundleOutputPath: "out/translated-bridge.json",
        patchReportOutputPath: "out/patch-report.json",
        liveFactoryOverride: () =>
          writtenTranslationFactory({
            bridgeUnitId: firstUnit.bridgeUnitId,
            sourceLocale: firstUnit.sourceLocale ?? "ja-JP",
          }),
        io,
        actor: { userId: "test" },
        supervision: testSupervision(),
      } as never),
    ).rejects.toBeInstanceOf(LocalizeProjectContextStoreRequiredError);
  });

  it("writes all three artifacts from the selected non-blank candidate, and pins every invocation to the policy pair", async () => {
    const smokeBridge = loadSmokeBridge() as {
      bridgeId: string;
      sourceBundleRevision: { revisionId: string };
      units: ReadonlyArray<{
        bridgeUnitId: string;
        sourceLocale?: string;
        sourceRevision: { revisionId: string };
      }>;
    };
    const firstUnit = smokeBridge.units[0];
    if (firstUnit === undefined) {
      throw new Error("smoke bridge fixture must carry a first unit");
    }
    const reads = new Map<string, unknown>([
      ["bridge.json", smokeBridge],
      ["pair-policy.json", loadPreset()],
    ]);
    const { io, writes } = ioFixture(reads);
    const contextArtifacts = new InMemoryContextArtifactRepository();
    // Inject the deterministic target-language provider via the ONLY test seam
    // (`liveFactoryOverride`). No fake provider ships in the command.
    await runLocalizeProjectStageCommand({
      bridgePath: "bridge.json",
      pairPolicyPath: "pair-policy.json",
      outputPath: "out/agentic-loop-bundle.v0.json",
      translatedBundleOutputPath: "out/translated-bridge.json",
      patchReportOutputPath: "out/patch-report.json",
      liveFactoryOverride: () =>
        writtenTranslationFactory({
          bridgeUnitId: firstUnit.bridgeUnitId,
          sourceLocale: firstUnit.sourceLocale ?? "ja-JP",
        }),
      io,
      actor: { userId: "test" },
      supervision: testSupervision(),
      contextArtifactRepository: contextArtifacts,
    });

    // ----- AgenticLoopBundle -----
    const bundle = writes.get("out/agentic-loop-bundle.v0.json") as {
      schemaVersion: string;
      stages: Array<{
        stageName: string;
        invocations: Array<{
          pair: { modelId: string; providerId: string };
          zdr: boolean;
          seed: number;
        }>;
      }>;
      writtenOutcome: {
        status: "written";
        unitId: string;
        selectedCandidateId: string;
        candidates: Array<{ id: string; body: string; kind: "primary" | "repair" }>;
        findings: unknown[];
        qualityFlags: string[];
      };
    };
    expect(bundle).toBeDefined();
    expect(bundle.schemaVersion).toBe("itotori.agentic-loop-bundle.v3");
    const stageNames = bundle.stages.map((s) => s.stageName);
    expect(stageNames).toEqual([
      "context",
      "pre_translation",
      "translation",
      "deterministic_checks",
      "qa_findings",
      "routing",
      "repair",
      "final_draft",
    ]);
    // Every invocation's pair must be the policy pair, AND every
    // invocation must carry the per-stage zdr + seed posture
    // (ITOTORI-234 acceptance criterion #3).
    for (const stage of bundle.stages) {
      for (const invocation of stage.invocations) {
        expect(invocation.pair.modelId).toBe("deepseek/deepseek-v4-flash");
        expect(invocation.pair.providerId).toBe("fireworks");
        expect(invocation.zdr).toBe(true);
        expect(Number.isInteger(invocation.seed)).toBe(true);
        expect(invocation.seed).toBeGreaterThanOrEqual(0);
      }
    }
    // The selected candidate is required and non-blank even before/after QA.
    const selectedCandidate = bundle.writtenOutcome.candidates.find(
      (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
    );
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(bundle.writtenOutcome.unitId).toBe(firstUnit.bridgeUnitId);
    expect(selectedCandidate).toMatchObject({ body: WRITTEN_TARGET_TEXT, kind: "primary" });
    const selectedBody = selectedCandidate?.body ?? "";
    expect(selectedBody.trim()).not.toBe("");

    // ----- Translated bridge bundle -----
    const translated = writes.get("out/translated-bridge.json") as {
      units: Array<{ target: { locale: string; text: string } }>;
    };
    expect(translated).toBeDefined();
    expect(translated.units.length).toBeGreaterThan(0);
    for (const unit of translated.units) {
      expect(unit.target.locale).toBe("en-US");
      // RealLive bracket wrap is an encoding requirement; the interior
      // is the selected candidate body verbatim.
      expect(unit.target.text.startsWith("「")).toBe(true);
      expect(unit.target.text.endsWith("」")).toBe(true);
      expect(unit.target.text).toContain(selectedBody);
    }

    // ----- Patch report -----
    const patchReport = writes.get("out/patch-report.json") as {
      schemaVersion: string;
      pair: { modelId: string; providerId: string };
      sceneId: number;
      translatedTargetText: string;
    };
    expect(patchReport).toBeDefined();
    expect(patchReport.schemaVersion).toBe("itotori.localize-project.patch-report.v0");
    expect(patchReport.pair).toEqual({
      modelId: "deepseek/deepseek-v4-flash",
      providerId: "fireworks",
    });
    expect(patchReport).not.toHaveProperty("enUsSentinel");
    expect(patchReport.sceneId).toBe(1017);
    // The patch-report records the selected text the downstream replay must
    // observe, including the RealLive encoding wrap.
    expect(patchReport.translatedTargetText).toBe(`「${selectedBody}」`);

    // The test seam receives an explicitly injected central repository; the
    // command never constructs an ephemeral fallback of its own.
    const persistedContext = await contextArtifacts.retrieveArtifacts(
      { userId: "test" },
      {
        projectId: smokeBridge.bridgeId,
        localeBranchId: `branch:${firstUnit.sourceRevision.revisionId}`,
        sourceRevisionId: smokeBridge.sourceBundleRevision.revisionId,
      },
    );
    expect(persistedContext.status).toBe("completed");
    expect(persistedContext.matches.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("localize-project-stage durable cost admission", () => {
  it("persists a capped stage run and pauses before its first paid dispatch", async () => {
    const context = await isolatedMigratedContext();
    try {
      const bridge = loadValidStageBridge() as {
        sourceLocale: string;
        units: ReadonlyArray<{
          bridgeUnitId: string;
          sourceRevision: { revisionId: string };
        }>;
      };
      const firstUnit = bridge.units[0];
      if (firstUnit === undefined) {
        throw new Error("valid stage bridge must carry a first unit");
      }
      const reads = new Map<string, unknown>([
        ["bridge.json", bridge],
        ["pair-policy.json", loadPreset()],
      ]);
      const { io } = ioFixture(reads);
      let paidDispatches = 0;
      const capUsd = 0.000001; // itotori-225-audit-allow: focused durable-stage cap is deliberately below the pair-policy worst case

      await expect(
        runLocalizeProjectStageLive({
          bridgePath: "bridge.json",
          pairPolicyPath: "pair-policy.json",
          outputPath: "out/agentic-loop-bundle.v0.json",
          translatedBundleOutputPath: "out/translated-bridge.json",
          patchReportOutputPath: "out/patch-report.json",
          io,
          budgetCapUsd: capUsd,
          databaseUrl: context.databaseUrl,
          liveFactoryOverride: () => () => {
            const provider = new FakeModelProvider();
            return {
              descriptor: provider.descriptor,
              invoke: async (request: ModelInvocationRequest) => {
                paidDispatches += 1;
                return await provider.invoke(request);
              },
            };
          },
        }),
      ).rejects.toBeInstanceOf(InvocationOperationalPauseError);
      expect(paidDispatches).toBe(0);

      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const runs = await repository.loadRunsForBranch(
        { userId: localUserId },
        `branch:${firstUnit.sourceRevision.revisionId}`,
      );
      expect(runs).toHaveLength(1);
      const run = runs[0];
      if (run === undefined) {
        throw new Error("durable stage run was not persisted");
      }
      expect(run).toMatchObject({
        status: "paused",
        pausedBlocker: { kind: "budget_cap" },
        leaseOwnerId: null,
        costPolicy: { budgetCapUsd: capUsd, reservation: "node_4_seam" },
      });
      expect(await repository.loadRunCostAccount({ userId: localUserId }, run.runId)).toMatchObject(
        {
          capUsd: "0.000001",
          spentCostUsd: "0",
          reservedCostUsd: "0",
        },
      );
      expect(await repository.loadAttemptsForRun({ userId: localUserId }, run.runId)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// OpenRouter-served route recording + live-path provider plumbing
// ---------------------------------------------------------------------------

function presetWithStageMaxPriceUsd(maxPriceUsd: number): unknown {
  const preset = loadPreset() as Record<string, unknown>;
  const stages = preset.stages;
  if (typeof stages !== "object" || stages === null || Array.isArray(stages)) {
    throw new Error("test preset missing stages object");
  }
  for (const stageGroup of Object.values(stages)) {
    if (typeof stageGroup !== "object" || stageGroup === null || Array.isArray(stageGroup)) {
      continue;
    }
    for (const leaf of Object.values(stageGroup)) {
      if (typeof leaf === "object" && leaf !== null && !Array.isArray(leaf)) {
        (leaf as Record<string, unknown>).maxPriceUsd = maxPriceUsd;
      }
    }
  }
  return preset;
}

/**
 * Build a ModelProviderError carrying a 429 errorClass. Mirrors what
 * `OpenRouterModelProvider.invoke` raises when the upstream returns HTTP
 * 429 (i.e. OpenRouter already exhausted the ZDR allow-list before
 * surfacing the error to the app).
 */
function http429Error(pair: { modelId: string; providerId: string }): ModelProviderError {
  const descriptor: ProviderDescriptor = {
    family: "openrouter",
    endpointFamily: "chat-completions",
    providerName: "openrouter-mock",
    defaultModelId: pair.modelId,
    capabilities: {
      structuredOutputs: {
        jsonSchema: "supported",
        jsonObject: "supported",
        toolCallArguments: "supported",
        plainJsonExtraction: "supported",
        preferredModes: ["json_schema"],
      },
      toolCalls: {
        support: "supported",
        parallelToolCalls: "supported",
        requiresSchemaPerRequest: true,
      },
      imageInput: { support: "unsupported" },
      routing: {
        providerRouting: "supported",
        modelFallbacks: "supported",
        presets: "supported",
        requireParameters: "supported",
        dataCollectionControl: "supported",
        zeroDataRetentionRouting: "supported",
      },
    },
  };
  const run: ProviderRunRecord = {
    runId: createProviderRunId("test-429"),
    taskKind: "experiment",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    latencyMs: 0,
    status: "failed",
    provider: {
      providerFamily: descriptor.family,
      endpointFamily: descriptor.endpointFamily,
      providerName: descriptor.providerName,
      requestedModelId: pair.modelId,
      requestedProviderId: pair.providerId,
      actualModelId: pair.modelId,
    },
    structuredOutputMode: "none",
    retryCount: 0,
    errorClasses: ["http_429"],
    fallbackUsed: false,
    fallbackPlan: [pair.modelId],
    tokenUsage: { tokenCountSource: "unknown" },
    cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
    routingPosture: localOnlyRoutingPosture(pair.providerId),
    usageResponseJson: { _http_error: 429 },
    prompt: {
      presetId: "test-prompt-preset",
      templateVersion: "v0",
      promptHash: "sha256:test",
    },
  };
  return new ModelProviderError(
    "simulated http 429 from primary",
    "provider_http_error",
    true,
    run,
  );
}

/**
 * Build a fake provider factory whose `invoke` ALWAYS throws the supplied
 * error class. Used to simulate "this whole pair is at quota".
 */
function alwaysFailingFactory(error: ModelProviderError): AgenticLoopProviderFactory {
  return () => ({
    descriptor: {
      family: "fake",
      endpointFamily: "chat-completions",
      providerName: "test-always-failing",
      defaultModelId: "test/always-failing",
      capabilities: {
        structuredOutputs: {
          jsonSchema: "supported",
          jsonObject: "supported",
          toolCallArguments: "supported",
          plainJsonExtraction: "supported",
          preferredModes: ["json_schema"],
        },
        toolCalls: {
          support: "supported",
          parallelToolCalls: "supported",
          requiresSchemaPerRequest: true,
        },
        imageInput: { support: "unsupported" },
        routing: {
          providerRouting: "supported",
          modelFallbacks: "supported",
          presets: "supported",
          requireParameters: "supported",
          dataCollectionControl: "supported",
          zeroDataRetentionRouting: "supported",
        },
      },
    },
    invoke: async (_request: ModelInvocationRequest): Promise<ModelInvocationResult> => {
      throw error;
    },
  });
}

/**
 * Deterministic target-language translation provider for the artifact shape
 * test. This lives in the TEST harness — the shipped command carries no fake
 * provider; the test injects it through the `liveFactoryOverride` seam.
 */
function writtenTranslationFactory(unit: {
  bridgeUnitId: string;
  sourceLocale: string;
}): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `test-written-outcome:${stage}:${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return JSON.stringify({
            schemaVersion: "itotori.speaker-label-output.v1",
            labels: [
              {
                bridgeUnitId: unit.bridgeUnitId,
                speakerId: { kind: "narration" },
                confidence: "high",
                evidenceRefs: [],
                agentRationale: "test narration",
              },
            ],
          });
        }
        if (request.taskKind === "experiment") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "draft_translation") {
          return JSON.stringify({
            schemaVersion: "itotori.structured-translation-draft-output.v1",
            drafts: [
              {
                bridgeUnitId: unit.bridgeUnitId,
                sourceLocale: unit.sourceLocale,
                targetLocale: "en-US",
                draftText: WRITTEN_TARGET_TEXT,
                protectedSpanRefs: [],
                citationRefs: [],
                agentRationale: "test translation",
                confidenceFloor: "medium",
              },
            ],
          });
        }
        if (request.taskKind === "llm_qa") {
          return JSON.stringify({
            schemaVersion: "itotori.structured-qa-finding-output.v1",
            findings: [],
          });
        }
        return "";
      },
    });
}

/**
 * Build a fake provider factory keyed to a (modelId, providerId) pair that
 * emits structurally-correct payloads whose selected candidate carries a
 * caller-supplied marker. The marker proves the written outcome reached the
 * downstream artifacts without imitating source text.
 */
function workingTranslationFactory(
  pair: PairChoice["pair"],
  marker: string,
  bridgeUnitId: string,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `test-working:${pair.providerId}:${stage}:${agentLabel}`,
      modelId: pair.modelId,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return JSON.stringify({
            schemaVersion: "itotori.speaker-label-output.v1",
            labels: [
              {
                bridgeUnitId,
                speakerId: { kind: "narration" },
                confidence: "high",
                evidenceRefs: [],
                agentRationale: "test working",
              },
            ],
          });
        }
        if (request.taskKind === "experiment") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "draft_translation") {
          return JSON.stringify({
            schemaVersion: "itotori.structured-translation-draft-output.v1",
            drafts: [
              {
                bridgeUnitId,
                sourceLocale: "ja-JP",
                targetLocale: "en-US",
                draftText: `${marker} translated`,
                protectedSpanRefs: [],
                citationRefs: [],
                agentRationale: "test working translation",
                confidenceFloor: "medium",
              },
            ],
          });
        }
        if (request.taskKind === "llm_qa") {
          return JSON.stringify({
            schemaVersion: "itotori.structured-qa-finding-output.v1",
            findings: [],
          });
        }
        return "";
      },
    });
}

function providerRunArtifactFromInvocation(
  request: ModelInvocationRequest,
  result: ModelInvocationResult,
): ProviderRunArtifact {
  return {
    schemaVersion: "itotori.provider-run.v0",
    run: result.providerRun,
    request: {
      messageCount: request.messages.length,
      inputClassification: request.inputClassification,
      requestedModelId: request.modelId,
      structuredOutputMode: request.structuredOutput?.mode ?? "none",
      toolCount: request.tools?.length ?? 0,
      rawTextCaptured: false,
      prompt: request.prompt,
      ...(request.preset === undefined ? {} : { providerPreset: request.preset }),
    },
    response: {
      finishReason: result.finishReason,
      contentLength: result.content?.length ?? 0,
      toolCallCount: result.toolCalls.length,
    },
  };
}

describe("OpenRouter-served route recording", () => {
  it("records a served provider different from the requested primary", async () => {
    // Models the post-ITOTORI-241 wire response: the request prefers the
    // primary pair (fireworks = provider.order[0]), while OpenRouter reports
    // DigitalOcean as the served ZDR-allow-list upstream. The app records the
    // served (model, providerId) pair on every provider-run record and does
    // not add an application-level failover loop.
    const SERVED_PROVIDER = "digitalocean";
    const smokeBridge = loadSmokeBridge() as {
      units: ReadonlyArray<{ bridgeUnitId: string }>;
    };
    const firstBridgeUnitId = smokeBridge.units[0]?.bridgeUnitId ?? "test-unit";
    const reads = new Map<string, unknown>([
      ["bridge.json", smokeBridge],
      ["pair-policy.json", loadPreset()],
    ]);
    const { io, writes } = ioFixture(reads);
    const providerRunArtifactDirectory = mkdtempSync(
      join(tmpdir(), "itotori-localize-or-fallback-"),
    );

    const liveFactoryOverride = (
      pair: { modelId: string; providerId: string },
      options: {
        artifactRecorder:
          | { recordProviderRun(artifact: ProviderRunArtifact): Promise<void> }
          | undefined;
      },
    ): AgenticLoopProviderFactory => {
      const delegateFactory = workingTranslationFactory(
        pair,
        "STELLA-WRITTEN-MARKER",
        firstBridgeUnitId,
      );
      return (input) => {
        const delegate = delegateFactory(input);
        return {
          descriptor: delegate.descriptor,
          invoke: async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => {
            const result = await delegate.invoke(request);
            // OpenRouter reported a DIFFERENT upstream than requested
            // order[0]: requested fireworks, served digitalocean.
            const served: ModelInvocationResult = {
              ...result,
              providerRun: {
                ...result.providerRun,
                provider: {
                  ...result.providerRun.provider,
                  requestedProviderId: "fireworks",
                  upstreamProvider: SERVED_PROVIDER,
                },
              },
            };
            if (options.artifactRecorder !== undefined) {
              await options.artifactRecorder.recordProviderRun(
                providerRunArtifactFromInvocation(request, served),
              );
            }
            return served;
          },
        };
      };
    };

    const bundle = await runLocalizeProjectStageCommand({
      bridgePath: "bridge.json",
      pairPolicyPath: "pair-policy.json",
      outputPath: "out/agentic-loop-bundle.v0.json",
      translatedBundleOutputPath: "out/translated-bridge.json",
      patchReportOutputPath: "out/patch-report.json",
      providerRunArtifactDirectory,
      liveFactoryOverride,
      io,
      actor: { userId: "test" },
      supervision: testSupervision(),
      contextArtifactRepository: new InMemoryContextArtifactRepository(),
    });

    // The reported served route is sufficient for the normal run; there is
    // no app-level retry loop.
    const selectedCandidate = bundle.writtenOutcome.candidates.find(
      (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
    );
    expect(selectedCandidate?.body).toContain("STELLA-WRITTEN-MARKER");

    // The patch-report records the REQUESTED primary pair (order[0]); the
    // served upstream lives on the per-invocation provider-run records.
    const patchReport = writes.get("out/patch-report.json") as {
      pair: { modelId: string; providerId: string };
    };
    expect(patchReport.pair.providerId).toBe("fireworks");
    // No superseded failover fields remain on the patch-report shape.
    expect(patchReport).not.toHaveProperty("failoverPredicate");
    expect(patchReport).not.toHaveProperty("failoverAttempts");

    // Every persisted provider-run artifact records the provider OpenRouter
    // reported as served.
    const runDirectories = readdirSync(providerRunArtifactDirectory, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(runDirectories.length).toBeGreaterThan(0);
    for (const runDirectory of runDirectories) {
      const artifact = JSON.parse(
        readFileSync(
          join(providerRunArtifactDirectory, runDirectory.name, "provider-run.json"),
          "utf8",
        ),
      ) as ProviderRunArtifact;
      expect(artifact.run.provider.requestedProviderId).toBe("fireworks");
      expect(artifact.run.provider.upstreamProvider).toBe(SERVED_PROVIDER);
    }
  });

  it("wires a persistent provider-run artifact recorder into the live provider path", async () => {
    const smokeBridge = loadSmokeBridge() as {
      units: ReadonlyArray<{ bridgeUnitId: string; sourceText?: string }>;
    };
    const firstBridgeUnitId = smokeBridge.units[0]?.bridgeUnitId ?? "test-unit";
    const firstSourceText = smokeBridge.units[0]?.sourceText;
    const reads = new Map<string, unknown>([
      ["bridge.json", smokeBridge],
      ["pair-policy.json", loadPreset()],
    ]);
    const { io } = ioFixture(reads);
    const providerRunArtifactDirectory = mkdtempSync(
      join(tmpdir(), "itotori-localize-provider-runs-"),
    );
    let sawRecorder = false;

    const liveFactoryOverride = (
      pair: { modelId: string; providerId: string },
      options: {
        artifactRecorder:
          | { recordProviderRun(artifact: ProviderRunArtifact): Promise<void> }
          | undefined;
      },
    ): AgenticLoopProviderFactory => {
      const delegateFactory = workingTranslationFactory(
        pair,
        "STELLA-WRITTEN-MARKER",
        firstBridgeUnitId,
      );
      return (input) => {
        const delegate = delegateFactory(input);
        return {
          descriptor: delegate.descriptor,
          invoke: async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => {
            const result = await delegate.invoke(request);
            if (options.artifactRecorder !== undefined) {
              sawRecorder = true;
              await options.artifactRecorder.recordProviderRun(
                providerRunArtifactFromInvocation(request, result),
              );
            }
            return result;
          },
        };
      };
    };

    const bundle = await runLocalizeProjectStageCommand({
      bridgePath: "bridge.json",
      pairPolicyPath: "pair-policy.json",
      outputPath: "out/agentic-loop-bundle.v0.json",
      translatedBundleOutputPath: "out/translated-bridge.json",
      patchReportOutputPath: "out/patch-report.json",
      providerRunArtifactDirectory,
      liveFactoryOverride,
      io,
      actor: { userId: "test" },
      supervision: testSupervision(),
      contextArtifactRepository: new InMemoryContextArtifactRepository(),
    });

    const invocationCount = bundle.stages.reduce((sum, stage) => sum + stage.invocations.length, 0);
    const runDirectories = readdirSync(providerRunArtifactDirectory, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(sawRecorder).toBe(true);
    expect(runDirectories).toHaveLength(invocationCount);

    for (const runDirectory of runDirectories) {
      const artifact = JSON.parse(
        readFileSync(
          join(providerRunArtifactDirectory, runDirectory.name, "provider-run.json"),
          "utf8",
        ),
      ) as ProviderRunArtifact;
      expect(artifact.schemaVersion).toBe("itotori.provider-run.v0");
      expect(artifact.run.routingPosture.zdr).toBe(true);
      expect(artifact.run.routingPosture.data_collection).toBe("deny");
      expect(artifact.run.usageResponseJson).toEqual({ _fake_no_billing: true });
      expect(artifact.run.cost.amountMicrosUsd).toBe(0);
      expect(artifact.request.rawTextCaptured).toBe(false);

      const serialized = JSON.stringify(artifact);
      expect(serialized).not.toContain("draftText");
      expect(serialized).not.toContain("test working translation");
      expect(serialized).not.toContain("OPENROUTER_API_KEY");
      expect(serialized).not.toContain("sk-or-");
      if (firstSourceText !== undefined) {
        expect(serialized).not.toContain(firstSourceText);
      }
    }
  });

  it("threads each stage maxPriceUsd into model invocation requests", async () => {
    const smokeBridge = loadSmokeBridge() as {
      units: ReadonlyArray<{ bridgeUnitId: string }>;
    };
    const firstBridgeUnitId = smokeBridge.units[0]?.bridgeUnitId ?? "test-unit";
    const tinyCapUsd = 0.000001;
    const reads = new Map<string, unknown>([
      ["bridge.json", smokeBridge],
      ["pair-policy.json", presetWithStageMaxPriceUsd(tinyCapUsd)],
    ]);
    const { io } = ioFixture(reads);
    const seenMaxPrices: number[] = [];

    const liveFactoryOverride = (
      pair: { modelId: string; providerId: string },
      _options: {
        artifactRecorder:
          | { recordProviderRun(artifact: ProviderRunArtifact): Promise<void> }
          | undefined;
      },
    ): AgenticLoopProviderFactory => {
      const delegateFactory = workingTranslationFactory(
        pair,
        "STELLA-WRITTEN-MARKER",
        firstBridgeUnitId,
      );
      return (input) => {
        const delegate = delegateFactory(input);
        return {
          descriptor: delegate.descriptor,
          invoke: async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => {
            seenMaxPrices.push(request.maxPriceUsd ?? Number.NaN);
            return delegate.invoke(request);
          },
        };
      };
    };

    const bundle = await runLocalizeProjectStageCommand({
      bridgePath: "bridge.json",
      pairPolicyPath: "pair-policy.json",
      outputPath: "out/agentic-loop-bundle.v0.json",
      translatedBundleOutputPath: "out/translated-bridge.json",
      patchReportOutputPath: "out/patch-report.json",
      liveFactoryOverride,
      io,
      actor: { userId: "test" },
      supervision: testSupervision(),
      contextArtifactRepository: new InMemoryContextArtifactRepository(),
    });

    const invocationCount = bundle.stages.reduce((sum, stage) => sum + stage.invocations.length, 0);
    expect(seenMaxPrices).toHaveLength(invocationCount);
    expect(seenMaxPrices.every((value) => value === tinyCapUsd)).toBe(true);
  });

  it("a provider error surfaces verbatim — no app-level retry or provider swap", async () => {
    const reads = new Map<string, unknown>([
      ["bridge.json", loadSmokeBridge()],
      ["pair-policy.json", loadPreset()],
    ]);
    const { io } = ioFixture(reads);
    // An HTTP 429 that reaches the APP means OpenRouter already exhausted
    // the ZDR allow-list. With the app-level alternate-chaining removed,
    // there is nothing to swallow it: the error surfaces verbatim.
    const error = http429Error({
      modelId: "deepseek/deepseek-v4-flash",
      providerId: "fireworks",
    });
    const liveFactoryOverride = (_pair: { modelId: string; providerId: string }) =>
      alwaysFailingFactory(error);
    await expect(
      runLocalizeProjectStageCommand({
        bridgePath: "bridge.json",
        pairPolicyPath: "pair-policy.json",
        outputPath: "out/agentic-loop-bundle.v0.json",
        translatedBundleOutputPath: "out/translated-bridge.json",
        patchReportOutputPath: "out/patch-report.json",
        liveFactoryOverride,
        io,
        actor: { userId: "test" },
        supervision: testSupervision(),
        contextArtifactRepository: new InMemoryContextArtifactRepository(),
      }),
    ).rejects.toMatchObject({
      blocker: { kind: "provider_outage" },
      causeValue: error,
    });
  });
});
