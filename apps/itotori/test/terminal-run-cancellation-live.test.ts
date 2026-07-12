import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import { cancelTerminalRunLive } from "../src/orchestrator/terminal-run-cancellation-live.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const scope = {
  projectId: "project-terminal-cancellation-live",
  localeBranchId: "branch-terminal-cancellation-live",
  sourceRevisionId: "revision-terminal-cancellation-live",
  targetLocale: "en-US",
} as const;

describe("operator terminal-run cancellation CLI", () => {
  it("requires the existing run id without requiring --config", async () => {
    await expect(
      runItotoriCliCommand(
        ["localize", "--cancel", "--run-dir", "/tmp/cancel-run"],
        cliDependencies(),
      ),
    ).rejects.toThrow("missing required flag --resume-run-id");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("live operator terminal-run cancellation", () => {
  it("CLI aborts live running and paused leases without config/provider work and writes only committed DB summaries", async () => {
    const context = await isolatedMigratedContext();
    const runDir = mkdtempSync(join(tmpdir(), "itotori-terminal-cancel-"));
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const runId = "terminal-cancellation-live-run";
      await seedCancellableRun(
        journal,
        runId,
        "terminal-cancellation-unit",
        "still-running-executor",
      );
      const before = await journal.loadRun(actor, runId);
      expect(before).toMatchObject({
        status: "running",
        leaseOwnerId: "still-running-executor",
        fenceToken: 1,
      });
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      await expect(
        repository.terminalize(actor, {
          runId,
          terminalStatus: "failed",
          operatorCancellation: true,
          rootCause: {
            kind: "cancelled",
            stage: null,
            code: "invalid-operator-override",
            message: "must not bypass a lease for a failed transition",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await journal.loadRun(actor, runId)).toMatchObject({ status: "running" });

      process.env.DATABASE_URL = context.databaseUrl;
      const crossScopeProjection = vi.fn();
      await expect(
        cancelTerminalRunLive({
          runId,
          runDir,
          io: { writeJson: crossScopeProjection },
          expectedScope: {
            projectId: scope.projectId,
            localeBranchId: "branch-owned-by-another-scope",
          },
        }),
      ).rejects.toThrow("run does not belong to the requested project and locale branch");
      expect(await journal.loadRun(actor, runId)).toMatchObject({
        status: "running",
        leaseOwnerId: "still-running-executor",
      });
      expect(crossScopeProjection).not.toHaveBeenCalled();

      await runItotoriCliCommand(
        ["localize", "--cancel", "--resume-run-id", runId, "--run-dir", runDir],
        cliDependencies(),
      );

      const snapshot = await repository.loadSnapshot(actor, runId);
      const canonical = await repository.loadTerminalSummary(actor, runId);
      expect(snapshot?.run).toMatchObject({
        status: "aborted",
        leaseOwnerId: null,
        leaseExpiresAt: null,
      });
      expect(canonical).toMatchObject({
        terminalStatus: "aborted",
        summaryEpoch: 1,
        summary: {
          terminalStatus: "aborted",
          rootCause: { kind: "cancelled", code: "explicit_cancellation" },
        },
      });

      const summaryRows = await context.pool.query<{ count: number }>(
        `select count(*)::int as count
         from itotori_localization_run_terminal_summaries
         where run_id = $1`,
        [runId],
      );
      expect(Number(summaryRows.rows[0]?.count)).toBe(1);
      expect(snapshot?.outbox.filter((entry) => entry.stage === "summary")).toHaveLength(1);
      expect(snapshot?.outbox.find((entry) => entry.stage === "summary")?.status).toBe("succeeded");

      const fileSummary = JSON.parse(
        readFileSync(join(runDir, "run-summary.json"), "utf8"),
      ) as unknown;
      expect(fileSummary).toEqual(canonical?.summary);
      expect(stdout.join("")).toContain('"runState": "aborted"');
      expect(stdout.join("")).toContain(runId);

      writeFileSync(join(runDir, "run-summary.json"), '{"stale":true}\n');
      await runItotoriCliCommand(
        ["localize", "--cancel", "--resume-run-id", runId, "--run-dir", runDir],
        cliDependencies(),
      );

      const replaySnapshot = await repository.loadSnapshot(actor, runId);
      const replayCanonical = await repository.loadTerminalSummary(actor, runId);
      expect(replayCanonical).toEqual(canonical);
      expect(replayCanonical?.summaryEpoch).toBe(1);
      expect(replaySnapshot?.outbox.filter((entry) => entry.stage === "summary")).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(runDir, "run-summary.json"), "utf8")) as unknown).toEqual(
        canonical?.summary,
      );
      const replaySummaryRows = await context.pool.query<{ count: number }>(
        `select count(*)::int as count
         from itotori_localization_run_terminal_summaries
         where run_id = $1`,
        [runId],
      );
      expect(Number(replaySummaryRows.rows[0]?.count)).toBe(1);

      const pausedRunId = "terminal-cancellation-live-paused-run";
      await seedCancellableRun(
        journal,
        pausedRunId,
        "terminal-cancellation-paused-unit",
        "still-paused-executor",
      );
      await journal.pauseRun(
        actor,
        pausedRunId,
        {
          kind: "provider_outage",
          detail: "provider is unavailable",
          evidence: "fixture:provider-outage",
          raisedAt: "2026-07-12T15:01:00.000Z",
          operatorAction: "cancel this run",
        },
        { ownerId: "still-paused-executor", fenceToken: 1 },
      );
      expect(await journal.loadRun(actor, pausedRunId)).toMatchObject({
        status: "paused",
        leaseOwnerId: "still-paused-executor",
      });

      await runItotoriCliCommand(
        ["localize", "--cancel", "--resume-run-id", pausedRunId, "--run-dir", runDir],
        cliDependencies(),
      );

      const pausedSnapshot = await repository.loadSnapshot(actor, pausedRunId);
      const pausedCanonical = await repository.loadTerminalSummary(actor, pausedRunId);
      expect(pausedSnapshot?.run).toMatchObject({
        status: "aborted",
        leaseOwnerId: null,
        leaseExpiresAt: null,
      });
      expect(pausedCanonical?.summary).toMatchObject({
        terminalStatus: "aborted",
        blocker: null,
        rootCause: { kind: "cancelled", code: "explicit_cancellation" },
      });
      const pausedSummaryRows = await context.pool.query<{ count: number }>(
        `select count(*)::int as count
         from itotori_localization_run_terminal_summaries
         where run_id = $1`,
        [pausedRunId],
      );
      expect(Number(pausedSummaryRows.rows[0]?.count)).toBe(1);
      expect(JSON.parse(readFileSync(join(runDir, "run-summary.json"), "utf8")) as unknown).toEqual(
        pausedCanonical?.summary,
      );
    } finally {
      stdoutSpy.mockRestore();
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
      rmSync(runDir, { recursive: true, force: true });
      await context.close();
    }
  });

  it("retries a failed cancellation summary projection without changing the canonical terminal row", async () => {
    const context = await isolatedMigratedContext();
    const runDir = mkdtempSync(join(tmpdir(), "itotori-terminal-cancel-retry-"));
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);

    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "terminal-cancellation-projection-retry-run";
      await seedCancellableRun(
        journal,
        runId,
        "terminal-cancellation-projection-retry-unit",
        "projection-retry-executor",
      );
      process.env.DATABASE_URL = context.databaseUrl;

      let projectionAttempt = 0;
      const dependencies = cliDependencies((path, value) => {
        projectionAttempt += 1;
        if (projectionAttempt === 1) {
          throw new Error("injected cancellation summary projection failure");
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      });
      const command = ["localize", "--cancel", "--resume-run-id", runId, "--run-dir", runDir];
      const summaryPath = join(runDir, "run-summary.json");
      writeFileSync(summaryPath, '{"stale":true}\n');

      await expect(runItotoriCliCommand(command, dependencies)).rejects.toThrow(
        "injected cancellation summary projection failure",
      );
      expect(existsSync(summaryPath)).toBe(false);

      const canonicalAfterFailure = await repository.loadTerminalSummary(actor, runId);
      const snapshotAfterFailure = await repository.loadSnapshot(actor, runId);
      expect(canonicalAfterFailure).toMatchObject({
        terminalStatus: "aborted",
        summaryEpoch: 1,
      });
      expect(snapshotAfterFailure?.run.status).toBe("aborted");
      expect(snapshotAfterFailure?.outbox.find((entry) => entry.stage === "summary")).toMatchObject(
        {
          status: "retry_waiting",
          lastError: "injected cancellation summary projection failure",
        },
      );

      await runItotoriCliCommand(command, dependencies);

      const canonicalAfterRetry = await repository.loadTerminalSummary(actor, runId);
      const snapshotAfterRetry = await repository.loadSnapshot(actor, runId);
      expect(canonicalAfterRetry).toEqual(canonicalAfterFailure);
      expect(canonicalAfterRetry?.summaryEpoch).toBe(1);
      expect(snapshotAfterRetry?.outbox.filter((entry) => entry.stage === "summary")).toHaveLength(
        1,
      );
      expect(snapshotAfterRetry?.outbox.find((entry) => entry.stage === "summary")).toMatchObject({
        status: "succeeded",
        evidence: { path: join(runDir, "run-summary.json") },
        lastError: null,
      });
      expect(JSON.parse(readFileSync(join(runDir, "run-summary.json"), "utf8")) as unknown).toEqual(
        canonicalAfterFailure?.summary,
      );
      const summaryRows = await context.pool.query<{ count: number }>(
        `select count(*)::int as count
         from itotori_localization_run_terminal_summaries
         where run_id = $1`,
        [runId],
      );
      expect(Number(summaryRows.rows[0]?.count)).toBe(1);
      expect(projectionAttempt).toBe(2);
    } finally {
      stdoutSpy.mockRestore();
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
      rmSync(runDir, { recursive: true, force: true });
      await context.close();
    }
  });
});

function cliDependencies(
  writeJson: ItotoriCliDependencies["io"]["writeJson"] = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  },
): ItotoriCliDependencies {
  return {
    io: {
      readJson: () => {
        throw new Error("operator cancellation must not read --config");
      },
      writeJson,
    },
    migrateDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async () => {
      throw new Error("operator cancellation must not open the project workflow service");
    }),
  };
}

async function seedCancellableRun(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
  ownerId: string,
): Promise<void> {
  await journal.seedRun(actor, {
    runId,
    ...scope,
    frozenScope: { kind: "explicit_units", unitIds: [bridgeUnitId] },
    routingPolicy: { routes: ["model-cancel/provider-cancel"] },
    costPolicy: { kind: "terminal-cancellation-test", capUsd: "1.00" },
    units: [
      {
        bridgeUnitId,
        sourceUnitKey: `scene.${bridgeUnitId}`,
        nextAction: { kind: "drive_unit", stage: "translation" },
      },
    ],
    lease: { ownerId },
    createdAt: "2026-07-12T15:00:00.000Z",
  });
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-terminal-cancellation-live', 'Terminal Cancellation Workspace')
  `);
  await context.pool.query(
    `
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      $1, 'workspace-terminal-cancellation-live', 'terminal-cancellation-live',
      'Terminal Cancellation Project', 'ja-JP', 'imported'
    )`,
    [scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values ($1, $2, 'bridge_revision', 'terminal-cancel-v1')`,
    [scope.sourceRevisionId, scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'bundle-terminal-cancellation-live', $1, $2,
      'bridge-terminal-cancellation-live', '0.2.0', 'hash:terminal-cancellation-live', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )`,
    [scope.projectId, scope.sourceRevisionId],
  );
  await context.pool.query(
    `
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      $1, $2, 'bundle-terminal-cancellation-live',
      $3, 'Terminal cancellation branch', 'active'
    )`,
    [scope.localeBranchId, scope.projectId, scope.targetLocale],
  );
}
