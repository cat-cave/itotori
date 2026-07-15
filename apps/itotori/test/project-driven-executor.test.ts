// itotori-project-level-driven-executor (P0 — LAST pre-pilot seam) — tests.
//
// Proves the driven executor turns the at-scale plumbing proof into a REAL
// driven pilot: it ENUMERATES the in-scope units (consuming the batch
// planner's scene grouping), runs `runAgenticLoopForUnit` PER unit WITH the
// real structure-informed context (narrativeStructure + sceneId, P0#1),
// persists written outcomes + provider-run summaries (real usage.cost + ZDR),
// and produces ONE patch export only after configured-scope coverage is
// complete. Per-unit failure isolation: one unit's malformed-pack failure (the
// filed P2) does NOT abort the run.
//
// Driven with a FakeModelProvider + in-memory sinks — no live LLM or Postgres.
// The LIVE (real ZDR OpenRouter) proof is the env-gated pilot.

import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STYLE_GUIDE_POLICY_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type StyleGuidePolicyV0Draft,
} from "@itotori/localization-bridge-schema";
import {
  ItotoriLocalizationJournalRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  localUserId,
  migrate,
  type AuthorizationActor,
  type ContextArtifactInvalidationResult,
  type DatabaseContext,
  type InvalidateContextArtifactsInput,
} from "@itotori/db";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import {
  InMemoryContextArtifactRepository,
  sceneSummaryArtifactId,
} from "../src/orchestrator/context-brain.js";
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
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  type NarrativeStructure,
} from "../src/structure/index.js";
import {
  DEFAULT_DRIVEN_CONCURRENCY,
  runProjectDrivenExecutor,
  synthesiseDrivenTranslatedBridge,
  unitSurfaceKindInScope,
  type DrivenFailedUnitJournalRecord,
  type DrivenPatchExportRecord,
  type DrivenUnitJournalRecord,
  type DrivenUnitContext,
} from "../src/orchestrator/project-driven-executor.js";
import type { InvocationCostAdmission } from "../src/orchestrator/invocation-supervisor.js";
import {
  buildScopeGraph,
  resolveEffectiveScope,
  type WorkCarve,
} from "../src/agents/work-scope/index.js";
import {
  DrivenJournalPersistenceAdapter,
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
const UNIT_A = "019ed0aa-0000-7000-8000-0000000000a1"; // clean written outcome
const UNIT_B = "019ed0aa-0000-7000-8000-0000000000b2"; // critical QA annotation
const UNIT_C = "019ed0aa-0000-7000-8000-0000000000c3"; // clean written outcome
const UNIT_D = "019ed0aa-0000-7000-8000-0000000000d4"; // POISON -> throws (isolated)
const UNIT_E = "019ed0aa-0000-7000-8000-0000000000e5"; // ui_label -> out of scope

const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";

const POISON_MARKER = "POISON_MALFORMED_PACK";
const CRITICAL_QA_MARKER = "CRITICAL_QA";

// --- In-memory persistence sinks --------------------------------------------

class InMemorySinks {
  readonly journalUnits: DrivenUnitJournalRecord[] = [];
  readonly failedUnitAttempts: DrivenFailedUnitJournalRecord[] = [];
  readonly patchExports: DrivenPatchExportRecord[] = [];
  readonly admittedAttemptIds: string[] = [];
  readonly journal = {
    // The executor intentionally requires admission even for an unlimited
    // run. This fixture is an explicit test-only admission, not a production
    // fallback: production uses DrivenJournalPersistenceAdapter.
    createCostAdmission: (): InvocationCostAdmission => ({
      admit: async ({ attempt }) => {
        this.admittedAttemptIds.push(attempt.attemptId);
        return { admitted: true };
      },
    }),
    persistUnitJournal: async (record: DrivenUnitJournalRecord): Promise<void> => {
      this.journalUnits.push(record);
    },
    persistFailedUnitAttempts: async (record: DrivenFailedUnitJournalRecord): Promise<void> => {
      this.failedUnitAttempts.push(record);
    },
  };
  readonly patchExport = {
    exportPatch: async (record: DrivenPatchExportRecord): Promise<void> => {
      this.patchExports.push(record);
    },
  };
}

/** Records the stale rows observed at the live invalidation boundary. */
class RecordingContextArtifactRepository extends InMemoryContextArtifactRepository {
  readonly invalidations: Array<{
    input: InvalidateContextArtifactsInput;
    staleArtifactIds: string[];
  }> = [];

  override async invalidateAffectedArtifacts(
    actor: AuthorizationActor,
    input: InvalidateContextArtifactsInput,
  ): Promise<ContextArtifactInvalidationResult> {
    const result = await super.invalidateAffectedArtifacts(actor, input);
    this.invalidations.push({
      input,
      staleArtifactIds: this.listAll()
        .filter((artifact) => artifact.status === "stale")
        .map((artifact) => artifact.contextArtifactId),
    });
    return result;
  }
}

// --- Fixtures ---------------------------------------------------------------

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
            { order: 1, speaker: null, text: "青空が広がっていた。", textSurface: null },
          ],
          choices: [],
        },
      ],
    },
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
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
    makeUnit(UNIT_B, `今日は${CRITICAL_QA_MARKER}だね。`, "dialogue", 2),
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

function translationContent(bridgeUnitId: string, draftText = "Good morning."): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText,
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
 *   - a unit carrying CRITICAL_QA_MARKER emits a critical QA finding. With zero
 *     repair budget it remains a written primary candidate plus annotations.
 *   - every other unit translates cleanly into a written outcome.
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
          if (blob.includes(CRITICAL_QA_MARKER)) {
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
  semanticPrompts?: string[],
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `driven-capture-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          if (agentLabel === "terminology-candidate") {
            semanticPrompts?.push(request.messages.map((message) => message.content).join("\n"));
          }
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

function baseInput(sinks?: InMemorySinks) {
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

describe("synthesiseDrivenTranslatedBridge (written-body coverage)", () => {
  it("rejects a missing in-scope body instead of synthesising source text", () => {
    const rawBridge = JSON.parse(JSON.stringify(makeBridge())) as unknown;
    expect(() =>
      synthesiseDrivenTranslatedBridge({
        rawBridge,
        writtenBodies: new Map([[UNIT_A, "Good morning."]]),
        inScopeUnitIds: new Set([UNIT_A, UNIT_B]),
        engineProfile: "rpg-maker-mv-mz",
        targetLocale: "en-US",
      }),
    ).toThrow(/no written body; refusing target-source substitution/u);
  });

  it("rejects a source-equal in-scope body instead of exporting it", () => {
    const bridge = makeBridge();
    const rawBridge = JSON.parse(JSON.stringify(bridge)) as unknown;
    const source = bridge.units.find((unit) => unit.bridgeUnitId === UNIT_A)!.sourceText;
    expect(() =>
      synthesiseDrivenTranslatedBridge({
        rawBridge,
        writtenBodies: new Map([[UNIT_A, source]]),
        inScopeUnitIds: new Set([UNIT_A]),
        engineProfile: "rpg-maker-mv-mz",
        targetLocale: "en-US",
      }),
    ).toThrow(/must not echo the source text/u);
  });

  it("rejects a source-equal RealLive body after out-of-band markup is stripped", () => {
    const bridge = makeBridge();
    const markedUnit = bridge.units.find((unit) => unit.bridgeUnitId === UNIT_A);
    if (markedUnit === undefined) {
      throw new Error("fixture must include UNIT_A");
    }
    markedUnit.sourceText = "<reallive.kidoku 7>おはよう、和人。";

    expect(() =>
      synthesiseDrivenTranslatedBridge({
        rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
        writtenBodies: new Map([[UNIT_A, "おはよう、和人。"]]),
        inScopeUnitIds: new Set([UNIT_A]),
        engineProfile: "reallive",
        targetLocale: "en-US",
      }),
    ).toThrow(/must not echo the source text/u);
  });
});

describe("runProjectDrivenExecutor (itotori-project-level-driven-executor)", () => {
  it("persists written progress and pauses without a partial patch at the retry ceiling", async () => {
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor(baseInput(sinks));

    // Enumeration: 5 units total, 4 in scope (UNIT_E ui_label excluded).
    expect(result.unitsEnumerated).toBe(5);
    expect(result.unitsInScope).toBe(4);

    // UNIT_D models a degenerate route that never satisfies the schema. This
    // is the hard-ceiling bug path: run-level pause, never a terminal unit
    // failure or fabricated candidate.
    expect(result.failures).toEqual([]);
    expect(result.runState).toBe("paused");
    expect(result.pausedBlocker).toMatchObject({ kind: "itotori_bug" });
    expect(result.unitsRun).toBe(3);

    // Every successfully returned loop bundle persists one required selected
    // body. UNIT_B's critical QA finding is annotation only, never a missing
    // draft state.
    expect(result.writtenOutcomesPersisted).toBe(3);
    expect(result.writtenOutcomeCount).toBe(3);
    expect(result.journalUnitsPersisted).toBe(3);
    expect(sinks.journalUnits).toHaveLength(3);
    for (const { writtenOutcome: outcome } of sinks.journalUnits) {
      expect(outcome.selectedBody.trim().length).toBeGreaterThan(0);
      const source = makeBridge().units.find(
        (unit) => unit.bridgeUnitId === outcome.bridgeUnitId,
      )!.sourceText;
      expect(outcome.selectedBody).not.toBe(source);
    }
    const flagged = sinks.journalUnits.find(
      (journal) => journal.writtenOutcome.bridgeUnitId === UNIT_B,
    )!.writtenOutcome;
    expect(flagged.outcome.findings.some((finding) => finding.severity === "critical")).toBe(true);
    expect(flagged.outcome.qualityFlags.length).toBeGreaterThan(0);

    // Every physical provider call, including the isolated failure's partial
    // attempt sequence, reaches the durable journal with its real routing
    // posture rather than a per-unit aggregate provider-run summary.
    const persistedAttempts = [
      ...sinks.journalUnits.flatMap((journal) => journal.attempts),
      ...sinks.failedUnitAttempts.flatMap((journal) => journal.attempts),
    ];
    expect(result.attemptsPersisted).toBe(persistedAttempts.length);
    expect(result.attemptsPersisted).toBeGreaterThan(result.journalUnitsPersisted);
    for (const attempt of persistedAttempts) {
      expect(attempt.zdr).toBe(true);
      expect(attempt.modelId).toBe(DEV_PAIR.modelId);
      expect(attempt.providerId).toBe(DEV_PAIR.providerId);
    }
    const poisonAttempts = sinks.failedUnitAttempts.find(
      (journal) => journal.bridgeUnitId === UNIT_D,
    )!.attempts;
    expect(
      poisonAttempts
        .filter((attempt) => attempt.stage === "context" || attempt.stage === "pre_translation")
        .every(
          (attempt) =>
            attempt.validationResult === "accepted" && attempt.retryDecision === "advance",
        ),
    ).toBe(true);
    const poisonTranslationAttempts = poisonAttempts.filter(
      (attempt) => attempt.stage === "translation",
    );
    expect(poisonTranslationAttempts).toHaveLength(12);
    expect(poisonTranslationAttempts[0]).toMatchObject({
      validationResult: "schema_invalid",
      retryDecision: "retry",
    });
    expect(
      poisonTranslationAttempts.every(
        (attempt) =>
          attempt.validationResult === "schema_invalid" &&
          attempt.failureClass === "schema_invalid",
      ),
    ).toBe(true);
    expect(poisonTranslationAttempts.at(-1)).toMatchObject({
      validationResult: "schema_invalid",
      failureClass: "schema_invalid",
      retryDecision: "advance",
    });
    expect(result.zdrConfirmed).toBe(true);

    // UNIT_D paused operationally. Do not fabricate source text for that
    // in-scope unit or emit a partial patch.
    expect(result.patchReport.coverageComplete).toBe(false);
    expect(result.patchReport.writtenUnits.map((unit) => unit.bridgeUnitId).sort()).toEqual(
      [UNIT_A, UNIT_B, UNIT_C].sort(),
    );
    expect(result.patchExportCount).toBe(0);
    expect(sinks.patchExports).toHaveLength(0);
  });

  it("supports a bounded slice via maxUnits (whole-game capable, pilot-bounded)", async () => {
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor({ ...baseInput(sinks), maxUnits: 2 });
    // Only the first 2 in-scope units (A, B) run; the poison D is never reached.
    expect(result.unitsRun).toBe(2);
    expect(result.failures).toHaveLength(0);
    expect(result.writtenOutcomesPersisted).toBe(2);
    expect(result.journalUnitsPersisted).toBe(2);
    expect(result.patchReport.coverageComplete).toBe(false);
    expect(result.patchExportCount).toBe(0);
  });

  it("threads resolved context per unit while persisting written outcomes", async () => {
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor(baseInput(sinks));
    expect(result.writtenOutcomesPersisted).toBe(3);
    expect(result.journalUnitsPersisted).toBe(3);
    expect(result.attemptsPersisted).toBeGreaterThan(3);
    expect(result.patchExportCount).toBe(0);
    // Every persisted outcome carries the resolved sceneId (real context threaded).
    for (const { writtenOutcome: outcome } of sinks.journalUnits) {
      expect(outcome.sceneId).toBe(SCENE_ID);
    }
  });

  it("passes planner batch siblings into semantic terminology evidence", async () => {
    const promptsByUnit = new Map<string, string>();
    const semanticPrompts: string[] = [];
    const sinks = new InMemorySinks();
    const sibling = makeBridge().units.find((unit) => unit.bridgeUnitId === UNIT_B);
    if (sibling === undefined) {
      throw new Error("fixture must include a same-scene sibling");
    }

    const result = await runProjectDrivenExecutor({
      ...baseInput(sinks),
      providerFactory: promptCapturingProviderFactory(promptsByUnit, semanticPrompts),
      maxUnits: 1,
    });

    expect(result.unitsRun).toBe(1);
    // UNIT_B is not dispatched in this bounded run, so its presence here proves
    // the planner batch retained its real source body as semantic sibling evidence.
    expect(semanticPrompts).toHaveLength(1);
    expect(semanticPrompts[0]).toContain(sibling.bridgeUnitId);
    expect(semanticPrompts[0]).toContain(sibling.sourceText);
  });

  it("a run over units WITHOUT any structure still drives + persists (synthetic path)", async () => {
    const sinks = new InMemorySinks();
    const input = baseInput(sinks);
    const result = await runProjectDrivenExecutor({
      ...input,
      resolveUnitContext: () => undefined,
    });
    expect(result.unitsRun).toBe(3);
    expect(result.writtenOutcomesPersisted).toBe(3);
    for (const { writtenOutcome: outcome } of sinks.journalUnits) {
      expect(outcome.sceneId).toBeUndefined();
    }
  });

  it("pauses malformed structure context as an itotori bug without a terminal unit failure", async () => {
    const sinks = new InMemorySinks();
    const result = await runProjectDrivenExecutor({
      ...baseInput(sinks),
      maxUnits: 1,
      resolveUnitContext: (): DrivenUnitContext =>
        ({ narrativeStructure: makeStructure() }) as unknown as DrivenUnitContext,
    });

    expect(result.failures).toEqual([]);
    expect(result.runState).toBe("paused");
    expect(result.pausedBlocker).toMatchObject({
      kind: "itotori_bug",
      detail: expect.stringContaining("narrativeStructure supplied without sceneId"),
    });
    expect(result.unitsRun).toBe(0);
    expect(result.writtenOutcomesPersisted).toBe(0);
    expect(result.journalUnitsPersisted).toBe(0);
    expect(result.attemptsPersisted).toBe(0);
    expect(sinks.journalUnits).toHaveLength(0);
    expect(sinks.failedUnitAttempts).toHaveLength(0);
    expect(result.patchExportCount).toBe(0);
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
    const styleGuide: StyleGuidePolicyV0Draft = {
      schemaVersion: STYLE_GUIDE_POLICY_SCHEMA_VERSION,
      sections: {
        tone: [
          {
            ruleId: "tone-fixture-warm",
            guidance: "Keep narration warm and direct.",
          },
        ],
        terminology: [],
        honorifics: [],
        formatting: [],
        protectedSpans: [],
      },
    };

    const result = await runProjectDrivenExecutor({
      ...baseInput(sinks),
      providerFactory: promptCapturingProviderFactory(promptsByUnit),
      maxUnits: 3,
      styleGuide,
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

    // The journal receives the resolved prompt context itself, not only the
    // structure artifact references. A reader can reconstruct the glossary,
    // active style rule, and inherited/override scope that produced UNIT_C.
    const afterJournal = sinks.journalUnits.find(
      (journal) => journal.writtenOutcome.bridgeUnitId === UNIT_C,
    );
    expect(afterJournal).toBeDefined();
    expect(afterJournal?.contextPacket).toMatchObject({
      glossary: expect.arrayContaining([
        expect.objectContaining({
          preferredSourceForm: "光紋",
          preferredTargetForm: "Lumen Crest",
        }),
        expect.objectContaining({
          preferredSourceForm: "約束",
          preferredTargetForm: "After Promise",
        }),
      ]),
      styleGuide: {
        schemaVersion: STYLE_GUIDE_POLICY_SCHEMA_VERSION,
        sections: {
          tone: [
            {
              ruleId: "tone-fixture-warm",
              guidance: "Keep narration warm and direct.",
            },
          ],
        },
      },
      styleGuideRules: [
        {
          ruleId: "tone-fixture-warm",
          section: "tone",
          guidance: "Keep narration warm and direct.",
        },
      ],
      workScope: {
        workId: "fixture-archive#work:after",
        glossary: expect.arrayContaining([
          expect.objectContaining({ sourceForm: "光紋", provenance: "inherited" }),
          expect.objectContaining({ sourceForm: "約束", provenance: "override" }),
        ]),
      },
      contextVersionReferenceState: {
        availability: "pending_persistent_context_brain",
        refs: [],
      },
      artifacts: expect.any(Array),
    });
    expect(afterJournal?.contextRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refKind: "glossary_term",
          details: expect.objectContaining({ preferredSourceForm: "光紋" }),
        }),
        expect.objectContaining({
          refKind: "style_guide_rule",
          refId: "tone-fixture-warm",
          details: expect.objectContaining({ guidance: "Keep narration warm and direct." }),
        }),
        expect.objectContaining({
          refKind: "work_scope",
          refId: "fixture-archive#work:after",
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// itotori-batched-concurrent-translation-scheduling — bounded-concurrent pool.
//
// Proves the driven executor schedules up to `concurrency` units'
// `runAgenticLoopForUnit` at once (a client-side worker pool over the canonical
// unit list) while keeping: (a) an injected durable admission's dispatch
// decision, (b) per-unit failure isolation, (c) DETERMINISTIC canonical result
// ordering regardless of completion order. Driven with an instrumented fake
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
 * Wraps a FakeModelProvider with an artificial delay + the concurrency meter.
 */
class InstrumentedProvider implements ModelProvider {
  constructor(
    private readonly inner: FakeModelProvider,
    private readonly meter: ConcurrencyMeter,
    private readonly delayMs: number,
  ) {}
  get descriptor() {
    return this.inner.descriptor;
  }
  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    this.meter.enter();
    try {
      await sleep(this.delayMs);
      return await this.inner.invoke(request);
    } finally {
      this.meter.exit();
    }
  }
}

function signal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Holds one unit at translation while another worker reaches the journal. */
class TranslationGateProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly heldBridgeUnitId: string,
    private readonly entered: () => void,
    private readonly release: Promise<void>,
  ) {}

  get descriptor() {
    return this.inner.descriptor;
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    if (
      request.taskKind === "draft_translation" &&
      bridgeUnitIdOf(request) === this.heldBridgeUnitId
    ) {
      this.entered();
      await this.release;
    }
    return this.inner.invoke(request);
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
    const bridgeUnitId = bridgeUnitIdOf(request);
    // Each multi-unit fixture result deliberately differs so the patch-export
    // assertion proves a unit cannot receive another unit's selected text.
    return translationContent(bridgeUnitId, `Concurrent target ${bridgeUnitId.slice(-4)}`);
  }
  if (request.taskKind === "llm_qa") {
    if (blob.includes(CRITICAL_QA_MARKER)) {
      return criticalQaContent(bridgeUnitIdOf(request));
    }
    return cleanQaContent();
  }
  return "";
}

function instrumentedFactory(opts: {
  meter: ConcurrencyMeter;
  delayMs: number;
  sceneSummaryCalls?: { count: number };
  semanticEnrichmentCalls?: Record<string, { count: number }>;
}): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) => {
    const inner = new FakeModelProvider({
      providerName: `driven-conc-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        if (request.taskKind === "experiment") {
          const enrichmentCalls = opts.semanticEnrichmentCalls?.[agentLabel];
          if (enrichmentCalls !== undefined) {
            enrichmentCalls.count += 1;
          }
          if (agentLabel === "scene-summary" && opts.sceneSummaryCalls !== undefined) {
            opts.sceneSummaryCalls.count += 1;
          }
        }
        return drivenGenerate(agentLabel, request);
      },
    });
    return new InstrumentedProvider(inner, opts.meter, opts.delayMs);
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
      sourceText = `今日は${CRITICAL_QA_MARKER}だね。${i}`;
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
  };
}

describe("runProjectDrivenExecutor (bounded-concurrent scheduling)", () => {
  it("exposes a conservative default concurrency", () => {
    expect(DEFAULT_DRIVEN_CONCURRENCY).toBe(8);
  });

  it("single-flights one persisted build per enrichment type for eight concurrent same-scene units", async () => {
    const UNIT_COUNT = 8;
    const semanticEnrichmentCalls = {
      "scene-summary": { count: 0 },
      "character-relationship": { count: 0 },
      "terminology-candidate": { count: 0 },
      "route-choice-map": { count: 0 },
    };
    const meter = new ConcurrencyMeter();
    const sinks = new InMemorySinks();
    const contextArtifacts = new InMemoryContextArtifactRepository();
    const { bridge } = makeManyUnitBridge(UNIT_COUNT);

    const result = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge,
        factory: instrumentedFactory({
          meter,
          // Keep the leader in-flight long enough for every worker to perform
          // its initial empty-store lookup. Without per-(scene, enrichment)
          // single-flight, each worker would invoke every semantic provider.
          delayMs: 20,
          semanticEnrichmentCalls,
        }),
        sinks,
      }),
      contextArtifactRepository: contextArtifacts,
      concurrency: UNIT_COUNT,
    });

    expect(result.unitsRun).toBe(UNIT_COUNT);
    expect(semanticEnrichmentCalls).toEqual({
      "scene-summary": { count: 1 },
      "character-relationship": { count: 1 },
      "terminology-candidate": { count: 1 },
      "route-choice-map": { count: 1 },
    });
    expect(
      contextArtifacts
        .listAll()
        .find(
          (artifact) =>
            artifact.contextArtifactId === sceneSummaryArtifactId(PROJECT_ID, String(SCENE_ID)),
        ),
    ).toEqual(
      expect.objectContaining({
        status: "active",
        producedByAgent: "scene-summary",
      }),
    );
  });

  it("invalidates changed-source context before rebuilding instead of stale-reusing it", async () => {
    const UPDATED_REVISION_ID = "019ed0cc-0000-7000-8000-0000000000f6";
    const sceneSummaryCalls = { count: 0 };
    const meter = new ConcurrencyMeter();
    const contextArtifacts = new RecordingContextArtifactRepository();
    const { bridge: initialBridge } = makeManyUnitBridge(1);
    const originalUnit = initialBridge.units[0];
    if (originalUnit === undefined) {
      throw new Error("invalidation fixture requires one bridge unit");
    }
    const factory = instrumentedFactory({ meter, delayMs: 0, sceneSummaryCalls });

    const first = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge: initialBridge,
        factory,
        sinks: new InMemorySinks(),
      }),
      contextArtifactRepository: contextArtifacts,
      concurrency: 1,
    });
    expect(first.unitsRun).toBe(1);

    const sceneArtifactId = sceneSummaryArtifactId(PROJECT_ID, String(SCENE_ID));
    const originalArtifact = contextArtifacts
      .listAll()
      .find((artifact) => artifact.contextArtifactId === sceneArtifactId);
    if (originalArtifact === undefined) {
      throw new Error("first driven unit did not persist its scene summary");
    }
    const originalContentHash = originalArtifact.contentHash;

    // The loop invokes invalidation on every live context read, but an
    // unchanged source revision must remain reusable. This guards against
    // accidentally passing every current bridgeUnitId as an explicit manual
    // invalidation target.
    const reused = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge: initialBridge,
        factory,
        sinks: new InMemorySinks(),
      }),
      contextArtifactRepository: contextArtifacts,
      concurrency: 1,
    });
    expect(reused.unitsRun).toBe(1);
    expect(sceneSummaryCalls.count).toBe(1);
    const unchangedInvalidation =
      contextArtifacts.invalidations[contextArtifacts.invalidations.length - 1];
    expect(unchangedInvalidation).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({ sourceRevisionId: REVISION_ID }),
        staleArtifactIds: expect.not.arrayContaining([sceneArtifactId]),
      }),
    );

    const updatedUnit: LocalizationUnitV02 = {
      ...originalUnit,
      sourceRevision: {
        ...originalUnit.sourceRevision,
        revisionId: UPDATED_REVISION_ID,
      },
      patchRef: {
        ...originalUnit.patchRef,
        sourceRevision: {
          ...originalUnit.patchRef.sourceRevision,
          revisionId: UPDATED_REVISION_ID,
        },
      },
    };
    const updatedBridge = {
      ...initialBridge,
      units: [updatedUnit],
    } as unknown as BridgeBundleV02;

    const rebuilt = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge: updatedBridge,
        factory,
        sinks: new InMemorySinks(),
      }),
      sourceRevisionId: UPDATED_REVISION_ID,
      contextArtifactRepository: contextArtifacts,
      concurrency: 1,
    });

    expect(rebuilt.unitsRun).toBe(1);
    expect(sceneSummaryCalls.count).toBe(2);
    const latestInvalidation =
      contextArtifacts.invalidations[contextArtifacts.invalidations.length - 1];
    expect(latestInvalidation).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          sourceRevisionId: UPDATED_REVISION_ID,
          reason: "agentic_loop_source_or_dependency_changed",
        }),
        staleArtifactIds: expect.arrayContaining([sceneArtifactId]),
      }),
    );
    const rebuiltArtifact = contextArtifacts
      .listAll()
      .find((artifact) => artifact.contextArtifactId === sceneArtifactId);
    expect(rebuiltArtifact).toEqual(
      expect.objectContaining({
        status: "active",
        sourceRevisionId: UPDATED_REVISION_ID,
      }),
    );
    // A revision change is stale even when the cited bytes and content hash
    // remain identical.
    expect(rebuiltArtifact?.contentHash).toBe(originalContentHash);
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
    // All N units ran + persisted written outcomes (all clean).
    expect(result.unitsRun).toBe(UNIT_COUNT);
    expect(result.writtenOutcomesPersisted).toBe(UNIT_COUNT);
    expect(result.journalUnitsPersisted).toBe(UNIT_COUNT);
    expect(result.attemptsPersisted).toBe(meter.totalCalls);
    expect(result.writtenOutcomeCount).toBe(UNIT_COUNT);
    expect(result.patchExportCount).toBe(1);
    expect(sinks.journalUnits).toHaveLength(UNIT_COUNT);
    expect(sinks.patchExports).toHaveLength(1);
    const translatedUnits = (
      sinks.patchExports[0]!.translatedBridge as {
        units: Array<{ bridgeUnitId: string; target: { text: string } }>;
      }
    ).units;
    const targetById = new Map(
      translatedUnits.map((unit) => [unit.bridgeUnitId, unit.target.text]),
    );
    for (const unit of bridge.units) {
      const selectedBody = `Concurrent target ${unit.bridgeUnitId.slice(-4)}`;
      // RealLive export adds the engine-visible wrapper, but each unit must
      // still receive exactly its own selected candidate rather than a
      // neighbouring unit's body.
      expect(targetById.get(unit.bridgeUnitId)).toBe(`「${selectedBody}」`);
    }
    // Same number of provider calls, but wall-clock is far below the sequential
    // sum (bounded speedup ~K). A conservative < 0.6x threshold avoids flake.
    expect(meter.totalCalls).toBe(seqMeter.totalCalls);
    expect(concMs).toBeLessThan(seqMs * 0.6);
  });

  it("persists each completed unit journal before a slower worker drains", async () => {
    const { bridge, orderedInScopeIds } = makeManyUnitBridge(2);
    const [slowUnitId, fastUnitId] = orderedInScopeIds;
    if (slowUnitId === undefined || fastUnitId === undefined) {
      throw new Error("incremental-persistence fixture requires two units");
    }
    const slowTranslationEntered = signal();
    const releaseSlowTranslation = signal();
    const fastUnitPersisted = signal();
    const sinks = new InMemorySinks();
    const persistUnitJournal = sinks.journal.persistUnitJournal;
    sinks.journal.persistUnitJournal = async (record): Promise<void> => {
      await persistUnitJournal(record);
      if (record.writtenOutcome.bridgeUnitId === fastUnitId) {
        fastUnitPersisted.resolve();
      }
    };
    const factory: AgenticLoopProviderFactory = ({ stage, agentLabel }) => {
      const inner = new FakeModelProvider({
        providerName: `driven-incremental-${stage}-${agentLabel}`,
        generate: (request: ModelInvocationRequest): string => drivenGenerate(agentLabel, request),
      });
      return new TranslationGateProvider(
        inner,
        slowUnitId,
        () => slowTranslationEntered.resolve(),
        releaseSlowTranslation.promise,
      );
    };

    const run = runProjectDrivenExecutor({
      ...concurrencyBaseInput({ bridge, factory, sinks }),
      concurrency: 2,
    });
    await slowTranslationEntered.promise;

    // If the executor buffered completion records until `Promise.all(workers)`
    // drained, this timeout would win because slowUnitId remains held above.
    const persistedBeforeDrain = await Promise.race([
      fastUnitPersisted.promise.then(() => true),
      sleep(1_000).then(() => false),
    ]);
    expect(persistedBeforeDrain).toBe(true);
    expect(sinks.journalUnits.map((journal) => journal.writtenOutcome.bridgeUnitId)).toContain(
      fastUnitId,
    );

    releaseSlowTranslation.resolve();
    await expect(run).resolves.toMatchObject({
      unitsRun: 2,
      journalUnitsPersisted: 2,
    });
  });

  it("persists concurrent progress then pauses the poison unit without a partial patch", async () => {
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
    // The hard ceiling is a run-level bug pause, not a terminal unit failure.
    expect(result.failures).toEqual([]);
    expect(result.runState).toBe("paused");
    expect(result.pausedBlocker).toMatchObject({ kind: "itotori_bug" });
    expect(result.unitsRun).toBe(UNIT_COUNT - 1);
    expect(result.writtenOutcomesPersisted).toBe(UNIT_COUNT - 1);
    expect(result.journalUnitsPersisted).toBe(UNIT_COUNT - 1);
    expect(result.writtenOutcomeCount).toBe(UNIT_COUNT - 1);
    expect(result.patchReport.coverageComplete).toBe(false);
    expect(result.patchExportCount).toBe(0);
    expect(meter.maxInFlight).toBeGreaterThan(1); // genuinely concurrent.
  });

  it("keeps aggregate outcome order canonical while journal units stream by completion", async () => {
    const UNIT_COUNT = 9;
    // A mix: clean units + a QA-flagged unit + a poison (isolated).
    const markers = { deferAt: 2, poisonAt: 6 };

    const runOnce = async (): Promise<{
      journalUnitOrder: string[];
      outcomeUnitOrder: string[];
      orderedInScopeIds: string[];
    }> => {
      const meter = new ConcurrencyMeter();
      const sinks = new InMemorySinks();
      const { bridge, orderedInScopeIds } = makeManyUnitBridge(UNIT_COUNT, markers);
      const result = await runProjectDrivenExecutor({
        ...concurrencyBaseInput({
          bridge,
          factory: instrumentedFactory({ meter, delayMs: 6 }),
          sinks,
        }),
        concurrency: 4,
      });
      expect(meter.maxInFlight).toBeGreaterThan(1);
      return {
        journalUnitOrder: sinks.journalUnits.map((journal) => journal.writtenOutcome.bridgeUnitId),
        outcomeUnitOrder: result.unitOutcomes.map((outcome) => outcome.bridgeUnitId),
        orderedInScopeIds,
      };
    };

    const first = await runOnce();
    const second = await runOnce();

    // Canonical report order == the enumerated in-scope order MINUS the
    // isolated poison. Journal persistence deliberately streams by completion
    // so a slower worker cannot make already-completed evidence volatile.
    const expectedOutcomeUnitOrder = first.orderedInScopeIds.filter(
      (_id, index) => index !== markers.poisonAt,
    );
    expect(first.outcomeUnitOrder).toEqual(expectedOutcomeUnitOrder);
    expect(first.journalUnitOrder.slice().sort()).toEqual(expectedOutcomeUnitOrder.slice().sort());

    // DETERMINISM: the aggregate reported to callers remains canonical across
    // independent runs even when physical journal writes race by completion.
    expect(second.outcomeUnitOrder).toEqual(first.outcomeUnitOrder);
    expect(second.journalUnitOrder.slice().sort()).toEqual(first.journalUnitOrder.slice().sort());
  });

  it("rejects an uncapped in-memory run without atomic admission before dispatch", async () => {
    const UNIT_COUNT = 12;
    const meter = new ConcurrencyMeter();
    const sinks = new InMemorySinks();
    const { bridge } = makeManyUnitBridge(UNIT_COUNT);
    const input = concurrencyBaseInput({
      bridge,
      factory: instrumentedFactory({ meter, delayMs: 4 }),
      sinks,
    });
    await expect(
      runProjectDrivenExecutor({
        ...input,
        sinks: {
          journal: {
            persistUnitJournal: sinks.journal.persistUnitJournal,
            persistFailedUnitAttempts: sinks.journal.persistFailedUnitAttempts,
          },
          patchExport: sinks.patchExport,
        },
        concurrency: 2,
      }),
    ).rejects.toThrow("every driven run requires a durable atomic cost-admission");
    expect(meter.totalCalls).toBe(0);
  });

  it("uses an injected durable admission denial to pause before a second dispatch", async () => {
    const UNIT_COUNT = 12;
    const meter = new ConcurrencyMeter();
    const sinks = new InMemorySinks();
    const { bridge } = makeManyUnitBridge(UNIT_COUNT);
    const admittedAttempts: string[] = [];
    const costAdmission: InvocationCostAdmission = {
      admit: async ({ attempt, worstCaseCostUsd }) => {
        admittedAttempts.push(`${attempt.attemptId}:${worstCaseCostUsd ?? "unbounded"}`);
        if (admittedAttempts.length === 1) return { admitted: true };
        return {
          admitted: false,
          detail: "durable cost reservation rejected the next attempt",
          evidence: "test durable account exhausted",
        };
      },
    };
    const result = await runProjectDrivenExecutor({
      ...concurrencyBaseInput({
        bridge,
        factory: instrumentedFactory({ meter, delayMs: 1 }),
        sinks,
      }),
      concurrency: 1,
      budgetCapUsd: 0.03,
      costAdmission,
    });
    expect(result.budgetStopped).toBe(true);
    expect(result.runState).toBe("paused");
    expect(result.pausedBlocker).toMatchObject({ kind: "budget_cap" });
    expect(result.unitsRun).toBe(0);
    expect(meter.maxInFlight).toBe(1);
    expect(meter.totalCalls).toBe(1);
    expect(admittedAttempts).toHaveLength(2);
    expect(admittedAttempts[0]).toMatch(/:\d/);
  });
});

// ---------------------------------------------------------------------------
// LIVE bounded-slice pilot — real ZDR OpenRouter DEV_PAIR, budget-capped, and
// PERSISTED TO REAL STORAGE (Postgres attempt/outcome journal + on-disk patch
// export).
//
// Drives a BOUNDED set of REAL Sweetie Rin-route units (built from the decoded
// narrative structure's real per-scene message stream, held out-of-repo)
// through the executor with the REAL OpenRouter provider + the CONCRETE DB/fs
// sinks. Post-run it QUERIES Postgres to prove N outcome rows + every physical
// attempt landed, ≥1 patch export written, real usage.cost in (0, $3],
// zdr:true on every call. Env-gated so CI never charges/needs a DB.
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
  await pool.query("delete from itotori_localization_journal_runs where project_id = $1", [
    LIVE_PROJECT_ID,
  ]);
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
  it("drives real Sweetie units, PERSISTING journal outcomes + physical attempts under ZDR", async () => {
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
        SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
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

      const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
      const journal = new DrivenJournalPersistenceAdapter(journalRepo, { actor: liveActor });
      const runDir = mkdtempSync(join(tmpdir(), "itotori-driven-live-patch-"));
      const patchSink = new FsDrivenPatchExportSink(runDir);
      const recorder = new LocalProviderRunArtifactRecorder(
        mkdtempSync(join(tmpdir(), "itotori-driven-live-runs-")),
      );
      const provider = new OpenRouterModelProvider({
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
        resolveUnitContext: () => ({ narrativeStructure: structure, sceneId }),
        translationScope: "dialogue-only",
        engineProfile: "reallive",
        sinks: { journal, patchExport: patchSink },
        maxUnits,
        budgetCapUsd: LIVE_BUDGET_CAP_USD,
      });

      // Real usage.cost > 0, ZDR confirmed on every call, within the budget cap.
      expect(result.unitsRun).toBeGreaterThan(0);
      expect(result.totalUsageCostUsd).toBeGreaterThan(0);
      expect(result.totalUsageCostUsd).toBeLessThanOrEqual(LIVE_BUDGET_CAP_USD);
      expect(result.zdrConfirmed).toBe(true);

      // PERSISTED TO REAL STORAGE — the journal repository reads the actual
      // normalized Postgres rows for this immutable run identity.
      const persistedRun = await journalRepo.loadRun(liveActor, result.journalRunId);
      const persistedOutcomes = await journalRepo.loadRunOutcomes(liveActor, result.journalRunId);
      const persistedAttempts = await journalRepo.loadAttemptsForRun(
        liveActor,
        result.journalRunId,
      );

      expect(persistedRun?.runId).toBe(result.journalRunId);
      expect(persistedOutcomes).toHaveLength(result.unitsRun);
      expect(persistedAttempts).toHaveLength(result.attemptsPersisted);
      expect(persistedAttempts.every((attempt) => attempt.zdr)).toBe(true);

      // A patch export exists only after complete configured-scope coverage.
      expect(patchSink.exportCount).toBe(result.patchReport.coverageComplete ? 1 : 0);
      expect(existsSync(join(runDir, "translated-bridge.json"))).toBe(
        result.patchReport.coverageComplete,
      );
      expect(existsSync(join(runDir, "patch-report.json"))).toBe(
        result.patchReport.coverageComplete,
      );

      // eslint-disable-next-line no-console
      console.warn(
        `[driven-live] scene=${sceneId} unitsRun=${result.unitsRun} written=${result.writtenOutcomeCount} ` +
          `failed=${result.failures.length} coverageComplete=${result.patchReport.coverageComplete} ` +
          `persisted{outcomes=${persistedOutcomes.length} attempts=${persistedAttempts.length}} ` +
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
