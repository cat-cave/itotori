// UTSUSHI-228 — unit tests for the localize-sweetie-hd-stage handler.
//
// Covers:
//   - The pair-policy parser accepts the production preset shape.
//   - Missing/malformed pair-policy fields hard-fail (no defaulting).
//   - Per-stage pair must byte-equal the top-level pair (single-game
//     alpha invariant).
//   - The handler refuses to run with `providerKind: "fake"` unless
//     the `ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1` opt-in is set.
//   - The fake-provider mode (opt-in) writes all three artifacts AND
//     the agentic-loop-bundle.v0 carries the (modelId, providerId)
//     pair pinned on every invocation (matching the pair-policy).
//   - The synthesised translated bundle's `target.text` field contains
//     the en-US sentinel substring, wrapped with the SJIS bracket pair
//     (`「…」`) so the KAIFUU-191 lexer classifies it as a Textout run.
//   - The synthesised patch-report.json carries the (modelId,
//     providerId) pair byte-for-byte.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AlphaRerunBlockedExternal,
  LocalizeSweetieHdPairPolicyError,
  LocalizeSweetieHdRefusedFakeError,
  parseLocalizeSweetieHdPairPolicy,
  runLocalizeSweetieHdStageCommand,
  type LocalizeSweetieHdStageIo,
} from "../src/orchestrator/localize-sweetie-hd-stage-command.js";
import {
  PairPolicyVersionMismatchError,
  type PairPolicyV03,
} from "@itotori/localization-bridge-schema";
import {
  createProviderRunId,
  localOnlyRoutingPosture,
  ModelProviderError,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ProviderDescriptor,
  type ProviderRunRecord,
} from "../src/providers/types.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { AgenticLoopProviderFactory, PairChoice } from "../src/orchestrator/agentic-loop.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PAIR_POLICY_PATH = resolve(REPO_ROOT, "presets/localize-sweetie-hd.pair-policy.json");
const SMOKE_BRIDGE_PATH = resolve(
  REPO_ROOT,
  "apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json",
);

function loadPreset(): unknown {
  return JSON.parse(readFileSync(PAIR_POLICY_PATH, "utf8"));
}

function loadSmokeBridge(): unknown {
  return JSON.parse(readFileSync(SMOKE_BRIDGE_PATH, "utf8"));
}

function ioFixture(reads: Map<string, unknown>): {
  io: LocalizeSweetieHdStageIo;
  writes: Map<string, unknown>;
} {
  const writes = new Map<string, unknown>();
  const io: LocalizeSweetieHdStageIo = {
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

describe("UTSUSHI-228 parseLocalizeSweetieHdPairPolicy", () => {
  it("accepts the production preset shape and exposes pair + sentinel", () => {
    const parsed = parseLocalizeSweetieHdPairPolicy(loadPreset());
    expect(parsed.policyId).toBe("localize-sweetie-hd-alpha-1");
    expect(parsed.pair).toEqual({
      modelId: "deepseek/deepseek-v4-flash",
      providerId: "fireworks",
    });
    expect(parsed.enUsSentinel).toBe("STELLA-ALPHA-EN-US-SENTINEL");
    expect(parsed.sceneId).toBe(1);
  });

  it("rejects an object without policyId", () => {
    const preset = loadPreset() as Record<string, unknown>;
    delete preset.policyId;
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
  });

  it("rejects an object with an empty enUsSentinel", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.enUsSentinel = "";
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
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
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseLocalizeSweetieHdPairPolicy("not an object")).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
    expect(() => parseLocalizeSweetieHdPairPolicy(null)).toThrow(LocalizeSweetieHdPairPolicyError);
    expect(() => parseLocalizeSweetieHdPairPolicy([1, 2, 3])).toThrow(
      LocalizeSweetieHdPairPolicyError,
    );
  });

  it("rejects v0.1 schemaVersion with PairPolicyVersionMismatchError (ITOTORI-234 / ITOTORI-238 no-legacy-compat)", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.schemaVersion = "0.1";
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects 'itotori.pair-policy.v0.1' schemaVersion with PairPolicyVersionMismatchError", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.schemaVersion = "itotori.pair-policy.v0.1";
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects v0.2 schemaVersion with PairPolicyVersionMismatchError (ITOTORI-238 no-legacy-compat)", () => {
    const preset = loadPreset() as Record<string, unknown>;
    preset.schemaVersion = "itotori.pair-policy.v0.2";
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects absent schemaVersion with PairPolicyVersionMismatchError", () => {
    const preset = loadPreset() as Record<string, unknown>;
    delete preset.schemaVersion;
    expect(() => parseLocalizeSweetieHdPairPolicy(preset)).toThrow(PairPolicyVersionMismatchError);
  });

  it("resolves per-leaf zdr=true + deterministic seed defaults from the v0.2 file", () => {
    const parsed = parseLocalizeSweetieHdPairPolicy(loadPreset());
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
    // fallbackModels defaults to [].
    expect(parsed.pairPolicy.translation.primary.fallbackModels).toEqual([]);
  });
});

describe("UTSUSHI-228 runLocalizeSweetieHdStageCommand", () => {
  it("refuses providerKind='fake' unless ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1", async () => {
    const prevAllow = process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    try {
      const reads = new Map<string, unknown>([
        ["bridge.json", loadSmokeBridge()],
        ["pair-policy.json", loadPreset()],
      ]);
      const { io } = ioFixture(reads);
      await expect(
        runLocalizeSweetieHdStageCommand({
          bridgePath: "bridge.json",
          pairPolicyPath: "pair-policy.json",
          outputPath: "out/agentic-loop-bundle.v0.json",
          translatedBundleOutputPath: "out/translated-bridge.json",
          patchReportOutputPath: "out/patch-report.json",
          providerKind: "fake",
          io,
          actor: { userId: "test" },
        }),
      ).rejects.toBeInstanceOf(LocalizeSweetieHdRefusedFakeError);
    } finally {
      if (prevAllow === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = prevAllow;
      }
    }
  });

  it("writes all three artifacts, embeds the sentinel, and pins every invocation to the policy pair (fake provider, opt-in)", async () => {
    const prevAllow = process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = "1";
    try {
      const reads = new Map<string, unknown>([
        ["bridge.json", loadSmokeBridge()],
        ["pair-policy.json", loadPreset()],
      ]);
      const { io, writes } = ioFixture(reads);
      await runLocalizeSweetieHdStageCommand({
        bridgePath: "bridge.json",
        pairPolicyPath: "pair-policy.json",
        outputPath: "out/agentic-loop-bundle.v0.json",
        translatedBundleOutputPath: "out/translated-bridge.json",
        patchReportOutputPath: "out/patch-report.json",
        providerKind: "fake",
        io,
        actor: { userId: "test" },
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
        finalDraft: { draftText?: string };
      };
      expect(bundle).toBeDefined();
      expect(bundle.schemaVersion).toBe("itotori.agentic-loop-bundle.v2");
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
      // The fake provider embeds the sentinel into the draft text so we
      // can assert the orchestrator surfaced it through final-draft.
      expect(bundle.finalDraft.draftText ?? "").toContain("STELLA-ALPHA-EN-US-SENTINEL");

      // ----- Translated bridge bundle -----
      const translated = writes.get("out/translated-bridge.json") as {
        units: Array<{ target: { locale: string; text: string } }>;
      };
      expect(translated).toBeDefined();
      expect(translated.units.length).toBeGreaterThan(0);
      for (const unit of translated.units) {
        expect(unit.target.locale).toBe("en-US");
        expect(unit.target.text.startsWith("「")).toBe(true);
        expect(unit.target.text.endsWith("」")).toBe(true);
        expect(unit.target.text).toContain("STELLA-ALPHA-EN-US-SENTINEL");
      }

      // ----- Patch report -----
      const patchReport = writes.get("out/patch-report.json") as {
        schemaVersion: string;
        pair: { modelId: string; providerId: string };
        enUsSentinel: string;
        sceneId: number;
        translatedTargetText: string;
      };
      expect(patchReport).toBeDefined();
      expect(patchReport.schemaVersion).toBe("itotori.localize-sweetie-hd.patch-report.v0");
      expect(patchReport.pair).toEqual({
        modelId: "deepseek/deepseek-v4-flash",
        providerId: "fireworks",
      });
      expect(patchReport.enUsSentinel).toBe("STELLA-ALPHA-EN-US-SENTINEL");
      expect(patchReport.sceneId).toBe(1);
      expect(patchReport.translatedTargetText).toContain("STELLA-ALPHA-EN-US-SENTINEL");
    } finally {
      if (prevAllow === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = prevAllow;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ITOTORI-238 — failover orchestration tests
// ---------------------------------------------------------------------------

/**
 * Build a v0.3 preset variant with N explicit alternates added. Used so
 * each failover test can declare exactly the alternate-chain shape it
 * needs (one alternate for the happy-path failover, no alternates for
 * the all-exhausted test, etc.).
 */
function presetWithAlternates(altProviders: ReadonlyArray<string>): unknown {
  const preset = loadPreset() as Record<string, unknown>;
  preset.alternateProviders = altProviders.map((providerId) => ({
    modelId: "deepseek/deepseek-v4-flash",
    providerId,
    capabilitySheet: {
      supportsStructuredOutputJsonSchema: true,
      supportsToolUse: true,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
      evidenceRef:
        "docs/openrouter-integration-evidence/2026-06-26-alt-providers.json (test fixture)",
    },
  }));
  return preset;
}

/**
 * Build a ModelProviderError carrying a 429 errorClass so the driver's
 * `matchesFailoverPredicate` recognises it as the configured failover
 * trigger. Mirrors what `OpenRouterModelProvider.invoke` raises when the
 * upstream returns HTTP 429.
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
    cost: { costKind: "zero", currency: "USD", amountMicrosUsd: 0 },
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
 * Build a fake provider factory keyed to a (modelId, providerId) pair
 * that emits structurally-correct sentinel-carrying payloads. Mirrors
 * the production sentinelFakeFactory so a downstream agentic-loop run
 * actually succeeds when this factory is adopted.
 *
 * The bridgeUnitId is captured here so the speaker-label citation
 * resolver finds a known unit; the smoke bridge fixture's first unit
 * is the canonical alpha-closer scene-1 unit 0.
 */
function workingSentinelFactory(
  pair: PairChoice["pair"],
  sentinel: string,
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
          return `test-working:context:${agentLabel}`;
        }
        if (request.taskKind === "draft_translation") {
          return JSON.stringify({
            schemaVersion: "itotori.structured-translation-draft-output.v1",
            drafts: [
              {
                bridgeUnitId,
                sourceLocale: "ja-JP",
                targetLocale: "en-US",
                draftText: `${sentinel} translated`,
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

describe("ITOTORI-238 failover orchestration", () => {
  it("failover-on-429: adopts the next declared alternate when the primary returns http_429", async () => {
    const prevAllow = process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = "1";
    try {
      const preset = presetWithAlternates(["deepinfra"]);
      const smokeBridge = loadSmokeBridge() as {
        units: ReadonlyArray<{ bridgeUnitId: string }>;
      };
      const firstBridgeUnitId = smokeBridge.units[0]?.bridgeUnitId ?? "test-unit";
      const reads = new Map<string, unknown>([
        ["bridge.json", smokeBridge],
        ["pair-policy.json", preset],
      ]);
      const { io, writes } = ioFixture(reads);
      // liveFactoryOverride keyed on providerId: primary='fireworks' fails
      // with http_429; alternate='deepinfra' succeeds with a sentinel-
      // carrying payload.
      const liveFactoryOverride = (pair: { modelId: string; providerId: string }) => {
        if (pair.providerId === "fireworks") {
          return alwaysFailingFactory(http429Error(pair));
        }
        return workingSentinelFactory(pair, "STELLA-ALPHA-EN-US-SENTINEL", firstBridgeUnitId);
      };
      const bundle = await runLocalizeSweetieHdStageCommand({
        bridgePath: "bridge.json",
        pairPolicyPath: "pair-policy.json",
        outputPath: "out/agentic-loop-bundle.v0.json",
        translatedBundleOutputPath: "out/translated-bridge.json",
        patchReportOutputPath: "out/patch-report.json",
        // providerKind defaults to 'live'; with liveFactoryOverride set we
        // bypass the OPENROUTER_API_KEY check.
        liveFactoryOverride,
        io,
        actor: { userId: "test" },
      });
      // The successful run was driven by the deepinfra alternate, so the
      // bundle's invocations all pin (deepinfra, deepseek-v4-flash) — the
      // driver re-points every leaf's pair.
      for (const stage of bundle.stages) {
        for (const invocation of stage.invocations) {
          expect(invocation.pair.providerId).toBe("deepinfra");
        }
      }
      // The patch-report records the driver pair (the pair that actually
      // succeeded) AND the failover-attempt audit trail.
      const patchReport = writes.get("out/patch-report.json") as {
        pair: { modelId: string; providerId: string };
        failoverPredicate: string;
        failoverAttempts: Array<{
          pair: { modelId: string; providerId: string };
          role: string;
          failureClass: string;
        }>;
      };
      expect(patchReport.pair.providerId).toBe("deepinfra");
      expect(patchReport.failoverPredicate).toBe("http_429_from_primary");
      expect(patchReport.failoverAttempts).toHaveLength(1);
      expect(patchReport.failoverAttempts[0]?.role).toBe("primary");
      expect(patchReport.failoverAttempts[0]?.pair.providerId).toBe("fireworks");
      expect(patchReport.failoverAttempts[0]?.failureClass).toBe("http_429");
    } finally {
      if (prevAllow === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = prevAllow;
      }
    }
  });

  it("unknown-error-no-failover: a non-429 ModelProviderError surfaces immediately (silent provider swap forbidden)", async () => {
    const prevAllow = process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = "1";
    try {
      const preset = presetWithAlternates(["deepinfra"]);
      const reads = new Map<string, unknown>([
        ["bridge.json", loadSmokeBridge()],
        ["pair-policy.json", preset],
      ]);
      const { io } = ioFixture(reads);
      // Build a non-429 error — pair_mismatch is one of the audit-focus 3
      // failure modes that MUST surface immediately rather than trigger
      // failover.
      const nonFailoverError = http429Error({
        modelId: "deepseek/deepseek-v4-flash",
        providerId: "fireworks",
      });
      // Mutate the run record so its errorClasses no longer include
      // `http_429` — this simulates a generic provider_http_error (e.g.
      // a 502 from the upstream gateway). The driver MUST NOT failover.
      (nonFailoverError.providerRun as { errorClasses: string[] }).errorClasses = ["http_502"];
      const liveFactoryOverride = (_pair: { modelId: string; providerId: string }) =>
        alwaysFailingFactory(nonFailoverError);
      await expect(
        runLocalizeSweetieHdStageCommand({
          bridgePath: "bridge.json",
          pairPolicyPath: "pair-policy.json",
          outputPath: "out/agentic-loop-bundle.v0.json",
          translatedBundleOutputPath: "out/translated-bridge.json",
          patchReportOutputPath: "out/patch-report.json",
          liveFactoryOverride,
          io,
          actor: { userId: "test" },
        }),
      ).rejects.toBeInstanceOf(ModelProviderError);
      // AND the driver MUST NOT have raised AlphaRerunBlockedExternal —
      // that error is reserved for "every alternate exhausted under the
      // failover predicate". A non-predicate failure surfaces verbatim.
    } finally {
      if (prevAllow === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = prevAllow;
      }
    }
  });

  it("all-exhausted: every declared (primary + alternate) returns http_429 -> AlphaRerunBlockedExternal", async () => {
    const prevAllow = process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
    process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = "1";
    try {
      const preset = presetWithAlternates(["deepinfra"]);
      const reads = new Map<string, unknown>([
        ["bridge.json", loadSmokeBridge()],
        ["pair-policy.json", preset],
      ]);
      const { io } = ioFixture(reads);
      // Both primary and alternate raise http_429 — the driver advances
      // through the chain and ultimately raises AlphaRerunBlockedExternal.
      const liveFactoryOverride = (pair: { modelId: string; providerId: string }) =>
        alwaysFailingFactory(http429Error(pair));
      let thrown: unknown;
      try {
        await runLocalizeSweetieHdStageCommand({
          bridgePath: "bridge.json",
          pairPolicyPath: "pair-policy.json",
          outputPath: "out/agentic-loop-bundle.v0.json",
          translatedBundleOutputPath: "out/translated-bridge.json",
          patchReportOutputPath: "out/patch-report.json",
          liveFactoryOverride,
          io,
          actor: { userId: "test" },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AlphaRerunBlockedExternal);
      const blocked = thrown as AlphaRerunBlockedExternal;
      // Two attempts: primary (fireworks) + one alternate (deepinfra),
      // both reporting failureClass='http_429'.
      expect(blocked.attempts).toHaveLength(2);
      expect(blocked.attempts[0]?.role).toBe("primary");
      expect(blocked.attempts[0]?.pair.providerId).toBe("fireworks");
      expect(blocked.attempts[0]?.failureClass).toBe("http_429");
      expect(blocked.attempts[1]?.role).toBe("alternate");
      expect(blocked.attempts[1]?.pair.providerId).toBe("deepinfra");
      expect(blocked.attempts[1]?.failureClass).toBe("http_429");
    } finally {
      if (prevAllow === undefined) {
        delete process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER;
      } else {
        process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER = prevAllow;
      }
    }
  });

  it("policy v0.3 exposes the alternateProviders[] + failoverPredicate fields verbatim", () => {
    const parsed = parseLocalizeSweetieHdPairPolicy(loadPreset());
    const v03 = parsed.policyV03 as PairPolicyV03;
    expect(v03.failoverPredicate).toBe("http_429_from_primary");
    expect(v03.alternateProviders.length).toBeGreaterThanOrEqual(1);
    const deepinfra = v03.alternateProviders.find((alt) => alt.providerId === "deepinfra");
    expect(deepinfra).toBeDefined();
    expect(deepinfra?.capabilitySheet.supportsStructuredOutputJsonSchema).toBe(true);
    expect(deepinfra?.capabilitySheet.evidenceRef).toContain("2026-06-26-alt-providers.json");
  });
});
