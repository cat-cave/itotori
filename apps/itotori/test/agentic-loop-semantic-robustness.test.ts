// itotori-semantic-agent-uniform-invocation-contract — the loop's context
// stage runs the four semantic enrichment agents under the SAME invocation
// contract as translation / QA / repair: retry-to-valid, then a resumable
// operational pause on genuine exhaustion. There is NO best-effort swallow: a
// MECHANICAL enrichment failure (empty / malformed / unsalvageable model
// output) is NEVER caught-and-degraded — it PROPAGATES (an operational pause
// in a durable run; the raw typed error in unbound/standalone mode) so no unit
// ever drafts with enrichment silently skipped. A VALID result — including a
// valid EMPTY pack — still proceeds.
//
// DB-less, fake-provider-only (unbound/standalone supervisor). Proofs:
//   1. One agent emits an unsalvageable pack → the unit PROPAGATES the
//      mechanical failure (no silent written outcome); the failing agent was
//      retried before it failed loud.
//   2. ALL four agents fail → the unit still PROPAGATES (no silent written
//      outcome) — never a degraded write.
//   3. All four agents succeed → written outcome, four invocations, context
//      stage `succeeded` (no regression).
//   4. Valid EMPTY packs → written outcome + explicit no-content records
//      persisted (valid-empty proceeds, never a false failure).

import { describe, expect, it } from "vitest";
import type { AuthorizationActor } from "@itotori/db";
import type { AgenticLoopBundle, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
} from "../src/orchestrator/agentic-loop.js";
import {
  characterRelationshipArtifactId,
  InMemoryContextArtifactRepository,
} from "../src/orchestrator/context-brain.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  type NarrativeStructure,
} from "../src/structure/index.js";

const ACTOR: AuthorizationActor = { userId: "itotori-semrobust-test-actor" };

const BRIDGE_UNIT_ID = "019ed079-1000-7000-8000-0000000sr001";
const REVISION_ID = "019ed079-1000-7000-8000-0000000sr003";
const ASSET_ID = "019ed079-1000-7000-8000-0000000sr004";
const SPEAKER_ID = "019ed079-1000-7000-8000-0000000sr005";

const SCENE_ID = 7010;
const SPEAKER_NAME = "和人";

const SEMANTIC_AGENTS = [
  "scene-summary",
  "character-relationship",
  "terminology-candidate",
  "route-choice-map",
] as const;
type SemanticAgent = (typeof SEMANTIC_AGENTS)[number];

/** Small but structurally-real decoded structure: a scene, a speaker, a dispatch. */
function makeStructure(): NarrativeStructure {
  return parseNarrativeStructure(
    {
      schemaVersion: "utsushi.narrative-structure.v1",
      entryScene: SCENE_ID,
      sceneDispatchOrder: [SCENE_ID, 7020],
      scenes: [
        {
          sceneId: SCENE_ID,
          nextScene: 7020,
          messages: [
            { order: 0, speaker: SPEAKER_NAME, text: "おはよう。", textSurface: null },
            { order: 1, speaker: null, text: "窓の外には青空が広がっていた。", textSurface: null },
          ],
          choices: [],
        },
        {
          sceneId: 7020,
          nextScene: null,
          messages: [{ order: 0, speaker: "ステラ", text: "そうね。", textSurface: null }],
          choices: [],
        },
      ],
    },
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
}

function makeUnit(sourceText: string): LocalizationUnitV02 {
  return {
    bridgeUnitId: BRIDGE_UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: `scene-${SCENE_ID}/line-000`,
    occurrenceId: "occ-sr-000",
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: "src-hash-semrobust",
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "sr-rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "semrobust-asset" },
    sourceLocation: { containerKey: "semrobust-asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: `scene-${SCENE_ID}/line-000`,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "sr-rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makePolicy(): AgenticLoopPolicy {
  let tick = 0;
  return {
    projectId: "019ed079-1000-7000-8000-0000000sr010",
    localeBranchId: "019ed079-1000-7000-8000-0000000sr011",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 1,
    now: () => {
      const d = new Date(Date.UTC(2026, 6, 4, 12, 0, 0));
      d.setUTCSeconds(tick);
      tick += 1;
      return d;
    },
  };
}

function selectedWrittenCandidateBody(bundle: AgenticLoopBundle): string {
  expect(bundle.writtenOutcome.status).toBe("written");
  const selectedCandidate = bundle.writtenOutcome.candidates.find(
    (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
  );
  expect(selectedCandidate).toBeDefined();
  if (selectedCandidate === undefined) {
    throw new Error("written outcome selectedCandidateId must resolve to a candidate");
  }
  return selectedCandidate.body;
}

function makeSpeakerLabel(unit: LocalizationUnitV02): string {
  return JSON.stringify({
    schemaVersion: "itotori.speaker-label-output.v1",
    labels: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "semrobust-fixture",
      },
    ],
  });
}

function makeTranslation(unit: LocalizationUnitV02): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-translation-draft-output.v1",
    drafts: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        sourceLocale: unit.sourceLocale,
        targetLocale: "en-US",
        draftText: "Good morning.",
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "semrobust-fixture-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

/** Minimal-VALID pack content for a semantic agent (empty packs are valid). */
function validSemanticPack(agentLabel: SemanticAgent): string {
  switch (agentLabel) {
    case "scene-summary":
      return "Synthetic scene summary.";
    case "character-relationship":
      return JSON.stringify({ bios: [], relationships: [] });
    case "terminology-candidate":
      return JSON.stringify({ candidates: [] });
    case "route-choice-map":
      return JSON.stringify({ routes: [], choices: [] });
  }
}

/**
 * Capturing fake factory. Semantic agents in `failing` return EMPTY or
 * MALFORMED model output — an unsalvageable mechanical failure that must
 * PROPAGATE (no swallow); the rest return minimal-valid packs. Records every
 * `draft_translation` user prompt so the deterministic structure block can be
 * asserted when the unit actually completes.
 */
function makeFactory(
  unit: LocalizationUnitV02,
  capturedTranslationPrompts: string[],
  failing: Partial<Record<SemanticAgent, "empty" | "malformed">>,
  attemptCounts?: Map<SemanticAgent, number>,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `semrobust-fake:${stage}:${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSpeakerLabel(unit);
        }
        if (request.taskKind === "experiment") {
          const semanticAgent = agentLabel as SemanticAgent;
          attemptCounts?.set(semanticAgent, (attemptCounts.get(semanticAgent) ?? 0) + 1);
          const mode = failing[semanticAgent];
          if (mode === "empty") return "";
          if (mode === "malformed") {
            // Not parseable JSON → the structured-pack agents throw a parse
            // error. For scene-summary (free text) a malformed JSON is still
            // "valid" free text, so scene-summary is exercised via empty output.
            return "{{{ this is not a valid pack";
          }
          return validSemanticPack(semanticAgent);
        }
        if (request.taskKind === "draft_translation") {
          const userMessage = request.messages?.find((m) => m.role === "user");
          if (userMessage !== undefined) {
            capturedTranslationPrompts.push(userMessage.content);
          }
          return makeTranslation(unit);
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

function makeInput(unit: LocalizationUnitV02): AgenticLoopUnitInput {
  return {
    unit,
    sourceRevisionId: REVISION_ID,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [],
    narrativeStructure: makeStructure(),
    sceneId: SCENE_ID,
    actor: ACTOR,
  };
}

describe("itotori-semantic-agent-uniform-invocation-contract", () => {
  it("one unsalvageable semantic pack → the unit PROPAGATES the mechanical failure (no silent written outcome)", async () => {
    const unit = makeUnit("おはよう。");
    const captured: string[] = [];
    const attemptCounts = new Map<SemanticAgent, number>();

    // route-choice-map emits an unsalvageable pack. In unbound/standalone mode
    // the supervisor retries to the route bound, then surfaces the raw typed
    // mechanical error instead of the old advance-with-drop swallow.
    await expect(
      runAgenticLoopForUnit(
        makeInput(unit),
        DEV_POLICY,
        makePolicy(),
        makeFactory(unit, captured, { "route-choice-map": "malformed" }, attemptCounts),
      ),
    ).rejects.toThrow();

    // retry-to-valid was attempted before failing loud (not a single-shot drop).
    expect(attemptCounts.get("route-choice-map")).toBeGreaterThan(1);
    // No unit ever drafts with enrichment mechanically skipped: the failure
    // aborted before any translation prompt was issued.
    expect(captured).toHaveLength(0);
  });

  it("ALL four semantic agents fail → the unit PROPAGATES (no degraded write)", async () => {
    const unit = makeUnit("おはよう。");
    const captured: string[] = [];
    const attemptCounts = new Map<SemanticAgent, number>();

    await expect(
      runAgenticLoopForUnit(
        makeInput(unit),
        DEV_POLICY,
        makePolicy(),
        makeFactory(
          unit,
          captured,
          {
            "scene-summary": "empty",
            "character-relationship": "malformed",
            "terminology-candidate": "malformed",
            "route-choice-map": "malformed",
          },
          attemptCounts,
        ),
      ),
    ).rejects.toThrow();

    // The FIRST enrichment agent (scene-summary) fails loud after retrying;
    // control never reaches translation, so no degraded outcome is written.
    expect(attemptCounts.get("scene-summary")).toBeGreaterThan(1);
    expect(captured).toHaveLength(0);
  });

  it("all four semantic agents succeed → written outcome, four invocations, context succeeded (no regression)", async () => {
    const unit = makeUnit("おはよう。");
    const captured: string[] = [];
    const bundle = await runAgenticLoopForUnit(
      makeInput(unit),
      DEV_POLICY,
      makePolicy(),
      makeFactory(unit, captured, {}),
    );

    expect(selectedWrittenCandidateBody(bundle)).toBe("Good morning.");
    const contextStage = bundle.stages.find((s) => s.stageName === "context");
    expect(contextStage?.invocations.map((i) => i.agentLabel).sort()).toEqual(
      [...SEMANTIC_AGENTS].sort(),
    );
    expect(contextStage?.outcome).toBe("succeeded");
    // Deterministic context + all semantic refs present.
    const prompt = captured[0] ?? "";
    expect(prompt).toContain("Structure-informed context");
  });

  it("valid EMPTY semantic packs proceed → written outcome + explicit no-content records (valid-empty, never a false failure)", async () => {
    const unit = makeUnit("おはよう。");
    const store = new InMemoryContextArtifactRepository();
    const bundle = await runAgenticLoopForUnit(
      { ...makeInput(unit), contextArtifactRepository: store },
      DEV_POLICY,
      makePolicy(),
      makeFactory(unit, [], {}),
    );

    // Valid-empty is SUCCESS: the unit completes and the context stage succeeds.
    expect(selectedWrittenCandidateBody(bundle)).toBe("Good morning.");
    const contextStage = bundle.stages.find((stage) => stage.stageName === "context");
    expect(contextStage?.outcome).toBe("succeeded");
    const noContentRecords = store.listAll().filter((artifact) => {
      const semanticResult = artifact.data.semanticResult;
      return (
        typeof semanticResult === "object" &&
        semanticResult !== null &&
        !Array.isArray(semanticResult) &&
        (semanticResult as { kind?: unknown }).kind === "no_content"
      );
    });
    expect(noContentRecords).toHaveLength(3);
    expect(noContentRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "character_note", status: "active" }),
        expect.objectContaining({ category: "terminology_candidate", status: "active" }),
        expect.objectContaining({ category: "route_map", status: "active" }),
      ]),
    );
    for (const record of noContentRecords) {
      expect(record.body.trim()).not.toHaveLength(0);
      expect(record.data.semanticResult).toEqual(
        expect.objectContaining({ kind: "no_content", agentLabel: expect.any(String) }),
      );
      expect(record.sourceUnits).not.toHaveLength(0);
    }
  });

  it("reuses a persisted character relationship on the next loop without a duplicate agent call", async () => {
    const unit = makeUnit("おはよう。");
    const store = new InMemoryContextArtifactRepository();
    const policy = makePolicy();
    const captured: string[] = [];
    const baseFactory = makeFactory(unit, captured, {});
    let characterAgentCalls = 0;
    const factory: AgenticLoopProviderFactory = (args) => {
      if (args.stage !== "context" || args.agentLabel !== "character-relationship") {
        return baseFactory(args);
      }
      return new FakeModelProvider({
        providerName: "character-relationship-reuse-fixture",
        generate: () => {
          characterAgentCalls += 1;
          return JSON.stringify({
            bios: [
              {
                characterId: SPEAKER_NAME,
                bioText: "和人は物語の主人公。",
                citedUnitIds: [unit.bridgeUnitId],
              },
              {
                characterId: "ステラ",
                bioText: "ステラは和人の幼なじみ。",
                citedUnitIds: [unit.bridgeUnitId],
              },
            ],
            relationships: [
              {
                fromCharacterId: SPEAKER_NAME,
                toCharacterId: "ステラ",
                kind: "Friendship",
                direction: "Symmetric",
                descriptor: "和人とステラは幼なじみ。",
                citedUnitIds: [unit.bridgeUnitId],
              },
            ],
          });
        },
      });
    };
    const input: AgenticLoopUnitInput = {
      ...makeInput(unit),
      knownCharacters: [
        {
          characterId: SPEAKER_NAME,
          displayName: SPEAKER_NAME,
          bioLocale: "ja-JP",
          bioText: "",
          hiddenFromReader: false,
        },
        {
          characterId: "ステラ",
          displayName: "ステラ",
          bioLocale: "ja-JP",
          bioText: "",
          hiddenFromReader: false,
        },
      ],
      contextArtifactRepository: store,
    };

    await runAgenticLoopForUnit(input, DEV_POLICY, policy, factory);
    const relationshipId = characterRelationshipArtifactId(
      policy.projectId,
      `${SPEAKER_NAME}->ステラ:Friendship`,
    );
    const persisted = store
      .listAll()
      .find((artifact) => artifact.contextArtifactId === relationshipId);
    expect(persisted).toMatchObject({
      body: "和人とステラは幼なじみ。",
      data: expect.objectContaining({
        semanticKind: "character_relationship",
        descriptorLocale: "ja-JP",
        promptTemplateVersion: expect.any(String),
        promptHash: expect.any(String),
        modelProfile: expect.any(Object),
      }),
    });

    await runAgenticLoopForUnit(input, DEV_POLICY, policy, factory);
    expect(characterAgentCalls).toBe(1);
    expect(captured.at(-1)).toContain("和人とステラは幼なじみ。");
  });

  it("reuses an existing speaker label for the same unit without another provider invocation", async () => {
    const unit = makeUnit("おはよう。");
    const store = new InMemoryContextArtifactRepository();
    const baseFactory = makeFactory(unit, [], {});
    let speakerProviderCalls = 0;
    const factory: AgenticLoopProviderFactory = (args) => {
      const provider = baseFactory(args);
      if (args.stage !== "pre_translation" || args.agentLabel !== "speaker-label") {
        return provider;
      }
      return {
        descriptor: provider.descriptor,
        invoke: async (request) => {
          speakerProviderCalls += 1;
          return provider.invoke(request);
        },
      };
    };

    await runAgenticLoopForUnit(
      { ...makeInput(unit), contextArtifactRepository: store },
      DEV_POLICY,
      makePolicy(),
      factory,
    );
    const reused = await runAgenticLoopForUnit(
      { ...makeInput(unit), contextArtifactRepository: store },
      DEV_POLICY,
      makePolicy(),
      factory,
    );

    expect(speakerProviderCalls).toBe(1);
    expect(reused.stages.find((stage) => stage.stageName === "pre_translation")).toMatchObject({
      outcome: "reused:existing-speaker-label",
      invocations: [],
    });
  });
});
