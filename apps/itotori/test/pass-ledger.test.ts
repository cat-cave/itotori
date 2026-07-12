// itotori-pass-ledger — multi-pass localization ledger tests.
//
// Proves the crux acceptance: the driver records each localization pass in a
// pass ledger, and a pass N+1 run CONSUMES pass N's written state + flagged-
// unit feedback as drafting context — so iteration BUILDS ON the prior pass's
// flagged units instead of re-running from scratch. A blank re-run (no prior
// context) is the control: it does NOT thread prior feedback, so the flagged
// unit stays flagged exactly as in pass 1.
//
// Project-agnostic: the only project knowledge lives behind the same fake
// provider + bridge fixtures the driven-executor tests use. No game / engine /
// title code anywhere — the multi-pass loop is generic over any project whose
// units flow through the agentic loop.

import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import type { AuthorizationActor } from "@itotori/db";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  parseNarrativeStructure,
  type NarrativeStructure,
} from "../src/agents/structure-informed-context/index.js";
import type {
  DrivenWrittenOutcomeRecord,
  DrivenPatchExportRecord,
  DrivenProviderRunRecord,
  DrivenUnitContext,
} from "../src/orchestrator/project-driven-executor.js";
import {
  buildPriorPassContext,
  deriveWrittenDeltas,
  InMemoryPassLedger,
  runLocalizationPass,
  type LocalizationPassRecord,
} from "../src/orchestrator/pass-ledger.js";

const ACTOR: AuthorizationActor = { userId: "pass-ledger-test-actor" };
const PROJECT_ID = "019ed0cc-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed0cc-0000-7000-8000-000000000002";
const REVISION_ID = "019ed0cc-0000-7000-8000-000000000003";
const ASSET_ID = "019ed0cc-0000-7000-8000-000000000004";
const SPEAKER_ID = "019ed0cc-0000-7000-8000-000000000005";

// Bridge unit ids carry a distinct `019ed0aa` prefix so the fake provider can
// regex the CURRENT unit's bridge id out of any request blob.
const UNIT_A = "019ed0aa-0000-7000-8000-0000000000a1"; // always written
const UNIT_B = "019ed0aa-0000-7000-8000-0000000000b2"; // FLAGGED in pass 1, addressed in pass 2
const UNIT_C = "019ed0aa-0000-7000-8000-0000000000c3"; // always written

const SCENE_ID = 6010;
const SPEAKER_NAME = "和人";

// The generic vs corrected draft for UNIT_B. The generic draft is what a blank
// (no-prior-feedback) pass produces; the corrected draft is what the provider
// emits when it SEES the prior-pass feedback block, proving the feedback was
// consumed as drafting context. The corrected draft carries the distinctive
// "Yui" token so the QA fake can tell them apart.
const GENERIC_DRAFT = "Good morning.";
const CORRECTED_DRAFT = "Good morning, Yui.";
const PRIOR_FEEDBACK_PROMPT_MARKER = "Prior pass feedback";

// ---------------------------------------------------------------------------
// In-memory sinks (mirrors project-driven-executor.test.ts)
// ---------------------------------------------------------------------------

class InMemorySinks {
  readonly writtenOutcomes: DrivenWrittenOutcomeRecord[] = [];
  readonly providerRuns: DrivenProviderRunRecord[] = [];
  readonly patchExports: DrivenPatchExportRecord[] = [];
  readonly writtenOutcome = {
    persistWrittenOutcome: async (record: DrivenWrittenOutcomeRecord): Promise<void> => {
      this.writtenOutcomes.push(record);
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeUnit(bridgeUnitId: string, sourceText: string, lineNo: number): LocalizationUnitV02 {
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
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
    makeUnit(UNIT_A, "おはよう、和人。", 1),
    makeUnit(UNIT_B, "今日は和人に会った。", 2),
    makeUnit(UNIT_C, "いい天気だね。", 3),
  ];
  return {
    schemaVersion: "0.2.0",
    bridgeId: "pass-ledger-fixture",
    sourceLocale: "ja-JP",
    units,
  } as unknown as BridgeBundleV02;
}

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

function translationContent(bridgeUnitId: string, draftText: string): string {
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
  const finding: QaFinding = {
    findingId: `${bridgeUnitId}-critical-finding`,
    bridgeUnitId,
    severity: "critical",
    category: "mistranslation",
    evidenceRefs: [],
    recommendation: "fixture: the generic draft dropped the speaker name",
    agentRationale: "fake-critical-finding",
  };
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [finding],
  });
}

function cleanQaContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

/**
 * Fake provider factory that captures, per bridge unit, whether the
 * "Prior pass feedback" block was threaded into that unit's translation
 * prompt. UNIT_B is the FLAGGED unit:
 *   - translation: when prior-pass feedback is present in the prompt, emit the
 *     CORRECTED draft (the provider "addressed" the feedback); otherwise emit
 *     the GENERIC draft.
 *   - qa: for UNIT_B, emit a critical finding when the draft under review is
 *     the GENERIC one (the one that dropped the speaker name); emit clean when
 *     the draft is the CORRECTED one. Every other unit is always clean.
 *
 * This makes the loop's outcome for UNIT_B depend ENTIRELY on whether the
 * prior-pass feedback reached its translation prompt — which is exactly what
 * the pass ledger's consumption seam controls.
 */
function makeCaptureFactory(): {
  factory: AgenticLoopProviderFactory;
  /** Per bridge unit: did its translation prompt carry prior-pass feedback? */
  priorFeedbackSeen: Map<string, boolean>;
} {
  const priorFeedbackSeen = new Map<string, boolean>();
  const factory: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `pass-ledger-fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        const blob = JSON.stringify(request);
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "draft_translation") {
          const unitId = bridgeUnitIdOf(request);
          const sawPriorFeedback = blob.includes(PRIOR_FEEDBACK_PROMPT_MARKER);
          priorFeedbackSeen.set(unitId, sawPriorFeedback);
          // UNIT_B's draft is chosen by whether prior feedback was consumed.
          if (unitId === UNIT_B) {
            return translationContent(unitId, sawPriorFeedback ? CORRECTED_DRAFT : GENERIC_DRAFT);
          }
          return translationContent(unitId, GENERIC_DRAFT);
        }
        if (request.taskKind === "llm_qa") {
          // The QA request carries the draft under review. UNIT_B is flagged
          // (critical finding) ONLY when the draft is the generic one — i.e.
          // when the prior feedback was NOT consumed. The corrected draft
          // (feedback consumed) passes QA clean.
          if (blob.includes(UNIT_B) && blob.includes(GENERIC_DRAFT)) {
            return criticalQaContent(UNIT_B);
          }
          return cleanQaContent();
        }
        return "";
      },
    });
  return { factory, priorFeedbackSeen };
}

function baseExecutorInput(
  factory: AgenticLoopProviderFactory,
  sinks: InMemorySinks,
): Parameters<typeof runLocalizationPass>[0]["executorInput"] {
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
    providerFactory: factory,
    // maxRepairAttempts: 0 so a critical finding defers immediately (pass 1's
    // UNIT_B defers without burning repair budget). Pass 2's UNIT_B passes QA
    // clean so the cap never comes into play.
    maxRepairAttempts: 0,
    resolveUnitContext,
    translationScope: "dialogue-only",
    engineProfile: "reallive",
    sinks,
  };
}

/** Deterministic clock so recordedAt / passNumbers replay byte-equal. */
function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 6, 6, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemoryPassLedger + deriveWrittenDeltas (deterministic, pure)", () => {
  it("assigns sequential passNumbers per branch and chains priorPassNumber", async () => {
    const ledger = new InMemoryPassLedger();
    const clock = deterministicClock();
    const base = {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: REVISION_ID,
      recordedAt: clock(),
      inputs: {
        translationScope: "dialogue-only" as const,
        pair: { modelId: "m", providerId: "p" },
        targetLocale: "en-US",
        engineProfile: "reallive" as const,
        unitsEnumerated: 1,
        unitsInScope: 1,
        unitsRun: 1,
      },
      outputs: {
        writtenOutcomeCount: 1,
        failureCount: 0,
        totalUsageCostUsd: 0,
        zdrConfirmed: true,
        budgetStopped: false,
        unitOutcomes: [
          {
            bridgeUnitId: UNIT_A,
            sourceUnitKey: "k",
            targetLocale: "en-US",
            outcomeId: "outcome-a",
            selectedCandidateId: "candidate-a",
            selectedBody: "Hello.",
            qualityFlags: [],
            writtenAt: "2026-07-06T12:00:00.000Z",
          },
        ],
        unitFailures: [],
      },
      writtenDeltas: [],
      consumedFeedbackNotes: [],
    };
    const r1 = await ledger.recordPass(ACTOR, base);
    const r2 = await ledger.recordPass(ACTOR, { ...base, recordedAt: clock() });
    const r3 = await ledger.recordPass(ACTOR, { ...base, recordedAt: clock() });

    expect(r1.passNumber).toBe(1);
    expect(r1.priorPassNumber).toBeUndefined();
    expect(r2.passNumber).toBe(2);
    expect(r2.priorPassNumber).toBe(1);
    expect(r3.passNumber).toBe(3);
    expect(r3.priorPassNumber).toBe(2);

    const latest = await ledger.loadLatestPass(ACTOR, LOCALE_BRANCH_ID);
    expect(latest?.passNumber).toBe(3);
    const history = await ledger.loadPassesForBranch(ACTOR, LOCALE_BRANCH_ID);
    expect(history.map((h) => h.passNumber)).toEqual([1, 2, 3]);
    expect(await ledger.loadLatestPass(ACTOR, "other-branch")).toBeUndefined();
  });

  it("deriveWrittenDeltas flags newly written and changed bodies, skips byte-equal bodies", () => {
    const unit = (id: string, selectedBody: string) => ({
      bridgeUnitId: id,
      sourceUnitKey: `k-${id}`,
      targetLocale: "en-US",
      outcomeId: `outcome-${id}`,
      selectedCandidateId: `candidate-${id}`,
      selectedBody,
      qualityFlags: [],
      writtenAt: "2026-07-06T12:00:00.000Z",
    });
    const prior: LocalizationPassRecord = {
      passNumber: 1,
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: REVISION_ID,
      recordedAt: new Date(),
      inputs: {
        translationScope: "dialogue-only",
        pair: { modelId: "m", providerId: "p" },
        targetLocale: "en-US",
        engineProfile: "reallive",
        unitsEnumerated: 3,
        unitsInScope: 3,
        unitsRun: 2,
      },
      outputs: {
        writtenOutcomeCount: 2,
        failureCount: 0,
        totalUsageCostUsd: 0,
        zdrConfirmed: true,
        budgetStopped: false,
        unitOutcomes: [
          unit(UNIT_A, "kept"), // byte-equal -> not a delta
          unit(UNIT_C, "old"), // changes in the current pass
        ],
        unitFailures: [],
      },
      writtenDeltas: [],
      consumedFeedbackNotes: [],
    };
    const current: LocalizationPassRecord = {
      ...prior,
      passNumber: 2,
      priorPassNumber: 1,
      outputs: {
        ...prior.outputs,
        writtenOutcomeCount: 3,
        unitOutcomes: [
          unit(UNIT_A, "kept"), // byte-equal -> not a delta
          unit(UNIT_B, "fixed"), // newly written -> no prior selected body
          unit(UNIT_C, "new"), // changed from "old"
        ],
      },
    };
    const deltas = deriveWrittenDeltas({ prior, current });
    expect(deltas).toEqual([
      {
        bridgeUnitId: UNIT_B,
        sourceUnitKey: "k-019ed0aa-0000-7000-8000-0000000000b2",
        currentSelectedBody: "fixed",
      },
      {
        bridgeUnitId: UNIT_C,
        sourceUnitKey: "k-019ed0aa-0000-7000-8000-0000000000c3",
        priorSelectedBody: "old",
        currentSelectedBody: "new",
      },
    ]);
  });

  it("buildPriorPassContext returns undefined for a blank first pass and a feedback map otherwise", () => {
    expect(buildPriorPassContext({ latest: undefined })).toBeUndefined();
    const latest: LocalizationPassRecord = {
      passNumber: 1,
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: REVISION_ID,
      recordedAt: new Date(),
      inputs: {
        translationScope: "dialogue-only",
        pair: { modelId: "m", providerId: "p" },
        targetLocale: "en-US",
        engineProfile: "reallive",
        unitsEnumerated: 1,
        unitsInScope: 1,
        unitsRun: 1,
      },
      outputs: {
        writtenOutcomeCount: 1,
        failureCount: 0,
        totalUsageCostUsd: 0,
        zdrConfirmed: true,
        budgetStopped: false,
        unitOutcomes: [
          {
            bridgeUnitId: UNIT_B,
            sourceUnitKey: "k",
            targetLocale: "en-US",
            outcomeId: "outcome-b",
            selectedCandidateId: "candidate-b",
            selectedBody: "Good morning.",
            qualityFlags: ["qa_unresolved", "repair_budget_exhausted"],
            writtenAt: "2026-07-06T12:00:00.000Z",
          },
        ],
        unitFailures: [],
      },
      writtenDeltas: [],
      consumedFeedbackNotes: [],
    };
    const ctx = buildPriorPassContext({
      latest,
      feedbackNotesByUnit: new Map([[UNIT_B, "restore the speaker name"]]),
    })!;
    expect(ctx.passNumber).toBe(1);
    expect(ctx.feedbackByUnit.has(UNIT_B)).toBe(true);
    const fb = ctx.feedbackByUnit.get(UNIT_B)!;
    expect(fb.passNumber).toBe(1);
    expect(fb.feedbackNote).toBe("restore the speaker name");
    expect(fb.priorDraftText).toBe("Good morning.");
    expect(fb.qualityFlags).toEqual(["qa_unresolved", "repair_budget_exhausted"]);
  });
});

describe("runLocalizationPass (multi-pass iteration consumes prior feedback)", () => {
  //
  //                            ─── pass 1 ───
  //   UNIT_A  -> written (generic draft, clean QA)
  //   UNIT_B  -> written (generic draft, critical QA finding: "dropped the
  //                       speaker name"). This is the FLAGGED unit.
  //   UNIT_C  -> written (generic draft, clean QA)
  //   The ledger records UNIT_B's required body plus quality flags.
  //
  //                            ─── pass 2 ───
  //   runLocalizationPass LOADS pass 1 from the ledger and threads UNIT_B's
  //   prior-pass feedback into its translation prompt. The fake provider SEES
  //   the "Prior pass feedback" block and emits the CORRECTED draft; QA then
  //   passes clean -> UNIT_B selects the corrected body. UNIT_A / UNIT_C (no
  //   prior feedback needed) stay byte-equal.
  //
  //   CONTROL: a BLANK re-run (runProjectDrivenExecutor with no priorPass) does
  //   NOT thread prior feedback, so UNIT_B stays written with its generic body.
  //
  it("pass 1 retains a flagged body; pass 2 consumes its feedback and improves it; a blank re-run does not", async () => {
    const ledger = new InMemoryPassLedger();
    const clock = deterministicClock();

    // ---------------- pass 1 (blank first pass) ----------------
    const pass1Capture = makeCaptureFactory();
    const pass1Sinks = new InMemorySinks();
    const pass1 = await runLocalizationPass({
      ledger,
      actor: ACTOR,
      executorInput: {
        ...baseExecutorInput(pass1Capture.factory, pass1Sinks),
        now: clock,
      },
      now: clock,
    });

    // Pass 1: all three units are written; UNIT_B is flagged informationally.
    expect(pass1.record.passNumber).toBe(1);
    expect(pass1.prior).toBeUndefined();
    expect(pass1.result.writtenOutcomeCount).toBe(3);
    const pass1Flagged = pass1.record.outputs.unitOutcomes.find(
      (unit) => unit.bridgeUnitId === UNIT_B,
    )!;
    expect(pass1Flagged.selectedBody).toBe(GENERIC_DRAFT);
    expect(pass1Flagged.qualityFlags.length).toBeGreaterThan(0);

    // Pass 1 UNIT_B's translation prompt did NOT carry prior-pass feedback
    // (blank first pass — the capture proves the marker was absent).
    expect(pass1Capture.priorFeedbackSeen.get(UNIT_B)).toBe(false);

    // The ledger is the medium of iteration: pass 1 is now persisted.
    const latestAfterPass1 = await ledger.loadLatestPass(ACTOR, LOCALE_BRANCH_ID);
    expect(latestAfterPass1?.passNumber).toBe(1);

    // ---------------- pass 2 (consumes pass 1) ----------------
    const pass2Capture = makeCaptureFactory();
    const pass2Sinks = new InMemorySinks();
    const pass2 = await runLocalizationPass({
      ledger,
      actor: ACTOR,
      executorInput: {
        ...baseExecutorInput(pass2Capture.factory, pass2Sinks),
        now: clock,
      },
      now: clock,
    });

    // Pass 2 built on pass 1: priorPassNumber chains the iteration lineage.
    expect(pass2.record.passNumber).toBe(2);
    expect(pass2.record.priorPassNumber).toBe(1);
    expect(pass2.prior?.passNumber).toBe(1);

    // CRUX: pass 2's UNIT_B translation prompt CARRIED the prior-pass feedback
    // (consumed from the ledger), so the provider emitted the corrected draft
    // and QA selected it while retaining the first pass as the baseline.
    expect(pass2Capture.priorFeedbackSeen.get(UNIT_B)).toBe(true);
    expect(pass2.result.writtenOutcomeCount).toBe(3);
    const pass2UnitB = pass2.record.outputs.unitOutcomes.find((u) => u.bridgeUnitId === UNIT_B)!;
    expect(pass2UnitB.selectedBody).toBe(CORRECTED_DRAFT);

    // Pass 2 UNIT_A / UNIT_C stayed byte-equal, so only UNIT_B is a written
    // delta. Its prior selected body remains inspectable.
    const deltaIds = pass2.record.writtenDeltas.map((d) => d.bridgeUnitId);
    expect(deltaIds).toEqual([UNIT_B]);
    const unitBDelta = pass2.record.writtenDeltas.find((d) => d.bridgeUnitId === UNIT_B)!;
    expect(unitBDelta.currentSelectedBody).toBe(CORRECTED_DRAFT);
    expect(unitBDelta.priorSelectedBody).toBe(GENERIC_DRAFT);

    // ---------------- CONTROL: blank re-run (no prior context) ----------------
    // Running the executor DIRECTLY (no priorPass) reproduces pass 1's outcome
    // for UNIT_B exactly — the generic selected body and critical annotation.
    // This proves pass 2's improvement came FROM consuming the prior feedback,
    // not from any non-determinism in the fake provider.
    const blankCapture = makeCaptureFactory();
    const blankSinks = new InMemorySinks();
    const { runProjectDrivenExecutor } =
      await import("../src/orchestrator/project-driven-executor.js");
    const blankResult = await runProjectDrivenExecutor({
      ...baseExecutorInput(blankCapture.factory, blankSinks),
      now: clock,
    });
    expect(blankCapture.priorFeedbackSeen.get(UNIT_B)).toBe(false);
    expect(blankResult.writtenOutcomeCount).toBe(3);
    const blankUnitB = blankResult.unitOutcomes.find((u) => u.bridgeUnitId === UNIT_B)!;
    expect(blankUnitB.selectedBody).toBe(GENERIC_DRAFT);
    expect(blankUnitB.outcome.qualityFlags.length).toBeGreaterThan(0);
  });

  it("a reviewer feedback note layered between passes reaches the pass N+1 prompt", async () => {
    // A play-test correction added AFTER pass 1 (UNIT_A was written but the
    // play tester wants it changed) reaches pass 2's translation prompt via
    // the ledger's feedbackNotesByUnit seam.
    const ledger = new InMemoryPassLedger();
    const clock = deterministicClock();
    const reviewerNote = "restore the character's full name";

    const pass1Capture = makeCaptureFactory();
    const pass1 = await runLocalizationPass({
      ledger,
      actor: ACTOR,
      executorInput: {
        ...baseExecutorInput(pass1Capture.factory, new InMemorySinks()),
        now: clock,
      },
      now: clock,
    });
    expect(pass1.record.passNumber).toBe(1);
    // UNIT_A was written in pass 1 with no prior feedback.
    expect(pass1Capture.priorFeedbackSeen.get(UNIT_A)).toBe(false);

    const pass2Capture = makeCaptureFactory();
    const pass2 = await runLocalizationPass({
      ledger,
      actor: ACTOR,
      executorInput: {
        ...baseExecutorInput(pass2Capture.factory, new InMemorySinks()),
        now: clock,
      },
      feedbackNotesByUnit: new Map([[UNIT_A, reviewerNote]]),
      now: clock,
    });
    // The reviewer note reached UNIT_A's prior-pass feedback block (pass 2
    // consumed it) and is recorded on the pass-2 trail.
    expect(pass2.record.consumedFeedbackNotes).toEqual([
      { bridgeUnitId: UNIT_A, note: reviewerNote },
    ]);
    expect(pass2Capture.priorFeedbackSeen.get(UNIT_A)).toBe(true);
  });

  it("buildLocalizationPassRecord records real usage.cost verbatim and is deterministic", async () => {
    // Two replays of the same pass produce byte-equal records (passNumber
    // aside, which the ledger assigns): deterministic recordedAt (via the
    // injected clock), deterministic writtenDeltas, real cost from the
    // executor's totalUsageCostUsd (zero for the fake provider — never
    // fabricated).
    const clock1 = deterministicClock();
    const clock2 = deterministicClock();
    const ledgerA = new InMemoryPassLedger();
    const ledgerB = new InMemoryPassLedger();

    const runOnce = async (clock: () => Date, ledger: InMemoryPassLedger) => {
      const capture = makeCaptureFactory();
      return runLocalizationPass({
        ledger,
        actor: ACTOR,
        executorInput: {
          ...baseExecutorInput(capture.factory, new InMemorySinks()),
          now: clock,
        },
        now: clock,
      });
    };
    const a = await runOnce(clock1, ledgerA);
    const b = await runOnce(clock2, ledgerB);
    // Candidate IDs are physical provider-attempt identifiers, so normalize
    // only that intentionally fresh provenance before comparing the replayable
    // ledger projection. Selected bodies, flags, deltas, clocks, and cost must
    // remain byte-equal.
    const normalizeCandidateIds = (record: LocalizationPassRecord) => ({
      ...record,
      outputs: {
        ...record.outputs,
        unitOutcomes: record.outputs.unitOutcomes.map((unit) => ({
          ...unit,
          selectedCandidateId: "<physical-attempt-id>",
        })),
      },
    });
    expect(normalizeCandidateIds(a.record)).toEqual(normalizeCandidateIds(b.record));
    // Cost is the real zero the fake provider produced (PROJECT LAW).
    expect(a.record.outputs.totalUsageCostUsd).toBe(0);
    expect(a.record.outputs.zdrConfirmed).toBe(true);
  });
});
