// itotori-project-level-driven-executor (P0 — LAST pre-pilot seam) — tests.
//
// Proves the driven executor turns the at-scale plumbing proof into a REAL
// driven pilot: it ENUMERATES the in-scope units (consuming the batch
// planner's scene grouping), runs `runAgenticLoopForUnit` PER unit WITH the
// real structure-informed context (narrativeStructure + sceneId, P0#1) AND the
// reviewer-queue DB sink wired (P0#2), PERSISTS drafts + provider-run summaries
// (real usage.cost + ZDR) + reviewer_queue_items, and produces ONE patch
// export for the accepted drafts. Per-unit failure isolation: one unit's
// malformed-pack failure (the filed P2) does NOT abort the run.
//
// Driven with a FakeModelProvider + in-memory sinks + an in-memory
// reviewer-queue repository — no live LLM, no Postgres. The DB-backed
// createItem path is exercised by the reviewer-queue repository tests under
// `ci-itotori`; the LIVE (real ZDR OpenRouter) proof is the env-gated pilot.

import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import {
  ItotoriDraftAttemptProviderLedgerRepository,
  ItotoriDraftJobRepository,
  ItotoriReviewerQueueRepository,
  ReviewerQueueRepositoryError,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  localUserId,
  migrate,
  reviewerQueueItemStateValues,
  type AuthorizationActor,
  type CreateReviewerQueueItemInput,
  type DatabaseContext,
  type ItotoriReviewerQueueRepositoryPort,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
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
import {
  DEFAULT_DRIVEN_CONCURRENCY,
  runProjectDrivenExecutor,
  unitSurfaceKindInScope,
  type DrivenDraftRecord,
  type DrivenPatchExportRecord,
  type DrivenProviderRunRecord,
  type DrivenUnitContext,
} from "../src/orchestrator/project-driven-executor.js";
import {
  buildScopeGraph,
  resolveEffectiveScope,
  type WorkCarve,
} from "../src/agents/work-scope/index.js";
import {
  DrivenDbPersistenceAdapter,
  FsDrivenPatchExportSink,
} from "../src/orchestrator/project-driven-executor-sinks.js";

const ACTOR: AuthorizationActor = { userId: "driven-executor-test-actor" };
const PROJECT_ID = "019ed0cc-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed0cc-0000-7000-8000-000000000002";
const REVISION_ID = "019ed0cc-0000-7000-8000-000000000003";
const ASSET_ID = "019ed0cc-0000-7000-8000-000000000004";
const SPEAKER_ID = "019ed0cc-0000-7000-8000-000000000005";

// Bridge unit ids carry a distinct `019ed0aa` prefix so the fake provider can
// regex the CURRENT unit's bridge id out of any request blob (asset/revision
// ids use the `019ed0cc` prefix and never collide).
const UNIT_A = "019ed0aa-0000-7000-8000-0000000000a1"; // clean -> accepted
const UNIT_B = "019ed0aa-0000-7000-8000-0000000000b2"; // critical finding -> deferred
const UNIT_C = "019ed0aa-0000-7000-8000-0000000000c3"; // clean -> accepted
const UNIT_D = "019ed0aa-0000-7000-8000-0000000000d4"; // POISON -> throws (isolated)
const UNIT_E = "019ed0aa-0000-7000-8000-0000000000e5"; // ui_label -> out of scope

const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";

const POISON_MARKER = "POISON_MALFORMED_PACK";
const DEFER_MARKER = "DEFER_CRITICAL";

// --- In-memory reviewer queue (same unique key as the real table) -----------

class InMemoryReviewerQueue implements Pick<
  ItotoriReviewerQueueRepositoryPort,
  "createItem" | "loadItemsByBranch"
> {
  readonly items: ReviewerQueueItemRecord[] = [];
  private seq = 0;

  async createItem(
    _actor: AuthorizationActor,
    input: CreateReviewerQueueItemInput,
  ): Promise<ReviewerQueueItemRecord> {
    const clash = this.items.some(
      (item) =>
        item.localeBranchId === input.localeBranchId &&
        item.sourceRevisionId === input.sourceRevisionId &&
        item.itemKind === input.itemKind &&
        item.sourceItemRef === input.sourceItemRef,
    );
    if (clash) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_duplicate",
        `duplicate ${input.sourceItemRef}`,
      );
    }
    this.seq += 1;
    const createdAt = input.createdAt ?? new Date();
    const record: ReviewerQueueItemRecord = {
      reviewItemId: `driven-inmem-${this.seq}`,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      itemKind: input.itemKind,
      sourceItemRef: input.sourceItemRef,
      state: reviewerQueueItemStateValues.pending,
      priority: input.priority ?? 0,
      summary: input.summary,
      affectedArtifactIds: input.affectedArtifactIds ?? [],
      evidenceTier: input.evidenceTier ?? null,
      observationEventIds: input.observationEventIds ?? null,
      artifactHashes: input.artifactHashes ?? null,
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      createdByUserId: input.createdByUserId ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
    };
    this.items.push(record);
    return record;
  }

  async loadItemsByBranch(
    _actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<ReviewerQueueItemRecord[]> {
    return this.items.filter((item) => item.localeBranchId === localeBranchId);
  }
}

// --- In-memory persistence sinks --------------------------------------------

class InMemorySinks {
  readonly drafts: DrivenDraftRecord[] = [];
  readonly providerRuns: DrivenProviderRunRecord[] = [];
  readonly patchExports: DrivenPatchExportRecord[] = [];
  readonly draft = {
    persistDraft: async (record: DrivenDraftRecord): Promise<void> => {
      this.drafts.push(record);
    },
  };
  readonly providerRun = {
    persistProviderRun: async (record: DrivenProviderRunRecord): Promise<void> => {
      this.providerRuns.push(record);
    },
  };
  readonly patchExport = {
    exportPatch: async (record: DrivenPatchExportRecord): Promise<void> => {
      this.patchExports.push(record);
    },
  };
}

// --- Fixtures ---------------------------------------------------------------

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
          { order: 1, speaker: null, text: "青空が広がっていた。", textSurface: null },
        ],
        choices: [],
      },
    ],
  });
}

function makeUnit(
  bridgeUnitId: string,
  sourceText: string,
  surfaceKind: LocalizationUnitV02["surfaceKind"],
  lineNo: number,
): LocalizationUnitV02 {
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind,
    sourceUnitKey: `scene-${SCENE_ID}/line-${String(lineNo).padStart(3, "0")}`,
    occurrenceId: `occ-${lineNo}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `src-hash-${bridgeUnitId}`,
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "asset" },
    sourceLocation: { containerKey: "asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: SPEAKER_NAME },
    context: { route: { sceneId: String(SCENE_ID) } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: `scene-${SCENE_ID}/line-${String(lineNo).padStart(3, "0")}`,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeBridge(): BridgeBundleV02 {
  const units: LocalizationUnitV02[] = [
    makeUnit(UNIT_A, "おはよう、和人。", "dialogue", 1),
    makeUnit(UNIT_B, `今日は${DEFER_MARKER}だね。`, "dialogue", 2),
    makeUnit(UNIT_C, "いい天気だね。", "dialogue", 3),
    makeUnit(UNIT_D, `これは${POISON_MARKER}。`, "dialogue", 4),
    makeUnit(UNIT_E, "設定", "ui_label", 5),
  ];
  return {
    schemaVersion: "0.2.0",
    bridgeId: "driven-executor-fixture",
    sourceLocale: "ja-JP",
    units,
  } as unknown as BridgeBundleV02;
}

/** Extract the current unit's bridge id (distinct `019ed0aa` prefix) from a request. */
function bridgeUnitIdOf(request: ModelInvocationRequest): string {
  const blob = JSON.stringify(request);
  const match = blob.match(/019ed0aa-[0-9a-f]{4}-7000-8000-[0-9a-f]{12}/u);
  if (match === null) {
    throw new Error("fake provider could not locate a bridge unit id in the request");
  }
  return match[0];
}

function speakerLabelContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fake-narration",
      },
    ],
  });
}

function translationContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText: `Good morning.`,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fake-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

function criticalQaContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [
      {
        findingId: `${bridgeUnitId}-finding`,
        bridgeUnitId,
        severity: "critical",
        category: "mistranslation",
        evidenceRefs: [],
        recommendation: "fixture: the draft mistranslates the source",
        agentRationale: "fake-critical-finding",
      },
    ],
  });
}

function cleanQaContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

/**
 * Fake provider factory. Keyed on the CURRENT unit's source markers:
 *   - a unit carrying POISON_MARKER emits a malformed translation pack (wrong
 *     schemaVersion) so the translation agent throws — the P2 shape.
 *   - a unit carrying DEFER_MARKER emits a critical QA finding so the loop
 *     defers (with maxRepairAttempts: 0) and the bridge lands a queue item.
 *   - every other unit translates cleanly and is accepted.
 */
function drivenProviderFactory(): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `driven-fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        const blob = JSON.stringify(request);
        // The four semantic-context agents carry no single bridge-unit id in
        // their request — return their minimal-valid pack without extracting.
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "draft_translation") {
          if (blob.includes(POISON_MARKER)) {
            // Malformed pack — wrong schemaVersion; the agent parse throws.
            return JSON.stringify({ schemaVersion: "totally.wrong.v0", drafts: [] });
          }
          return translationContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "llm_qa") {
          if (blob.includes(DEFER_MARKER)) {
            return criticalQaContent(bridgeUnitIdOf(request));
          }
          return cleanQaContent();
        }
        return "";
      },
    });
}

function promptCapturingProviderFactory(
  promptsByUnit: Map<string, string>,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `driven-capture-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "draft_translation") {
          const unitId = bridgeUnitIdOf(request);
          promptsByUnit.set(unitId, request.messages.map((m) => m.content).join("\n"));
          return translationContent(unitId);
        }
        if (request.taskKind === "llm_qa") {
          return cleanQaContent();
        }
        return "";
      },
    });
}

function baseInput(queue?: InMemoryReviewerQueue, sinks?: InMemorySinks) {
  const bridge = makeBridge();
  const structure = makeStructure();
  const resolveUnitContext = (): DrivenUnitContext => ({
    narrativeStructure: structure,
    sceneId: SCENE_ID,
  });
  return {
    bridge,
    rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
    pairPolicy: DEV_POLICY,
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    actor: ACTOR,
    providerFactory: drivenProviderFactory(),
    maxRepairAttempts: 0,
    resolveUnitContext,
    translationScope: "dialogue-only" as const,
    engineProfile: "reallive" as const,
    sinks: sinks ?? new InMemorySinks(),
    ...(queue !== undefined ? { reviewerQueue: { repository: queue } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unitSurfaceKindInScope (config-driven scope)", () => {
  it("dialogue-only admits dialogue kinds and rejects choices/ui", () => {
    expect(unitSurfaceKindInScope("dialogue", "dialogue-only")).toBe(true);
    expect(unitSurfaceKindInScope("narration", "dialogue-only")).toBe(true);
    expect(unitSurfaceKindInScope("choice_label", "dialogue-only")).toBe(false);
    expect(unitSurfaceKindInScope("ui_label", "dialogue-only")).toBe(false);
  });
  it("scope is additive: choices then ui then all", () => {
    expect(unitSurfaceKindInScope("choice_label", "dialogue-and-choices")).toBe(true);
    expect(unitSurfaceKindInScope("ui_label", "dialogue-and-choices")).toBe(false);
    expect(unitSurfaceKindInScope("ui_label", "dialogue-choices-ui")).toBe(true);
    expect(unitSurfaceKindInScope("anything-else", "all")).toBe(true);
    expect(unitSurfaceKindInScope("anything-else", "dialogue-choices-ui")).toBe(false);
  });
});

describe("runProjectDrivenExecutor (itotori-project-level-driven-executor)", () => {
  it("drives the in-scope units, persists drafts + provider-runs + queue-items + ONE patch export, isolates a failing unit", async () => {
    const queue = new InMemoryReviewerQueue();
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor(baseInput(queue, sinks));

    // Enumeration: 5 units total, 4 in scope (UNIT_E ui_label excluded).
    expect(result.unitsEnumerated).toBe(5);
    expect(result.unitsInScope).toBe(4);

    // Per-unit isolation: UNIT_D (poison) throws but the run completes.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.bridgeUnitId).toBe(UNIT_D);
    expect(result.unitsRun).toBe(3); // A, B, C succeeded; D isolated.

    // Drafts: one per successfully-run unit; 2 accepted (A, C), 1 deferred (B).
    expect(result.draftsPersisted).toBe(3);
    expect(sinks.drafts).toHaveLength(3);
    expect(result.acceptedDraftCount).toBe(2);
    expect(result.deferredCount).toBe(1);
    const acceptedIds = sinks.drafts
      .filter((d) => d.accepted)
      .map((d) => d.bridgeUnitId)
      .sort();
    expect(acceptedIds).toEqual([UNIT_A, UNIT_C].sort());
    const deferred = sinks.drafts.find((d) => !d.accepted);
    expect(deferred!.bridgeUnitId).toBe(UNIT_B);
    expect(deferred!.outcome).toBe("deferred_to_human");
    expect(deferred!.deferredReason).toBeDefined();

    // Provider runs: one summary per run unit, real zdr:true from the policy.
    expect(result.providerRunsPersisted).toBe(3);
    expect(sinks.providerRuns).toHaveLength(3);
    for (const run of sinks.providerRuns) {
      expect(run.zdr).toBe(true);
      expect(run.invocationCount).toBeGreaterThan(0);
      expect(run.pair.modelId).toBe(DEV_PAIR.modelId);
      expect(run.pair.providerId).toBe(DEV_PAIR.providerId);
    }
    expect(result.zdrConfirmed).toBe(true);

    // Reviewer queue: the single deferral (UNIT_B) persisted a context-rich row.
    expect(result.reviewerQueueItemCount).toBe(1);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.sourceItemRef).toBe(`agentic-loop:${UNIT_B}`);
    const decision = queue.items[0]!.payload.decisionRecord as Record<string, unknown>;
    expect((decision.source as { sourceText: string }).sourceText).toContain(DEFER_MARKER);

    // ONE patch export; accepted units carry the real translated body, others
    // stay a byte no-op (target === source).
    expect(result.patchExportCount).toBe(1);
    expect(sinks.patchExports).toHaveLength(1);
    const exported = sinks.patchExports[0]!;
    expect(exported.patchReport.acceptedDraftCount).toBe(2);
    expect(exported.patchReport.acceptedUnits.map((u) => u.bridgeUnitId).sort()).toEqual(
      [UNIT_A, UNIT_C].sort(),
    );
    const translatedUnits = (exported.translatedBridge as { units: Array<Record<string, unknown>> })
      .units;
    const targetById = new Map(
      translatedUnits.map((u) => [u.bridgeUnitId as string, (u.target as { text: string }).text]),
    );
    // Accepted: bracket-wrapped English body (RealLive lexer requirement).
    expect(targetById.get(UNIT_A)).toContain("Good morning.");
    expect(targetById.get(UNIT_A)!.startsWith("「")).toBe(true);
    // Deferred / failed / out-of-scope: byte no-op (target === source).
    expect(targetById.get(UNIT_B)).toBe(`今日は${DEFER_MARKER}だね。`);
    expect(targetById.get(UNIT_D)).toBe(`これは${POISON_MARKER}。`);
    expect(targetById.get(UNIT_E)).toBe("設定");
  });

  it("supports a bounded slice via maxUnits (whole-game capable, pilot-bounded)", async () => {
    const queue = new InMemoryReviewerQueue();
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor({ ...baseInput(queue, sinks), maxUnits: 2 });
    // Only the first 2 in-scope units (A, B) run; the poison D is never reached.
    expect(result.unitsRun).toBe(2);
    expect(result.failures).toHaveLength(0);
    expect(result.draftsPersisted).toBe(2);
    expect(result.patchExportCount).toBe(1);
  });

  it("threads real context per unit: without a wired queue nothing is bridged", async () => {
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor(baseInput(undefined, sinks));
    // No sink -> no queue items counted, but drafts + runs + patch still persist.
    expect(result.reviewerQueueItemCount).toBe(0);
    expect(result.draftsPersisted).toBe(3);
    expect(result.providerRunsPersisted).toBe(3);
    expect(result.patchExportCount).toBe(1);
    // Every persisted draft carries the resolved sceneId (real context threaded).
    for (const draft of sinks.drafts) {
      expect(draft.sceneId).toBe(SCENE_ID);
    }
  });

  it("a run over units WITHOUT any structure still drives + persists (synthetic path)", async () => {
    const sinks = new InMemorySinks();
    const input = baseInput(undefined, sinks);
    const result = await runProjectDrivenExecutor({
      ...input,
      resolveUnitContext: () => undefined,
    });
    expect(result.unitsRun).toBe(3);
    expect(result.draftsPersisted).toBe(3);
    for (const draft of sinks.drafts) {
      expect(draft.sceneId).toBeUndefined();
    }
  });

  it("isolates malformed structure context instead of silently dropping it", async () => {
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor({
      ...baseInput(undefined, sinks),
      maxUnits: 1,
      resolveUnitContext: (): DrivenUnitContext =>
        ({ narrativeStructure: makeStructure() }) as unknown as DrivenUnitContext,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.bridgeUnitId).toBe(UNIT_A);
    expect(result.failures[0]!.errorClass).toBe("AgenticLoopInvariantError");
    expect(result.failures[0]!.errorMessage).toContain(
      "narrativeStructure supplied without sceneId",
    );
    expect(result.failures[0]!.diagnostic?.step).toBe("executor.drive-unit");
    expect(result.unitsRun).toBe(0);
    expect(result.draftsPersisted).toBe(0);
    expect(result.providerRunsPersisted).toBe(0);
    expect(sinks.drafts).toHaveLength(0);
    expect(sinks.providerRuns).toHaveLength(0);
    expect(result.patchExportCount).toBe(1);
  });

  it("injects inherited cross-work glossary and character/style context with per-work overrides into drafting prompts", async () => {
    const promptsByUnit = new Map<string, string>();
    const sinks = new InMemorySinks();
    const carve: WorkCarve = {
      archiveRef: "fixture-archive",
      works: [
        {
          workId: "fixture-archive#work:base",
          optionIndex: 0,
          optionLabel: "base",
          branchEntryScene: 100,
          branchMessageCount: 1,
          branchSpeakers: ["Iris"],
        },
        {
          workId: "fixture-archive#work:after",
          optionIndex: 1,
          optionLabel: "after",
          branchEntryScene: 200,
          branchMessageCount: 1,
          branchSpeakers: ["Iris", "Noa"],
        },
      ],
      derivation: {
        signal: "operator-entry-scene-override",
        gameSelectScene: null,
        gameSelectSelectedBy: "none",
        selectionControl: "none",
        namingSignal: "provided",
        notes: "synthetic two-work fixture",
      },
    };
    const graph = buildScopeGraph({
      shared: {
        scopeId: "scope:fixture-shared",
        kind: "shared",
        label: "Fixture shared scope",
        // Treat this as a term established by the first work and promoted to
        // the shared scope; the second work must receive it in its draft prompt.
        glossary: [{ sourceForm: "光紋", targetForm: "Lumen Crest", policyAction: "localize" }],
        characters: [
          {
            characterId: "iris",
            displayName: "Iris",
            voiceNote: "dry wit with clipped, confident phrasing",
          },
        ],
      },
      carve,
      perWork: {
        "fixture-archive#work:after": {
          glossaryOverrides: [
            { sourceForm: "約束", targetForm: "After Promise", policyAction: "localize" },
          ],
          characterOverrides: [
            {
              characterId: "noa",
              displayName: "Noa",
              voiceNote: "after-story-only gentle register",
            },
          ],
        },
      },
    });
    const baseScope = resolveEffectiveScope(graph, "fixture-archive#work:base");
    const afterScope = resolveEffectiveScope(graph, "fixture-archive#work:after");

    const result = await runProjectDrivenExecutor({
      ...baseInput(undefined, sinks),
      providerFactory: promptCapturingProviderFactory(promptsByUnit),
      maxUnits: 3,
      resolveUnitContext: ({ unit }): DrivenUnitContext => ({
        effectiveScope: unit.bridgeUnitId === UNIT_C ? afterScope : baseScope,
      }),
    });

    expect(result.failures).toHaveLength(0);
    const afterPrompt = promptsByUnit.get(UNIT_C);
    expect(afterPrompt).toBeDefined();
    expect(afterPrompt).toContain("Work-scoped continuity context");
    // Inherited from the shared scope into the second work's draft context.
    expect(afterPrompt).toContain("光紋 -> Lumen Crest");
    expect(afterPrompt).toContain("Iris");
    expect(afterPrompt).toContain("dry wit with clipped, confident phrasing");
    expect(afterPrompt).toContain("inherited");
    // Added/overridden by the second work and present only after resolution.
    expect(afterPrompt).toContain("約束 -> After Promise");
    expect(afterPrompt).toContain("Noa");
    expect(afterPrompt).toContain("after-story-only gentle register");
    expect(afterPrompt).toContain("override");
    // The effective glossary also reaches the existing glossary block consumed
    // by translation + terminology QA, not just the audit continuity block.
    expect(afterPrompt).toContain("Glossary (apply preferred target forms):");
    expect(afterPrompt).toContain("光紋 -> Lumen Crest");
  });
});

// ---------------------------------------------------------------------------
// itotori-batched-concurrent-translation-scheduling — bounded-concurrent pool.
//
// Proves the driven executor schedules up to `concurrency` units'
// `runAgenticLoopForUnit` at once (a client-side worker pool over the canonical
// unit list) while keeping: (a) the budget cap (stops DISPATCHING before
// overspend), (b) per-unit failure isolation, (c) DETERMINISTIC canonical result
// ordering regardless of completion order. Driven with an INSTRUMENTED fake
// provider (small artificial per-call delay + an in-flight concurrency meter);
// no live LLM. Because the loop fires provider calls SEQUENTIALLY within a unit,
// the max in-flight invocation count IS the unit-level concurrency.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tracks max simultaneous in-flight provider invocations (== unit concurrency). */
class ConcurrencyMeter {
  inFlight = 0;
  maxInFlight = 0;
  totalCalls = 0;
  enter(): void {
    this.inFlight += 1;
    this.totalCalls += 1;
    if (this.inFlight > this.maxInFlight) {
      this.maxInFlight = this.inFlight;
    }
  }
  exit(): void {
    this.inFlight -= 1;
  }
}

/**
 * Wraps a FakeModelProvider with an artificial delay + the concurrency meter,
 * and OPTIONALLY overrides each invocation's cost to a fixed billed amount so a
 * budget-cap test accumulates real (fake) spend.
 */
class InstrumentedProvider implements ModelProvider {
  constructor(
    private readonly inner: FakeModelProvider,
    private readonly meter: ConcurrencyMeter,
    private readonly delayMs: number,
    private readonly costPerCallUsd: number,
  ) {}
  get descriptor() {
    return this.inner.descriptor;
  }
  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    this.meter.enter();
    try {
      await sleep(this.delayMs);
      const result = await this.inner.invoke(request);
      if (this.costPerCallUsd <= 0) {
        return result;
      }
      const micros = Math.round(this.costPerCallUsd * 1_000_000);
      return {
        ...result,
        providerRun: {
          ...result.providerRun,
          cost: {
            costKind: "billed",
            currency: "USD",
            amountUsd: this.costPerCallUsd.toFixed(6),
            amountMicrosUsd: micros,
          },
        },
      };
    } finally {
      this.meter.exit();
    }
  }
}

/** The same clean/POISON/DEFER generate logic as `drivenProviderFactory`. */
function drivenGenerate(agentLabel: string, request: ModelInvocationRequest): string {
  const blob = JSON.stringify(request);
  if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
    return fakeSemanticContextContent(agentLabel);
  }
  if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
    return speakerLabelContent(bridgeUnitIdOf(request));
  }
  if (request.taskKind === "draft_translation") {
    if (blob.includes(POISON_MARKER)) {
      return JSON.stringify({ schemaVersion: "totally.wrong.v0", drafts: [] });
    }
    return translationContent(bridgeUnitIdOf(request));
  }
  if (request.taskKind === "llm_qa") {
    if (blob.includes(DEFER_MARKER)) {
      return criticalQaContent(bridgeUnitIdOf(request));
    }
    return cleanQaContent();
  }
  return "";
}

function instrumentedFactory(opts: {
  meter: ConcurrencyMeter;
  delayMs: number;
  costPerCallUsd?: number;
}): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) => {
    const inner = new FakeModelProvider({
      providerName: `driven-conc-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => drivenGenerate(agentLabel, request),
    });
    return new InstrumentedProvider(inner, opts.meter, opts.delayMs, opts.costPerCallUsd ?? 0);
  };
}

/** A bridge of `count` distinct clean dialogue units, optionally poison/defer at indices. */
function makeManyUnitBridge(
  count: number,
  markers?: { poisonAt?: number; deferAt?: number },
): { bridge: BridgeBundleV02; orderedInScopeIds: string[] } {
  const units: LocalizationUnitV02[] = [];
  const orderedInScopeIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `019ed0aa-0000-7000-8000-${String(i + 1).padStart(12, "0")}`;
    let sourceText = `おはよう、和人。${i}`;
    if (markers?.poisonAt === i) {
      sourceText = `これは${POISON_MARKER}。${i}`;
    } else if (markers?.deferAt === i) {
      sourceText = `今日は${DEFER_MARKER}だね。${i}`;
    }
    units.push(makeUnit(id, sourceText, "dialogue", i + 1));
    orderedInScopeIds.push(id);
  }
  const bridge = {
    schemaVersion: "0.2.0",
    bridgeId: "driven-executor-concurrency-fixture",
    sourceLocale: "ja-JP",
    units,
  } as unknown as BridgeBundleV02;
  return { bridge, orderedInScopeIds };
}

function concurrencyBaseInput(args: {
  bridge: BridgeBundleV02;
  factory: AgenticLoopProviderFactory;
  sinks: InMemorySinks;
  queue?: InMemoryReviewerQueue;
}) {
  const structure = makeStructure();
  return {
    bridge: args.bridge,
    rawBridge: JSON.parse(JSON.stringify(args.bridge)) as unknown,
    pairPolicy: DEV_POLICY,
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    actor: ACTOR,
    providerFactory: args.factory,
    maxRepairAttempts: 0,
    resolveUnitContext: (): DrivenUnitContext => ({
      narrativeStructure: structure,
      sceneId: SCENE_ID,
    }),
    translationScope: "dialogue-only" as const,
    engineProfile: "reallive" as const,
    sinks: args.sinks,
    ...(args.queue !== undefined ? { reviewerQueue: { repository: args.queue } } : {}),
  };
}

describe("runProjectDrivenExecutor (bounded-concurrent scheduling)", () => {
  it("exposes a conservative default concurrency", () => {
    expect(DEFAULT_DRIVEN_CONCURRENCY).toBe(8);
  });

  it("runs units CONCURRENTLY up to the bound (counter reaches K) with a wall-clock speedup", async () => {
    const UNIT_COUNT = 8;
    const CONCURRENCY = 4;
    const DELAY_MS = 15;

    // Sequential baseline (concurrency 1) for the wall-clock comparison.
    const seqMeter = new ConcurrencyMeter();
    const seqSinks = new InMemorySinks();
    const { bridge: seqBridge } = makeManyUnitBridge(UNIT_COUNT);
    const seqStart = Date.now();
    const seqResult = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge: seqBridge,
        factory: instrumentedFactory({ meter: seqMeter, delayMs: DELAY_MS }),
        sinks: seqSinks,
      }),
      concurrency: 1,
    });
    const seqMs = Date.now() - seqStart;
    expect(seqResult.unitsRun).toBe(UNIT_COUNT);
    expect(seqMeter.maxInFlight).toBe(1); // strictly sequential.

    // Concurrent run (concurrency K).
    const meter = new ConcurrencyMeter();
    const sinks = new InMemorySinks();
    const { bridge } = makeManyUnitBridge(UNIT_COUNT);
    const start = Date.now();
    const result = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge,
        factory: instrumentedFactory({ meter, delayMs: DELAY_MS }),
        sinks,
      }),
      concurrency: CONCURRENCY,
    });
    const concMs = Date.now() - start;

    // Concurrency counter reached the bound (never exceeds it — only K workers).
    expect(meter.maxInFlight).toBe(CONCURRENCY);
    // All N units ran + persisted (accepted, since all clean).
    expect(result.unitsRun).toBe(UNIT_COUNT);
    expect(result.draftsPersisted).toBe(UNIT_COUNT);
    expect(result.providerRunsPersisted).toBe(UNIT_COUNT);
    expect(result.acceptedDraftCount).toBe(UNIT_COUNT);
    expect(result.patchExportCount).toBe(1);
    expect(sinks.drafts).toHaveLength(UNIT_COUNT);
    // Same number of provider calls, but wall-clock is far below the sequential
    // sum (bounded speedup ~K). A conservative < 0.6x threshold avoids flake.
    expect(meter.totalCalls).toBe(seqMeter.totalCalls);
    expect(concMs).toBeLessThan(seqMs * 0.6);
  });

  it("isolates a poison unit while the concurrent pool keeps running", async () => {
    const UNIT_COUNT = 8;
    const meter = new ConcurrencyMeter();
    const sinks = new InMemorySinks();
    const { bridge } = makeManyUnitBridge(UNIT_COUNT, { poisonAt: 3 });
    const result = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge,
        factory: instrumentedFactory({ meter, delayMs: 5 }),
        sinks,
      }),
      concurrency: 4,
    });
    // One poison unit isolated; the other 7 ran + persisted; ONE patch export.
    expect(result.failures).toHaveLength(1);
    expect(result.unitsRun).toBe(UNIT_COUNT - 1);
    expect(result.draftsPersisted).toBe(UNIT_COUNT - 1);
    expect(result.acceptedDraftCount).toBe(UNIT_COUNT - 1);
    expect(result.patchExportCount).toBe(1);
    expect(meter.maxInFlight).toBeGreaterThan(1); // genuinely concurrent.
  });

  it("persists drafts + provider-runs + queue-items in CANONICAL order, deterministically", async () => {
    const UNIT_COUNT = 9;
    // A mix: clean units + a mid-list deferral (queue item) + a poison (isolated).
    const markers = { deferAt: 2, poisonAt: 6 };

    const runOnce = async (): Promise<{
      draftOrder: string[];
      providerRunOrder: string[];
      queueOrder: string[];
      orderedInScopeIds: string[];
    }> => {
      const meter = new ConcurrencyMeter();
      const sinks = new InMemorySinks();
      const queue = new InMemoryReviewerQueue();
      const { bridge, orderedInScopeIds } = makeManyUnitBridge(UNIT_COUNT, markers);
      await runProjectDrivenExecutor({
        ...concurrencyBaseInput({
          bridge,
          factory: instrumentedFactory({ meter, delayMs: 6 }),
          sinks,
          queue,
        }),
        concurrency: 4,
      });
      expect(meter.maxInFlight).toBeGreaterThan(1);
      return {
        draftOrder: sinks.drafts.map((d) => d.bridgeUnitId),
        providerRunOrder: sinks.providerRuns.map((r) => r.bridgeUnitId),
        queueOrder: queue.items.map((i) => i.sourceItemRef),
        orderedInScopeIds,
      };
    };

    const first = await runOnce();
    const second = await runOnce();

    // Canonical order == the enumerated in-scope order MINUS the isolated poison.
    const expectedDraftOrder = first.orderedInScopeIds.filter(
      (_id, index) => index !== markers.poisonAt,
    );
    expect(first.draftOrder).toEqual(expectedDraftOrder);
    expect(first.providerRunOrder).toEqual(expectedDraftOrder);
    // The single deferral (index 2) is the only queue item.
    expect(first.queueOrder).toEqual([`agentic-loop:${first.orderedInScopeIds[markers.deferAt]}`]);

    // DETERMINISM: identical persisted order across independent runs.
    expect(second.draftOrder).toEqual(first.draftOrder);
    expect(second.providerRunOrder).toEqual(first.providerRunOrder);
    expect(second.queueOrder).toEqual(first.queueOrder);
  });

  it("budget cap STOPS dispatching before overspend under concurrency (unspent units not run)", async () => {
    const UNIT_COUNT = 12;
    const COST_PER_CALL = 0.001; // ~10 calls/unit -> ~$0.01/unit.
    const BUDGET_CAP = 0.03; // trips after ~3 units.
    const meter = new ConcurrencyMeter();
    const sinks = new InMemorySinks();
    const { bridge } = makeManyUnitBridge(UNIT_COUNT);
    const result = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge,
        factory: instrumentedFactory({ meter, delayMs: 4, costPerCallUsd: COST_PER_CALL }),
        sinks,
      }),
      concurrency: 2,
      budgetCapUsd: BUDGET_CAP,
    });
    // The cap stopped scheduling: not every unit ran, but at least one did.
    expect(result.budgetStopped).toBe(true);
    expect(result.unitsRun).toBeGreaterThan(0);
    expect(result.unitsRun).toBeLessThan(UNIT_COUNT);
    // Persisted count matches what actually ran (unspent units never dispatched).
    expect(sinks.drafts).toHaveLength(result.unitsRun);
    expect(sinks.providerRuns).toHaveLength(result.unitsRun);
    // Real spend accumulated, bounded: at most `concurrency - 1` in-flight units
    // can overshoot past the cap (here <= ~1 extra unit's worth).
    expect(result.totalUsageCostUsd).toBeGreaterThan(0);
    expect(result.totalUsageCostUsd).toBeLessThan(BUDGET_CAP + 0.02);
  });

  it("budget cap at concurrency=1 stops with ZERO overshoot (sequential guard preserved)", async () => {
    const UNIT_COUNT = 12;
    const COST_PER_CALL = 0.001;
    const BUDGET_CAP = 0.025;
    const meter = new ConcurrencyMeter();
    const sinks = new InMemorySinks();
    const { bridge } = makeManyUnitBridge(UNIT_COUNT);
    const result = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge,
        factory: instrumentedFactory({ meter, delayMs: 1, costPerCallUsd: COST_PER_CALL }),
        sinks,
      }),
      concurrency: 1,
      budgetCapUsd: BUDGET_CAP,
    });
    expect(result.budgetStopped).toBe(true);
    expect(result.unitsRun).toBeGreaterThan(0);
    expect(result.unitsRun).toBeLessThan(UNIT_COUNT);
    expect(meter.maxInFlight).toBe(1);
    // Sequential: the run stops the FIRST time completed cost reaches the cap, so
    // the total is exactly the sum through the crossing unit (one unit's worth of
    // overshoot at most — the unit that crossed).
    expect(result.totalUsageCostUsd).toBeGreaterThanOrEqual(BUDGET_CAP);
  });
});

// ---------------------------------------------------------------------------
// LIVE bounded-slice pilot — real ZDR OpenRouter DEV_PAIR, budget-capped, and
// PERSISTED TO REAL STORAGE (Postgres draft-jobs + provider-ledger +
// reviewer_queue + on-disk patch export).
//
// Drives a BOUNDED set of REAL Sweetie Rin-route units (built from the decoded
// narrative structure's real per-scene message stream, held out-of-repo)
// through the executor with the REAL OpenRouter provider + the CONCRETE DB/fs
// sinks. Post-run it QUERIES Postgres to prove N draft-jobs + N ledger rows +
// the reviewer_queue rows landed, ≥1 patch export written, real usage.cost in
// (0, $3], zdr:true on every call. Env-gated so CI never charges/needs a DB.
// ---------------------------------------------------------------------------

const LIVE_ENABLED =
  process.env.ITOTORI_DRIVEN_EXECUTOR_LIVE === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0 &&
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0 &&
  typeof process.env.ITOTORI_DRIVEN_STRUCTURE_JSON === "string" &&
  process.env.ITOTORI_DRIVEN_STRUCTURE_JSON.length > 0;

const LIVE_BUDGET_CAP_USD = 3.0;

// Live-run ids (distinct from the deterministic-test constants so a live run
// against a shared DB never collides with other fixtures).
const LIVE_WORKSPACE_ID = "workspace-driven-pilot";
const LIVE_PROJECT_ID = "project-driven-pilot";
const LIVE_REVISION_ID = "source-revision-driven-pilot";
const LIVE_SOURCE_BUNDLE_ID = "source-bundle-driven-pilot";
const LIVE_LOCALE_BRANCH_ID = "locale-branch-driven-pilot";

/** Build a real Sweetie unit from one decoded scene message. */
function makeLiveUnit(
  bridgeUnitId: string,
  sceneId: number,
  lineNo: number,
  speaker: string | null,
  sourceText: string,
): LocalizationUnitV02 {
  const key = `scene-${sceneId}/line-${String(lineNo).padStart(3, "0")}`;
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind: speaker !== null ? "dialogue" : "narration",
    sourceUnitKey: key,
    occurrenceId: `occ-${sceneId}-${lineNo}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `src-hash-${bridgeUnitId}`,
    sourceRevision: { revisionId: LIVE_REVISION_ID, revisionKind: "content_hash", value: "rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "sweetie-asset" },
    sourceLocation: { containerKey: "sweetie-asset" },
    ...(speaker !== null
      ? {
          speaker: {
            knowledgeState: "known" as const,
            speakerId: SPEAKER_ID,
            displayName: speaker,
          },
        }
      : {}),
    context: { route: { sceneId: String(sceneId) } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: key,
      sourceRevision: { revisionId: LIVE_REVISION_ID, revisionKind: "content_hash", value: "rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

async function seedLiveProjectScope(pool: DatabaseContext["pool"]): Promise<void> {
  await pool.query("delete from itotori_reviewer_queue_transitions where locale_branch_id = $1", [
    LIVE_LOCALE_BRANCH_ID,
  ]);
  await pool.query("delete from itotori_reviewer_queue_items where project_id = $1", [
    LIVE_PROJECT_ID,
  ]);
  await pool.query("delete from itotori_draft_jobs where project_id = $1", [LIVE_PROJECT_ID]);
  await pool.query("delete from itotori_projects where project_id = $1", [LIVE_PROJECT_ID]);
  await pool.query(
    `insert into itotori_workspaces (workspace_id, name) values ($1, $2)
     on conflict (workspace_id) do nothing`,
    [LIVE_WORKSPACE_ID, "driven-executor pilot"],
  );
  await pool.query(
    `insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [LIVE_PROJECT_ID, LIVE_WORKSPACE_ID, "driven-pilot", "Driven Pilot", "ja-JP", "imported"],
  );
  await pool.query(
    `insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
     values ($1, $2, $3, $4)`,
    [LIVE_REVISION_ID, LIVE_PROJECT_ID, "bridge_revision", "driven-pilot-v1"],
  );
  await pool.query(
    `insert into itotori_source_bundles (
       source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
       schema_version, source_bundle_hash, source_locale,
       extractor_name, extractor_version, unit_count, asset_count
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0)`,
    [
      LIVE_SOURCE_BUNDLE_ID,
      LIVE_PROJECT_ID,
      LIVE_REVISION_ID,
      "bridge-driven-pilot",
      "0.2.0",
      "hash:driven-pilot",
      "ja-JP",
      "structure-export",
      "1.0.0",
    ],
  );
  await pool.query(
    `insert into itotori_locale_branches (
       locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
     ) values ($1, $2, $3, $4, $5, $6)`,
    [LIVE_LOCALE_BRANCH_ID, LIVE_PROJECT_ID, LIVE_SOURCE_BUNDLE_ID, "en-US", "English", "active"],
  );
}

describe("runProjectDrivenExecutor (live bounded-slice pilot, real DB + fs)", () => {
  it("drives real Sweetie units, PERSISTING drafts + provider-runs + queue-items + patch to real storage under ZDR", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[driven-live] skipping — set ITOTORI_DRIVEN_EXECUTOR_LIVE=1, OPENROUTER_API_KEY, " +
          "OPENROUTER_ZDR_ACCOUNT_ASSERTED=1, DATABASE_URL, and ITOTORI_DRIVEN_STRUCTURE_JSON=<decoded structure> " +
          "(optional: ITOTORI_DRIVEN_SCENE=<id>, ITOTORI_DRIVEN_MAX_UNITS=<n>) to run the bounded pilot",
      );
      return;
    }
    // Privacy gate BEFORE any live byte.
    assertOpenRouterZdrAccount(process.env);

    const databaseUrl = databaseUrlFromEnv();
    await migrate(databaseUrl);
    const context = createDatabaseContext(databaseUrl);
    const liveActor: AuthorizationActor = { userId: localUserId };

    try {
      await bootstrapLocalUser(context.db);
      await seedLiveProjectScope(context.pool);

      const structurePath = process.env.ITOTORI_DRIVEN_STRUCTURE_JSON as string;
      const structure = parseNarrativeStructure(
        JSON.parse(readFileSync(structurePath, "utf8")) as unknown,
      );
      const sceneId = Number(process.env.ITOTORI_DRIVEN_SCENE ?? String(structure.entryScene));
      const scene = structure.scenes.find((s) => s.sceneId === sceneId);
      expect(scene).toBeDefined();
      const maxUnits = Number(process.env.ITOTORI_DRIVEN_MAX_UNITS ?? "24");

      const lines = (scene?.messages ?? [])
        .filter((m) => m.text.trim().length > 0)
        .slice(0, maxUnits);
      expect(lines.length).toBeGreaterThan(0);
      const units = lines.map((m, index) =>
        makeLiveUnit(
          `019ed0aa-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
          sceneId,
          index,
          m.speaker,
          m.text,
        ),
      );
      const bridge = {
        schemaVersion: "0.2.0",
        bridgeId: "sweetie-driven-pilot",
        sourceLocale: "ja-JP",
        units,
      } as unknown as BridgeBundleV02;

      const draftJobRepo = new ItotoriDraftJobRepository(context.db);
      const ledgerRepo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
      const reviewerQueueRepo = new ItotoriReviewerQueueRepository(context.db);
      const dbAdapter = new DrivenDbPersistenceAdapter(draftJobRepo, ledgerRepo, {
        projectId: LIVE_PROJECT_ID,
        localeBranchId: LIVE_LOCALE_BRANCH_ID,
        actor: liveActor,
        pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
      });
      const runDir = mkdtempSync(join(tmpdir(), "itotori-driven-live-patch-"));
      const patchSink = new FsDrivenPatchExportSink(runDir);
      const recorder = new LocalProviderRunArtifactRecorder(
        mkdtempSync(join(tmpdir(), "itotori-driven-live-runs-")),
      );
      const provider = new OpenRouterModelProvider({
        costCapUsd: LIVE_BUDGET_CAP_USD,
        artifactRecorder: recorder,
      });

      const result = await runProjectDrivenExecutor({
        bridge,
        rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
        pairPolicy: DEV_POLICY,
        pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
        projectId: LIVE_PROJECT_ID,
        localeBranchId: LIVE_LOCALE_BRANCH_ID,
        sourceRevisionId: LIVE_REVISION_ID,
        actor: liveActor,
        providerFactory: () => provider,
        reviewerQueue: { repository: reviewerQueueRepo },
        resolveUnitContext: () => ({ narrativeStructure: structure, sceneId }),
        translationScope: "dialogue-only",
        engineProfile: "reallive",
        sinks: { draft: dbAdapter, providerRun: dbAdapter, patchExport: patchSink },
        maxUnits,
        budgetCapUsd: LIVE_BUDGET_CAP_USD,
      });

      // Real usage.cost > 0, ZDR confirmed on every call, within the budget cap.
      expect(result.unitsRun).toBeGreaterThan(0);
      expect(result.totalUsageCostUsd).toBeGreaterThan(0);
      expect(result.totalUsageCostUsd).toBeLessThanOrEqual(LIVE_BUDGET_CAP_USD);
      expect(result.zdrConfirmed).toBe(true);

      // PERSISTED TO REAL STORAGE — query Postgres to prove the rows landed.
      const draftJobRows = await context.pool.query(
        "select count(*)::int as n from itotori_draft_jobs where project_id = $1",
        [LIVE_PROJECT_ID],
      );
      const ledgerRows = await context.pool.query(
        `select count(*)::int as n, coalesce(sum(cost_amount), 0)::text as total
           from itotori_draft_attempt_provider_ledger l
           join itotori_draft_job_attempts a on a.draft_job_attempt_id = l.draft_job_attempt_id
           join itotori_draft_jobs j on j.draft_job_id = a.draft_job_id
          where j.project_id = $1`,
        [LIVE_PROJECT_ID],
      );
      const queueRows = await context.pool.query(
        "select count(*)::int as n from itotori_reviewer_queue_items where project_id = $1",
        [LIVE_PROJECT_ID],
      );
      const persistedDraftJobs = Number(draftJobRows.rows[0].n);
      const persistedLedger = Number(ledgerRows.rows[0].n);
      const persistedQueue = Number(queueRows.rows[0].n);

      // N draft-jobs == N ledger rows == unitsRun, all in real Postgres.
      expect(persistedDraftJobs).toBe(result.unitsRun);
      expect(persistedLedger).toBe(result.unitsRun);
      expect(persistedQueue).toBe(result.reviewerQueueItemCount);
      // The ledger's summed real cost matches the executor's summed usage.cost.
      expect(Math.abs(Number(ledgerRows.rows[0].total) - result.totalUsageCostUsd)).toBeLessThan(
        1e-6,
      );

      // ONE patch export written to disk.
      expect(patchSink.exportCount).toBe(1);
      expect(existsSync(join(runDir, "translated-bridge.json"))).toBe(true);
      expect(existsSync(join(runDir, "patch-report.json"))).toBe(true);

      // eslint-disable-next-line no-console
      console.warn(
        `[driven-live] scene=${sceneId} unitsRun=${result.unitsRun} accepted=${result.acceptedDraftCount} ` +
          `deferred=${result.deferredCount} failed=${result.failures.length} ` +
          `persisted{draftJobs=${persistedDraftJobs} ledger=${persistedLedger} queue=${persistedQueue}} ` +
          `totalCost=$${result.totalUsageCostUsd.toFixed(6)} zdr=${result.zdrConfirmed} ` +
          `budgetStopped=${result.budgetStopped} patchDir=${runDir}`,
      );
    } finally {
      await context.close();
    }
    // Generous ceiling: real ZDR calls are sequential (~10 provider calls per
    // unit across the loop's stages), so a bounded slice still needs headroom.
  }, 1_800_000);
});
