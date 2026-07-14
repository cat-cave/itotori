// A QA call whose structured content is persistently unsalvageable is a
// MECHANICAL failure, not an informational one. It must ride the supervisor's
// retry-to-valid + hard-ceiling exactly like a translation call and become a
// RESUMABLE operational pause — the unit does NOT advance with QA silently
// skipped, and nothing is exported. This is the same uniform invocation
// contract now shared by every phase (see the escape-hatch prune).

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
import {
  INVOCATION_HARD_RETRY_CEILING,
  type InvocationCostAdmission,
} from "../src/orchestrator/invocation-supervisor.js";
import type { OperationalBlocker } from "../src/orchestrator/invocation-supervisor.js";
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
          // Persistently blank QA content. `QaAgent` classifies this as an
          // empty/partial mechanical failure that the supervisor can never
          // salvage or retry to a valid finding set, so the QA stage rides to
          // the hard-ceiling operational pause.
          return "";
        }
        return "";
      },
    });
}

describe("runProjectDrivenExecutor (unsalvageable QA pauses resumably)", () => {
  it("rides QA to the hard-ceiling operational pause instead of advancing the unit", async () => {
    const journalUnits: DrivenUnitJournalRecord[] = [];
    const failedUnitAttempts: DrivenFailedUnitJournalRecord[] = [];
    const patchExports: DrivenPatchExportRecord[] = [];
    const pauses: Array<{ runId: string; blocker: OperationalBlocker }> = [];
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
          pauseRun: async (runId, blocker) => {
            pauses.push({ runId, blocker });
          },
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

    // The run is PAUSED, not advanced. Nothing was written or exported.
    expect(result.runState).toBe("paused");
    expect(result.pausedBlocker).not.toBeNull();
    expect(result.writtenOutcomesPersisted).toBe(0);
    expect(result.journalUnitsPersisted).toBe(0);
    expect(result.writtenOutcomeCount).toBe(0);
    expect(result.patchExportCount).toBe(0);
    expect(result.patchReport.coverageComplete).toBe(false);
    expect(journalUnits).toEqual([]);
    expect(patchExports).toEqual([]);

    // The pause is a RESUMABLE operational blocker (the hard-ceiling class,
    // same as translation) — the operator fixes the model/tool/schema and
    // resumes. It is NOT a silent drop.
    expect(pauses.length).toBeGreaterThan(0);
    expect(result.pausedBlocker).toMatchObject({
      kind: "itotori_bug",
      operatorAction: "fix the model/tool/schema configuration, then resume",
    });

    // The failing QA output rode the supervisor's retry to the hard ceiling
    // and every attempt was captured (never fabricated) before the pause.
    expect(failedUnitAttempts).toHaveLength(1);
    const qaAttempts = failedUnitAttempts[0]!.attempts.filter(
      (attempt) => attempt.stage === "qa_findings",
    );
    expect(qaAttempts).toHaveLength(INVOCATION_HARD_RETRY_CEILING);
    expect(qaAttempts.every((attempt) => attempt.failureClass === "empty")).toBe(true);
    expect(qaAttempts.every((attempt) => attempt.validationResult === "semantic_invalid")).toBe(
      true,
    );
  });
});
