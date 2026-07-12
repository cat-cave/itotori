// itotori-semantic-agent-live-robustness-single-unit — the loop's context
// stage runs the four semantic agents BEST-EFFORT: a persistent model-content
// failure (empty, malformed, or uncitable output) is CAUGHT + recorded as a
// dropped-enrichment signal, and the unit degrades
// to the DETERMINISTIC structure-informed context (+ whichever semantic agents
// DID succeed) instead of failing the whole unit.
//
// Before this node, `invokeSemanticContextStage` had NO try/catch around the
// four agents, so one malformed pack failed the whole unit. The deterministic
// structure-informed context is the load-bearing, never-failing artifact; only
// the LLM enrichment is best-effort.
//
// DB-less, fake-provider-only. Four proofs:
//   1. One agent's pack is malformed → unit still completes; the draft is
//      produced on the deterministic context + the other three agents; the
//      dropped agent is recorded in telemetry (not silent).
//   2. ALL four agents fail → unit still completes on the deterministic
//      structure context alone; all four are recorded as dropped.
//   3. In both, the deterministic structure block is STILL injected into the
//      translation prompt (assert the prompt carries it).
//   4. All four agents succeed → unchanged (no `droppedEnrichments`, all four
//      invocations recorded) — no regression to the real-context behavior.

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
  EnrichmentFailurePersistenceError,
  InMemoryContextArtifactRepository,
  persistTypedEnrichmentFailure,
} from "../src/orchestrator/context-brain.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  parseNarrativeStructure,
  type NarrativeStructure,
} from "../src/agents/structure-informed-context/index.js";

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
  return parseNarrativeStructure({
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
  });
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
 * MALFORMED model output so the loop's best-effort
 * seam must catch them; the rest return minimal-valid packs. Records every
 * `draft_translation` user prompt so the deterministic structure block can be
 * asserted.
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

describe("itotori-semantic-agent-live-robustness-single-unit (best-effort enrichment)", () => {
  it("one malformed semantic pack → unit still completes on deterministic + the other three agents; the drop is recorded", async () => {
    const unit = makeUnit("おはよう。");
    const captured: string[] = [];
    const attemptCounts = new Map<SemanticAgent, number>();
    const bundle = await runAgenticLoopForUnit(
      makeInput(unit),
      DEV_POLICY,
      makePolicy(),
      makeFactory(unit, captured, { "route-choice-map": "malformed" }, attemptCounts),
    );

    // The unit STILL completes with a real draft.
    expect(selectedWrittenCandidateBody(bundle)).toBe("Good morning.");

    const contextStage = bundle.stages.find((s) => s.stageName === "context");
    expect(contextStage).toBeDefined();

    // The three surviving agents each recorded an invocation; the dropped one did not.
    expect(contextStage?.invocations.map((i) => i.agentLabel).sort()).toEqual([
      "character-relationship",
      "scene-summary",
      "terminology-candidate",
    ]);

    // The drop is TELEMETRY, not silent: which agent + why.
    expect(contextStage?.droppedEnrichments).toBeDefined();
    expect(contextStage?.droppedEnrichments?.length).toBe(1);
    const drop = contextStage?.droppedEnrichments?.[0];
    expect(drop?.agentLabel).toBe("route-choice-map");
    expect(drop?.reason.length).toBeGreaterThan(0);
    expect(attemptCounts.get("route-choice-map")).toBeGreaterThan(1);
    // The stage still SUCCEEDS (degraded), never fails.
    expect(contextStage?.outcome).toContain("succeeded");
    expect(contextStage?.outcome).toContain("1-dropped");

    // The DETERMINISTIC structure context is still injected into the prompt.
    const prompt = captured[0] ?? "";
    expect(prompt).toContain("Structure-informed context");
    expect(prompt).toContain(`Scene ${SCENE_ID}`);
    expect(prompt).toContain(SPEAKER_NAME);
    expect(prompt).toContain("dispatches to scene 7020");
    // Deterministic artifact refs (scene slice + route-branch map) survive; the
    // dropped route-choice-map agent's `route:`/`choice:` refs do not appear.
    expect(prompt).toContain(`scene-summary:${SCENE_ID}`);
    expect(prompt).toContain("route-branch-map");
  });

  it("ALL four semantic agents fail → unit still completes on the deterministic structure context alone; all four are recorded", async () => {
    const unit = makeUnit("おはよう。");
    const captured: string[] = [];
    const attemptCounts = new Map<SemanticAgent, number>();
    const bundle = await runAgenticLoopForUnit(
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
    );

    // The unit STILL completes on the deterministic context alone.
    expect(selectedWrittenCandidateBody(bundle)).toBe("Good morning.");

    const contextStage = bundle.stages.find((s) => s.stageName === "context");
    // No semantic invocations survived...
    expect(contextStage?.invocations.length).toBe(0);
    // ...but all four drops are recorded (not silent).
    expect(contextStage?.droppedEnrichments?.map((d) => d.agentLabel).sort()).toEqual(
      [...SEMANTIC_AGENTS].sort(),
    );
    for (const drop of contextStage?.droppedEnrichments ?? []) {
      expect(drop.reason.length).toBeGreaterThan(0);
    }
    for (const agent of SEMANTIC_AGENTS) {
      expect(attemptCounts.get(agent)).toBeGreaterThan(1);
    }
    expect(contextStage?.outcome).toContain("4-dropped");

    // The DETERMINISTIC structure context is STILL injected.
    const prompt = captured[0] ?? "";
    expect(prompt).toContain("Structure-informed context");
    expect(prompt).toContain(`Scene ${SCENE_ID}`);
    expect(prompt).toContain("dispatches to scene 7020");
    expect(prompt).toContain(`scene-summary:${SCENE_ID}`);
  });

  it("all four semantic agents succeed → unchanged: four invocations, no droppedEnrichments (no regression)", async () => {
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
    // No drops → the field is OMITTED entirely (byte-identical to pre-robustness).
    expect(contextStage?.droppedEnrichments).toBeUndefined();
    expect(contextStage?.outcome).toBe("succeeded");
    // Deterministic context + all semantic refs present.
    const prompt = captured[0] ?? "";
    expect(prompt).toContain("Structure-informed context");
  });

  it("persists explicit no-content records for valid empty semantic packs", async () => {
    const unit = makeUnit("おはよう。");
    const store = new InMemoryContextArtifactRepository();
    const bundle = await runAgenticLoopForUnit(
      { ...makeInput(unit), contextArtifactRepository: store },
      DEV_POLICY,
      makePolicy(),
      makeFactory(unit, [], {}),
    );

    const contextStage = bundle.stages.find((stage) => stage.stageName === "context");
    expect(contextStage?.droppedEnrichments).toBeUndefined();
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

  it("surfaces a typed error when a failure record cannot be persisted", async () => {
    const repository: NonNullable<AgenticLoopUnitInput["contextArtifactRepository"]> = {
      upsertArtifact: async () => {
        throw new Error("Postgres unavailable");
      },
      invalidateAffectedArtifacts: async () => ({
        status: "completed",
        projectId: "unused",
        localeBranchId: "unused",
        sourceRevisionId: null,
        invalidatedCount: 0,
        invalidatedArtifactIds: [],
        diagnostics: [],
      }),
      retrieveArtifacts: async () => ({
        status: "completed",
        toolName: "tool.context-artifacts",
        toolVersion: "1.0.0",
        projectId: "unused",
        localeBranchId: "unused",
        sourceRevisionId: null,
        query: null,
        normalizedQuery: null,
        categories: [],
        matches: [],
        diagnostics: [],
      }),
    };

    const failure = await persistTypedEnrichmentFailure({
      repository,
      actor: ACTOR,
      projectId: "019ed079-1000-7000-8000-0000000sr010",
      localeBranchId: "019ed079-1000-7000-8000-0000000sr011",
      sourceRevisionId: REVISION_ID,
      bridgeUnitId: BRIDGE_UNIT_ID,
      agentLabel: "scene-summary",
      error: new Error("provider response malformed"),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EnrichmentFailurePersistenceError);
    expect(failure).toMatchObject({
      attemptedFailure: {
        agentLabel: "scene-summary",
      },
    });
    expect(failure).not.toHaveProperty("contextArtifactId");
  });
});
