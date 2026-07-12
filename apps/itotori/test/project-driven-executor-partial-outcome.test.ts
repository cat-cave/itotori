// F1 — a typed partial QA response after primary translation is informational:
// the driven executor must persist and export the canonical written outcome,
// rather than classify the unit as an operational failure and omit it.

import { describe, expect, it } from "vitest";
import type { AuthorizationActor } from "@itotori/db";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import {
  runProjectDrivenExecutor,
  type DrivenFailedUnitJournalRecord,
  type DrivenPatchExportRecord,
  type DrivenUnitJournalRecord,
} from "../src/orchestrator/project-driven-executor.js";
import type { InvocationCostAdmission } from "../src/orchestrator/invocation-supervisor.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";

const ACTOR: AuthorizationActor = { userId: "partial-outcome-executor-test" };
const PROJECT_ID = "019ed0f1-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed0f1-0000-7000-8000-000000000002";
const REVISION_ID = "019ed0f1-0000-7000-8000-000000000003";
const ASSET_ID = "019ed0f1-0000-7000-8000-000000000004";
const BRIDGE_UNIT_ID = "019ed0f1-0000-7000-8000-0000000000a1";
const SOURCE_TEXT = "おはよう。";
const SELECTED_TARGET = "Good morning.";
const TEST_COST_ADMISSION: InvocationCostAdmission = {
  admit: async () => ({ admitted: true }),
};

function makeBridge(): BridgeBundleV02 {
  const unit: LocalizationUnitV02 = {
    bridgeUnitId: BRIDGE_UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: "scene-001/line-001",
    occurrenceId: "partial-outcome-occurrence",
    sourceLocale: "ja-JP",
    sourceText: SOURCE_TEXT,
    sourceHash: "partial-outcome-source-hash",
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "partial-outcome-asset" },
    sourceLocation: { containerKey: "partial-outcome-asset" },
    speaker: { knowledgeState: "unknown" },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: "scene-001/line-001",
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
  return {
    schemaVersion: "0.2.0",
    bridgeId: "partial-outcome-executor-bridge",
    sourceLocale: "ja-JP",
    units: [unit],
  } as unknown as BridgeBundleV02;
}

function speakerLabelContent(): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId: BRIDGE_UNIT_ID,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "partial-outcome fixture",
      },
    ],
  });
}

function primaryTranslationContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId: BRIDGE_UNIT_ID,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText: SELECTED_TARGET,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "partial-outcome fixture",
        confidenceFloor: "medium",
      },
    ],
  });
}

function partialQaProviderFactory(): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `partial-outcome-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent();
        }
        if (request.taskKind === "experiment") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "draft_translation") {
          return primaryTranslationContent();
        }
        if (request.taskKind === "llm_qa") {
          // `QaAgent` turns this into QaPartialResultError. The loop must
          // retain the primary candidate because it already exists.
          return "";
        }
        return "";
      },
    });
}

describe("runProjectDrivenExecutor (partial QA outcome retention)", () => {
  it("persists and exports a primary candidate when QA coverage is incomplete", async () => {
    const journalUnits: DrivenUnitJournalRecord[] = [];
    const failedUnitAttempts: DrivenFailedUnitJournalRecord[] = [];
    const patchExports: DrivenPatchExportRecord[] = [];
    const bridge = makeBridge();

    const result = await runProjectDrivenExecutor({
      bridge,
      rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
      pairPolicy: DEV_POLICY,
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: REVISION_ID,
      actor: ACTOR,
      providerFactory: partialQaProviderFactory(),
      costAdmission: TEST_COST_ADMISSION,
      translationScope: "dialogue-only",
      engineProfile: "rpg-maker-mv-mz",
      sinks: {
        journal: {
          persistUnitJournal: async (record) => {
            journalUnits.push(record);
          },
          persistFailedUnitAttempts: async (record) => {
            failedUnitAttempts.push(record);
          },
        },
        patchExport: {
          exportPatch: async (record) => {
            patchExports.push(record);
          },
        },
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.writtenOutcomesPersisted).toBe(1);
    expect(result.journalUnitsPersisted).toBe(1);
    expect(result.patchExportCount).toBe(1);
    expect(result.patchReport.coverageComplete).toBe(true);
    expect(journalUnits).toHaveLength(1);
    expect(journalUnits[0]!.writtenOutcome).toMatchObject({
      bridgeUnitId: BRIDGE_UNIT_ID,
      selectedBody: SELECTED_TARGET,
      outcome: { status: "written", qualityFlags: expect.arrayContaining(["qa_incomplete"]) },
    });
    expect(failedUnitAttempts).toEqual([]);
    expect(result.attemptsPersisted).toBe(journalUnits[0]!.attempts.length);
    expect(journalUnits[0]!.attempts.length).toBeGreaterThan(0);
    const incompleteQaAttempts = journalUnits[0]!.attempts.filter(
      (attempt) => attempt.stage === "qa_findings",
    );
    expect(incompleteQaAttempts).toHaveLength(8);
    expect(incompleteQaAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          validationResult: "semantic_invalid",
          retryDecision: "retry",
          failureClass: "empty",
        }),
        expect.objectContaining({
          validationResult: "semantic_invalid",
          retryDecision: "advance",
          failureClass: "InvocationContentExhaustedError",
        }),
      ]),
    );
    expect(
      incompleteQaAttempts.every((attempt) => attempt.validationResult === "semantic_invalid"),
    ).toBe(true);
    expect(
      incompleteQaAttempts.filter((attempt) => attempt.retryDecision === "retry"),
    ).toHaveLength(4);
    expect(
      incompleteQaAttempts.filter((attempt) => attempt.retryDecision === "advance"),
    ).toHaveLength(4);
    expect(patchExports).toHaveLength(1);
    const exported = patchExports[0]!.translatedBridge as {
      units: Array<{ bridgeUnitId: string; target: { text: string } }>;
    };
    expect(exported.units).toEqual([
      expect.objectContaining({
        bridgeUnitId: BRIDGE_UNIT_ID,
        target: expect.objectContaining({ text: SELECTED_TARGET }),
      }),
    ]);
  });
});
