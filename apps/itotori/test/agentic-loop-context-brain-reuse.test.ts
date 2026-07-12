// Persistent context brain — real Postgres + full-project executor proof.
//
// This deliberately does not use the in-memory context repository or the
// default fake-provider test double. The deterministic transport is only a local provider
// adapter; the behavioral boundary under test is the actual executor wiring
// into the migrated Postgres context-artifact repository.

import { describe, expect, it } from "vitest";
import {
  ItotoriContextArtifactRepository,
  ItotoriProjectRepository,
  bootstrapLocalUser,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import type { BridgeBundleV02, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { DEV_POLICY, type AgenticLoopProviderFactory } from "../src/orchestrator/agentic-loop.js";
import { runProjectDrivenExecutor } from "../src/orchestrator/project-driven-executor.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import {
  createProviderRunId,
  localOnlyRoutingPosture,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelProvider,
  type ProviderDescriptor,
} from "../src/providers/types.js";
import {
  parseNarrativeStructure,
  type NarrativeStructure,
} from "../src/agents/structure-informed-context/index.js";

const ACTOR: AuthorizationActor = { userId: localUserId };
const PROJECT_ID = "019ed0cb-1000-7000-8000-00000000cb11";
const LOCALE_BRANCH_ID = "019ed0cb-1000-7000-8000-00000000cb12";
const SOURCE_REVISION_ID = "019ed0cb-1000-7000-8000-00000000cb13";
const ASSET_ID = "019ed0cb-1000-7000-8000-00000000cb14";
const SPEAKER_ID = "019ed0cb-1000-7000-8000-00000000cb15";
const BRIDGE_ID = "019ed0cb-1000-7000-8000-00000000cb20";
const UNIT_A_ID = "019ed0cb-1000-7000-8000-00000000cb21";
const UNIT_B_ID = "019ed0cb-1000-7000-8000-00000000cb22";
const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";
const SOURCE_REVISION_HASH = `sha256:${"a".repeat(64)}`;
const SOURCE_PROFILE_HASH = `sha256:${"b".repeat(64)}`;
const SEMANTIC_SCENE_SUMMARY_BODY =
  "PERSISTED-SEMANTIC-SCENE-SUMMARY: the station scene where 和人 greets the morning sky.";

const providerDescriptor: ProviderDescriptor = {
  family: "recorded",
  endpointFamily: "recorded-fixture",
  providerName: "context-brain-postgres-executor-fixture",
  defaultModelId: DEV_PAIR.modelId,
  capabilities: {
    structuredOutputs: {
      jsonSchema: "supported",
      jsonObject: "supported",
      toolCallArguments: "supported",
      plainJsonExtraction: "supported",
      preferredModes: ["json_schema", "json_object", "plain_json"],
    },
    toolCalls: {
      support: "supported",
      parallelToolCalls: "unsupported",
      requiresSchemaPerRequest: false,
    },
    imageInput: { support: "unsupported" },
    routing: {
      providerRouting: "unsupported",
      modelFallbacks: "unsupported",
      presets: "unsupported",
      requireParameters: "unsupported",
      dataCollectionControl: "unsupported",
      zeroDataRetentionRouting: "unsupported",
    },
  },
};

function revision(revisionId: string, value: string) {
  return { revisionId, revisionKind: "content_hash" as const, value };
}

function makeStructure(): NarrativeStructure {
  return parseNarrativeStructure({
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: SCENE_ID,
    sceneDispatchOrder: [SCENE_ID],
    scenes: [
      {
        sceneId: SCENE_ID,
        nextScene: null,
        messages: [
          { order: 0, speaker: SPEAKER_NAME, text: "おはよう。", textSurface: null },
          { order: 1, speaker: SPEAKER_NAME, text: "今日はいい天気だね。", textSurface: null },
        ],
        choices: [],
      },
    ],
  });
}

function makeUnit(bridgeUnitId: string, line: number, sourceText: string): LocalizationUnitV02 {
  const sourceUnitKey = `scene-${SCENE_ID}/line-${String(line).padStart(3, "0")}`;
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey,
    occurrenceId: `context-brain-occurrence-${line}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `sha256:${line === 1 ? "e".repeat(64) : "f".repeat(64)}`,
    sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "context-brain-scenario" },
    sourceLocation: { containerKey: "context-brain-scenario" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: { route: { sceneKey: String(SCENE_ID) } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey,
      sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeBridge(): BridgeBundleV02 {
  const sourceBundleRevision = revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH);
  return {
    schemaVersion: "0.2.0",
    bridgeId: BRIDGE_ID,
    sourceGame: {
      gameId: "context-brain-postgres-fixture",
      gameVersion: "1",
      sourceProfileId: "context-brain-profile",
      sourceProfileRevision: revision("019ed0cb-1000-7000-8000-00000000cb16", SOURCE_PROFILE_HASH),
    },
    sourceBundleHash: SOURCE_REVISION_HASH,
    sourceBundleRevision,
    sourceLocale: "ja-JP",
    hashStrategy: {
      sourceProfile: {
        scope: "source_profile",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceBundle: {
        scope: "source_bundle",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceAsset: { scope: "source_asset", algorithm: "sha256", normalization: "bytes" },
      sourceUnit: {
        scope: "source_unit",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
        fields: ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
      },
      patchExport: {
        scope: "patch_export",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      deltaPackage: {
        scope: "delta_package",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
    },
    extractor: { name: "context-brain-postgres-fixture", version: "1" },
    assets: [
      {
        assetId: ASSET_ID,
        assetKey: "context-brain-scenario",
        assetKind: "text",
        sourceHash: SOURCE_REVISION_HASH,
        sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
      },
    ],
    units: [makeUnit(UNIT_A_ID, 1, "おはよう。"), makeUnit(UNIT_B_ID, 2, "今日はいい天気だね。")],
    policyRecords: [],
  };
}

function currentBridgeUnitId(request: ModelInvocationRequest): string {
  // Context artifact citations can contain earlier same-scene unit ids. The
  // prompt's `unitId=` input line is the actual unit currently being drafted.
  const match = JSON.stringify(request).match(
    /unitId=(019ed0cb-1000-7000-8000-00000000cb(?:21|22))/u,
  );
  if (match === null) {
    throw new Error("deterministic executor provider could not identify the current bridge unit");
  }
  const bridgeUnitId = match[1];
  if (bridgeUnitId === undefined) {
    throw new Error("deterministic executor provider captured no current bridge unit");
  }
  return bridgeUnitId;
}

function speakerLabelContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: "itotori.speaker-label-output.v1",
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "named", characterId: "wato", displayName: SPEAKER_NAME },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fixture roster match",
      },
    ],
  });
}

function translationContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-translation-draft-output.v1",
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText: "Good morning.",
        confidenceFloor: "medium",
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fixture translation",
      },
    ],
  });
}

class DeterministicExecutorProvider implements ModelProvider {
  readonly descriptor = providerDescriptor;

  constructor(
    private readonly args: {
      stage: string;
      agentLabel: string;
      sceneSummaryCalls: { count: number };
      promptsByUnit: Map<string, string>;
    },
  ) {}

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const content = this.responseFor(request);
    const now = new Date().toISOString();
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      providerRun: {
        runId: createProviderRunId("context-brain-postgres-executor"),
        taskKind: request.taskKind,
        startedAt: now,
        completedAt: now,
        latencyMs: 0,
        status: "succeeded",
        provider: {
          providerFamily: this.descriptor.family,
          endpointFamily: this.descriptor.endpointFamily,
          providerName: this.descriptor.providerName,
          requestedModelId: request.modelId,
          requestedProviderId: request.providerId,
          actualModelId: request.modelId,
        },
        structuredOutputMode: request.structuredOutput?.mode ?? "none",
        retryCount: 0,
        errorClasses: [],
        fallbackUsed: false,
        fallbackPlan: [request.modelId],
        tokenUsage: {
          tokenCountSource: "deterministic_counter",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
        cost: { costKind: "zero", currency: "USD", amountUsd: "0", amountMicrosUsd: 0 },
        routingPosture: localOnlyRoutingPosture(request.providerId),
        usageResponseJson: { fixture: "context-brain-postgres-executor" },
        prompt: request.prompt,
      },
    };
  }

  private responseFor(request: ModelInvocationRequest): string {
    if (this.args.stage === "context") {
      switch (this.args.agentLabel) {
        case "scene-summary":
          this.args.sceneSummaryCalls.count += 1;
          return SEMANTIC_SCENE_SUMMARY_BODY;
        case "character-relationship":
          return JSON.stringify({ bios: [], relationships: [] });
        case "terminology-candidate":
          return JSON.stringify({ candidates: [] });
        case "route-choice-map":
          return JSON.stringify({ routes: [], choices: [] });
        default:
          throw new Error(`unexpected context agent ${this.args.agentLabel}`);
      }
    }
    if (this.args.stage === "pre_translation") {
      return speakerLabelContent(currentBridgeUnitId(request));
    }
    if (this.args.stage === "translation") {
      const unitId = currentBridgeUnitId(request);
      this.args.promptsByUnit.set(
        unitId,
        request.messages.map((message) => String(message.content)).join("\n"),
      );
      return translationContent(unitId);
    }
    if (this.args.stage === "qa_findings") {
      return JSON.stringify({
        schemaVersion: "itotori.structured-qa-finding-output.v1",
        findings: [],
      });
    }
    throw new Error(`unexpected executor stage ${this.args.stage}`);
  }
}

function executorProviderFactory(args: {
  sceneSummaryCalls: { count: number };
  promptsByUnit: Map<string, string>;
}): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new DeterministicExecutorProvider({
      stage,
      agentLabel,
      sceneSummaryCalls: args.sceneSummaryCalls,
      promptsByUnit: args.promptsByUnit,
    });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "persistent context brain — Postgres-backed full-project reuse",
  () => {
    it("persists unit A's scene body and reuses it for unit B without a second scene build", async () => {
      const context = await isolatedMigratedContext();
      try {
        await bootstrapLocalUser(context.db);
        const bridge = makeBridge();
        await new ItotoriProjectRepository(context.db).importSourceBundle(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          targetLocale: "en-US",
          drafts: {},
          bridge,
        });
        const contextArtifacts = new ItotoriContextArtifactRepository(context.db);
        const sceneSummaryCalls = { count: 0 };
        const promptsByUnit = new Map<string, string>();
        const journalUnits: unknown[] = [];

        const result = await runProjectDrivenExecutor({
          bridge,
          rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
          pairPolicy: DEV_POLICY,
          pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          actor: ACTOR,
          providerFactory: executorProviderFactory({ sceneSummaryCalls, promptsByUnit }),
          contextArtifactRepository: contextArtifacts,
          resolveUnitContext: () => ({ narrativeStructure: makeStructure(), sceneId: SCENE_ID }),
          translationScope: "dialogue-only",
          engineProfile: "rpg-maker-mv-mz",
          concurrency: 1,
          maxRepairAttempts: 0,
          sinks: {
            journal: {
              persistUnitJournal: async (record) => {
                journalUnits.push(record);
              },
              persistFailedUnitAttempts: async () => {},
            },
            patchExport: { exportPatch: async () => {} },
          },
        });

        expect(result.pausedBlocker).toBeNull();
        expect(result.runState).toBe("running");
        expect(result.unitsRun).toBe(2);
        expect(journalUnits).toHaveLength(2);
        expect(sceneSummaryCalls.count).toBe(1);

        const persisted = await contextArtifacts.retrieveArtifacts(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          categories: ["scene_summary"],
        });
        expect(persisted.status).toBe("completed");
        expect(persisted.matches).toEqual([
          expect.objectContaining({
            body: SEMANTIC_SCENE_SUMMARY_BODY,
            headVersionId: expect.any(String),
            producedByAgent: "scene-summary",
            sourceUnits: expect.arrayContaining([
              expect.objectContaining({ bridgeUnitId: UNIT_A_ID }),
            ]),
          }),
        ]);

        const unitBPrompt = promptsByUnit.get(UNIT_B_ID);
        expect(unitBPrompt).toContain("Context artifacts (resolved content):");
        expect(unitBPrompt).toContain(SEMANTIC_SCENE_SUMMARY_BODY);
        expect(unitBPrompt).toContain(
          `contextEntryVersionId=${persisted.matches[0]?.headVersionId}`,
        );
        expect(unitBPrompt).toContain(`contentHash=${persisted.matches[0]?.contentHash}`);
        expect(unitBPrompt).not.toContain("Context artifacts available for citation:");
      } finally {
        await context.close();
      }
    }, 15_000);
  },
);
