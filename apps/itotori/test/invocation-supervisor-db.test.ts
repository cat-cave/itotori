import { describe, expect, it } from "vitest";
import {
  ItotoriLocalizationJournalRepository,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import {
  runProjectDrivenExecutor,
  type DrivenPatchExportRecord,
} from "../src/orchestrator/project-driven-executor.js";
import { DrivenJournalPersistenceAdapter } from "../src/orchestrator/project-driven-executor-sinks.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";

const ACTOR: AuthorizationActor = { userId: localUserId };
const PROJECT_ID = "project-invocation-supervisor-resume";
const BRANCH_ID = "branch-invocation-supervisor-resume";
const REVISION_ID = "revision-invocation-supervisor-resume";
const BUNDLE_ID = "bundle-invocation-supervisor-resume";
const UNIT_ONE = "019ed200-0000-7000-8000-000000000001";
const UNIT_TWO = "019ed200-0000-7000-8000-000000000002";

describe("InvocationSupervisor durable pause/resume", () => {
  it("seeds every unit before dispatch, pauses without a patch, and resumes only pending work", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const firstCalls = new Map<string, number>();
      const firstPatches: DrivenPatchExportRecord[] = [];
      const first = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(firstCalls)),
        costAdmission: {
          admit: async ({ bridgeUnitId }) =>
            bridgeUnitId === UNIT_TWO
              ? {
                  admitted: false,
                  detail: "injected cost denial for second unit",
                  evidence: "failure-injection:cost-denied",
                }
              : { admitted: true },
        },
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async (record) => void firstPatches.push(record) },
        },
      });

      expect(first.runState).toBe("paused");
      expect(first.pausedBlocker).toMatchObject({
        kind: "budget_cap",
        detail: "injected cost denial for second unit",
      });
      expect(first.patchExportCount).toBe(0);
      expect(firstPatches).toEqual([]);
      expect(firstCalls.get(UNIT_ONE)).toBeGreaterThan(0);
      expect(firstCalls.get(UNIT_TWO) ?? 0).toBe(0);

      const pausedRun = await repository.loadRun(ACTOR, first.journalRunId);
      const pausedUnits = await repository.loadRunUnits(ACTOR, first.journalRunId);
      expect(pausedRun).toMatchObject({
        status: "paused",
        pausedBlocker: { kind: "budget_cap" },
        frozenScope: { bridgeUnitIds: [UNIT_ONE, UNIT_TWO] },
      });
      expect(pausedUnits.map((unit) => [unit.bridgeUnitId, unit.state])).toEqual([
        [UNIT_ONE, "written"],
        [UNIT_TWO, "pending"],
      ]);
      expect(pausedUnits.every((unit) => !("sourceText" in (unit.nextAction ?? {})))).toBe(true);

      const resumedCalls = new Map<string, number>();
      const resumedPatches: DrivenPatchExportRecord[] = [];
      const resumed = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(resumedCalls)),
        resumeRunId: first.journalRunId,
        costAdmission: { admit: async () => ({ admitted: true }) },
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async (record) => void resumedPatches.push(record) },
        },
      });

      expect(resumed.journalRunId).toBe(first.journalRunId);
      expect(resumed.runState).toBe("running");
      expect(resumed.pausedBlocker).toBeNull();
      expect(resumedCalls.get(UNIT_ONE) ?? 0).toBe(0);
      expect(resumedCalls.get(UNIT_TWO)).toBeGreaterThan(0);
      expect(resumed.patchExportCount).toBe(1);
      expect(resumedPatches).toHaveLength(1);
      expect(resumed.patchReport.writtenUnits.map((unit) => unit.bridgeUnitId)).toEqual([
        UNIT_ONE,
        UNIT_TWO,
      ]);

      const completedUnits = await repository.loadRunUnits(ACTOR, first.journalRunId);
      const attempts = await repository.loadAttemptsForRun(ACTOR, first.journalRunId);
      expect(completedUnits.every((unit) => unit.state === "written")).toBe(true);
      expect(attempts.length).toBe(
        (firstCalls.get("__all__") ?? 0) + (resumedCalls.get("__all__") ?? 0),
      );
      expect(attempts.every((attempt) => attempt.lifecycleState === "completed")).toBe(true);
      expect(attempts.every((attempt) => attempt.costUsd === "0")).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("persists providerless outage attempts and resumes after all routes recover", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context.pool);
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const outageFactory: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
        new FakeModelProvider({
          providerName: `outage-${stage}-${agentLabel}`,
          generate: () => {
            throw Object.assign(new Error("injected HTTP 503 outage"), { status: 503 });
          },
        });
      const paused = await runProjectDrivenExecutor({
        ...executorInput(outageFactory),
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async () => undefined },
        },
      });

      expect(paused.runState).toBe("paused");
      expect(paused.pausedBlocker).toMatchObject({
        kind: "provider_outage",
        operatorAction: expect.stringContaining("resume"),
      });
      expect(paused.patchExportCount).toBe(0);
      const outageAttempts = await repository.loadAttemptsForRun(ACTOR, paused.journalRunId);
      expect(outageAttempts).toHaveLength(2);
      expect(outageAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lifecycleState: "completed",
            modelId: null,
            providerId: null,
            costUsd: null,
            failureClass: "provider_unavailable",
          }),
        ]),
      );

      const resumedCalls = new Map<string, number>();
      const patches: DrivenPatchExportRecord[] = [];
      const resumed = await runProjectDrivenExecutor({
        ...executorInput(providerFactory(resumedCalls)),
        resumeRunId: paused.journalRunId,
        sinks: {
          journal: new DrivenJournalPersistenceAdapter(repository, { actor: ACTOR }),
          patchExport: { exportPatch: async (record) => void patches.push(record) },
        },
      });

      expect(resumed.runState).toBe("running");
      expect(resumed.patchExportCount).toBe(1);
      expect(patches).toHaveLength(1);
      expect(
        (await repository.loadRunUnits(ACTOR, paused.journalRunId)).every(
          (unit) => unit.state === "written",
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});

function executorInput(providerFactoryValue: AgenticLoopProviderFactory) {
  const bridge = bridgeFixture();
  return {
    bridge,
    rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
    pairPolicy: DEV_POLICY,
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    projectId: PROJECT_ID,
    localeBranchId: BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    actor: ACTOR,
    providerFactory: providerFactoryValue,
    translationScope: "dialogue-only" as const,
    engineProfile: "rpg-maker-mv-mz" as const,
    concurrency: 1,
    maxRepairAttempts: 0,
  };
}

function providerFactory(calls: Map<string, number>): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `supervisor-db-${stage}-${agentLabel}`,
      generate: (request) => {
        calls.set("__all__", (calls.get("__all__") ?? 0) + 1);
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        const unitId = bridgeUnitIdOf(request);
        calls.set(unitId, (calls.get(unitId) ?? 0) + 1);
        if (request.taskKind === "experiment") return speakerContent(unitId);
        if (request.taskKind === "draft_translation") {
          return translationContent(
            unitId,
            unitId === UNIT_ONE ? "First target." : "Second target.",
          );
        }
        if (request.taskKind === "llm_qa") return cleanQaContent();
        throw new Error(`unexpected task ${request.taskKind}`);
      },
    });
}

function bridgeUnitIdOf(request: ModelInvocationRequest): string {
  const match = JSON.stringify(request).match(/019ed200-[0-9a-f]{4}-7000-8000-[0-9a-f]{12}/u);
  if (match === null) throw new Error("fixture provider could not find bridge unit id");
  return match[0];
}

function speakerContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "durable resume fixture",
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
        agentRationale: "durable resume fixture",
        confidenceFloor: "medium",
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

function bridgeFixture(): BridgeBundleV02 {
  return {
    schemaVersion: "0.2.0",
    bridgeId: "invocation-supervisor-resume-bridge",
    sourceLocale: "ja-JP",
    units: [unitFixture(UNIT_ONE, "一番目", 1), unitFixture(UNIT_TWO, "二番目", 2)],
  } as unknown as BridgeBundleV02;
}

function unitFixture(
  bridgeUnitId: string,
  sourceText: string,
  ordinal: number,
): LocalizationUnitV02 {
  const assetId = `019ed200-0000-7000-9000-${String(ordinal).padStart(12, "0")}`;
  return {
    bridgeUnitId,
    surfaceId: assetId,
    surfaceKind: "dialogue",
    sourceUnitKey: `scene/line-${ordinal}`,
    occurrenceId: `resume-occurrence-${ordinal}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `resume-source-hash-${ordinal}`,
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "v1" },
    sourceAssetRef: { assetId, assetKey: `resume-asset-${ordinal}` },
    sourceLocation: { containerKey: `resume-asset-${ordinal}` },
    speaker: { knowledgeState: "unknown" },
    context: {},
    spans: [],
    patchRef: {
      assetId,
      writeMode: "replace",
      sourceUnitKey: `scene/line-${ordinal}`,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "v1" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

async function seedScope(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
): Promise<void> {
  await pool.query(`insert into itotori_workspaces (workspace_id, name) values ($1, $2)`, [
    "workspace-invocation-supervisor-resume",
    "Invocation Supervisor Resume",
  ]);
  await pool.query(
    `insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
     values ($1, $2, $3, $4, 'ja-JP', 'imported')`,
    [
      PROJECT_ID,
      "workspace-invocation-supervisor-resume",
      "supervisor-resume",
      "Supervisor Resume",
    ],
  );
  await pool.query(
    `insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
     values ($1, $2, 'bridge_revision', 'v1')`,
    [REVISION_ID, PROJECT_ID],
  );
  await pool.query(
    `insert into itotori_source_bundles (
       source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
       schema_version, source_bundle_hash, source_locale, extractor_name,
       extractor_version, unit_count, asset_count
     ) values ($1, $2, $3, 'resume-bridge', '0.2.0', 'hash:resume', 'ja-JP', 'fixture', '1', 2, 2)`,
    [BUNDLE_ID, PROJECT_ID, REVISION_ID],
  );
  await pool.query(
    `insert into itotori_locale_branches (
       locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
     ) values ($1, $2, $3, 'en-US', 'Resume branch', 'active')`,
    [BRANCH_ID, PROJECT_ID, BUNDLE_ID],
  );
}
