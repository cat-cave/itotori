import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ItotoriEventQueueRepository,
  ItotoriJobsRunTableRepository,
  ItotoriModelLedgerRepository,
  type JobsRunTableReadModel,
  jobIdempotencyPolicyValues,
  jobTaskTypeValues,
  localUserId,
  providerCostKindValues,
  providerRunStatusValues,
  type AuthorizationActor,
} from "@itotori/db";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  draftJobFixtureLocaleBranchId,
  draftJobFixtureProjectId,
  provisionDraftJobFixtureProject,
} from "../../../packages/itotori-db/test/draft-job-fixtures.js";
import { createItotoriServer } from "../src/server.js";

import { requireLivePostgres } from "../../../packages/itotori-db/test/live-postgres-suite.js";

const postgresDescribe = requireLivePostgres(describe);
const localActor: AuthorizationActor = { userId: localUserId };
const servers: ReturnType<typeof createItotoriServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

postgresDescribe("jobs run table over persisted provider runs", () => {
  beforeAll(() => {
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("renders persisted provider runs and an optional same-project queue job through the API", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const queue = new ItotoriEventQueueRepository(context.db);
      const ledger = new ItotoriModelLedgerRepository(context.db);
      await queue.enqueueJob(localActor, {
        jobId: "jobs-table-queued-job",
        projectId: draftJobFixtureProjectId,
        localeBranchId: draftJobFixtureLocaleBranchId,
        jobType: jobTaskTypeValues.agentTask,
        jobName: "Draft translation",
        idempotency: { policy: jobIdempotencyPolicyValues.nonIdempotent },
        correlationId: "jobs-table-correlation",
        payload: {},
      });
      await recordProviderRun(ledger, "jobs-table-run-with-job", "jobs-table-queued-job", {
        zdr: true,
        startedAt: "2026-07-27T12:00:00.000Z",
      });
      await recordProviderRun(ledger, "jobs-table-run-without-job", undefined, {
        routingPosture: { _pre_itotori_230: true },
        startedAt: "2026-07-27T11:00:00.000Z",
      });

      const server = createItotoriServer({ databaseUrl: context.databaseUrl });
      servers.push(server);
      const response = await fetch(
        `${await listen(server)}/api/jobs/run-table?projectId=${draftJobFixtureProjectId}`,
      );
      const body = (await response.json()) as JobsRunTableReadModel;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        schemaVersion: "jobs.run_table.v0.3",
        filter: { projectId: draftJobFixtureProjectId },
        pagination: { total: 2 },
      });
      expect(body.rows).toEqual([
        expect.objectContaining({
          runId: "jobs-table-run-with-job",
          jobId: "jobs-table-queued-job",
          task: "Draft translation",
          servedModel: "anthropic/claude-3-5-sonnet",
          servedProvider: "anthropic",
          zdr: { availability: "captured", enforced: true },
          cost: { availability: "captured", unit: "usd", amount: "0.0125" },
          tokens: { in: 500, out: 200, total: 700 },
          fallback: {
            used: true,
            plan: ["openrouter/auto", "anthropic/claude-3-5-sonnet"],
            chain: null,
          },
        }),
        expect.objectContaining({
          runId: "jobs-table-run-without-job",
          jobId: null,
          zdr: { availability: "not_captured", enforced: null },
        }),
      ]);

      const service = new ItotoriJobsRunTableRepository(context.db);
      await expect(
        service.loadRunTable(localActor, { projectId: "no-such-project" }),
      ).rejects.toThrow(/no-such-project/);
    } finally {
      await context.close();
    }
  });
});

async function recordProviderRun(
  ledger: ItotoriModelLedgerRepository,
  providerRunId: string,
  jobId: string | undefined,
  options: { zdr?: boolean; routingPosture?: Record<string, unknown>; startedAt: string },
): Promise<void> {
  await ledger.recordProviderRun(localActor, {
    providerRunId,
    projectId: draftJobFixtureProjectId,
    localeBranchId: draftJobFixtureLocaleBranchId,
    ...(jobId === undefined ? {} : { jobId }),
    taskKind: "draft_translation",
    status: providerRunStatusValues.succeeded,
    startedAt: new Date(options.startedAt),
    completedAt: new Date(options.startedAt),
    provider: {
      providerFamily: "openrouter",
      endpointFamily: "chat",
      providerName: "OpenRouter",
      requestedModelId: "openrouter/auto",
      actualModelId: "anthropic/claude-3-5-sonnet",
      upstreamProvider: "anthropic",
    },
    prompt: {
      promptPresetId: `prompt-${providerRunId}`,
      promptTemplateVersion: "jobs-run-table-test.v1",
      promptHash: `sha256:${"a".repeat(64)}`,
    },
    structuredOutputMode: "json_schema",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: true,
    fallbackPlan: ["openrouter/auto", "anthropic/claude-3-5-sonnet"],
    tokenUsage: {
      tokenCountSource: "provider_reported",
      promptTokens: 500,
      completionTokens: 200,
      totalTokens: 700,
    },
    cost: {
      costKind: providerCostKindValues.billed,
      currency: "USD",
      amountMicrosUsd: 12_500, // cost-audit-allow: synthetic persisted ledger fixture
    },
    routingPosture: options.routingPosture ?? { zdr: options.zdr ?? false },
  });
}

async function listen(server: ReturnType<typeof createItotoriServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}
