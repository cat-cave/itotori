// Regression: cross-unit speaker-label contamination under bounded concurrency.
//
// Reproduces the North-Star bridge failure (2026-07-13): at client concurrency
// 8 the durable localize run PAUSED with `blocker=itotori_bug` and message
// `speakerLabels[0].bridgeUnitId=<X> must equal <Y>`.
//
// Mechanism (proven here against real Postgres + the real durable journal):
//   - The batch planner groups same-scene units, so each unit's loop call
//     receives its scene siblings (`sceneUnits`).
//   - The scene enrichment is a single-flight shared by every same-scene unit;
//     it resolves the persisted speaker labels of EVERY evidence unit into the
//     shared `contextPacket.speakers`. Once ≥2 siblings have durable labels
//     (e.g. a resume / second pass, or any wave where a sibling persisted
//     first), that shared packet carries multiple bridgeUnitIds.
//   - Before the fix, the loop wrote `contextPacket.speakers` verbatim as the
//     unit's journal-provenance `speakerLabels`. The journal repository's
//     `normalizeSpeakerLabels` requires every persisted label to reference the
//     outcome's OWN bridgeUnitId, so persisting a sibling-inclusive set throws
//     `speakerLabels[0].bridgeUnitId=<sibling> must equal <thisUnit>` — the
//     exact itotori_bug that paused the run. Concurrency=1 hid it because the
//     first pass's single-flight snapshots the scene BEFORE any sibling label
//     is persisted.
//
// The fix scopes the provenance to the unit's OWN label (`ownSpeakerLabels`),
// while sibling labels remain in the shared packet as read-only prompt context.
// This test drives 8 same-scene units at concurrency 8 through the REAL journal
// (which runs the failing assertion) and asserts: no pause, every persisted
// outcome carries only its own label, no cross-unit artifact overwrite, and the
// sibling speaker context is still injected into each unit's prompt.

import { describe, expect, it } from "vitest";
import {
  ItotoriContextArtifactRepository,
  ItotoriLocalizationJournalRepository,
  ItotoriProjectRepository,
  bootstrapLocalUser,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import type { BridgeBundleV02, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { DEV_POLICY, type AgenticLoopProviderFactory } from "../src/orchestrator/agentic-loop.js";
import { speakerLabelArtifactId } from "../src/orchestrator/context-brain.js";
import { runProjectDrivenExecutor } from "../src/orchestrator/project-driven-executor.js";
import { DrivenJournalPersistenceAdapter } from "../src/orchestrator/project-driven-executor-sinks.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { REQUESTED_PROVIDER_UNKNOWN } from "../src/providers/types.js";
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

const ACTOR: AuthorizationActor = { userId: localUserId };
const PROJECT_ID = "019ed0cb-2000-7000-8000-00000000cc01";
const LOCALE_BRANCH_ID = "019ed0cb-2000-7000-8000-00000000cc02";
const SOURCE_REVISION_ID = "019ed0cb-2000-7000-8000-00000000cc03";
const SOURCE_PROFILE_REVISION_ID = "019ed0cb-2000-7000-8000-00000000cc04";
const ASSET_ID = "019ed0cb-2000-7000-8000-00000000cc05";
const SPEAKER_ID = "019ed0cb-2000-7000-8000-00000000cc06";
const BRIDGE_ID = "019ed0cb-2000-7000-8000-00000000cc07";
const SCENE_ID = 7010;
const UNIT_COUNT = 8;
const CONCURRENCY = 8;
const SPEAKER_NAME = "和人";
const RPG_MAKER_MAP_ASSET_KEY = "rpgmaker:Map010.json";
const SOURCE_REVISION_HASH = `sha256:${"a".repeat(64)}`;
const SOURCE_PROFILE_HASH = `sha256:${"b".repeat(64)}`;

function revision(revisionId: string, value: string) {
  return { revisionId, revisionKind: "content_hash" as const, value };
}

// Distinct, well-formed source hashes (content is irrelevant to the race; the
// import path validates hash SHAPE, not that it matches the source text).
function unitId(index: number): string {
  return `019ed0cb-2000-7000-8000-0000000${String(70 + index).padStart(5, "0")}`;
}
function sourceHash(index: number): string {
  return `sha256:${String(index % 10).repeat(64)}`;
}

function makeUnit(index: number): LocalizationUnitV02 {
  const bridgeUnitId = unitId(index);
  const pointer = `/events/1/pages/0/list/${String(index - 1)}/parameters/0`;
  const sourceUnitKey = `${RPG_MAKER_MAP_ASSET_KEY}#${pointer}`;
  const entryPath = pointer.slice(1).split("/");
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey,
    occurrenceId: `crossunit-occurrence-${index}`,
    sourceLocale: "ja-JP",
    sourceText: `セリフ${index}。`,
    sourceHash: sourceHash(index),
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
  const units = Array.from({ length: UNIT_COUNT }, (_, i) => makeUnit(i + 1));
  return {
    schemaVersion: "0.2.0",
    bridgeId: BRIDGE_ID,
    sourceGame: {
      gameId: "crossunit-speaker-label-fixture",
      gameVersion: "1",
      sourceProfileId: "crossunit-profile",
      sourceProfileRevision: revision(SOURCE_PROFILE_REVISION_ID, SOURCE_PROFILE_HASH),
    },
    sourceBundleHash: SOURCE_REVISION_HASH,
    sourceBundleRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
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
    extractor: { name: "crossunit-speaker-label-fixture", version: "1" },
    assets: [
      {
        assetId: ASSET_ID,
        assetKey: RPG_MAKER_MAP_ASSET_KEY,
        assetKind: "text",
        sourceHash: SOURCE_REVISION_HASH,
        sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
      },
    ],
    units,
    policyRecords: [],
  };
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
          messages: Array.from({ length: UNIT_COUNT }, (_, i) => ({
            order: i,
            speaker: SPEAKER_NAME,
            text: `セリフ${i + 1}。`,
            textSurface: null,
          })),
          choices: [],
        },
      ],
    },
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
}

const providerDescriptor: ProviderDescriptor = {
  family: "recorded",
  endpointFamily: "recorded-fixture",
  providerName: "crossunit-speaker-label-fixture",
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

function currentBridgeUnitId(request: ModelInvocationRequest): string {
  const match = JSON.stringify(request).match(/unitId=(019ed0cb-2000-7000-8000-[0-9a-f]{12})/u);
  if (match?.[1] === undefined) {
    throw new Error("fixture provider could not identify the current bridge unit");
  }
  return match[1];
}

function speakerLabelContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: "itotori.speaker-label-output.v1",
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "named", characterId: "kazuto", displayName: "Kazuto" },
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
        draftText: `Kazuto's line for ${bridgeUnitId}.`,
        confidenceFloor: "medium",
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fixture translation",
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

type PromptsByUnit = Map<string, string[]>;

class CrossUnitProvider implements ModelProvider {
  readonly descriptor = providerDescriptor;

  constructor(
    private readonly args: {
      stage: string;
      agentLabel: string;
      translationPromptsByUnit: PromptsByUnit;
    },
  ) {}

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const content = this.responseFor(request);
    const nowIso = new Date().toISOString();
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      providerRun: {
        runId: request.runId ?? createProviderRunId("crossunit-speaker-label"),
        taskKind: request.taskKind,
        startedAt: nowIso,
        completedAt: nowIso,
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
        usageResponseJson: { fixture: "crossunit-speaker-label" },
        prompt: request.prompt,
      },
    };
  }

  private responseFor(request: ModelInvocationRequest): string {
    if (this.args.stage === "context") {
      switch (this.args.agentLabel) {
        case "scene-summary":
          return "SCENE SUMMARY: a quiet morning at the station.";
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
    if (this.args.stage === "translation" || this.args.stage === "repair") {
      const unit = currentBridgeUnitId(request);
      const prompt = request.messages.map((m) => String(m.content)).join("\n");
      const existing = this.args.translationPromptsByUnit.get(unit) ?? [];
      existing.push(prompt);
      this.args.translationPromptsByUnit.set(unit, existing);
      return translationContent(unit);
    }
    if (this.args.stage === "qa_findings") {
      return emptyQaFindingsContent();
    }
    throw new Error(`unexpected executor stage ${this.args.stage}`);
  }
}

function providerFactory(translationPromptsByUnit: PromptsByUnit): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new CrossUnitProvider({ stage, agentLabel, translationPromptsByUnit });
}

async function drivePass(args: {
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0];
  bridge: BridgeBundleV02;
  contextArtifacts: ItotoriContextArtifactRepository;
  translationPromptsByUnit: PromptsByUnit;
}) {
  const journalRepo = new ItotoriLocalizationJournalRepository(args.db);
  const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor: ACTOR });
  const result = await runProjectDrivenExecutor({
    bridge: args.bridge,
    rawBridge: JSON.parse(JSON.stringify(args.bridge)) as unknown,
    pairPolicy: DEV_POLICY,
    pair: { modelId: DEV_PAIR.modelId, providerId: REQUESTED_PROVIDER_UNKNOWN },
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    actor: ACTOR,
    providerFactory: providerFactory(args.translationPromptsByUnit),
    contextArtifactRepository: args.contextArtifacts,
    resolveUnitContext: () => ({ narrativeStructure: makeStructure(), sceneId: SCENE_ID }),
    translationScope: "dialogue-only",
    engineProfile: "rpg-maker-mv-mz",
    concurrency: CONCURRENCY,
    maxRepairAttempts: 0,
    sinks: {
      journal,
      patchExport: { exportPatch: async () => {} },
    },
  });
  return { result, journalRepo };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "cross-unit speaker-label isolation under bounded concurrency (real Postgres)",
  () => {
    it("drives 8 same-scene units at concurrency 8 through the real journal without a cross-unit itotori_bug", async () => {
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

        const allUnitIds = Array.from({ length: UNIT_COUNT }, (_, i) => unitId(i + 1));

        // Pass 1: fresh scene. The scene single-flight snapshots BEFORE any
        // sibling label persists, so each unit writes only its own label.
        const pass1Prompts: PromptsByUnit = new Map();
        const pass1 = await drivePass({
          db: context.db,
          bridge,
          contextArtifacts,
          translationPromptsByUnit: pass1Prompts,
        });
        expect(pass1.result.pausedBlocker).toBeNull();
        expect(pass1.result.unitsRun).toBe(UNIT_COUNT);

        // Every scene sibling now has a durable speaker label. In a second
        // pass the shared single-flight resolves ALL of them into the shared
        // context packet — this is precisely the state the pre-fix code
        // persisted verbatim, tripping `speakerLabels[0].bridgeUnitId ...
        // must equal ...` in the journal for units whose alphabetically-first
        // resolved label is a sibling.
        const persistedLabels = await contextArtifacts.retrieveArtifacts(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          categories: ["speaker_label"],
        });
        expect(persistedLabels.status).toBe("completed");
        expect(persistedLabels.matches.length).toBe(UNIT_COUNT);

        // Pass 2: concurrency 8, siblings resolved. Pre-fix this PAUSES with
        // the cross-unit itotori_bug; post-fix it completes cleanly.
        const pass2Prompts: PromptsByUnit = new Map();
        const pass2 = await drivePass({
          db: context.db,
          bridge,
          contextArtifacts,
          translationPromptsByUnit: pass2Prompts,
        });

        expect(pass2.result.pausedBlocker).toBeNull();
        expect(pass2.result.runState).toBe("running");
        expect(pass2.result.unitsRun).toBe(UNIT_COUNT);

        // Every persisted outcome references ONLY its own bridgeUnitId's
        // speaker label — structural per-unit isolation, no cross-unit leak.
        const outcomes = await pass2.journalRepo.loadRunOutcomes(ACTOR, pass2.result.journalRunId);
        expect(outcomes).toHaveLength(UNIT_COUNT);
        for (const outcome of outcomes) {
          expect(outcome.speakerLabels).toHaveLength(1);
          expect(outcome.speakerLabels[0]?.bridgeUnitId).toBe(outcome.bridgeUnitId);
        }

        // No cross-unit artifact overwrite: each unit's speaker-label artifact
        // still keys to its own bridgeUnitId.
        for (const uid of allUnitIds) {
          const artifact = persistedLabels.matches.find(
            (a) => a.contextArtifactId === speakerLabelArtifactId(PROJECT_ID, uid),
          );
          expect(artifact).toBeDefined();
          expect(artifact?.sourceUnits.some((s) => s.bridgeUnitId === uid)).toBe(true);
        }

        // Sibling context is PRESERVED, not dropped: each unit's translation
        // prompt in pass 2 carries the sibling speaker-label artifact bodies
        // as read-only citation context (the shared packet still exposes
        // them), even though the durable provenance is scoped to the unit.
        for (const uid of allUnitIds) {
          const prompts = pass2Prompts.get(uid);
          expect(prompts, `translation prompt for ${uid}`).toBeDefined();
          const prompt = prompts![prompts!.length - 1]!;
          const siblingIds = allUnitIds.filter((other) => other !== uid);
          const citedSiblingArtifacts = siblingIds.filter((other) =>
            prompt.includes(`contextArtifactId=${speakerLabelArtifactId(PROJECT_ID, other)}`),
          );
          expect(
            citedSiblingArtifacts.length,
            `sibling speaker context for ${uid}`,
          ).toBeGreaterThan(0);
        }
      } finally {
        await context.close();
      }
    }, 180_000);
  },
);
