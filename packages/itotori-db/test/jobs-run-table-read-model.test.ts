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
import type { ItotoriDatabase } from "../src/connection.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import {
  draftJobFixtureInput,
  draftJobFixtureLocaleBranchId,
  draftJobFixtureProject,
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

  it("fails closed when no projectId scope is supplied (never reads across all projects)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const providerLedger = new ItotoriDraftAttemptProviderLedgerRepository(context.db);

      // A missing or empty projectId must NOT fall through to an all-projects
      // read — it fails closed (P1 route-scoping, defense in depth in the repo).
      await expect(providerLedger.loadJobsRunTable(localActor, {})).rejects.toThrow(/projectId/i);
      await expect(providerLedger.loadJobsRunTable(localActor, { projectId: "" })).rejects.toThrow(
        /projectId/i,
      );
    } finally {
      await context.close();
    }
  });

  it("never joins a provider_run from another project (cross-project served/zdr/job leak, P1)", async () => {
    const context = await isolatedMigratedContext();
    try {
      // Project A (the target) + project B (the victim whose run must not leak).
      await provisionDraftJobFixtureProject(context.db, localActor);
      await provisionCrossProjectVictim(context.db);

      const draftJobs = new ItotoriDraftJobRepository(context.db);
      const providerLedger = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
      const modelLedger = new ItotoriModelLedgerRepository(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      const foreignRunId = "cross-project-leak-run";
      const foreignJobId = "job-project-b-secret";

      // Project B owns a job + a provider_run carrying DISTINCTIVE served
      // model/provider/zdr/job values that must never appear in A's run table.
      await queue.enqueueJob(localActor, {
        jobId: foreignJobId,
        projectId: crossProjectVictimProjectId,
        localeBranchId: crossProjectVictimLocaleBranchId,
        jobType: jobTaskTypeValues.agentTask,
        jobName: "PROJECT-B-SECRET-JOB",
        idempotency: { policy: jobIdempotencyPolicyValues.nonIdempotent },
        correlationId: "corr-project-b",
        payload: {},
      });
      await modelLedger.recordProviderRun(localActor, {
        providerRunId: foreignRunId,
        projectId: crossProjectVictimProjectId,
        localeBranchId: crossProjectVictimLocaleBranchId,
        jobId: foreignJobId,
        taskKind: "draft_translation",
        startedAt: new Date("2026-06-23T10:00:00Z"),
        completedAt: new Date("2026-06-23T10:00:01Z"),
        latencyMs: 1_000,
        status: providerRunStatusValues.succeeded,
        provider: {
          providerFamily: "openrouter",
          endpointFamily: "chat",
          providerName: "OpenRouter",
          requestedModelId: "openrouter/auto",
          actualModelId: "LEAKED-model-from-project-b",
          upstreamProvider: "LEAKED-provider-b",
        },
        prompt: {
          promptPresetId: "prompt-project-b",
          promptTemplateVersion: "itotori-translation-agent-v1",
          promptHash: `sha256:${"b".repeat(64)}`,
        },
        structuredOutputMode: "json_schema",
        retryCount: 0,
        errorClasses: [],
        fallbackUsed: true,
        fallbackPlan: ["openrouter/auto", "LEAKED-model-from-project-b"],
        tokenUsage: {
          tokenCountSource: "provider_reported",
          promptTokens: 9_000,
          completionTokens: 999,
          totalTokens: 9_999,
        },
        cost: {
          costKind: providerCostKindValues.billed,
          currency: "USD",
          amountMicrosUsd: 99_999, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
        routingPosture: { zdr: true, data_collection: "deny", allow_fallbacks: true },
      });

      // Project A has an attempt whose provider_run_id POINTS AT project B's run
      // (plain text, no FK) plus its OWN ledger row with distinctive values.
      const job = await draftJobs.createDraftJob(localActor, draftJobFixtureInput());
      const attempt = await draftJobs.recordAttempt(localActor, job.draftJobId, {
        attemptIndex: 1,
        providerRunId: foreignRunId,
        startedAt: new Date("2026-06-23T12:00:00Z"),
      });
      await draftJobs.markAttemptSucceeded(
        localActor,
        attempt.draftJobAttemptId,
        new Date("2026-06-23T12:00:02Z"),
        foreignRunId,
        "recorded-artifact-project-a",
      );
      await providerLedger.recordLedgerEntry(localActor, {
        draftJobAttemptId: attempt.draftJobAttemptId,
        providerProofId: "provider-proof-project-a",
        modelProviderFamily: "openrouter",
        modelId: "project-a-served-model",
        providerId: "project-a-served-provider",
        tokensIn: 10,
        tokensOut: 5,
        tokenCountSource: "provider_reported",
        costUnit: "usd",
        costAmount: "0.00100000",
        usageResponseJson: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: 0.001, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        },
        fallbackChain: [],
      });

      const page = await providerLedger.loadJobsRunTable(localActor, {
        projectId: draftJobFixtureProjectId,
        generatedAt: new Date("2026-06-23T13:00:00Z"),
      });

      expect(page.rows).toHaveLength(1);
      const row = page.rows[0];
      // The foreign project-B run is UNREACHABLE from project A: every served
      // field falls back to project A's OWN ledger, never project B's run.
      expect(row?.servedModel).toBe("project-a-served-model");
      expect(row?.servedProvider).toBe("project-a-served-provider");
      expect(row?.servedModel).not.toBe("LEAKED-model-from-project-b");
      expect(row?.servedProvider).not.toBe("LEAKED-provider-b");
      expect(row?.zdr).toBeNull(); // project B's zdr:true must not leak
      expect(row?.jobId).toBeNull(); // project B's job must not leak
      expect(row?.providerRunId).toBeNull(); // foreign run id is not surfaced
      expect(row?.runId).toBe(attempt.draftJobAttemptId); // not the foreign run id
      expect(row?.task).toBe("draft"); // not project B's job name
      expect(row?.status).toBe("succeeded");
      // Cost + tokens are project A's own ledger values (same attempt).
      expect(row?.cost).toEqual({ unit: "usd", amount: "0.00100000" });
      expect(row?.tokens).toEqual({ in: 10, out: 5, total: 15 });
      expect(row?.fallback.used).toBe(false);

      // FINDING 1 — a request scoped to the FOREIGN project returns NONE of
      // project A's rows (project B has a run but no draft-job/ledger anchor).
      const foreign = await providerLedger.loadJobsRunTable(localActor, {
        projectId: crossProjectVictimProjectId,
        generatedAt: new Date("2026-06-23T13:00:00Z"),
      });
      expect(foreign.rows).toHaveLength(0);
      expect(foreign.pagination.total).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("reconciles the served row to one attempt: cost + tokens are single-sourced from the ledger (P1)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);

      const draftJobs = new ItotoriDraftJobRepository(context.db);
      const providerLedger = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
      const modelLedger = new ItotoriModelLedgerRepository(context.db);
      const queue = new ItotoriEventQueueRepository(context.db);

      // The provider_run reports a DIFFERENT total_tokens (9,999) than the
      // ledger (500 + 200 = 700). The served pair/zdr come from the run; the
      // cost + tokens must come from the ledger — the SAME attempt, never a
      // stitch of run-tokens with ledger-cost.
      await seedRunTableRow({
        draftJobs,
        providerLedger,
        modelLedger,
        queue,
        suffix: "reconcile",
        providerRunId: "provider-run-reconcile",
        jobId: "job-run-table-reconcile",
        requestedModelId: "openrouter/auto",
        actualModelId: "anthropic/claude-3.5-sonnet",
        requestedProviderIdInDraftLedger: "requested-provider-reconcile",
        upstreamProvider: "anthropic",
        zdr: true,
        createdAt: new Date("2026-06-23T12:00:00Z"),
        runTokenUsage: { promptTokens: 9_000, completionTokens: 999, totalTokens: 9_999 },
      });

      const page = await providerLedger.loadJobsRunTable(localActor, {
        projectId: draftJobFixtureProjectId,
        generatedAt: new Date("2026-06-23T13:00:00Z"),
      });

      expect(page.rows).toHaveLength(1);
      const row = page.rows[0];
      // Served pair + zdr come from the run (the actual serving record)…
      expect(row?.servedModel).toBe("anthropic/claude-3.5-sonnet");
      expect(row?.servedProvider).toBe("anthropic");
      expect(row?.zdr).toBe(true);
      // …but cost AND tokens come from the SAME ledger row — NOT the run's
      // divergent 9,999-token count.
      expect(row?.cost).toEqual({ unit: "usd", amount: "0.01250000" });
      expect(row?.tokens).toEqual({ in: 500, out: 200, total: 700 });
      expect(row?.tokens.total).not.toBe(9_999);
    } finally {
      await context.close();
    }
  });
});

const crossProjectVictimProjectId = "project-cross-project-victim";
const crossProjectVictimLocaleBranchId = "locale-cross-project-victim";

async function provisionCrossProjectVictim(db: ItotoriDatabase): Promise<void> {
  const base = draftJobFixtureProject();
  const projects = new ItotoriProjectRepository(db);
  // A fully DISTINCT bridge (bundle id/hash, unit ids/keys, and asset ids) so
  // the victim project owns its own assets — asset ids are unique per source
  // bundle, so it must not reuse project A's "asset.json".
  await projects.importSourceBundle(localActor, {
    ...base,
    projectId: crossProjectVictimProjectId,
    localeBranchId: crossProjectVictimLocaleBranchId,
    bridge: {
      ...base.bridge,
      bridgeId: "bridge-cross-project-victim",
      sourceBundleHash: "hash-cross-project-victim",
      units: [
        {
          bridgeUnitId: "unit-victim-1",
          sourceUnitKey: "scene.900.line.001",
          occurrenceId: "occ-victim-1",
          sourceHash: "hash-victim-1",
          sourceLocale: "ja-JP",
          sourceText: "秘密",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "asset-victim.json",
            writeMode: "replace",
            sourceUnitKey: "scene.900.line.001",
          },
        },
      ],
    },
  });
}

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
  // Optional override for the provider_run token counts, used to prove the
  // read model single-sources tokens from the LEDGER (not the run). Defaults
  // to counts that match the ledger's 500/200.
  runTokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
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
      promptTokens: input.runTokenUsage?.promptTokens ?? 500,
      completionTokens: input.runTokenUsage?.completionTokens ?? 200,
      totalTokens: input.runTokenUsage?.totalTokens ?? 700,
    },
    cost: {
      costKind: providerCostKindValues.billed,
      currency: "USD",
      amountMicrosUsd: 12_500, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
      cost: 0.0125, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
