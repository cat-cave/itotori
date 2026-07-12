import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriLocalizationJournalRepository,
  type PersistLocalizationJournalAttemptInput,
} from "../src/repositories/localization-journal-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("jobs.run_table journal read model", () => {
  it("renders physical journal attempts with served facts and captured fallback provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const scope = await seedJournalScope(context.db, "runs-a");
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const run = await repository.createRun(localActor, {
        ...scope,
        runId: "journal-runs-a",
      });

      await repository.persistAttempts(localActor, {
        runId: run.runId,
        bridgeUnitId: "unit-runs-a",
        attempts: [
          journalAttempt({
            runId: run.runId,
            bridgeUnitId: "unit-runs-a",
            attemptId: "physical-call-older",
            completedAt: "2026-07-12T10:00:00.000Z",
            fallbackUsed: false,
            fallbackPlan: ["requested-model"],
          }),
          journalAttempt({
            runId: run.runId,
            bridgeUnitId: "unit-runs-a",
            attemptId: "physical-call-served",
            completedAt: "2026-07-12T11:00:00.000Z",
            fallbackUsed: true,
            fallbackPlan: ["requested-model", "served-model"],
          }),
        ],
      });

      const page = await repository.loadJobsRunTable(localActor, {
        projectId: scope.projectId,
        limit: 1,
        generatedAt: new Date("2026-07-12T12:00:00.000Z"),
      });

      expect(page).toMatchObject({
        schemaVersion: "jobs.run_table.v0.2",
        generatedAt: "2026-07-12T12:00:00.000Z",
        filter: { projectId: scope.projectId },
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
      expect(page.rows).toEqual([
        expect.objectContaining({
          runId: "physical-call-served",
          providerRunId: "physical-call-served",
          attemptId: "physical-call-served",
          journalRunId: run.runId,
          bridgeUnitId: "unit-runs-a",
          projectId: scope.projectId,
          localeBranchId: scope.localeBranchId,
          task: "translation:translator",
          status: "accepted",
          servedModel: "served-model",
          servedProvider: "served-provider",
          zdr: true,
          cost: { unit: "usd", amount: "0.01250000" },
          tokens: { in: 500, out: 200, total: 700 },
          fallback: {
            availability: "captured",
            used: true,
            plan: ["requested-model", "served-model"],
            chain: [],
          },
          createdAt: "2026-07-12T11:00:00.000Z",
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("marks pre-0078 fallback facts unavailable instead of fabricating false/[]", async () => {
    const context = await isolatedMigratedContext();
    try {
      const scope = await seedJournalScope(context.db, "runs-legacy");
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const run = await repository.createRun(localActor, {
        ...scope,
        runId: "journal-runs-legacy",
      });
      const attempt = journalAttempt({
        runId: run.runId,
        bridgeUnitId: "unit-runs-legacy",
        attemptId: "physical-call-pre-0078",
        completedAt: "2026-07-12T11:00:00.000Z",
      });
      const {
        requestedModelId: _requestedModelId,
        requestedProviderId: _requestedProviderId,
        costKind: _costKind,
        usageResponseJson: _usageResponseJson,
        tokenCountSource: _tokenCountSource,
        cacheReadTokens: _cacheReadTokens,
        cacheWriteTokens: _cacheWriteTokens,
        cacheDiscountMicrosUsd: _cacheDiscountMicrosUsd,
        fallbackUsed: _fallbackUsed,
        fallbackPlan: _fallbackPlan,
        ...pre0078Attempt
      } = attempt;
      await repository.persistAttempts(localActor, {
        runId: run.runId,
        bridgeUnitId: "unit-runs-legacy",
        attempts: [pre0078Attempt],
      });

      const [row] = (await repository.loadJobsRunTable(localActor, { projectId: scope.projectId }))
        .rows;
      expect(row?.fallback).toEqual({
        availability: "not_captured",
        used: null,
        plan: null,
        chain: [],
      });
    } finally {
      await context.close();
    }
  });

  it("fails closed without scope and never returns another project's journal attempts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const first = await seedJournalScope(context.db, "runs-first");
      const second = await seedJournalScope(context.db, "runs-second");
      const repository = new ItotoriLocalizationJournalRepository(context.db);
      const firstRun = await repository.createRun(localActor, { ...first, runId: "journal-first" });
      const secondRun = await repository.createRun(localActor, {
        ...second,
        runId: "journal-second",
      });
      await repository.persistAttempts(localActor, {
        runId: firstRun.runId,
        bridgeUnitId: "unit-first",
        attempts: [
          journalAttempt({
            runId: firstRun.runId,
            bridgeUnitId: "unit-first",
            attemptId: "physical-call-first",
          }),
        ],
      });
      await repository.persistAttempts(localActor, {
        runId: secondRun.runId,
        bridgeUnitId: "unit-second",
        attempts: [
          journalAttempt({
            runId: secondRun.runId,
            bridgeUnitId: "unit-second",
            attemptId: "physical-call-foreign",
          }),
        ],
      });

      await expect(repository.loadJobsRunTable(localActor, {})).rejects.toThrow(/projectId/i);
      await expect(repository.loadJobsRunTable(localActor, { projectId: "" })).rejects.toThrow(
        /projectId/i,
      );
      expect(
        (await repository.loadJobsRunTable(localActor, { projectId: first.projectId })).rows.map(
          (row) => row.runId,
        ),
      ).toEqual(["physical-call-first"]);
    } finally {
      await context.close();
    }
  });
});

function journalAttempt(input: {
  runId: string;
  bridgeUnitId: string;
  attemptId: string;
  completedAt?: string;
  fallbackUsed?: boolean;
  fallbackPlan?: string[];
}): PersistLocalizationJournalAttemptInput {
  return {
    attemptId: input.attemptId,
    runId: input.runId,
    bridgeUnitId: input.bridgeUnitId,
    stage: "translation",
    agentLabel: "translator",
    logicalCallId: `logical:${input.attemptId}`,
    attemptIndex: 1,
    requestedModelId: "requested-model",
    requestedProviderId: "requested-provider",
    modelId: "served-model",
    providerId: "served-provider",
    providerRunId: input.attemptId,
    costUsd: "0.01250000",
    costKind: "billed",
    usageResponseJson: {
      cost: 0.0125, // itotori-225-audit-allow: synthetic journal fixture cost, not a real billed amount
    },
    tokensIn: 500,
    tokensOut: 200,
    tokenCountSource: "provider_reported",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: input.fallbackUsed ?? false,
    fallbackPlan: input.fallbackPlan ?? ["requested-model"],
    zdr: true,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `provider-run:${input.attemptId}`,
    errorClasses: [],
    startedAt: "2026-07-12T09:59:00.000Z",
    completedAt: input.completedAt ?? "2026-07-12T10:00:00.000Z",
  };
}

async function seedJournalScope(
  db: ItotoriDatabase,
  suffix: string,
): Promise<{
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
}> {
  const projectId = `project-${suffix}`;
  const localeBranchId = `locale-${suffix}`;
  const sourceRevisionId = `revision-${suffix}`;
  const sourceBundleId = `bundle-${suffix}`;
  await db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values (${`workspace-${suffix}`}, ${`Workspace ${suffix}`})
  `);
  await db.execute(sql`
    insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
    values (${projectId}, ${`workspace-${suffix}`}, ${suffix}, ${`Project ${suffix}`}, 'ja-JP', 'imported')
  `);
  await db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${sourceRevisionId}, ${projectId}, 'bridge_revision', 'v1')
  `);
  await db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale, extractor_name,
      extractor_version, unit_count, asset_count
    ) values (
      ${sourceBundleId}, ${projectId}, ${sourceRevisionId}, ${`bridge-${suffix}`},
      '0.2.0', ${`hash-${suffix}`}, 'ja-JP', 'fixture', '1.0.0', 0, 0
    )
  `);
  await db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (${localeBranchId}, ${projectId}, ${sourceBundleId}, 'en-US', 'Journal', 'active')
  `);
  return { projectId, localeBranchId, sourceRevisionId, targetLocale: "en-US" };
}
