import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashLocalizationArtifact,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import { DbTerminalRunFinalizerAdapter } from "../src/orchestrator/terminal-run-finalizer-db-adapter.js";
import {
  finalizeTerminalRun,
  type TerminalFinalizerWorkerPorts,
  type TerminalRunFinalizerPersistencePort,
} from "../src/orchestrator/terminal-run-finalizer.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "terminal-finalizer-live-resume-driver",
  fenceToken: 1,
};
const scope = {
  projectId: "project-terminal-finalizer-live-resume",
  localeBranchId: "branch-terminal-finalizer-live-resume",
  sourceRevisionId: "revision-terminal-finalizer-live-resume",
  targetLocale: "en-US",
} as const;

describe.skipIf(!process.env.DATABASE_URL)("shipped terminal finalizer resume", () => {
  it("finishes an unconfirmed finalizing commit without config, provider, or executor work", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact();
    const runDir = mkdtempSync(join(tmpdir(), "itotori-finalizer-live-resume-"));
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "terminal-finalizer-live-resume-unconfirmed-commit";
      const unitId = `${runId}-unit`;
      await journal.seedRun(actor, {
        runId,
        ...scope,
        frozenScope: { kind: "explicit_units", unitIds: [unitId] },
        routingPolicy: { routes: ["model-finalizer-live/provider-finalizer-live"] },
        // itotori-225-audit-allow: deterministic synthetic ceiling; the fixture attempt bills exact zero.
        costPolicy: { kind: "terminal-finalizer-live-resume-test", capUsd: "1.00" },
        units: [
          {
            bridgeUnitId: unitId,
            sourceUnitKey: `scene.${unitId}`,
            nextAction: { kind: "drive_unit", stage: "translation" },
          },
        ],
        lease: { ownerId: driverLease.ownerId },
        createdAt: "2026-07-12T16:10:00.000Z",
      });
      await writeUnit(journal, runId, unitId);

      const productionAdapter = new DbTerminalRunFinalizerAdapter(
        repository,
        actor,
        () => driverLease,
        {},
        { runLockPool: context.pool },
      );
      const commitUnavailable: TerminalRunFinalizerPersistencePort = {
        acquireRunLock: (id) => productionAdapter.acquireRunLock(id),
        loadSnapshot: (id) => productionAdapter.loadSnapshot(id),
        loadTerminalSummary: (id) => productionAdapter.loadTerminalSummary(id),
        enterFinalizing: (id) => productionAdapter.enterFinalizing(id),
        ensurePatchVersion: (input) => productionAdapter.ensurePatchVersion(input),
        recordStage: (input) => productionAdapter.recordStage(input),
        commitTerminal: async () => {
          throw new Error("injected terminal commit transport outage");
        },
      };

      await expect(
        finalizeTerminalRun({
          runId,
          persistence: commitUnavailable,
          workers: successfulWorkers(artifact),
          now: () => new Date("2026-07-12T16:10:10.000Z"),
        }),
      ).rejects.toMatchObject({
        name: "TerminalRunCommitResumableError",
        runId,
        durableRunStatus: "finalizing",
      });
      expect(await repository.loadSnapshot(actor, runId)).toMatchObject({
        run: { status: "finalizing" },
        patch: { status: "building" },
      });
      expect(await repository.loadTerminalSummary(actor, runId)).toBeNull();

      const readJson = vi.fn(() => {
        throw new Error("finalizing resume must not read config or bridge input");
      });
      process.env.DATABASE_URL = context.databaseUrl;
      await runItotoriCliCommand(
        [
          "localize",
          "--config",
          "/must-not-be-read/localize.config.json",
          "--resume-run-id",
          runId,
          "--run-dir",
          runDir,
        ],
        cliDependencies(readJson),
      );

      const canonical = await repository.loadTerminalSummary(actor, runId);
      const resumedSnapshot = await repository.loadSnapshot(actor, runId);
      expect(canonical).toMatchObject({
        terminalStatus: "succeeded",
        summaryEpoch: 1,
        summary: {
          terminalStatus: "succeeded",
          rootCause: { kind: "completed", code: "coverage_complete" },
          patch: { playable: true },
        },
      });
      expect(resumedSnapshot?.run.status).toBe("succeeded");
      expect(readJson).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(runDir, "run-summary.json"), "utf8")) as unknown).toEqual(
        canonical?.summary,
      );
      expect(stdout.join("")).toContain('"resumedFinalization": true');

      writeFileSync(join(runDir, "run-summary.json"), '{"stale":true}\n');
      await runItotoriCliCommand(
        [
          "localize",
          "--config",
          "/still-must-not-be-read/localize.config.json",
          "--resume-run-id",
          runId,
          "--run-dir",
          runDir,
        ],
        cliDependencies(readJson),
      );
      expect(JSON.parse(readFileSync(join(runDir, "run-summary.json"), "utf8")) as unknown).toEqual(
        canonical?.summary,
      );
      expect(readJson).not.toHaveBeenCalled();
      const summaryRows = await context.pool.query<{ count: number }>(
        `select count(*)::int as count
         from itotori_localization_run_terminal_summaries
         where run_id = $1`,
        [runId],
      );
      expect(summaryRows.rows[0]?.count).toBe(1);
    } finally {
      stdoutSpy.mockRestore();
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
      rmSync(runDir, { recursive: true, force: true });
      artifact.cleanup();
      await context.close();
    }
  });
});

function cliDependencies(readJson: () => unknown): ItotoriCliDependencies {
  return {
    io: {
      readJson,
      writeJson: (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
    },
    migrateDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async () => {
      throw new Error("finalizing resume must not open project workflow services");
    }),
  };
}

function successfulWorkers(
  artifact: ReturnType<typeof createRealArtifact>,
): TerminalFinalizerWorkerPorts {
  return {
    patch_build: () => ({
      artifactRefs: { patch: artifact.path },
      artifactHashes: { patch: artifact.hash },
      evidence: { fixture: "live-resume", stage: "patch_build" },
    }),
    patch_apply: () => ({ evidence: { fixture: "live-resume", stage: "patch_apply" } }),
    validation: () => ({ evidence: { fixture: "live-resume", stage: "validation" } }),
    cleanup: () => ({ evidence: { fixture: "live-resume", stage: "cleanup" } }),
  };
}

function createRealArtifact(): { path: string; hash: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "itotori-finalizer-live-resume-artifact-"));
  const path = join(root, "patch-artifact.bin");
  writeFileSync(path, "live DB terminal finalizer resume artifact\n", "utf8");
  return {
    path,
    hash: hashLocalizationArtifact(path),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
): Promise<void> {
  const attemptId = `terminal-finalizer-live-resume-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "terminal-finalizer-live-resume-fixture",
    logicalCallId: `terminal-finalizer-live-resume-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-finalizer-live",
    requestedProviderId: "provider-finalizer-live",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T16:10:01.000Z",
    lease: driverLease,
  });
  await journal.completeAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-finalizer-live",
    providerId: "provider-finalizer-live",
    costUsd: "0",
    costKind: "zero",
    tokensIn: 1,
    tokensOut: 1,
    tokenCountSource: "fixture",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: false,
    fallbackPlan: [],
    zdr: true,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `provider-run:${attemptId}`,
    errorClasses: [],
    completedAt: "2026-07-12T16:10:02.000Z",
    lease: driverLease,
  });

  const outcomeId = `terminal-finalizer-live-resume-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `terminal-finalizer-live-resume-candidate:${runId}:${bridgeUnitId}`;
  const outcome: WrittenUnitOutcome = {
    id: outcomeId,
    status: "written",
    unitId: bridgeUnitId,
    targetLocale: scope.targetLocale,
    selectedCandidateId: candidateId,
    candidates: [
      {
        id: candidateId,
        outcomeId,
        body: asNonBlankTargetText(`Translated ${bridgeUnitId}.`),
        producedBy: {
          modelId: "model-finalizer-live",
          providerId: "provider-finalizer-live",
        },
        attemptId,
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { origin: "terminal-finalizer-live-resume-fixture" },
    writtenAt: "2026-07-12T16:10:03.000Z",
  };
  await journal.persistUnit(actor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "terminal-finalizer-live-resume" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {},
    lease: driverLease,
  });
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-terminal-finalizer-live-resume', 'Terminal Finalizer Live Resume Workspace')
  `);
  await context.pool.query(
    `
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      $1, 'workspace-terminal-finalizer-live-resume', 'terminal-finalizer-live-resume',
      'Terminal Finalizer Live Resume Project', 'ja-JP', 'imported'
    )
  `,
    [scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values ($1, $2, 'bridge_revision', 'terminal-finalizer-live-resume-v1')
  `,
    [scope.sourceRevisionId, scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'bundle-terminal-finalizer-live-resume', $1, $2,
      'bridge-terminal-finalizer-live-resume', '0.2.0',
      'hash:terminal-finalizer-live-resume', 'ja-JP',
      'fixture-extractor', '1.0.0', 1, 0
    )
  `,
    [scope.projectId, scope.sourceRevisionId],
  );
  await context.pool.query(
    `
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      $1, $2, 'bundle-terminal-finalizer-live-resume',
      $3, 'Terminal finalizer live resume branch', 'active'
    )
  `,
    [scope.localeBranchId, scope.projectId, scope.targetLocale],
  );
}
