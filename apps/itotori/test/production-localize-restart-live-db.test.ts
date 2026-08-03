import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { launchEnvironment, seedStyleBible } from "./production-role-bindings-live-db.support.js";
import { deterministicProvider } from "./production-role-bindings-provider.support.js";
import {
  Q5_BACKGROUND_ASSET,
  stageRealLiveQ5Fixture,
  type RealLiveQ5Fixture,
} from "./production-role-bindings-reallive-fixture.support.js";

const workerPath = fileURLToPath(
  new URL("./production-localize-restart-worker.mjs", import.meta.url),
);
const ROLE_IDS = ["P1", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] as const;
type ProviderRole = (typeof ROLE_IDS)[number];
type ProviderCallCounts = Record<ProviderRole, number>;

type RestartWorkerInput = {
  readonly phase: "interrupt" | "resume";
  readonly databaseUrl: string;
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
  readonly sourceRoot: string;
  readonly buildRoot: string;
  readonly backgroundAsset: string;
  readonly structureJson: unknown;
  readonly bridge: unknown;
  readonly localizationSnapshotId: string;
  readonly bibleRenderingId: string;
  readonly voiceRenderingId: string;
};

type RestartWorkerMessage =
  | { readonly kind: "ready-to-kill"; readonly calls: ProviderCallCounts }
  | { readonly kind: "completed"; readonly calls: ProviderCallCounts }
  | { readonly kind: "error"; readonly message: string };

type WorkerHandle = {
  readonly child: ChildProcess;
  readonly stderr: () => string;
};

const environmentBefore = new Map<string, string | undefined>();

describe("production localize restart over live Postgres", () => {
  afterEach(() => restoreLaunchEnvironment());

  it("SIGKILLs a production child after P1, then resumes from its durable checkpoint", async () => {
    requireLivePostgres();
    installLaunchEnvironment();
    const fixture = stageRealLiveQ5Fixture();
    const context = await isolatedMigratedContext();
    const projectId = "durable-restart-project";
    const runId = "durable-restart-run";
    const localeBranchId = "durable-restart-en-US";
    try {
      const seeded = await seedRestartBible({
        databaseUrl: context.databaseUrl,
        context,
        fixture,
        projectId,
        runId,
        localeBranchId,
      });
      const input: Omit<RestartWorkerInput, "phase"> = {
        databaseUrl: context.databaseUrl,
        projectId,
        runId,
        localeBranchId,
        sourceRoot: fixture.sourceRoot,
        buildRoot: fixture.buildRoot,
        backgroundAsset: Q5_BACKGROUND_ASSET,
        structureJson: fixture.structure,
        bridge: fixture.bridge,
        localizationSnapshotId: seeded.localizationSnapshotId,
        bibleRenderingId: seeded.bibleRenderingId,
        voiceRenderingId: seeded.voiceRenderingId,
      };

      const interrupted = await startWorker({ ...input, phase: "interrupt" });
      const ready = await waitForMessage(interrupted, "ready-to-kill");
      expect(ready.kind).toBe("ready-to-kill");
      if (ready.kind !== "ready-to-kill")
        throw new Error("restart worker did not reach review pause");
      expect(ready.calls.P1).toBe(1);
      const durableCheckpointCount = await workflowCheckpointCount(context.pool);
      expect(durableCheckpointCount).toBeGreaterThanOrEqual(1);

      expect(interrupted.child.kill("SIGKILL")).toBe(true);
      const killed = await waitForExit(interrupted);
      expect(killed.signal).toBe("SIGKILL");
      await waitForLeaseExpiry(context.pool, projectId, runId);
      // The Q1 request was in flight at the real HTTP boundary when the child
      // died. Let its durable physical-attempt lease expire before a new process
      // may safely retry that incomplete request; P1 remains a completed cache hit.
      await waitForProviderAttemptExpiry(context.pool);

      const resumed = await startWorker({ ...input, phase: "resume" });
      const completed = await waitForMessage(resumed, "completed");
      expect(completed.kind).toBe("completed");
      if (completed.kind !== "completed") throw new Error("restart worker did not complete");
      const resumedExit = await waitForExit(resumed);
      expect(resumedExit.code).toBe(0);

      const live = await readLiveRun(context.databaseUrl, projectId, runId);
      expect(live?.run.status).toBe("completed");
      expect(live?.progress.statusCounts.patched).toBe(1);
      expect(completed.calls.P1).toBe(0);
      expect(completed.calls.Q1).toBeGreaterThan(0);
      expect(completed.calls.Q2).toBeGreaterThan(0);
      expect(completed.calls.Q3).toBeGreaterThan(0);
      expect(completed.calls.Q4).toBeGreaterThan(0);
      expect(completed.calls.Q5).toBe(1);
      const completedCheckpointCount = await workflowCheckpointCount(context.pool);
      expect(completedCheckpointCount).toBeGreaterThan(durableCheckpointCount);

      console.log(
        JSON.stringify({
          durableRestartProof: {
            database: "live-postgresql",
            interruption: {
              signal: killed.signal,
              persistedWorkflowCheckpoints: durableCheckpointCount,
              providerCalls: ready.calls,
            },
            resume: {
              terminalStatus: live?.run.status,
              persistedWorkflowCheckpoints: completedCheckpointCount,
              providerCalls: completed.calls,
              completedP1Recomputed: completed.calls.P1,
            },
          },
        }),
      );
    } finally {
      await context.close();
      fixture.dispose();
    }
  }, 180_000);
});

function requireLivePostgres(): void {
  if (process.env.DATABASE_URL === undefined)
    throw new Error("production durable-restart proof requires DATABASE_URL");
}

async function seedRestartBible(input: {
  readonly databaseUrl: string;
  readonly context: Awaited<ReturnType<typeof isolatedMigratedContext>>;
  readonly fixture: RealLiveQ5Fixture;
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
}) {
  const transport = deterministicProvider({ reviewMode: "pass" });
  return await withDatabaseItotoriServices(
    { databaseUrl: input.databaseUrl, providerFetcher: transport.fetcher },
    async (services) =>
      await seedStyleBible({
        services,
        context: input.context,
        projectId: input.projectId,
        runId: input.runId,
        localeBranchId: input.localeBranchId,
        sourceInstalled: false,
        runtimeFixture: input.fixture,
        runMode: "production",
      }),
  );
}

async function startWorker(input: RestartWorkerInput): Promise<WorkerHandle> {
  const child = fork(workerPath, [], { silent: true });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.resume();
  const worker = { child, stderr: () => stderr };
  await waitForInputReady(worker);
  child.send(JSON.stringify(input));
  return worker;
}

async function waitForInputReady(worker: WorkerHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish();
      reject(new Error(`restart worker did not initialize its IPC channel: ${worker.stderr()}`));
    }, 30_000);
    const onMessage = (value: unknown) => {
      if (value !== "restart-worker-ready") return;
      finish();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish();
      reject(
        new Error(
          `restart worker exited before its IPC channel initialized (code ${String(code)}, signal ${String(signal)}): ${worker.stderr()}`,
        ),
      );
    };
    const finish = () => {
      clearTimeout(timeout);
      worker.child.off("message", onMessage);
      worker.child.off("exit", onExit);
    };
    worker.child.on("message", onMessage);
    worker.child.once("exit", onExit);
  });
}

async function waitForMessage(
  worker: WorkerHandle,
  expectedKind: Exclude<RestartWorkerMessage["kind"], "error">,
): Promise<RestartWorkerMessage> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish();
      reject(new Error(`restart worker timed out waiting for ${expectedKind}: ${worker.stderr()}`));
    }, 90_000);
    const onMessage = (value: unknown) => {
      const message = parseWorkerMessage(value);
      if (message === null) return;
      if (message.kind === "error") {
        finish();
        reject(new Error(`restart worker failed: ${message.message}`));
        return;
      }
      if (message.kind !== expectedKind) return;
      finish();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish();
      reject(
        new Error(
          `restart worker exited before ${expectedKind} (code ${String(code)}, signal ${String(signal)}): ${worker.stderr()}`,
        ),
      );
    };
    const finish = () => {
      clearTimeout(timeout);
      worker.child.off("message", onMessage);
      worker.child.off("exit", onExit);
    };
    worker.child.on("message", onMessage);
    worker.child.once("exit", onExit);
  });
}

async function waitForExit(
  worker: WorkerHandle,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    return { code: worker.child.exitCode, signal: worker.child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    worker.child.once("error", reject);
    worker.child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function workflowCheckpointCount(pool: {
  query(query: string): Promise<{ rows: unknown[] }>;
}): Promise<number> {
  const result = await pool.query(
    "select count(*)::integer as count from itotori_llm_workflow_step_memos where deletion_state = 'active'",
  );
  const row = result.rows[0];
  if (!isRecord(row) || typeof row.count !== "number") {
    throw new Error("workflow checkpoint count query returned an invalid row");
  }
  return row.count;
}

async function waitForLeaseExpiry(
  pool: { query(query: string, values: readonly string[]): Promise<{ rows: unknown[] }> },
  projectId: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "select lease_expires_at <= now() as reclaimable from itotori_project_runs where project_id = $1 and run_id = $2",
      [projectId, runId],
    );
    const row = result.rows[0];
    if (isRecord(row) && row.reclaimable === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("killed run lease did not expire in time");
}

async function waitForProviderAttemptExpiry(pool: {
  query(query: string): Promise<{ rows: unknown[] }>;
}): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "select not exists (select 1 from itotori_llm_http_attempts where attempt_status = 'in-flight' and deadline_at > now()) as reclaimable",
    );
    const row = result.rows[0];
    if (isRecord(row) && row.reclaimable === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("killed provider request did not become reclaimable in time");
}

async function readLiveRun(databaseUrl: string, projectId: string, runId: string) {
  const transport = deterministicProvider({ reviewMode: "pass" });
  return await withDatabaseItotoriServices(
    { databaseUrl, providerFetcher: transport.fetcher },
    async (services) => await services.projectWorkflow.loadLiveReadModel(projectId, runId),
  );
}

function parseWorkerMessage(value: unknown): RestartWorkerMessage | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "error") {
    return typeof value.message === "string" ? { kind: "error", message: value.message } : null;
  }
  if (value.kind !== "ready-to-kill" && value.kind !== "completed") return null;
  const calls = parseCallCounts(value.calls);
  return calls === null ? null : { kind: value.kind, calls };
}

function parseCallCounts(value: unknown): ProviderCallCounts | null {
  if (!isRecord(value)) return null;
  const counts = ROLE_IDS.map((role) => value[role]);
  if (!counts.every((count) => typeof count === "number" && Number.isSafeInteger(count))) {
    return null;
  }
  return {
    P1: count(value, "P1"),
    Q1: count(value, "Q1"),
    Q2: count(value, "Q2"),
    Q3: count(value, "Q3"),
    Q4: count(value, "Q4"),
    Q5: count(value, "Q5"),
    Q6: count(value, "Q6"),
  };
}

function count(value: Record<string, unknown>, role: ProviderRole): number {
  const candidate = value[role];
  if (typeof candidate !== "number") throw new Error("restart worker count is invalid");
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
