// Persistent context brain — real Postgres + full-project executor proof.
//
// This deliberately does not use the in-memory context repository or the
// default fake-provider test double. The deterministic transport is only a local provider
// adapter; the behavioral boundary under test is the actual executor wiring
// into the migrated Postgres context-artifact repository.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ItotoriContextArtifactRepository,
  ItotoriEventQueueRepository,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriProjectRepository,
  bootstrapLocalUser,
  localUserId,
  type AuthorizationActor,
  type WikiContextEntriesReadModel,
  type WikiContextEntryHistoryReadModel,
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
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  type NarrativeStructure,
} from "../src/structure/index.js";
import type { WikiBrainEditResult } from "../src/wiki/service.js";
import { assertHttpContractOk, startPostgresHttpContractHarness } from "./http-contract-harness.js";

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
const RPG_MAKER_MAP_ASSET_KEY = "rpgmaker:Map001.json";
const RPG_MAKER_UNIT_HASHES = [
  "sha256:0aec2f529887f276a2f89a9ca914df3d1b8e246bc408d4d55244de383a4dfca1",
  "sha256:928e61f8df4cbd30519b9f1577973398ec13063663bc2276900aa965c699a542",
] as const;
const SEMANTIC_SCENE_SUMMARY_BODY =
  "PERSISTED-SEMANTIC-SCENE-SUMMARY: the station scene where 和人 greets the morning sky.";
const CONTEXT_AWARE_DRAFT = "Captain Wato's context-aware greeting.";
const PRIMARY_REPAIR_DRAFT = "Captain Wato's draft before repair.";
const REPAIRED_DRAFT = "Captain Wato's repaired context-aware greeting.";
const DELIVERED_DRAFT = "Captain Wato's delivered greeting before the context correction.";
const CONTEXT_CORRECTED_DRAFT = "Captain Wato's formally delivered wiki-corrected greeting.";
const PLAY_TESTER_SPEAKER_BODY =
  "PLAY-TESTER WIKI CORRECTION: Captain Wato uses a formal naval honorific in this scene.";
const PLAY_TESTER_NOTE_TITLE = "Captain Wato dashboard note";
const PLAY_TESTER_NOTE_BODY =
  "PLAY-TESTER WIKI NOTE: This follow-up line must retain the captain's formal naval honorific.";
const NOTE_CORRECTED_DRAFT = "Captain Wato's dashboard-note-corrected follow-up greeting.";
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
  return parseNarrativeStructure(
    {
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
    },
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
}

function makeUnit(bridgeUnitId: string, line: number, sourceText: string): LocalizationUnitV02 {
  const pointer = `/events/1/pages/0/list/${String(line - 1)}/parameters/0`;
  const sourceUnitKey = `${RPG_MAKER_MAP_ASSET_KEY}#${pointer}`;
  const entryPath = pointer.slice(1).split("/");
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey,
    occurrenceId: `context-brain-occurrence-${line}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: RPG_MAKER_UNIT_HASHES[line - 1]!,
    sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
    sourceAssetRef: { assetId: ASSET_ID, assetKey: RPG_MAKER_MAP_ASSET_KEY },
    sourceLocation: { containerKey: RPG_MAKER_MAP_ASSET_KEY, entryPath },
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
        assetKey: RPG_MAKER_MAP_ASSET_KEY,
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
      terminologyCalls: { count: number };
      terminologyFails: { value: boolean };
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
        // The real durable journal allocates the physical attempt id before
        // provider dispatch. Preserve it when supplied so the journal's
        // canonical outcome provenance refers to a completed attempt.
        runId: request.runId ?? createProviderRunId("context-brain-postgres-executor"),
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
          this.args.terminologyCalls.count += 1;
          // A mechanical failure (unparseable, unsalvageable output) that the
          // supervisor cannot repair — rides retry to the hard-ceiling pause.
          return this.args.terminologyFails.value
            ? "MECHANICALLY BROKEN TERMINOLOGY OUTPUT (unparseable)"
            : JSON.stringify({ candidates: [] });
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
  terminologyCalls?: { count: number } | undefined;
  terminologyFails?: { value: boolean } | undefined;
  prompts?: PromptCaptures | undefined;
  responseOverride?: ProviderResponseOverride | undefined;
}): AgenticLoopProviderFactory {
  const speakerLabelCalls = args.speakerLabelCalls ?? { count: 0 };
  const terminologyCalls = args.terminologyCalls ?? { count: 0 };
  const terminologyFails = args.terminologyFails ?? { value: false };
  const prompts = args.prompts ?? makePromptCaptures();
  return ({ stage, agentLabel }) =>
    new DeterministicExecutorProvider({
      stage,
      agentLabel,
      sceneSummaryCalls: args.sceneSummaryCalls,
      speakerLabelCalls,
      terminologyCalls,
      terminologyFails,
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

    it("resume does not bypass a mechanically-failed enrichment: it re-runs while the successful earlier enrichment is reused", async () => {
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
        const terminologyCalls = { count: 0 };
        // scene-summary runs and persists BEFORE terminology; terminology then
        // mechanically fails on the first pass.
        const terminologyFails = { value: true };
        const providerFactory = executorProviderFactory({
          sceneSummaryCalls,
          terminologyCalls,
          terminologyFails,
        });

        const driveArgs = {
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
          translationScope: "dialogue-only" as const,
          engineProfile: "rpg-maker-mv-mz" as const,
          concurrency: 1,
          maxUnits: 1,
          maxRepairAttempts: 0,
          sinks: {
            journal: {
              createCostAdmission: () => ({ admit: async () => ({ admitted: true }) }),
              persistUnitJournal: async () => {},
              persistFailedUnitAttempts: async () => {},
              pauseRun: async () => {},
            },
            patchExport: { exportPatch: async () => {} },
          },
        };

        // First pass: scene-summary succeeds + persists, terminology fails → PAUSE.
        const paused = await runProjectDrivenExecutor(driveArgs);
        expect(paused.runState).toBe("paused");
        expect(paused.pausedBlocker).not.toBeNull();
        expect(paused.writtenOutcomesPersisted).toBe(0);
        expect(paused.unitsRun).toBe(0);
        expect(sceneSummaryCalls.count).toBe(1);
        const terminologyCallsAfterFailure = terminologyCalls.count;
        expect(terminologyCallsAfterFailure).toBeGreaterThan(0); // the failed enrichment WAS attempted

        // The successful scene-summary is durably persisted; the failed
        // terminology enrichment persisted NOTHING (no stale partial artifact to
        // bypass the re-run).
        const afterFailure = await contextArtifacts.retrieveArtifacts(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          categories: ["scene_summary", "terminology_candidate"],
        });
        expect(afterFailure.status).toBe("completed");
        expect(afterFailure.matches.some((a) => a.body === SEMANTIC_SCENE_SUMMARY_BODY)).toBe(true);
        expect(afterFailure.matches.some((a) => a.category === "terminology_candidate")).toBe(
          false,
        );

        // Resume: re-drive the still-unwritten unit. Terminology now succeeds.
        terminologyFails.value = false;
        const resumed = await runProjectDrivenExecutor(driveArgs);
        expect(resumed.runState).toBe("running");
        expect(resumed.pausedBlocker).toBeNull();
        expect(resumed.unitsRun).toBe(1); // the unit now completes and is written

        // The already-successful scene-summary was REUSED, not re-called.
        expect(sceneSummaryCalls.count).toBe(1);
        // The previously-failed terminology enrichment was RE-RUN on resume — it
        // was NOT skipped/bypassed by a stale partial artifact.
        expect(terminologyCalls.count).toBeGreaterThan(terminologyCallsAfterFailure);
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

    it("runs dashboard wiki POST add and edit corrections through the default production redrafter", async () => {
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
        const workDir = mkdtempSync(join(tmpdir(), "itotori-context-correction-"));
        materializeRpgMakerSource(workDir);
        const initialDir = join(workDir, "delivered-before-refresh");
        const registeredRunDir = join(workDir, "registered-live-pass");
        const registeredBridgePath = join(workDir, "registered-bridge.json");
        const registeredConfigPath = join(workDir, "registered.config.json");
        const registeredPairPolicyPath = join(workDir, "registered.pair-policy.json");
        writeFileSync(registeredBridgePath, `${JSON.stringify(bridge, null, 2)}\n`);
        const rawPairPolicy = JSON.parse(
          readFileSync(
            new URL("./fixtures/agentic-loop-smoke-pair-policy.json", import.meta.url),
            "utf8",
          ),
        ) as unknown;
        writeFileSync(registeredPairPolicyPath, `${JSON.stringify(rawPairPolicy, null, 2)}\n`);
        writeFileSync(
          registeredConfigPath,
          `${JSON.stringify(
            {
              schemaVersion: "itotori.localize-fullproject.config.v0",
              projectId: PROJECT_ID,
              localeBranchId: LOCALE_BRANCH_ID,
              sourceRevisionId: SOURCE_REVISION_ID,
              engineProfile: "rpg-maker-mv-mz",
              targetLocale: "en-US",
              bridgePath: registeredBridgePath,
              pairPolicyPath: registeredPairPolicyPath,
              translationScope: "all",
              concurrency: 1,
              maxRepairAttempts: 0,
            },
            null,
            2,
          )}\n`,
        );
        await new ItotoriLocalizationPassRunConfigRepository(context.db).saveRunConfig(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          configPath: registeredConfigPath,
          dataRoot: workDir,
          pairPolicyPath: registeredPairPolicyPath,
          modelId: DEV_PAIR.modelId,
          providerId: DEV_PAIR.providerId,
          runDir: registeredRunDir,
        });
        const prompts = makePromptCaptures();
        const sceneSummaryCalls = { count: 0 };
        const providerFactory = executorProviderFactory({
          sceneSummaryCalls,
          prompts,
          responseOverride: ({ bridgeUnitId, stage }) => {
            if (stage !== "translation") {
              return undefined;
            }
            return translationContent(
              bridgeUnitId,
              bridgeUnitId === UNIT_A_ID ? DELIVERED_DRAFT : "Delivered unaffected greeting.",
            );
          },
        });

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
              persistUnitJournal: async () => {},
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

        const speakerArtifactId = speakerLabelArtifactId(PROJECT_ID, UNIT_A_ID);
        let added: WikiBrainEditResult | undefined;
        let edited: WikiBrainEditResult | undefined;
        const productionTransport = await withProductionOpenRouterTransport(async (transport) => {
          // This is the actual Studio dashboard's loopback HTTP server over
          // the migrated DB. The only fake is below the production redrafter:
          // OpenRouter's external transport gets deterministic fixture bytes.
          const dashboard = await startPostgresHttpContractHarness({
            databaseUrl: context.databaseUrl,
          });
          try {
            const dashboardList = await dashboard.httpRequest("wiki.list", {
              params: { projectId: PROJECT_ID, localeBranchId: LOCALE_BRANCH_ID },
              query: {
                sourceRevisionId: SOURCE_REVISION_ID,
                kind: "speaker",
                includeStale: true,
              },
            });
            assertHttpContractOk("wiki.list", dashboardList);
            const dashboardEntries = dashboardList.body as WikiContextEntriesReadModel;
            const dashboardSpeaker = dashboardEntries.entries.find(
              (entry) => entry.contextArtifactId === speakerArtifactId,
            );
            if (dashboardSpeaker === undefined || dashboardSpeaker.headVersionId === null) {
              throw new Error("generated speaker enrichment was not visible in the dashboard wiki");
            }
            const generatedSpeakerVersionId = dashboardSpeaker.headVersionId;
            expect(dashboardSpeaker).toMatchObject({
              contextArtifactId: speakerArtifactId,
              category: "speaker_label",
              kind: "speaker",
              body: PERSISTED_SPEAKER_BODY,
              provenance: expect.objectContaining({
                producedByAgent: "speaker-label",
                producedByTool: "tool.context-brain",
              }),
              citations: [
                expect.objectContaining({
                  bridgeUnitId: UNIT_A_ID,
                  citation: `speaker-label:${UNIT_A_ID}`,
                }),
              ],
            });

            const dashboardShow = await dashboard.httpRequest("wiki.show", {
              params: {
                projectId: PROJECT_ID,
                localeBranchId: LOCALE_BRANCH_ID,
                contextArtifactId: speakerArtifactId,
              },
            });
            assertHttpContractOk("wiki.show", dashboardShow);
            expect(dashboardShow.body).toMatchObject({
              entry: expect.objectContaining({
                contextArtifactId: speakerArtifactId,
                body: PERSISTED_SPEAKER_BODY,
                history: [
                  expect.objectContaining({
                    contextEntryVersionId: generatedSpeakerVersionId,
                    body: PERSISTED_SPEAKER_BODY,
                    isHead: true,
                  }),
                ],
              }),
            });

            // Dashboard POST add is a canonical node-8 correction, not a
            // front-end fixture: it must create a version and run a real
            // scoped production full-project rerun for unit A.
            const dashboardAdd = await dashboard.httpRequest("wiki.add", {
              params: { projectId: PROJECT_ID, localeBranchId: LOCALE_BRANCH_ID },
              body: {
                sourceRevisionId: SOURCE_REVISION_ID,
                kind: "note",
                title: PLAY_TESTER_NOTE_TITLE,
                body: PLAY_TESTER_NOTE_BODY,
                reason: "The dashboard play test added delivery guidance for the follow-up line.",
                affectedUnitIds: [UNIT_A_ID],
              },
            });
            assertHttpContractOk("wiki.add", dashboardAdd);
            added = dashboardAdd.body as WikiBrainEditResult;
            expect(added).toMatchObject({
              schemaVersion: "wiki.context.edit.v0.2",
              contextArtifactId: expect.any(String),
              contextEntryVersionId: expect.any(String),
              affectedUnitIds: [UNIT_A_ID],
              rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
              entry: expect.objectContaining({
                category: "context_note",
                kind: "note",
                title: PLAY_TESTER_NOTE_TITLE,
                body: PLAY_TESTER_NOTE_BODY,
              }),
            });
            expect(added.entry.headVersionId).toBe(added.contextEntryVersionId);

            const addedHistoryResponse = await dashboard.httpRequest("wiki.history", {
              params: {
                projectId: PROJECT_ID,
                localeBranchId: LOCALE_BRANCH_ID,
                contextArtifactId: added.contextArtifactId,
              },
            });
            assertHttpContractOk("wiki.history", addedHistoryResponse);
            const addedHistory = addedHistoryResponse.body as WikiContextEntryHistoryReadModel;
            expect(addedHistory).toMatchObject({
              contextArtifactId: added.contextArtifactId,
              headVersionId: added.contextEntryVersionId,
              versions: [
                expect.objectContaining({
                  contextEntryVersionId: added.contextEntryVersionId,
                  parentVersionId: null,
                  body: PLAY_TESTER_NOTE_BODY,
                  isHead: true,
                }),
              ],
            });

            // Dashboard POST edit server-loads the generated entry and only
            // accepts human correction fields. The returned receipt must tell
            // the client that the durable rerun actually succeeded.
            const dashboardEdit = await dashboard.httpRequest("wiki.edit", {
              params: {
                projectId: PROJECT_ID,
                localeBranchId: LOCALE_BRANCH_ID,
                contextArtifactId: speakerArtifactId,
              },
              body: {
                body: PLAY_TESTER_SPEAKER_BODY,
                reason: "The play test corrected the captain's delivery guidance for this scene.",
              },
            });
            assertHttpContractOk("wiki.edit", dashboardEdit);
            edited = dashboardEdit.body as WikiBrainEditResult;
            expect(edited).toMatchObject({
              schemaVersion: "wiki.context.edit.v0.2",
              contextArtifactId: speakerArtifactId,
              contextEntryVersionId: expect.any(String),
              affectedUnitIds: [UNIT_A_ID],
              rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
              entry: expect.objectContaining({
                contextArtifactId: speakerArtifactId,
                category: "speaker_label",
                kind: "speaker",
                body: PLAY_TESTER_SPEAKER_BODY,
              }),
            });
            expect(edited.contextEntryVersionId).not.toBe(generatedSpeakerVersionId);
            expect(edited.entry.headVersionId).toBe(edited.contextEntryVersionId);
            expect(edited.invalidatedArtifactIds.length).toBeGreaterThan(0);

            const editedHistoryResponse = await dashboard.httpRequest("wiki.history", {
              params: {
                projectId: PROJECT_ID,
                localeBranchId: LOCALE_BRANCH_ID,
                contextArtifactId: speakerArtifactId,
              },
            });
            assertHttpContractOk("wiki.history", editedHistoryResponse);
            const editedHistory = editedHistoryResponse.body as WikiContextEntryHistoryReadModel;
            expect(editedHistory.contextArtifactId).toBe(speakerArtifactId);
            expect(editedHistory.headVersionId).toBe(edited.contextEntryVersionId);
            expect(editedHistory.versions.length).toBeGreaterThanOrEqual(2);
            const generatedVersion = editedHistory.versions.find(
              (version) => version.contextEntryVersionId === generatedSpeakerVersionId,
            );
            const canonicalEditVersion = editedHistory.versions.find(
              (version) => version.contextEntryVersionId === edited.contextEntryVersionId,
            );
            if (generatedVersion === undefined || canonicalEditVersion === undefined) {
              throw new Error(
                "dashboard wiki edit history did not retain both generated and canonical versions",
              );
            }
            expect(generatedVersion).toMatchObject({
              contextEntryVersionId: generatedSpeakerVersionId,
              body: PERSISTED_SPEAKER_BODY,
              isHead: false,
            });
            expect(canonicalEditVersion).toMatchObject({
              contextEntryVersionId: edited.contextEntryVersionId,
              parentVersionId: expect.any(String),
              body: PLAY_TESTER_SPEAKER_BODY,
              isHead: true,
              impact: { affectedUnitIds: [UNIT_A_ID] },
              provenance: expect.objectContaining({
                producedByAgent: "play-tester",
                origin: "play_tester_edit",
              }),
            });
            expect(
              editedHistory.versions.some(
                (version) => version.contextEntryVersionId === canonicalEditVersion.parentVersionId,
              ),
            ).toBe(true);
            // The editor corrects canonical prose while preserving the typed
            // speaker identity that the packet resolver uses separately.
            expect(canonicalEditVersion.data).toMatchObject({
              speakerLabel: expect.objectContaining({
                speakerId: expect.objectContaining({ displayName: PERSISTED_SPEAKER_NAME }),
              }),
            });

            const dashboardPostEditShow = await dashboard.httpRequest("wiki.show", {
              params: {
                projectId: PROJECT_ID,
                localeBranchId: LOCALE_BRANCH_ID,
                contextArtifactId: speakerArtifactId,
              },
            });
            assertHttpContractOk("wiki.show", dashboardPostEditShow);
            expect(dashboardPostEditShow.body).toMatchObject({
              entry: expect.objectContaining({
                headVersionId: edited.contextEntryVersionId,
                body: PLAY_TESTER_SPEAKER_BODY,
              }),
            });
            return transport;
          } finally {
            await dashboard.close();
          }
        });
        if (added === undefined || edited === undefined) {
          throw new Error("dashboard POST proof did not return both canonical wiki receipts");
        }
        expect(
          productionTransport.messageTexts.some((message) =>
            message.includes(PLAY_TESTER_NOTE_BODY),
          ),
        ).toBe(true);
        expect(
          productionTransport.messageTexts.some((message) =>
            message.includes(PLAY_TESTER_SPEAKER_BODY),
          ),
        ).toBe(true);

        const queue = new ItotoriEventQueueRepository(context.db);
        const addedRunId = successfulRedraftJournalRunId(
          await queue.getJob(ACTOR, added.redraftJobId),
          { bridgeUnitId: UNIT_A_ID, contextEntryVersionId: added.contextEntryVersionId },
        );
        const editedRunId = successfulRedraftJournalRunId(
          await queue.getJob(ACTOR, edited.redraftJobId),
          { bridgeUnitId: UNIT_A_ID, contextEntryVersionId: edited.contextEntryVersionId },
        );
        const journal = new ItotoriLocalizationJournalRepository(context.db);
        const [addedJournalUnits, editedJournalUnits] = await Promise.all([
          journal.loadRunOutcomes(ACTOR, addedRunId),
          journal.loadRunOutcomes(ACTOR, editedRunId),
        ]);
        const addedOutcome = requiredJournalOutcome(
          addedJournalUnits,
          UNIT_A_ID,
          "dashboard wiki add",
        );
        expect(
          addedOutcome.outcome.candidates.find(
            (candidate) => candidate.id === addedOutcome.outcome.selectedCandidateId,
          )?.body,
        ).toBe(NOTE_CORRECTED_DRAFT);
        expect(addedOutcome.contextPacket).toMatchObject({
          unitContextPacket: {
            resolvedFromVersions: {
              [added.contextArtifactId]: added.contextEntryVersionId,
            },
            artifacts: expect.arrayContaining([
              expect.objectContaining({
                contextArtifactId: added.contextArtifactId,
                contextEntryVersionId: added.contextEntryVersionId,
                body: PLAY_TESTER_NOTE_BODY,
              }),
            ]),
          },
        });

        const editedOutcome = requiredJournalOutcome(
          editedJournalUnits,
          UNIT_A_ID,
          "dashboard wiki edit",
        );
        expect(
          editedOutcome.outcome.candidates.find(
            (candidate) => candidate.id === editedOutcome.outcome.selectedCandidateId,
          )?.body,
        ).toBe(CONTEXT_CORRECTED_DRAFT);
        expect(editedOutcome.contextPacket).toMatchObject({
          unitContextPacket: {
            resolvedFromVersions: {
              [edited.contextArtifactId]: edited.contextEntryVersionId,
            },
            artifacts: expect.arrayContaining([
              expect.objectContaining({
                contextArtifactId: edited.contextArtifactId,
                contextEntryVersionId: edited.contextEntryVersionId,
                body: PLAY_TESTER_SPEAKER_BODY,
              }),
            ]),
          },
        });

        const addRunDir = join(registeredRunDir, "context-corrections", added.redraftJobId);
        const editRunDir = join(registeredRunDir, "context-corrections", edited.redraftJobId);
        expect(exportedTargetText(addRunDir, UNIT_A_ID)).toBe(NOTE_CORRECTED_DRAFT);
        expect(exportedTargetText(editRunDir, UNIT_A_ID)).toBe(CONTEXT_CORRECTED_DRAFT);
        expect(exportedTargetText(initialDir, UNIT_A_ID)).toBe(DELIVERED_DRAFT);
        expect(readFileSync(join(addRunDir, "patched-game", "Map001.json"), "utf8")).toContain(
          NOTE_CORRECTED_DRAFT,
        );
        expect(readFileSync(join(editRunDir, "patched-game", "Map001.json"), "utf8")).toContain(
          CONTEXT_CORRECTED_DRAFT,
        );
        expect(
          readFileSync(join(editRunDir, "rpgmaker-delta.kaifuu"), "utf8").length,
        ).toBeGreaterThan(0);
        const persistedTargets = await context.pool.query<{
          bridge_unit_id: string;
          target_text: string;
        }>(
          `select bridge_unit_id, target_text
           from itotori_locale_branch_units
           where locale_branch_id = $1 and bridge_unit_id = $2`,
          [LOCALE_BRANCH_ID, UNIT_A_ID],
        );
        expect(
          Object.fromEntries(
            persistedTargets.rows.map((row) => [row.bridge_unit_id, row.target_text]),
          ),
        ).toEqual({
          [UNIT_A_ID]: CONTEXT_CORRECTED_DRAFT,
        });
      } finally {
        await context.close();
      }
      // Heavy live e2e: dashboard POST add+edit → production redrafter → real
      // Kaifuu delivery over HTTP. Its sibling (parent+child edit) runs ~25s
      // locally; CI is slower, so 45s tips over. Give it a generous ceiling.
    }, 180_000);
  },
);

function exportedTargetText(runDir: string, bridgeUnitId: string): string | undefined {
  const bridge = JSON.parse(readFileSync(join(runDir, "translated-bridge.json"), "utf8")) as {
    units: Array<{ bridgeUnitId: string; target?: { text?: string } }>;
  };
  return bridge.units.find((unit) => unit.bridgeUnitId === bridgeUnitId)?.target?.text;
}

function materializeRpgMakerSource(root: string): void {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "Map001.json"),
    `${JSON.stringify({
      events: [
        null,
        {
          id: 1,
          pages: [
            {
              list: [
                { code: 401, indent: 0, parameters: ["おはよう。"] },
                { code: 401, indent: 0, parameters: ["今日はいい天気だね。"] },
              ],
            },
          ],
        },
      ],
    })}\n`,
  );
}

type ProductionOpenRouterTransport = {
  messageTexts: string[];
};

// Keep the real default `DbBackedContextCorrectionRedrafter` and its
// `runLocalizeFullProjectLive` boundary intact. Only its external OpenRouter
// HTTP transport is deterministic, while loopback dashboard requests continue
// to reach the real server and Postgres.
async function withProductionOpenRouterTransport<T>(
  callback: (transport: ProductionOpenRouterTransport) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalZdrAssertion = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
  const transport: ProductionOpenRouterTransport = { messageTexts: [] };
  process.env.OPENROUTER_API_KEY = "test-context-correction-production-transport";
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED = "1";
  vi.stubGlobal("fetch", (async (input, init) => {
    if (fetchInputUrl(input) !== "https://openrouter.ai/api/v1/chat/completions") {
      return await originalFetch(input, init);
    }
    const messageText = openRouterMessageText(init);
    transport.messageTexts.push(messageText);
    return productionOpenRouterResponse(productionRedraftContent(messageText));
  }) as typeof fetch);
  try {
    return await callback(transport);
  } finally {
    vi.unstubAllGlobals();
    restoreEnvironment("OPENROUTER_API_KEY", originalApiKey);
    restoreEnvironment("OPENROUTER_ZDR_ACCOUNT_ASSERTED", originalZdrAssertion);
  }
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function openRouterMessageText(init: Parameters<typeof fetch>[1]): string {
  if (typeof init?.body !== "string") {
    throw new Error("production redrafter transport received a non-string OpenRouter request body");
  }
  const parsed = JSON.parse(init.body) as { messages?: unknown };
  if (!Array.isArray(parsed.messages)) {
    throw new Error("production redrafter transport request omitted chat messages");
  }
  return parsed.messages
    .map((message) => {
      if (message === null || typeof message !== "object") return "";
      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? content : JSON.stringify(content);
    })
    .join("\n");
}

function productionRedraftContent(messageText: string): string {
  if (messageText.includes("You are a localization translation agent.")) {
    const unitId = currentBridgeUnitIdFromWire(messageText);
    if (messageText.includes(PLAY_TESTER_SPEAKER_BODY)) {
      return translationContent(unitId, CONTEXT_CORRECTED_DRAFT);
    }
    if (messageText.includes(PLAY_TESTER_NOTE_BODY)) {
      return translationContent(unitId, NOTE_CORRECTED_DRAFT);
    }
    throw new Error(
      "production redraft translation did not receive the canonical dashboard correction",
    );
  }
  if (messageText.includes("You are a localization QA agent.")) {
    return emptyQaFindingsContent();
  }
  if (messageText.includes("You are a localization speaker-labeling agent.")) {
    return speakerLabelContent(currentBridgeUnitIdFromWire(messageText));
  }
  if (messageText.includes("Summarize the following scene")) {
    return SEMANTIC_SCENE_SUMMARY_BODY;
  }
  if (messageText.includes("return a JSON object naming every character")) {
    return JSON.stringify({ bios: [], relationships: [] });
  }
  if (messageText.includes("surface forms that should become glossary entries")) {
    return JSON.stringify({ candidates: [] });
  }
  if (messageText.includes("return a JSON object naming the routes")) {
    return JSON.stringify({ routes: [], choices: [] });
  }
  throw new Error("production redrafter made an unexpected OpenRouter request");
}

function currentBridgeUnitIdFromWire(messageText: string): string {
  const match = messageText.match(/unitId=(019ed0cb-1000-7000-8000-00000000cb(?:21|22))/u);
  if (match === null || match[1] === undefined) {
    throw new Error("production redrafter transport could not identify the current bridge unit");
  }
  return match[1];
}

function productionOpenRouterResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "gen-context-correction-production-transport",
      model: DEV_PAIR.modelId,
      provider: DEV_PAIR.providerId,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      // Synthetic mock-wire usage.cost lets the unmodified live provider,
      // durable admission, and ledger reconciliation path run without a paid
      // request. It stays far below the fixture policy's real reservation cap.
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.000001 }, // itotori-225-audit-allow: synthetic mock-wire usage.cost for the production transport boundary; never a real captured bill.
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function restoreEnvironment(name: string, priorValue: string | undefined): void {
  if (priorValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = priorValue;
  }
}

function successfulRedraftJournalRunId(
  job: {
    status: string;
    result: Record<string, unknown> | null;
  } | null,
  expected: {
    bridgeUnitId: string;
    contextEntryVersionId: string;
  },
): string {
  if (job === null) {
    throw new Error(
      `dashboard correction did not persist a redraft job for ${expected.bridgeUnitId}`,
    );
  }
  expect(job.status).toBe("succeeded");
  expect(job.result).toMatchObject({
    journalRunId: expect.any(String),
    redraftedUnitIds: [expected.bridgeUnitId],
    changedDraftCount: expect.any(Number),
    contextEntryVersionId: expected.contextEntryVersionId,
  });
  const changedDraftCount = job.result?.["changedDraftCount"];
  if (typeof changedDraftCount !== "number" || changedDraftCount <= 0) {
    throw new Error(`dashboard correction did not durably change ${expected.bridgeUnitId}`);
  }
  const journalRunId = job.result?.["journalRunId"];
  if (typeof journalRunId !== "string" || journalRunId.length === 0) {
    throw new Error(
      `dashboard correction job for ${expected.bridgeUnitId} omitted its journal run`,
    );
  }
  return journalRunId;
}

function requiredJournalOutcome<T extends { bridgeUnitId: string }>(
  outcomes: readonly T[],
  bridgeUnitId: string,
  label: string,
): T {
  const outcome = outcomes.find((candidate) => candidate.bridgeUnitId === bridgeUnitId);
  if (outcome === undefined) {
    throw new Error(`${label} did not durably journal ${bridgeUnitId}`);
  }
  return outcome;
}
