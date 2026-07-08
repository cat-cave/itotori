import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriDraftAttemptProviderLedgerRepository } from "../src/repositories/draft-attempt-provider-ledger-repository.js";
import { ItotoriDraftJobRepository } from "../src/repositories/draft-job-repository.js";
import { ItotoriEventQueueRepository } from "../src/repositories/event-queue-repository.js";
import { ItotoriModelLedgerRepository } from "../src/repositories/model-ledger-repository.js";
import {
  jobIdempotencyPolicyValues,
  jobTaskTypeValues,
  providerCostKindValues,
  providerRunStatusValues,
} from "../src/schema.js";
import {
  draftJobFixtureInput,
  draftJobFixtureLocaleBranchId,
  draftJobFixtureProjectId,
  provisionDraftJobFixtureProject,
} from "./draft-job-fixtures.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("jobs.run_table read model", () => {
  it("returns paginated rows with the honest served model/provider pair and ZDR posture", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);

      const draftJobs = new ItotoriDraftJobRepository(context.db);
      const providerLedger = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
      const modelLedger = new ItotoriModelLedgerRepository(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      await seedRunTableRow({
        draftJobs,
        providerLedger,
        modelLedger,
        queue,
        suffix: "older",
        providerRunId: "provider-run-older",
        jobId: "job-run-table-older",
        requestedModelId: "openrouter/auto",
        actualModelId: "mistral/mistral-large",
        requestedProviderIdInDraftLedger: "requested-provider-older",
        upstreamProvider: "mistral",
        zdr: false,
        createdAt: new Date("2026-06-23T11:00:00Z"),
      });
      const first = await seedRunTableRow({
        draftJobs,
        providerLedger,
        modelLedger,
        queue,
        suffix: "served",
        providerRunId: "provider-run-served-pair",
        jobId: "job-run-table-served",
        requestedModelId: "openrouter/auto",
        actualModelId: "anthropic/claude-3.5-sonnet",
        requestedProviderIdInDraftLedger: "requested-provider-sentinel",
        upstreamProvider: "anthropic",
        zdr: true,
        createdAt: new Date("2026-06-23T12:00:00Z"),
      });

      const page = await providerLedger.loadJobsRunTable(localActor, {
        projectId: draftJobFixtureProjectId,
        limit: 1,
        offset: 0,
        generatedAt: new Date("2026-06-23T13:00:00Z"),
      });

      expect(page).toMatchObject({
        schemaVersion: "jobs.run_table.v0.1",
        generatedAt: "2026-06-23T13:00:00.000Z",
        filter: { projectId: draftJobFixtureProjectId },
        pagination: {
          total: 2,
          limit: 1,
          offset: 0,
          page: 1,
          pageCount: 2,
          hasMore: true,
          nextOffset: 1,
        },
      });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({
        runId: "provider-run-served-pair",
        draftJobAttemptId: first.draftJobAttemptId,
        providerRunId: "provider-run-served-pair",
        jobId: "job-run-table-served",
        projectId: draftJobFixtureProjectId,
        localeBranchId: draftJobFixtureLocaleBranchId,
        task: "Draft translation",
        status: "succeeded",
        servedModel: "anthropic/claude-3.5-sonnet",
        servedProvider: "anthropic",
        zdr: true,
        cost: { unit: "usd", amount: "0.01250000" },
        tokens: { in: 500, out: 200, total: 700 },
        fallback: {
          used: true,
          plan: ["openrouter/auto", "anthropic/claude-3.5-sonnet"],
        },
      });

      expect(page.rows[0]?.servedProvider).not.toBe("requested-provider-sentinel");
      expect(page.rows[0]?.servedModel).not.toBe("openrouter/auto");
    } finally {
      await context.close();
    }
  });
});

async function seedRunTableRow(input: {
  draftJobs: ItotoriDraftJobRepository;
  providerLedger: ItotoriDraftAttemptProviderLedgerRepository;
  modelLedger: ItotoriModelLedgerRepository;
  queue: ItotoriEventQueueRepository;
  suffix: string;
  providerRunId: string;
  jobId: string;
  requestedModelId: string;
  actualModelId: string;
  requestedProviderIdInDraftLedger: string;
  upstreamProvider: string;
  zdr: boolean;
  createdAt: Date;
}): Promise<{ draftJobAttemptId: string }> {
  const job = await input.draftJobs.createDraftJob(localActor, draftJobFixtureInput());
  const attempt = await input.draftJobs.recordAttempt(localActor, job.draftJobId, {
    attemptIndex: 1,
    providerRunId: input.providerRunId,
    startedAt: input.createdAt,
  });
  await input.queue.enqueueJob(localActor, {
    jobId: input.jobId,
    projectId: draftJobFixtureProjectId,
    localeBranchId: draftJobFixtureLocaleBranchId,
    jobType: jobTaskTypeValues.agentTask,
    jobName: "Draft translation",
    idempotency: { policy: jobIdempotencyPolicyValues.nonIdempotent },
    correlationId: `corr-${input.suffix}`,
    payload: { draftJobId: job.draftJobId },
  });
  await input.modelLedger.recordProviderRun(localActor, {
    providerRunId: input.providerRunId,
    projectId: draftJobFixtureProjectId,
    localeBranchId: draftJobFixtureLocaleBranchId,
    jobId: input.jobId,
    taskKind: "draft_translation",
    startedAt: input.createdAt,
    completedAt: new Date(input.createdAt.getTime() + 1_000),
    latencyMs: 1_000,
    status: providerRunStatusValues.succeeded,
    provider: {
      providerFamily: "openrouter",
      endpointFamily: "chat",
      providerName: "OpenRouter",
      requestedModelId: input.requestedModelId,
      actualModelId: input.actualModelId,
      upstreamProvider: input.upstreamProvider,
    },
    prompt: {
      promptPresetId: `prompt-${input.suffix}`,
      promptTemplateVersion: "itotori-translation-agent-v1",
      promptHash: `sha256:${input.suffix.padEnd(64, "0")}`,
    },
    structuredOutputMode: "json_schema",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: input.requestedModelId !== input.actualModelId,
    fallbackPlan:
      input.requestedModelId === input.actualModelId
        ? [input.requestedModelId]
        : [input.requestedModelId, input.actualModelId],
    tokenUsage: {
      tokenCountSource: "provider_reported",
      promptTokens: 500,
      completionTokens: 200,
      totalTokens: 700,
    },
    cost: {
      costKind: providerCostKindValues.billed,
      currency: "USD",
      amountMicrosUsd: 12_500,
    },
    routingPosture: { zdr: input.zdr, data_collection: "deny", allow_fallbacks: true },
  });
  await input.draftJobs.markAttemptSucceeded(
    localActor,
    attempt.draftJobAttemptId,
    new Date(input.createdAt.getTime() + 2_000),
    input.providerRunId,
    `recorded-artifact-${input.suffix}`,
  );
  await input.providerLedger.recordLedgerEntry(localActor, {
    draftJobAttemptId: attempt.draftJobAttemptId,
    providerProofId: `provider-proof-${input.suffix}`,
    modelProviderFamily: "openrouter",
    modelId: input.requestedModelId,
    providerId: input.requestedProviderIdInDraftLedger,
    tokensIn: 500,
    tokensOut: 200,
    tokenCountSource: "provider_reported",
    costUnit: "usd",
    costAmount: "0.01250000",
    usageResponseJson: {
      prompt_tokens: 500,
      completion_tokens: 200,
      total_tokens: 700,
      cost: 0.0125,
    },
    fallbackChain:
      input.requestedModelId === input.actualModelId
        ? []
        : [
            {
              modelProviderFamily: "openrouter",
              modelId: input.requestedModelId,
              failureReason: "provider fallback",
              attemptedAt: input.createdAt.toISOString(),
            },
          ],
  });
  return { draftJobAttemptId: attempt.draftJobAttemptId };
}
