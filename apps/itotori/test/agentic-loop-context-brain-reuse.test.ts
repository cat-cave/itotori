// Persistent context brain — real Postgres + full-project executor proof.
//
// This deliberately does not use the in-memory context repository or the
// default fake-provider test double. The deterministic transport is only a local provider
// adapter; the behavioral boundary under test is the actual executor wiring
// into the migrated Postgres context-artifact repository.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ItotoriContextArtifactRepository,
  ItotoriEventQueueRepository,
  ItotoriProjectRepository,
  bootstrapLocalUser,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import type { BridgeBundleV02, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { DEV_POLICY, type AgenticLoopProviderFactory } from "../src/orchestrator/agentic-loop.js";
import { speakerLabelArtifactId } from "../src/orchestrator/context-brain.js";
import {
  runProjectDrivenExecutor,
  type DrivenUnitJournalRecord,
} from "../src/orchestrator/project-driven-executor.js";
import { FsDrivenPatchExportSink } from "../src/orchestrator/project-driven-executor-sinks.js";
import { ContextCorrectionService } from "../src/orchestrator/context-correction-service.js";
import { ContextCorrectionRerunWorker } from "../src/orchestrator/context-correction-worker.js";
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
const PERSISTED_SPEAKER_NAME = "Captain Wato";
const PERSISTED_SPEAKER_BODY = "Speaker: Captain Wato (characterId=wato, confidence=high)";
const PERSISTED_SPEAKER_PROMPT = "Captain Wato (persisted speaker label, confidence=high)";
const SOURCE_REVISION_HASH = `sha256:${"a".repeat(64)}`;
const SOURCE_PROFILE_HASH = `sha256:${"b".repeat(64)}`;
const SEMANTIC_SCENE_SUMMARY_BODY =
  "PERSISTED-SEMANTIC-SCENE-SUMMARY: the station scene where 和人 greets the morning sky.";
const CONTEXT_AWARE_DRAFT = "Captain Wato's context-aware greeting.";
const PRIMARY_REPAIR_DRAFT = "Captain Wato's draft before repair.";
const REPAIRED_DRAFT = "Captain Wato's repaired context-aware greeting.";
const DELIVERED_DRAFT = "Captain Wato's delivered greeting before the context correction.";
const CONTEXT_CORRECTED_DRAFT = "Captain Wato's glossary-corrected greeting.";
const PLAY_TESTER_GLOSSARY_BODY =
  "PLAY-TESTER GLOSSARY: Captain Wato must be rendered as Captain Wato in this scene.";
const QA_FINDING_ID = "019ed0cb-1000-7000-8000-00000000cb31";

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
        speakerId: { kind: "named", characterId: "wato", displayName: PERSISTED_SPEAKER_NAME },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fixture roster match",
      },
    ],
  });
}

function translationContent(bridgeUnitId: string, draftText = "Good morning."): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-translation-draft-output.v1",
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText,
        confidenceFloor: "medium",
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fixture translation",
      },
    ],
  });
}

function qaFindingContent(bridgeUnitId: string, evidenceRef: string): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-qa-finding-output.v1",
    findings: [
      {
        findingId: QA_FINDING_ID,
        bridgeUnitId,
        severity: "minor",
        category: "context-mismatch",
        evidenceRefs: [evidenceRef],
        recommendation: "Use the persisted scene and speaker evidence.",
        agentRationale: "The fixture only emits this finding after receiving the resolved packet.",
      },
    ],
  });
}

function emptyQaFindingsContent(): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-qa-finding-output.v1",
    findings: [],
  });
}

type PromptCaptures = {
  translationByUnit: Map<string, string[]>;
  repairByUnit: Map<string, string[]>;
  qaByUnit: Map<string, string[]>;
};

type ProviderResponseOverride = (args: {
  stage: string;
  agentLabel: string;
  request: ModelInvocationRequest;
  bridgeUnitId: string;
  prompt: string;
}) => string | undefined;

function makePromptCaptures(): PromptCaptures {
  return {
    translationByUnit: new Map<string, string[]>(),
    repairByUnit: new Map<string, string[]>(),
    qaByUnit: new Map<string, string[]>(),
  };
}

function promptFromRequest(request: ModelInvocationRequest): string {
  return request.messages.map((message) => String(message.content)).join("\n");
}

function appendCapturedPrompt(
  promptsByUnit: Map<string, string[]>,
  unitId: string,
  prompt: string,
): void {
  const existing = promptsByUnit.get(unitId) ?? [];
  existing.push(prompt);
  promptsByUnit.set(unitId, existing);
}

function capturedPromptsFor(promptsByUnit: Map<string, string[]>, unitId: string): string[] {
  const prompts = promptsByUnit.get(unitId);
  if (prompts === undefined) {
    throw new Error(`expected captured prompt for bridge unit ${unitId}`);
  }
  return prompts;
}

function expectPromptContainsResolvedArtifacts(
  prompt: string,
  artifacts: ReadonlyArray<{
    contextArtifactId: string;
    title: string;
    body: string;
    headVersionId: string | null;
    contentHash: string;
  }>,
): void {
  expect(prompt).toContain("Context artifacts (resolved content):");
  for (const artifact of artifacts) {
    expect(prompt).toContain(`contextArtifactId=${artifact.contextArtifactId}`);
    expect(prompt).toContain(`title=${JSON.stringify(artifact.title)}`);
    expect(prompt).toContain(artifact.body);
    expect(prompt).toContain(`contentHash=${artifact.contentHash}`);
    if (artifact.headVersionId !== null) {
      expect(prompt).toContain(`contextEntryVersionId=${artifact.headVersionId}`);
    }
  }
}

class DeterministicExecutorProvider implements ModelProvider {
  readonly descriptor = providerDescriptor;

  constructor(
    private readonly args: {
      stage: string;
      agentLabel: string;
      sceneSummaryCalls: { count: number };
      speakerLabelCalls: { count: number };
      prompts: PromptCaptures;
      responseOverride?: ProviderResponseOverride | undefined;
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
      this.args.speakerLabelCalls.count += 1;
      return speakerLabelContent(currentBridgeUnitId(request));
    }
    if (
      this.args.stage === "translation" ||
      this.args.stage === "repair" ||
      this.args.stage === "qa_findings"
    ) {
      const unitId = currentBridgeUnitId(request);
      const prompt = promptFromRequest(request);
      switch (this.args.stage) {
        case "translation":
          appendCapturedPrompt(this.args.prompts.translationByUnit, unitId, prompt);
          break;
        case "repair":
          appendCapturedPrompt(this.args.prompts.repairByUnit, unitId, prompt);
          break;
        case "qa_findings":
          appendCapturedPrompt(this.args.prompts.qaByUnit, unitId, prompt);
          break;
        default:
          throw new Error(`unexpected captured executor stage ${this.args.stage}`);
      }
      const override = this.args.responseOverride?.({
        stage: this.args.stage,
        agentLabel: this.args.agentLabel,
        request,
        bridgeUnitId: unitId,
        prompt,
      });
      if (override !== undefined) {
        return override;
      }
      return this.args.stage === "qa_findings"
        ? emptyQaFindingsContent()
        : translationContent(unitId);
    }
    throw new Error(`unexpected executor stage ${this.args.stage}`);
  }
}

function executorProviderFactory(args: {
  sceneSummaryCalls: { count: number };
  speakerLabelCalls?: { count: number } | undefined;
  prompts?: PromptCaptures | undefined;
  responseOverride?: ProviderResponseOverride | undefined;
}): AgenticLoopProviderFactory {
  const speakerLabelCalls = args.speakerLabelCalls ?? { count: 0 };
  const prompts = args.prompts ?? makePromptCaptures();
  return ({ stage, agentLabel }) =>
    new DeterministicExecutorProvider({
      stage,
      agentLabel,
      sceneSummaryCalls: args.sceneSummaryCalls,
      speakerLabelCalls,
      prompts,
      ...(args.responseOverride !== undefined ? { responseOverride: args.responseOverride } : {}),
    });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "persistent context brain — Postgres-backed full-project reuse",
  () => {
    it("reuses persisted scene and speaker bodies in a later translation and every QA judge", async () => {
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
        const speakerLabelCalls = { count: 0 };
        const prompts = makePromptCaptures();
        const journalUnits: DrivenUnitJournalRecord[] = [];
        let reusePass = false;
        const persistedSpeakerArtifactId = speakerLabelArtifactId(PROJECT_ID, UNIT_A_ID);
        const providerFactory = executorProviderFactory({
          sceneSummaryCalls,
          speakerLabelCalls,
          prompts,
          responseOverride: ({ agentLabel, bridgeUnitId, prompt, stage }) => {
            if (!reusePass) {
              return undefined;
            }
            const hasPersistedPacket =
              prompt.includes(SEMANTIC_SCENE_SUMMARY_BODY) &&
              prompt.includes(PERSISTED_SPEAKER_BODY) &&
              prompt.includes(PERSISTED_SPEAKER_PROMPT) &&
              prompt.includes(
                `contextArtifactId=${speakerLabelArtifactId(PROJECT_ID, bridgeUnitId)}`,
              );
            if (stage === "translation") {
              return translationContent(
                bridgeUnitId,
                hasPersistedPacket ? CONTEXT_AWARE_DRAFT : "Context packet was not reused.",
              );
            }
            if (stage === "qa_findings" && agentLabel === "qa-semantic-drift") {
              return hasPersistedPacket
                ? qaFindingContent(bridgeUnitId, speakerLabelArtifactId(PROJECT_ID, bridgeUnitId))
                : emptyQaFindingsContent();
            }
            return undefined;
          },
        });

        const first = await runProjectDrivenExecutor({
          bridge,
          rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
          pairPolicy: DEV_POLICY,
          pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          actor: ACTOR,
          providerFactory,
          contextArtifactRepository: contextArtifacts,
          resolveUnitContext: () => ({ narrativeStructure: makeStructure(), sceneId: SCENE_ID }),
          translationScope: "dialogue-only",
          engineProfile: "rpg-maker-mv-mz",
          concurrency: 1,
          maxRepairAttempts: 0,
          sinks: {
            journal: {
              // Node 4 requires every driven run to choose an explicit
              // admission authority, including this recorded-provider fixture.
              createCostAdmission: () => ({ admit: async () => ({ admitted: true }) }),
              persistUnitJournal: async (record) => {
                journalUnits.push(record);
              },
              persistFailedUnitAttempts: async () => {},
            },
            patchExport: { exportPatch: async () => {} },
          },
        });

        expect(first.pausedBlocker).toBeNull();
        expect(first.runState).toBe("running");
        expect(first.unitsRun).toBe(2);
        expect(journalUnits).toHaveLength(2);
        expect(sceneSummaryCalls.count).toBe(1);
        expect(speakerLabelCalls.count).toBe(2);

        const persisted = await contextArtifacts.retrieveArtifacts(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          categories: ["scene_summary", "speaker_label"],
        });
        expect(persisted.status).toBe("completed");
        const persistedScene = persisted.matches.find(
          (artifact) => artifact.body === SEMANTIC_SCENE_SUMMARY_BODY,
        );
        if (persistedScene === undefined) {
          throw new Error("first driven pass did not persist the semantic scene body");
        }
        expect(persistedScene).toMatchObject({
          headVersionId: expect.any(String),
          producedByAgent: "scene-summary",
          sourceUnits: expect.arrayContaining([
            expect.objectContaining({ bridgeUnitId: UNIT_A_ID }),
          ]),
        });
        const persistedSpeaker = persisted.matches.find(
          (artifact) => artifact.contextArtifactId === persistedSpeakerArtifactId,
        );
        if (persistedSpeaker === undefined) {
          throw new Error("first driven pass did not persist unit A's speaker label");
        }
        expect(persistedSpeaker).toMatchObject({
          body: PERSISTED_SPEAKER_BODY,
          headVersionId: expect.any(String),
          producedByAgent: "speaker-label",
        });

        const translationCountBeforeReuse = capturedPromptsFor(
          prompts.translationByUnit,
          UNIT_A_ID,
        ).length;
        const qaCountBeforeReuse = capturedPromptsFor(prompts.qaByUnit, UNIT_A_ID).length;
        reusePass = true;
        const reused = await runProjectDrivenExecutor({
          bridge,
          rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
          pairPolicy: DEV_POLICY,
          pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          actor: ACTOR,
          providerFactory,
          contextArtifactRepository: contextArtifacts,
          resolveUnitContext: () => ({ narrativeStructure: makeStructure(), sceneId: SCENE_ID }),
          translationScope: "dialogue-only",
          engineProfile: "rpg-maker-mv-mz",
          concurrency: 1,
          maxRepairAttempts: 0,
          sinks: {
            journal: {
              createCostAdmission: () => ({ admit: async () => ({ admitted: true }) }),
              persistUnitJournal: async (record) => {
                journalUnits.push(record);
              },
              persistFailedUnitAttempts: async () => {},
            },
            patchExport: { exportPatch: async () => {} },
          },
        });

        expect(reused.pausedBlocker).toBeNull();
        expect(reused.runState).toBe("running");
        expect(reused.unitsRun).toBe(2);
        expect(journalUnits).toHaveLength(4);
        expect(sceneSummaryCalls.count).toBe(1);
        // The second pass is a genuine central-store reuse: no label model call
        // may replace the persisted voice identity with fresh telemetry.
        expect(speakerLabelCalls.count).toBe(2);

        const reusedUnitA = reused.unitOutcomes.find(
          (outcome) => outcome.bridgeUnitId === UNIT_A_ID,
        );
        if (reusedUnitA === undefined) {
          throw new Error("second driven pass did not write unit A");
        }
        expect(reusedUnitA.selectedBody).toBe(CONTEXT_AWARE_DRAFT);
        expect(reusedUnitA.outcome.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: "context-mismatch",
            }),
          ]),
        );
        const unitAJournals = journalUnits.filter(
          (record) => record.writtenOutcome.bridgeUnitId === UNIT_A_ID,
        );
        const reusedUnitAJournal = unitAJournals[unitAJournals.length - 1];
        if (reusedUnitAJournal === undefined) {
          throw new Error("second driven pass did not journal unit A's QA evidence");
        }
        expect(Object.values(reusedUnitAJournal.qaDetails)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ evidenceRefs: [persistedSpeakerArtifactId] }),
          ]),
        );

        const reusedTranslationPrompts = capturedPromptsFor(
          prompts.translationByUnit,
          UNIT_A_ID,
        ).slice(translationCountBeforeReuse);
        const reusedQaPrompts = capturedPromptsFor(prompts.qaByUnit, UNIT_A_ID).slice(
          qaCountBeforeReuse,
        );
        expect(reusedTranslationPrompts).toHaveLength(1);
        expect(reusedQaPrompts).toHaveLength(4);
        for (const prompt of [...reusedTranslationPrompts, ...reusedQaPrompts]) {
          expectPromptContainsResolvedArtifacts(prompt, [persistedScene, persistedSpeaker]);
          expect(prompt).toContain(`speaker=${PERSISTED_SPEAKER_PROMPT}`);
          expect(prompt).not.toContain("Context artifacts available for citation:");
        }
      } finally {
        await context.close();
      }
    }, 30_000);

    it("keeps the frozen resolved packet intact for repair and post-repair QA", async () => {
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
        const speakerLabelCalls = { count: 0 };
        const prompts = makePromptCaptures();
        const persistedSpeakerArtifactId = speakerLabelArtifactId(PROJECT_ID, UNIT_A_ID);
        const providerFactory = executorProviderFactory({
          sceneSummaryCalls,
          speakerLabelCalls,
          prompts,
          responseOverride: ({ agentLabel, bridgeUnitId, prompt, stage }) => {
            const hasFrozenPacket =
              prompt.includes(SEMANTIC_SCENE_SUMMARY_BODY) &&
              prompt.includes(PERSISTED_SPEAKER_BODY) &&
              prompt.includes(PERSISTED_SPEAKER_PROMPT) &&
              prompt.includes(
                `contextArtifactId=${speakerLabelArtifactId(PROJECT_ID, bridgeUnitId)}`,
              );
            if (stage === "translation") {
              return translationContent(bridgeUnitId, PRIMARY_REPAIR_DRAFT);
            }
            if (stage === "repair") {
              return translationContent(
                bridgeUnitId,
                hasFrozenPacket ? REPAIRED_DRAFT : "Repair lost the resolved packet.",
              );
            }
            if (
              stage === "qa_findings" &&
              agentLabel === "qa-semantic-drift" &&
              prompt.includes(PRIMARY_REPAIR_DRAFT)
            ) {
              return hasFrozenPacket
                ? qaFindingContent(bridgeUnitId, speakerLabelArtifactId(PROJECT_ID, bridgeUnitId))
                : emptyQaFindingsContent();
            }
            return undefined;
          },
        });

        const result = await runProjectDrivenExecutor({
          bridge,
          rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
          pairPolicy: DEV_POLICY,
          pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          actor: ACTOR,
          providerFactory,
          contextArtifactRepository: contextArtifacts,
          resolveUnitContext: () => ({ narrativeStructure: makeStructure(), sceneId: SCENE_ID }),
          translationScope: "dialogue-only",
          engineProfile: "rpg-maker-mv-mz",
          concurrency: 1,
          maxUnits: 1,
          maxRepairAttempts: 1,
          sinks: {
            journal: {
              createCostAdmission: () => ({ admit: async () => ({ admitted: true }) }),
              persistUnitJournal: async () => {},
              persistFailedUnitAttempts: async () => {},
            },
            patchExport: { exportPatch: async () => {} },
          },
        });

        expect(result.pausedBlocker).toBeNull();
        expect(result.runState).toBe("running");
        expect(result.unitsRun).toBe(1);
        expect(result.patchReport.writtenUnits).toEqual([
          expect.objectContaining({ bridgeUnitId: UNIT_A_ID, selectedBody: REPAIRED_DRAFT }),
        ]);
        expect(sceneSummaryCalls.count).toBe(1);
        expect(speakerLabelCalls.count).toBe(1);

        const persisted = await contextArtifacts.retrieveArtifacts(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          categories: ["scene_summary", "speaker_label"],
        });
        expect(persisted.status).toBe("completed");
        const persistedScene = persisted.matches.find(
          (artifact) => artifact.body === SEMANTIC_SCENE_SUMMARY_BODY,
        );
        const persistedSpeaker = persisted.matches.find(
          (artifact) => artifact.contextArtifactId === persistedSpeakerArtifactId,
        );
        if (persistedScene === undefined || persistedSpeaker === undefined) {
          throw new Error("repair fixture did not persist the context packet artifacts");
        }

        const primaryPrompts = capturedPromptsFor(prompts.translationByUnit, UNIT_A_ID);
        const repairPrompts = capturedPromptsFor(prompts.repairByUnit, UNIT_A_ID);
        const qaPrompts = capturedPromptsFor(prompts.qaByUnit, UNIT_A_ID);
        const initialQaPrompts = qaPrompts.filter((prompt) =>
          prompt.includes(PRIMARY_REPAIR_DRAFT),
        );
        const reQaPrompts = qaPrompts.filter((prompt) => prompt.includes(REPAIRED_DRAFT));
        expect(primaryPrompts).toHaveLength(1);
        expect(repairPrompts).toHaveLength(1);
        expect(initialQaPrompts).toHaveLength(4);
        expect(reQaPrompts).toHaveLength(4);

        // One immutable packet projection must be visible in primary drafting,
        // repair, initial QA, and the bounded re-QA pass. The version ids and
        // hashes prove this is real persisted content, not a citation-only list.
        for (const prompt of [
          ...primaryPrompts,
          ...repairPrompts,
          ...initialQaPrompts,
          ...reQaPrompts,
        ]) {
          expectPromptContainsResolvedArtifacts(prompt, [persistedScene, persistedSpeaker]);
          expect(prompt).toContain(`speaker=${PERSISTED_SPEAKER_PROMPT}`);
        }
      } finally {
        await context.close();
      }
    }, 30_000);

    it("persists a play-tester glossary version, invalidates context, and runs the registered redraft worker", async () => {
      const context = await isolatedMigratedContext();
      try {
        await bootstrapLocalUser(context.db);
        const bridge = makeBridge();
        const projectRepository = new ItotoriProjectRepository(context.db);
        const project = {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          targetLocale: "en-US",
          drafts: {},
          bridge,
        };
        await projectRepository.importSourceBundle(ACTOR, project);

        const contextArtifacts = new ItotoriContextArtifactRepository(context.db);
        const queue = new ItotoriEventQueueRepository(context.db);
        const workDir = mkdtempSync(join(tmpdir(), "itotori-context-correction-"));
        const initialDir = join(workDir, "delivered-before-refresh");
        const refreshDir = join(workDir, "refresh-after-correction");
        const prompts = makePromptCaptures();
        const sceneSummaryCalls = { count: 0 };
        let refreshPass = false;
        const providerFactory = executorProviderFactory({
          sceneSummaryCalls,
          prompts,
          responseOverride: ({ bridgeUnitId, prompt, stage }) => {
            if (stage !== "translation") {
              return undefined;
            }
            if (!refreshPass) {
              return translationContent(
                bridgeUnitId,
                bridgeUnitId === UNIT_A_ID ? DELIVERED_DRAFT : "Delivered unaffected greeting.",
              );
            }
            const reloadedCorrection = prompt.includes(PLAY_TESTER_GLOSSARY_BODY);
            return translationContent(
              bridgeUnitId,
              reloadedCorrection ? CONTEXT_CORRECTED_DRAFT : "Context packet was not reloaded.",
            );
          },
        });
        const initialJournalUnits: DrivenUnitJournalRecord[] = [];

        const initial = await runProjectDrivenExecutor({
          bridge,
          rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
          pairPolicy: DEV_POLICY,
          pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          actor: ACTOR,
          providerFactory,
          contextArtifactRepository: contextArtifacts,
          resolveUnitContext: () => ({ narrativeStructure: makeStructure(), sceneId: SCENE_ID }),
          translationScope: "dialogue-only",
          engineProfile: "rpg-maker-mv-mz",
          concurrency: 1,
          maxRepairAttempts: 0,
          sinks: {
            journal: {
              createCostAdmission: () => ({ admit: async () => ({ admitted: true }) }),
              persistUnitJournal: async (record) => {
                initialJournalUnits.push(record);
              },
              persistFailedUnitAttempts: async () => {},
            },
            patchExport: new FsDrivenPatchExportSink(initialDir),
          },
        });
        expect(initial.patchReport.coverageComplete).toBe(true);
        const deliveredOutcome = initial.unitOutcomes.find(
          (outcome) => outcome.bridgeUnitId === UNIT_A_ID,
        );
        if (deliveredOutcome === undefined) {
          throw new Error("initial delivered run did not persist unit A");
        }
        expect(deliveredOutcome.selectedBody).toBe(DELIVERED_DRAFT);
        const deliveredDrafts = Object.fromEntries(
          initial.unitOutcomes.map((outcome) => [outcome.bridgeUnitId, outcome.selectedBody]),
        );
        await projectRepository.saveDrafts(ACTOR, { ...project, drafts: deliveredDrafts });
        expect(exportedTargetText(initialDir, UNIT_A_ID)).toBe(DELIVERED_DRAFT);
        expect(
          (
            await context.pool.query<{ target_text: string }>(
              "select target_text from itotori_locale_branch_units where locale_branch_id = $1 and bridge_unit_id = $2",
              [LOCALE_BRANCH_ID, UNIT_A_ID],
            )
          ).rows[0]?.target_text,
        ).toBe(DELIVERED_DRAFT);

        const correction = await new ContextCorrectionService({
          actor: ACTOR,
          contextArtifacts,
          jobs: queue,
        }).apply({
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          contextArtifactId: "play-tester-glossary-captain-wato",
          kind: "glossary",
          title: "Captain Wato",
          body: PLAY_TESTER_GLOSSARY_BODY,
          reason: "The play test established the canonical captain title.",
          affectedUnitIds: [UNIT_A_ID],
        });
        const correctionVersionId = correction.contextArtifact.headVersionId;
        if (correctionVersionId === null) {
          throw new Error("correction did not append a canonical context version");
        }
        expect(correction.invalidatedArtifactIds.length).toBeGreaterThan(0);
        const versions = await contextArtifacts.listEntryVersions(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          contextArtifactId: correction.contextArtifact.contextArtifactId,
        });
        expect(versions).toEqual([
          expect.objectContaining({
            contextEntryVersionId: correctionVersionId,
            body: PLAY_TESTER_GLOSSARY_BODY,
            affectedUnitIds: [UNIT_A_ID],
          }),
        ]);
        expect((await queue.getJob(ACTOR, correction.redraftJob.jobId))?.status).toBe("queued");
        // The delivered patch stays available while the refresh waits in the
        // durable queue; no delivery projection is overwritten at schedule time.
        expect(exportedTargetText(initialDir, UNIT_A_ID)).toBe(DELIVERED_DRAFT);

        let refreshRunId: string | undefined;
        const refreshJournalUnits: DrivenUnitJournalRecord[] = [];
        const affectedBridge = {
          ...bridge,
          units: bridge.units.filter((unit) => unit.bridgeUnitId === UNIT_A_ID),
        };
        const worker = new ContextCorrectionRerunWorker({
          queue,
          actor: ACTOR,
          workerId: "context-correction-e2e-worker",
          redrafter: {
            redraft: async (_payload) => {
              refreshPass = true;
              const refresh = await runProjectDrivenExecutor({
                bridge: affectedBridge,
                rawBridge: JSON.parse(JSON.stringify(affectedBridge)) as unknown,
                pairPolicy: DEV_POLICY,
                pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
                projectId: PROJECT_ID,
                localeBranchId: LOCALE_BRANCH_ID,
                sourceRevisionId: SOURCE_REVISION_ID,
                actor: ACTOR,
                providerFactory,
                contextArtifactRepository: contextArtifacts,
                resolveUnitContext: () => ({
                  narrativeStructure: makeStructure(),
                  sceneId: SCENE_ID,
                }),
                translationScope: "dialogue-only",
                engineProfile: "rpg-maker-mv-mz",
                concurrency: 1,
                maxRepairAttempts: 0,
                sinks: {
                  journal: {
                    createCostAdmission: () => ({ admit: async () => ({ admitted: true }) }),
                    persistUnitJournal: async (record) => {
                      refreshJournalUnits.push(record);
                    },
                    persistFailedUnitAttempts: async () => {},
                  },
                  patchExport: new FsDrivenPatchExportSink(refreshDir),
                },
              });
              refreshRunId = refresh.journalRunId;
              const refreshedDrafts = Object.fromEntries(
                refresh.unitOutcomes.map((outcome) => [outcome.bridgeUnitId, outcome.selectedBody]),
              );
              await projectRepository.saveDrafts(ACTOR, {
                ...project,
                drafts: { ...deliveredDrafts, ...refreshedDrafts },
              });
              const resolvedContextVersionsByUnit: Record<string, Record<string, string>> = {};
              let changedDraftCount = 0;
              for (const record of refreshJournalUnits) {
                const packet = record.contextPacket.unitContextPacket;
                if (packet === null || packet === undefined) {
                  throw new Error(
                    `redraft ${record.writtenOutcome.bridgeUnitId} did not resolve a ContextPacket`,
                  );
                }
                resolvedContextVersionsByUnit[record.writtenOutcome.bridgeUnitId] = {
                  ...packet.resolvedFromVersions,
                };
                const selected = refresh.unitOutcomes.find(
                  (outcome) => outcome.bridgeUnitId === record.writtenOutcome.bridgeUnitId,
                );
                if (selected?.selectedBody !== DELIVERED_DRAFT) {
                  changedDraftCount += 1;
                }
              }
              return {
                journalRunId: refresh.journalRunId,
                redraftedUnitIds: refreshJournalUnits.map(
                  (record) => record.writtenOutcome.bridgeUnitId,
                ),
                changedDraftCount,
                resolvedContextVersionsByUnit,
              };
            },
          },
        });
        expect(worker.hasRegisteredHandler()).toBe(true);
        const workerResult = await worker.runAvailable();
        expect(workerResult).toMatchObject({
          claimed: 1,
          succeeded: 1,
          failed: 0,
        });
        if (refreshRunId === undefined) {
          throw new Error("registered context-correction worker did not run the redrafter");
        }

        const refreshedOutcome = refreshJournalUnits.find(
          (record) => record.writtenOutcome.bridgeUnitId === UNIT_A_ID,
        );
        if (refreshedOutcome === undefined) {
          throw new Error("registered redraft did not run unit A");
        }
        expect(
          refreshJournalUnits.find((record) => record.writtenOutcome.bridgeUnitId === UNIT_A_ID)
            ?.writtenOutcome.selectedBody,
        ).toBe(CONTEXT_CORRECTED_DRAFT);
        expect(refreshedOutcome.contextPacket).toMatchObject({
          unitContextPacket: {
            resolvedFromVersions: {
              [correction.contextArtifact.contextArtifactId]: correctionVersionId,
            },
            artifacts: expect.arrayContaining([
              expect.objectContaining({
                contextEntryVersionId: correctionVersionId,
                body: PLAY_TESTER_GLOSSARY_BODY,
              }),
            ]),
          },
        });
        expect(exportedTargetText(refreshDir, UNIT_A_ID)).toBe(CONTEXT_CORRECTED_DRAFT);
        expect(exportedTargetText(initialDir, UNIT_A_ID)).toBe(DELIVERED_DRAFT);
        expect(
          (
            await context.pool.query<{ target_text: string }>(
              "select target_text from itotori_locale_branch_units where locale_branch_id = $1 and bridge_unit_id = $2",
              [LOCALE_BRANCH_ID, UNIT_A_ID],
            )
          ).rows[0]?.target_text,
        ).toBe(CONTEXT_CORRECTED_DRAFT);
        expect((await queue.getJob(ACTOR, correction.redraftJob.jobId))?.status).toBe("succeeded");
      } finally {
        await context.close();
      }
    }, 30_000);
  },
);

function exportedTargetText(runDir: string, bridgeUnitId: string): string | undefined {
  const bridge = JSON.parse(readFileSync(join(runDir, "translated-bridge.json"), "utf8")) as {
    units: Array<{ bridgeUnitId: string; target?: { text?: string } }>;
  };
  return bridge.units.find((unit) => unit.bridgeUnitId === bridgeUnitId)?.target?.text;
}
