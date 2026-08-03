import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createItotoriServer } from "../src/server.js";
import { createDatabaseItotoriServiceFactory } from "../src/services/database-service-factory.js";
import type { ItotoriServiceFactory } from "../src/services/database-services.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { launchEnvironment, seedStyleBible } from "./production-role-bindings-live-db.support.js";
import { deterministicProvider } from "./production-role-bindings-provider.support.js";
import {
  CLEAN_Q5_TARGET,
  Q5_BACKGROUND_ASSET,
  stageRealLiveQ5Fixture,
} from "./production-role-bindings-reallive-fixture.support.js";

const ROLE_IDS = ["P1", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] as const;
type ProviderCallCounts = Record<(typeof ROLE_IDS)[number], number>;
const environmentBefore = new Map<string, string | undefined>();

describe("production localization user pause/resume over live Postgres", () => {
  afterEach(() => restoreLaunchEnvironment());

  it("pauses live provider work, resumes the same run, and reuses its 0120 checkpoint", async () => {
    requireLivePostgres();
    installLaunchEnvironment();
    const fixture = stageRealLiveQ5Fixture();
    const context = await isolatedMigratedContext();
    const projectId = "durable-pause-project";
    const localeBranchId = "durable-pause-project:en-US";
    const firstReviewStarted = deferred();
    let holdReviews = true;
    let firstReviewReported = false;
    let abortedReviewCalls = 0;
    const transport = deterministicProvider({
      reviewMode: "pass",
      targetSkeleton: CLEAN_Q5_TARGET,
      beforeResponse: async (role, request) => {
        if (!holdReviews || (role !== "Q1" && role !== "Q2" && role !== "Q3" && role !== "Q4")) {
          return;
        }
        if (!firstReviewReported) {
          firstReviewReported = true;
          firstReviewStarted.resolve();
        }
        await waitForAbort(request.signal);
        abortedReviewCalls += 1;
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error("paused review request had no abort reason");
      },
    });
    const factory = createDatabaseItotoriServiceFactory({
      databaseUrl: context.databaseUrl,
      providerFetcher: transport.fetcher,
    });
    let closeServer: (() => Promise<void>) | undefined;
    try {
      const paths = writeLaunchFiles(fixture.root, fixture.structure, fixture.bridge);
      const seeded = await factory(async (services) => {
        await services.projectWorkflow.ensureRunProjectScope({
          projectId,
          localeBranchId,
          sourceRevisionId: "pause-live-source-revision",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          engineFamily: "synthetic_fixture",
          sourceRoot: fixture.sourceRoot,
          buildRoot: fixture.buildRoot,
          extractProfile: { source: "pause-live-db" },
        });
        return await seedStyleBible({
          services,
          context,
          projectId,
          runId: "pause-bible-seed",
          localeBranchId,
          sourceInstalled: false,
          runtimeFixture: fixture,
          runMode: "production",
        });
      });
      transport.setLocalizationSnapshotId(seeded.localizationSnapshotId);
      transport.setBibleRenderingId(seeded.bibleRenderingId);
      transport.setVoiceRenderingId(seeded.voiceRenderingId);
      const server = await startServer(factory);
      closeServer = server.close;
      const configResponse = await post(server.baseUrl, configPath(projectId, localeBranchId), {
        projectId,
        localeBranchId,
        configPath: paths.configPath,
        dataRoot: fixture.sourceRoot,
        pairPolicyPath: paths.pairPolicyPath,
        modelId: "fixture-model",
        providerId: "fixture-provider",
        runDir: paths.runDir,
      });
      expect(configResponse.status).toBe(200);

      const started = await post(server.baseUrl, `/api/projects/${projectId}/launch-pass`, {
        localeBranchId,
      });
      expect(started.status).toBe(200);
      const startBody = jsonRecord(started.body, "launch response");
      expect(startBody.outcome).toBe("started");
      const journalRunId = text(startBody, "journalRunId", "launch response");

      await firstReviewStarted.promise;
      const running = await waitForStatus(factory, projectId, journalRunId, "running");
      expect(running.run.leaseOwnerId).not.toBeNull();
      expect(transport.count("P1")).toBe(1);
      const checkpointsAtRunning = await workflowCheckpointCount(context.pool);
      expect(checkpointsAtRunning).toBeGreaterThanOrEqual(1);

      const invalidResume = await post(
        server.baseUrl,
        controlPath(projectId, journalRunId, "resume"),
        {},
      );
      expectTypedTransitionRejection(invalidResume, /paused/i);

      const [firstPause, secondPause] = await Promise.all([
        post(server.baseUrl, controlPath(projectId, journalRunId, "pause"), {}),
        post(server.baseUrl, controlPath(projectId, journalRunId, "pause"), {}),
      ]);
      const paused = firstPause.status === 200 ? firstPause : secondPause;
      const duplicatePause = firstPause.status === 200 ? secondPause : firstPause;
      expect(paused.status).toBe(200);
      const pauseBody = jsonRecord(paused.body, "pause response");
      expect(pauseBody.journalRunId).toBe(journalRunId);
      expect(pauseBody.status).toBe("paused");
      const pausedLive = await waitForStatus(factory, projectId, journalRunId, "paused");
      expect(pausedLive.run.leaseOwnerId).toBeNull();
      expect(pausedLive.run.leaseExpiresAt).toBeNull();
      expect(await inFlightAttemptCount(context.pool)).toBe(0);
      const callsAtPause = providerCallCounts(transport);
      const pausedReviewCalls =
        callsAtPause.Q1 + callsAtPause.Q2 + callsAtPause.Q3 + callsAtPause.Q4;
      expect(pausedReviewCalls).toBeGreaterThan(0);
      expect(abortedReviewCalls).toBe(pausedReviewCalls);
      const checkpointsAtPause = await workflowCheckpointCount(context.pool);
      await wait(150);
      expect(providerCallCounts(transport)).toEqual(callsAtPause);
      expect(await workflowCheckpointCount(context.pool)).toBe(checkpointsAtPause);

      expectTypedTransitionRejection(duplicatePause, /running/i);

      holdReviews = false;
      const resumed = await post(
        server.baseUrl,
        controlPath(projectId, journalRunId, "resume"),
        {},
      );
      expect(resumed.status).toBe(200);
      const resumeBody = jsonRecord(resumed.body, "resume response");
      expect(resumeBody.journalRunId).toBe(journalRunId);
      expect(resumeBody.status).toBe("running");
      const completed = await waitForStatus(factory, projectId, journalRunId, "completed");
      expect(completed.progress.statusCounts.patched).toBe(1);
      const completedCheckpoints = await workflowCheckpointCount(context.pool);
      expect(completedCheckpoints).toBeGreaterThan(checkpointsAtPause);
      const completedCalls = providerCallCounts(transport);
      expect(completedCalls.P1 - callsAtPause.P1).toBe(0);
      expect(completedCalls.Q1 - callsAtPause.Q1).toBeGreaterThan(0);
      expect(completedCalls.Q2 - callsAtPause.Q2).toBeGreaterThan(0);
      expect(completedCalls.Q3 - callsAtPause.Q3).toBeGreaterThan(0);
      expect(completedCalls.Q4 - callsAtPause.Q4).toBeGreaterThan(0);
      expect(completedCalls.Q5).toBe(1);

      const invalidPause = await post(
        server.baseUrl,
        controlPath(projectId, journalRunId, "pause"),
        {},
      );
      expectTypedTransitionRejection(invalidPause, /running/i);
      console.log(
        JSON.stringify({
          durablePauseResumeProof: {
            database: "live-postgresql",
            journalRunId,
            pause: {
              status: pausedLive.run.status,
              providerAbortCount: abortedReviewCalls,
              persistedWorkflowCheckpoints: checkpointsAtPause,
              providerCalls: callsAtPause,
            },
            resume: {
              terminalStatus: completed.run.status,
              persistedWorkflowCheckpoints: completedCheckpoints,
              providerCalls: completedCalls,
              completedP1Recomputed: completedCalls.P1 - callsAtPause.P1,
            },
          },
        }),
      );
    } finally {
      await closeServer?.();
      await context.close();
      fixture.dispose();
    }
  }, 180_000);
});

function writeLaunchFiles(root: string, structure: unknown, bridge: unknown) {
  const structurePath = join(root, "pause-structure.json");
  const bridgePath = join(root, "pause-bridge.json");
  const configPath = join(root, "pause-launch.json");
  const pairPolicyPath = join(root, "pause-pair-policy.json");
  const runDir = join(root, "pause-run-output");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(structurePath, JSON.stringify(structure));
  writeFileSync(bridgePath, JSON.stringify(bridge));
  writeFileSync(pairPolicyPath, "{}\n");
  writeFileSync(
    configPath,
    JSON.stringify({
      structurePath,
      bridgePath,
      runMode: "production",
      contextScope: "whole-game",
      outputScope: "dialogue-only",
      runtimeBackgroundAsset: Q5_BACKGROUND_ASSET,
      wholeSceneMaxUnits: 1,
    }),
  );
  return { configPath, pairPolicyPath, runDir };
}

function configPath(projectId: string, localeBranchId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/locale-branches/${encodeURIComponent(localeBranchId)}/settings/localization-run-config`;
}

function controlPath(projectId: string, journalRunId: string, action: "pause" | "resume"): string {
  return `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(journalRunId)}/${action}`;
}

async function startServer(factory: ItotoriServiceFactory): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createItotoriServer({ serviceFactory: factory });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("pause proof server has no TCP port");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await response.json();
  return { status: response.status, body: responseBody };
}

async function waitForStatus(
  factory: ItotoriServiceFactory,
  projectId: string,
  journalRunId: string,
  status: "running" | "paused" | "completed",
) {
  return await waitFor(`run ${journalRunId} to become ${status}`, async () => {
    const live = await factory(
      async (services) =>
        await services.projectWorkflow.loadLiveReadModel(projectId, journalRunId, {
          blockerPage: { limit: 100, offset: 0 },
        }),
    );
    if (live?.run.status === "failed" || live?.run.status === "cancelled") {
      throw new Error(
        `run ${journalRunId} reached ${live.run.status} while waiting for ${status}: ${JSON.stringify(live)}`,
      );
    }
    return live?.run.status === status ? live : null;
  });
}

async function inFlightAttemptCount(pool: {
  query(query: string): Promise<{ rows: unknown[] }>;
}): Promise<number> {
  const result = await pool.query(
    "select count(*)::integer as count from itotori_llm_http_attempts where attempt_status = 'in-flight'",
  );
  return integerColumn(result.rows[0], "count");
}

async function workflowCheckpointCount(pool: {
  query(query: string): Promise<{ rows: unknown[] }>;
}): Promise<number> {
  const result = await pool.query(
    "select count(*)::integer as count from itotori_llm_workflow_step_memos where deletion_state = 'active'",
  );
  return integerColumn(result.rows[0], "count");
}

async function waitFor<T>(label: string, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function expectTypedTransitionRejection(
  response: { status: number; body: unknown },
  message: RegExp,
): void {
  expect(response.status).toBe(409);
  const body = jsonRecord(response.body, "transition rejection");
  expect(body.code).toBe("run_transition_rejected");
  expect(text(body, "error", "transition rejection")).toMatch(message);
}

function providerCallCounts(
  transport: ReturnType<typeof deterministicProvider>,
): ProviderCallCounts {
  return {
    P1: transport.count("P1"),
    Q1: transport.count("Q1"),
    Q2: transport.count("Q2"),
    Q3: transport.count("Q3"),
    Q4: transport.count("Q4"),
    Q5: transport.count("Q5"),
    Q6: transport.count("Q6"),
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the user pause signal at the provider boundary"));
    }, 30_000);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function integerColumn(row: unknown, column: string): number {
  const value = jsonRecord(row, "Postgres row")[column];
  if (typeof value !== "number") throw new Error(`Postgres ${column} was not an integer`);
  return value;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}.${field} missing`);
  return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireLivePostgres(): void {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("production pause/resume proof requires DATABASE_URL");
  }
}

function installLaunchEnvironment(): void {
  for (const [key, value] of Object.entries(launchEnvironment)) {
    if (!environmentBefore.has(key)) environmentBefore.set(key, process.env[key]);
    process.env[key] = value;
  }
}

function restoreLaunchEnvironment(): void {
  for (const [key, value] of environmentBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  environmentBefore.clear();
}
