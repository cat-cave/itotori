// p0-core-persistent-context-brain-primary-loop — proves the central context
// store is wired as source/sink in the live loop:
//   1. A semantic call persists an artifact (content + citations + provenance
//      + revision) to the central store.
//   2. The next unit REUSES that artifact (no second scene-summary call).
//   3. The translation prompt contains resolved CONTENT (the actual body
//      text), not just an id.
//   4. Speaker labels are persisted and reused across units.

import { describe, expect, it } from "vitest";
import type { AuthorizationActor } from "@itotori/db";
import type { LocalizationUnitV02 } from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
} from "../src/orchestrator/agentic-loop.js";
import {
  InMemoryContextArtifactRepository,
  sceneSummaryArtifactId,
  speakerLabelArtifactId,
} from "../src/orchestrator/context-brain.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest, ModelProvider } from "../src/providers/types.js";
import {
  parseNarrativeStructure,
  type NarrativeStructure,
} from "../src/agents/structure-informed-context/index.js";

const ACTOR: AuthorizationActor = { userId: "itotori-context-brain-test-actor" };
const PROJECT_ID = "019ed0cb-1000-7000-8000-00000000cb01";
const LOCALE_BRANCH_ID = "019ed0cb-1000-7000-8000-00000000cb02";
const SOURCE_REVISION_ID = "019ed0cb-1000-7000-8000-00000000cb03";
const ASSET_ID = "019ed0cb-1000-7000-8000-00000000cb04";
const SPEAKER_ID = "019ed0cb-1000-7000-8000-00000000cb05";
const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";
// Distinct body so the reuse assertion cannot pass on a structure-only prompt.
const SEMANTIC_SCENE_SUMMARY_BODY =
  "PERSISTED-SEMANTIC-SCENE-SUMMARY: the station scene where 和人 greets the morning sky.";

function makeStructure(): NarrativeStructure {
  return parseNarrativeStructure({
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: SCENE_ID,
    sceneDispatchOrder: [SCENE_ID, 6020],
    scenes: [
      {
        sceneId: SCENE_ID,
        nextScene: 6020,
        messages: [
          { order: 0, speaker: SPEAKER_NAME, text: "おはよう。", textSurface: null },
          { order: 1, speaker: SPEAKER_NAME, text: "今日はいい天気だね。", textSurface: null },
        ],
        choices: [],
      },
      {
        sceneId: 6020,
        nextScene: null,
        messages: [{ order: 0, speaker: "ステラ", text: "そうね。", textSurface: null }],
        choices: [],
      },
    ],
  });
}

function makeUnit(bridgeUnitId: string, sourceText: string): LocalizationUnitV02 {
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: `scene-${SCENE_ID}/line-${bridgeUnitId.slice(-4)}`,
    occurrenceId: `occ-${bridgeUnitId.slice(-4)}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `hash:${bridgeUnitId}`,
    sourceRevision: {
      revisionId: SOURCE_REVISION_ID,
      revisionKind: "content_hash",
      value: "cb-rev",
    },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "ctx-brain-asset" },
    sourceLocation: { containerKey: "ctx-brain-asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: `scene-${SCENE_ID}/line-${bridgeUnitId.slice(-4)}`,
      sourceRevision: {
        revisionId: SOURCE_REVISION_ID,
        revisionKind: "content_hash",
        value: "cb-rev",
      },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makePolicy(): AgenticLoopPolicy {
  let tick = 0;
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 0,
    now: () => {
      const d = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
      d.setUTCSeconds(tick);
      tick += 1;
      return d;
    },
  };
}

function makeInput(
  unit: LocalizationUnitV02,
  store: InMemoryContextArtifactRepository,
): AgenticLoopUnitInput {
  return {
    unit,
    sourceRevisionId: SOURCE_REVISION_ID,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [
      {
        characterId: "wato",
        displayName: SPEAKER_NAME,
        bioLocale: "ja-JP",
        bioText: "Protagonist.",
        hiddenFromReader: false,
      },
    ],
    narrativeStructure: makeStructure(),
    sceneId: SCENE_ID,
    actor: ACTOR,
    contextArtifactRepository: store,
  };
}

function capturingFactory(args: {
  unitA: LocalizationUnitV02;
  unitB: LocalizationUnitV02;
  capturedPrompts: string[];
  sceneSummaryCalls: { count: number };
}): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) => {
    if (stage === "context") {
      if (agentLabel === "scene-summary") {
        return new FakeModelProvider({
          providerName: "ctx-brain-scene-summary",
          generate: () => {
            args.sceneSummaryCalls.count += 1;
            return SEMANTIC_SCENE_SUMMARY_BODY;
          },
        }) as ModelProvider;
      }
      return new FakeModelProvider({
        providerName: `ctx-brain-${agentLabel}`,
        generate: () => fakeSemanticContextContent(agentLabel),
      }) as ModelProvider;
    }
    if (stage === "pre_translation" && agentLabel === "speaker-label") {
      return new FakeModelProvider({
        providerName: "ctx-brain-speaker",
        generate: (request: ModelInvocationRequest) => {
          const prompt = request.messages.map((m) => m.content).join("\n");
          const unitId = prompt.includes(args.unitB.bridgeUnitId)
            ? args.unitB.bridgeUnitId
            : args.unitA.bridgeUnitId;
          return JSON.stringify({
            schemaVersion: "itotori.speaker-label-output.v1",
            labels: [
              {
                bridgeUnitId: unitId,
                speakerId: {
                  kind: "named",
                  characterId: "wato",
                  displayName: SPEAKER_NAME,
                },
                confidence: "high",
                evidenceRefs: [],
                agentRationale: "Roster match on speaker tag.",
              },
            ],
          });
        },
      }) as ModelProvider;
    }
    if (stage === "translation" || stage === "repair") {
      return new FakeModelProvider({
        providerName: "ctx-brain-translation",
        generate: (request: ModelInvocationRequest) => {
          const user = request.messages.find((m) => m.role === "user")?.content ?? "";
          args.capturedPrompts.push(user);
          const unitId = user.includes(args.unitB.bridgeUnitId)
            ? args.unitB.bridgeUnitId
            : args.unitA.bridgeUnitId;
          return JSON.stringify({
            schemaVersion: "itotori.structured-translation-draft-output.v1",
            drafts: [
              {
                bridgeUnitId: unitId,
                sourceLocale: "ja-JP",
                targetLocale: "en-US",
                draftText: "Good morning.",
                confidenceFloor: "medium",
                protectedSpanRefs: [],
                citationRefs: [],
                agentRationale: "Simple greeting.",
              },
            ],
          });
        },
      }) as ModelProvider;
    }
    return new FakeModelProvider({
      providerName: `ctx-brain-qa-${agentLabel}`,
      generate: () =>
        JSON.stringify({
          schemaVersion: "itotori.structured-qa-finding-output.v1",
          findings: [],
        }),
    }) as ModelProvider;
  };
}

describe("persistent context brain — store source/sink + cross-unit reuse", () => {
  it("persists semantic content, reuses it on the next unit, and puts CONTENT in the translation prompt", async () => {
    const store = new InMemoryContextArtifactRepository();
    const unitA = makeUnit("019ed0cb-2000-7000-8000-00000000u00a", "おはよう。");
    const unitB = makeUnit("019ed0cb-2000-7000-8000-00000000u00b", "今日はいい天気だね。");
    const capturedPrompts: string[] = [];
    const sceneSummaryCalls = { count: 0 };
    const factory = capturingFactory({ unitA, unitB, capturedPrompts, sceneSummaryCalls });

    // Unit A — generates + persists scene summary (+ other enrichment).
    await runAgenticLoopForUnit(makeInput(unitA, store), DEV_POLICY, makePolicy(), factory);
    expect(sceneSummaryCalls.count).toBe(1);

    const sceneArtifactId = sceneSummaryArtifactId(PROJECT_ID, String(SCENE_ID));
    const storedAfterA = store.listAll();
    const sceneArtifact = storedAfterA.find((a) => a.contextArtifactId === sceneArtifactId);
    expect(sceneArtifact).toBeDefined();
    expect(sceneArtifact?.body).toBe(SEMANTIC_SCENE_SUMMARY_BODY);
    expect(sceneArtifact?.contentHash).toMatch(/^sha256:/);
    expect(sceneArtifact?.producedByAgent).toBe("scene-summary");
    expect(sceneArtifact?.sourceUnits.length).toBeGreaterThan(0);
    expect(sceneArtifact?.provenance).toEqual(
      expect.objectContaining({
        kind: "semantic_enrichment",
        agentLabel: "scene-summary",
      }),
    );

    // Speaker label persisted for unit A.
    const speakerAId = speakerLabelArtifactId(PROJECT_ID, unitA.bridgeUnitId);
    const speakerA = storedAfterA.find((a) => a.contextArtifactId === speakerAId);
    expect(speakerA).toBeDefined();
    expect(speakerA?.body).toContain(SPEAKER_NAME);
    expect(speakerA?.data).toEqual(
      expect.objectContaining({
        speakerLabel: expect.objectContaining({ bridgeUnitId: unitA.bridgeUnitId }),
      }),
    );

    // Unit A's translation prompt contains the REAL body text, not just an id.
    expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
    const promptA = capturedPrompts[0] ?? "";
    expect(promptA).toContain("Context artifacts (resolved content):");
    expect(promptA).toContain(SEMANTIC_SCENE_SUMMARY_BODY);
    expect(promptA).toContain(sceneArtifactId);
    expect(promptA).not.toContain("Context artifacts available for citation:");

    // Unit B — same scene → MUST reuse the stored scene summary (no second call).
    const callsBeforeB = sceneSummaryCalls.count;
    await runAgenticLoopForUnit(makeInput(unitB, store), DEV_POLICY, makePolicy(), factory);
    expect(sceneSummaryCalls.count).toBe(callsBeforeB);

    // Unit B's prompt still contains the persisted content (reused).
    const promptB = capturedPrompts[capturedPrompts.length - 1] ?? "";
    expect(promptB).toContain(SEMANTIC_SCENE_SUMMARY_BODY);
    expect(promptB).toContain(sceneArtifactId);

    // Speaker label for unit B also persisted (new unit → new label).
    const speakerB = store
      .listAll()
      .find((a) => a.contextArtifactId === speakerLabelArtifactId(PROJECT_ID, unitB.bridgeUnitId));
    expect(speakerB).toBeDefined();
    expect(speakerB?.body).toContain(SPEAKER_NAME);
  });
});
