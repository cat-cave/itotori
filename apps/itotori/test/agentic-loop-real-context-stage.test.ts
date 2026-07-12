// itotori-agentic-loop-real-context-stage — the loop's context stage now
// delivers REAL structure-informed context to the translator.
//
// SUPERSEDES `genaudit1-01-agentic-loop-context-probe-coerces-mis` and
// `itotori-semantic-agent-clis-no-fake-context-on-real-path`: the old
// `invokeContextLikeProbe` (which fired a provider call and DISCARDED its
// output, leaving `contextArtifactRefs: []`) is gone. The context stage now
//   (a) builds the DETERMINISTIC structure-informed context slice from the
//       decoded `NarrativeStructure` and injects it into the translation
//       prompt (scene summary + route/branch position + speaker character
//       arcs), and
//   (b) runs the four semantic context agents LIVE for enrichment.
//
// Two proofs:
//   1. Unit/integration (mock LLM): the translation stage PROVABLY receives
//      the decoded scene / route / speaker structure in its prompt, and the
//      four semantic agents all ran. Deterministic, runs in CI.
//   2. Live (env-gated, real ZDR OpenRouter DEV_PAIR): the SAME assertion on a
//      real run — the translation prompt carries the decoded structure, the
//      four semantic agents ran live, real `usage.cost` recorded, zdr:true.

import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  ExistsTerminologyTermBySurfaceFormInput,
  ItotoriTerminologyCandidateRepositoryPort,
} from "@itotori/db";
import type { AgenticLoopBundle, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
} from "../src/orchestrator/agentic-loop.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  LocalProviderRunArtifactRecorder,
  OpenRouterModelProvider,
  assertOpenRouterZdrAccount,
} from "../src/providers/index.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
} from "../src/providers/types.js";
import {
  parseNarrativeStructure,
  type NarrativeStructure,
} from "../src/agents/structure-informed-context/index.js";

const ACTOR: AuthorizationActor = { userId: "itotori-realctx-test-actor" };

const BRIDGE_UNIT_ID = "019ed079-1000-7000-8000-00000000rc01";
const REVISION_ID = "019ed079-1000-7000-8000-00000000rc03";
const ASSET_ID = "019ed079-1000-7000-8000-00000000rc04";
const SPEAKER_ID = "019ed079-1000-7000-8000-00000000rc05";

const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";

/** A small but structurally-real decoded structure: two scenes, a speaker, a choice. */
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
          { order: 2, speaker: null, text: "窓の外には青空が広がっていた。", textSurface: null },
        ],
        choices: [],
      },
      {
        sceneId: 6020,
        nextScene: null,
        messages: [{ order: 0, speaker: "ステラ", text: "そうね。", textSurface: null }],
        choices: [
          {
            optionIndex: 0,
            label: "散歩に行く",
            branchEntryScene: null,
            branchMessages: [],
          },
          {
            optionIndex: 1,
            label: "家にいる",
            branchEntryScene: null,
            branchMessages: [],
          },
        ],
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
    occurrenceId: "occ-rc-000",
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: "src-hash-realctx",
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rc-rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "realctx-asset" },
    sourceLocation: { containerKey: "realctx-asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: `scene-${SCENE_ID}/line-000`,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rc-rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makePolicy(): AgenticLoopPolicy {
  let tick = 0;
  return {
    projectId: "019ed079-1000-7000-8000-00000000rc10",
    localeBranchId: "019ed079-1000-7000-8000-00000000rc11",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 1,
    now: () => {
      const d = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
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

// --- Fake content (unit/integration path) ---------------------------------

function makeSpeakerLabel(unit: LocalizationUnitV02): string {
  return JSON.stringify({
    schemaVersion: "itotori.speaker-label-output.v1",
    labels: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "realctx-fixture",
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
        agentRationale: "realctx-fixture-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

/**
 * Capturing fake provider factory. Records every `draft_translation` request's
 * user prompt so the test can assert the injected structure block, AND returns
 * minimal-valid content for every stage (semantic agents parse an empty pack).
 */
function capturingFakeFactory(
  unit: LocalizationUnitV02,
  capturedTranslationPrompts: string[],
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `realctx-fake:${stage}:${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSpeakerLabel(unit);
        }
        if (request.taskKind === "experiment") {
          // The four semantic context agents. Minimal-valid packs.
          switch (agentLabel) {
            case "scene-summary":
              return "Synthetic scene summary.";
            case "character-relationship":
              return JSON.stringify({ bios: [], relationships: [] });
            case "terminology-candidate":
              return JSON.stringify({ candidates: [] });
            case "route-choice-map":
              return JSON.stringify({ routes: [], choices: [] });
            default:
              return "";
          }
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

describe("itotori-agentic-loop-real-context-stage (unit/integration)", () => {
  it("injects the decoded structure into the translation prompt and runs all four semantic agents", async () => {
    const unit = makeUnit("おはよう。");
    const captured: string[] = [];
    const input: AgenticLoopUnitInput = {
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

    const bundle = await runAgenticLoopForUnit(
      input,
      DEV_POLICY,
      makePolicy(),
      capturingFakeFactory(unit, captured),
    );

    // (b) All four semantic context agents ran (one invocation each) — the
    //     discard-probe is gone.
    const contextStage = bundle.stages.find((s) => s.stageName === "context");
    expect(contextStage).toBeDefined();
    expect(contextStage?.invocations.map((i) => i.agentLabel).sort()).toEqual([
      "character-relationship",
      "route-choice-map",
      "scene-summary",
      "terminology-candidate",
    ]);

    // (a) The translation stage PROVABLY received the decoded structure.
    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured[0] ?? "";
    // The dedicated structure-informed context block.
    expect(prompt).toContain("Structure-informed context");
    // Scene summary (decoded scene id + speaker).
    expect(prompt).toContain(`Scene ${SCENE_ID}`);
    expect(prompt).toContain(SPEAKER_NAME);
    // Route/branch position (this scene dispatches to 6020).
    expect(prompt).toContain("route position");
    expect(prompt).toContain("dispatches to scene 6020");
    // Speaker character arc.
    expect(prompt).toContain("speaks");
    // contextArtifactRefs are non-empty and citable.
    expect(prompt).toContain("Context artifacts available for citation:");
    expect(prompt).toContain(`scene-summary:${SCENE_ID}`);
    expect(prompt).toContain("route-branch-map");

    // The loop still completes end-to-end with a real draft.
    expect(selectedWrittenCandidateBody(bundle)).toBe("Good morning.");
  });

  it("without a structure, the loop still runs the semantic agents (no injected block)", async () => {
    const unit = makeUnit("おはよう。");
    const captured: string[] = [];
    const input: AgenticLoopUnitInput = {
      unit,
      sourceRevisionId: REVISION_ID,
      sceneUnits: [],
      glossary: [],
      protectedSpans: [],
      knownCharacters: [],
      actor: ACTOR,
    };
    const bundle = await runAgenticLoopForUnit(
      input,
      DEV_POLICY,
      makePolicy(),
      capturingFakeFactory(unit, captured),
    );
    // No deterministic structure → no injected block (baseline prompt).
    expect(captured[0] ?? "").not.toContain("Structure-informed context");
    // The semantic agents still ran (character-relationship anchors on the
    // unit's decoded speaker).
    const contextStage = bundle.stages.find((s) => s.stageName === "context");
    expect(contextStage?.invocations.length).toBe(4);
  });

  it("ITOTORI-150 (prod path): the loop forwards the terminology-candidate repository so the repository-side conflict check FIRES", async () => {
    // A repository spy whose only meaningful method records + answers
    // `existsTerminologyTermBySurfaceForm`. If the loop wiring forwards it
    // (with `input.actor`), the terminology-candidate agent's pre-persist check
    // queries it in production — closing the TOCTOU window. Every other port
    // method throws (unused on this path) to keep the fixture honest.
    const repoCalls: ExistsTerminologyTermBySurfaceFormInput[] = [];
    const repository: ItotoriTerminologyCandidateRepositoryPort = {
      async existsTerminologyTermBySurfaceForm(
        actor: AuthorizationActor,
        queryInput: ExistsTerminologyTermBySurfaceFormInput,
      ): Promise<string | null> {
        expect(actor).toBe(ACTOR); // the loop forwarded `input.actor`, not some default
        repoCalls.push(queryInput);
        return queryInput.surfaceForm === "ハル" ? "019ed079-1000-7000-8000-00000000t001" : null;
      },
      saveCandidate: () => {
        throw new Error("unused on the loop's terminology-candidate path");
      },
      loadCandidatesByProject: () => {
        throw new Error("unused on the loop's terminology-candidate path");
      },
      markCandidateStale: () => {
        throw new Error("unused on the loop's terminology-candidate path");
      },
      markCandidateRejected: () => {
        throw new Error("unused on the loop's terminology-candidate path");
      },
      markCandidatePromoted: () => {
        throw new Error("unused on the loop's terminology-candidate path");
      },
      currentSourceHashesForBridgeUnits: () => {
        throw new Error("unused on the loop's terminology-candidate path");
      },
    } as unknown as ItotoriTerminologyCandidateRepositoryPort;

    const unit = makeUnit("ハル、おはよう。");
    // A factory whose terminology-candidate agent emits a candidate whose
    // surfaceForm ("ハル") matches the curator-inserted repository term. The
    // supervised semantic-grounding check first proves the cited surface
    // appears in the source; the asynchronous repository check then catches
    // the curator-inserted conflict before candidate persistence.
    const factory: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
      new FakeModelProvider({
        providerName: `i150-loop-fake:${stage}:${agentLabel}`,
        generate: (request: ModelInvocationRequest) => {
          if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
            return makeSpeakerLabel(unit);
          }
          if (request.taskKind === "experiment") {
            switch (agentLabel) {
              case "scene-summary":
                return "Synthetic scene summary.";
              case "character-relationship":
                return JSON.stringify({ bios: [], relationships: [] });
              case "terminology-candidate":
                return JSON.stringify({
                  candidates: [
                    {
                      kind: "ProperNoun",
                      surfaceForm: "ハル",
                      rationale: "主人公の固有名。",
                      citedUnitIds: [unit.bridgeUnitId],
                    },
                  ],
                });
              case "route-choice-map":
                return JSON.stringify({ routes: [], choices: [] });
              default:
                return "";
            }
          }
          if (request.taskKind === "draft_translation") {
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

    const input: AgenticLoopUnitInput = {
      unit,
      sourceRevisionId: REVISION_ID,
      sceneUnits: [],
      glossary: [],
      protectedSpans: [],
      knownCharacters: [],
      actor: ACTOR,
      terminologyCandidateRepository: repository,
    };

    const bundle = await runAgenticLoopForUnit(input, DEV_POLICY, makePolicy(), factory);

    // (1) PROOF the wiring fired: the repository-side check was queried in prod
    //     with the emitted surfaceForm + the run's real projectId.
    expect(repoCalls).toContainEqual({
      projectId: makePolicy().projectId,
      surfaceForm: "ハル",
    });

    // (2) The conflict surfaced SYNCHRONOUSLY as a dropped enrichment (the
    //     best-effort loop catches the ExistingGlossaryConflictError) — not
    //     asynchronously at the next staleness scan.
    const contextStage = bundle.stages.find((s) => s.stageName === "context");
    const dropped = contextStage?.droppedEnrichments ?? [];
    const terminologyDrop = dropped.find((d) => d.agentLabel === "terminology-candidate");
    expect(terminologyDrop).toBeDefined();
    expect(terminologyDrop?.reason).toContain("ExistingGlossaryConflictError");

    // The loop still completes end-to-end (per-agent best-effort isolation).
    expect(selectedWrittenCandidateBody(bundle)).toBe("Good morning.");
  });
});

// ---------------------------------------------------------------------------
// LIVE proof — real ZDR OpenRouter DEV_PAIR. Env-gated so CI never charges.
// ---------------------------------------------------------------------------

const LIVE_ENABLED =
  process.env.ITOTORI_REALCTX_LIVE === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0 &&
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1";

const LIVE_BUDGET_CAP_USD = 1.0;

/** Provider wrapper that records every request + result for the live proof. */
function capturingLiveProvider(
  inner: ModelProvider,
  requests: ModelInvocationRequest[],
  results: ModelInvocationResult[],
): ModelProvider {
  return {
    descriptor: inner.descriptor,
    invoke: async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => {
      requests.push(request);
      const result = await inner.invoke(request);
      results.push(result);
      return result;
    },
  };
}

describe("itotori-agentic-loop-real-context-stage (live)", () => {
  it("a live run's translation prompt carries the decoded structure; the four semantic agents ran live under ZDR", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[realctx-live] skipping — set ITOTORI_REALCTX_LIVE=1, OPENROUTER_API_KEY, and " +
          "OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 to run it (optional: ITOTORI_REALCTX_STRUCTURE_JSON=<path>, ITOTORI_REALCTX_SCENE=<id>)",
      );
      return;
    }
    // Privacy gate BEFORE any live byte.
    assertOpenRouterZdrAccount(process.env);

    // Prefer a REAL decoded Sweetie structure (held out-of-repo); fall back to
    // the built-in structure so the proof is self-contained.
    let structure: NarrativeStructure;
    let sceneId: number;
    let sourceText: string;
    const structurePath = process.env.ITOTORI_REALCTX_STRUCTURE_JSON;
    if (typeof structurePath === "string" && structurePath.length > 0) {
      structure = parseNarrativeStructure(
        JSON.parse(readFileSync(structurePath, "utf8")) as unknown,
      );
      sceneId = Number(process.env.ITOTORI_REALCTX_SCENE ?? String(structure.entryScene));
      const scene = structure.scenes.find((s) => s.sceneId === sceneId);
      const line = scene?.messages.find(
        (m) => m.speaker !== null && m.text.trim().length > 0 && m.text.length <= 40,
      );
      expect(line).toBeDefined();
      sourceText = line?.text ?? "";
    } else {
      structure = makeStructure();
      sceneId = SCENE_ID;
      sourceText = "おはよう。";
    }

    const unit = makeUnit(sourceText);
    const requests: ModelInvocationRequest[] = [];
    const results: ModelInvocationResult[] = [];
    const recorder = new LocalProviderRunArtifactRecorder(
      mkdtempSync(join(tmpdir(), "itotori-realctx-live-runs-")),
    );
    const provider = new OpenRouterModelProvider({
      costCapUsd: LIVE_BUDGET_CAP_USD,
      artifactRecorder: recorder,
    });
    const factory: AgenticLoopProviderFactory = () =>
      capturingLiveProvider(provider, requests, results);

    const input: AgenticLoopUnitInput = {
      unit,
      sourceRevisionId: REVISION_ID,
      sceneUnits: [],
      glossary: [],
      protectedSpans: [],
      knownCharacters: [],
      narrativeStructure: structure,
      sceneId,
      actor: ACTOR,
    };

    const bundle = await runAgenticLoopForUnit(input, DEV_POLICY, makePolicy(), factory);

    // The four semantic context agents ran LIVE (real openrouter proof ids).
    const contextStage = bundle.stages.find((s) => s.stageName === "context");
    expect(contextStage?.invocations.length).toBe(4);
    for (const inv of contextStage?.invocations ?? []) {
      expect(inv.providerProofId).toMatch(/^openrouter-/u);
      // Real cost, from usage.cost.
      expect(Number(inv.costUsd)).toBeGreaterThanOrEqual(0);
    }

    // The translation prompt PROVABLY carried the decoded structure.
    const translationRequest = requests.find((r) => r.taskKind === "draft_translation");
    expect(translationRequest).toBeDefined();
    const userMessage = translationRequest?.messages?.find((m) => m.role === "user");
    const prompt = userMessage?.content ?? "";
    expect(prompt).toContain("Structure-informed context");
    expect(prompt).toContain(`Scene ${sceneId}`);
    expect(prompt).toContain("route position");
    expect(prompt).toContain("Context artifacts available for citation:");

    // ZDR enforced on the wire + real cost recorded; budget cap respected.
    let totalCostUsd = 0;
    for (const result of results) {
      expect(result.providerRun.routingPosture.zdr).toBe(true);
      expect(result.providerRun.routingPosture.data_collection).toBe("deny");
      expect(result.providerRun.cost.costKind).toBe("billed");
      totalCostUsd += (result.providerRun.cost.amountMicrosUsd ?? 0) / 1_000_000;
    }
    expect(totalCostUsd).toBeGreaterThan(0);
    expect(totalCostUsd).toBeLessThanOrEqual(LIVE_BUDGET_CAP_USD);

    // eslint-disable-next-line no-console
    console.warn(
      `[realctx-live] scene=${sceneId} calls=${results.length} totalCost=$${totalCostUsd.toFixed(6)} ` +
        `zdr=true semanticAgents=4 finalOutcome=${bundle.writtenOutcome.status}`,
    );
  }, 180_000);
});
