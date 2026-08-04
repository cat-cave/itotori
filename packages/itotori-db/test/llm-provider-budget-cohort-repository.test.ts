import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  LlmMemoCipher,
  LlmStepExecution,
} from "../src/repositories/llm-call-memo-repository.js";
import { ItotoriLlmHttpAttemptRepository } from "../src/repositories/llm-http-attempt-repository.js";
import {
  ItotoriLlmProviderBudgetCohortRepository,
  LlmProviderBudgetCohortBusyError,
  LlmProviderBudgetCohortDefinitionMismatchError,
  LlmProviderBudgetCohortMemberUnavailableError,
} from "../src/repositories/llm-provider-budget-cohort-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

describe("ItotoriLlmProviderBudgetCohortRepository", () => {
  it("atomically declares a canonical three-member cohort and reclaims unused capacity fairly", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
      const cohort = threeMemberCohort("profile-a", "cohort-a");
      const activations = await Promise.all([
        repository.activate(cohort),
        repository.activate({ ...cohort, members: [...cohort.members].reverse() }),
        repository.activate(cohort),
      ]);
      expect(activations).toEqual(
        [cohort, cohort, cohort].map((activation) => ({
          profileScope: activation.profileScope,
          cohortId: activation.cohortId,
          profileCostCapUsd: activation.profileCostCapUsd,
          memberCount: 3,
          runCostCapUsd: "0.000002",
        })),
      );
      await expect(activeShares(repository, cohort)).resolves.toEqual([
        "0.000002",
        "0.000002",
        "0.000002",
      ]);
      await expect(
        repository.activate({ ...cohort, members: cohort.members.slice(0, 2) }),
      ).rejects.toBeInstanceOf(LlmProviderBudgetCohortDefinitionMismatchError);
      await expect(
        repository.activate({
          ...cohort,
          members: [
            cohort.members[0]!,
            cohort.members[1]!,
            { projectId: "project-c", runId: "run-c", runScope: "other-run-c" },
          ],
        }),
      ).rejects.toBeInstanceOf(LlmProviderBudgetCohortDefinitionMismatchError);
      await expect(
        repository.activate({ ...cohort, profileCostCapUsd: "0.000008" }),
      ).rejects.toBeInstanceOf(LlmProviderBudgetCohortDefinitionMismatchError);
      await expect(
        repository.activate({
          profileScope: cohort.profileScope,
          profileCostCapUsd: cohort.profileCostCapUsd,
          cohortId: "cohort-b",
          members: [{ projectId: "project-d", runId: "run-d", runScope: "run-d" }],
        }),
      ).rejects.toBeInstanceOf(LlmProviderBudgetCohortBusyError);

      await expect(repository.release(memberRelease(cohort, 1))).resolves.toEqual({
        memberReleased: true,
        cohortReleased: false,
      });
      await expect(activeShares(repository, cohort, [0, 2])).resolves.toEqual([
        "0.000003",
        "0.000003",
      ]);
      await repository.release(memberRelease(cohort, 2));
      await expect(activeShares(repository, cohort, [0])).resolves.toEqual(["0.000006"]);
      await expect(repository.release(memberRelease(cohort, 0))).resolves.toEqual({
        memberReleased: true,
        cohortReleased: true,
      });
      await expect(
        repository.activeMember({
          profileScope: cohort.profileScope,
          cohortId: cohort.cohortId,
          runScope: cohort.members[0]!.runScope,
        }),
      ).rejects.toBeInstanceOf(LlmProviderBudgetCohortMemberUnavailableError);
      await expect(repository.activate(cohort)).rejects.toBeInstanceOf(
        LlmProviderBudgetCohortMemberUnavailableError,
      );
      const header = await context.pool.query<{ member_count: number; cohort_state: string }>(
        `
          select member_count, cohort_state
          from itotori_llm_provider_budget_cohorts
          where profile_scope = $1 and cohort_id = $2
        `,
        [cohort.profileScope, cohort.cohortId],
      );
      expect(header.rows).toEqual([{ member_count: 0, cohort_state: "released" }]);
    } finally {
      await context.close();
    }
  });

  it("never establishes or joins a cohort from transaction-time verification", async () => {
    const context = await isolatedMigratedContext();
    const client = await context.pool.connect();
    try {
      const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
      const cohort = threeMemberCohort("profile-verify", "cohort-verify");
      await client.query("begin");
      await expect(repository.activateInTransaction(client, cohort)).rejects.toBeInstanceOf(
        LlmProviderBudgetCohortMemberUnavailableError,
      );
      const missing = await client.query<{ cohort_count: number }>(
        `
          select count(*)::integer as cohort_count
          from itotori_llm_provider_budget_cohorts
          where profile_scope = $1
        `,
        [cohort.profileScope],
      );
      expect(missing.rows).toEqual([{ cohort_count: 0 }]);
      await client.query("rollback");

      await repository.activate(cohort);
      await client.query("begin");
      await expect(
        repository.activateInTransaction(client, {
          ...cohort,
          members: cohort.members.slice(0, 2),
        }),
      ).rejects.toBeInstanceOf(LlmProviderBudgetCohortDefinitionMismatchError);
      await expect(repository.activateInTransaction(client, cohort)).resolves.toMatchObject({
        memberCount: 3,
        runCostCapUsd: "0.000002",
      });
      await client.query("commit");
    } finally {
      client.release();
      await context.close();
    }
  });

  it("does not reallocate a released member's confirmed profile spend to survivors", async () => {
    const context = await isolatedMigratedContext();
    const client = await context.pool.connect();
    try {
      const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
      const attempts = new ItotoriLlmHttpAttemptRepository(context.pool, testCipher());
      const cohort = threeMemberCohort("profile-consumed", "cohort-consumed");
      await repository.activate(cohort);
      const spent = directAttempt(cohort, "memo-consumed", 0, "0.000002");
      const startedAt = new Date().toISOString();
      await attempts.admitAndStart(client, spent, { ordinal: 1, startedAt });
      await attempts.finish(client, spent, {
        ordinal: 1,
        execution: confirmedExecution("0.000002"),
      });

      await repository.release(memberRelease(cohort, 0));
      await expect(activeShares(repository, cohort, [1, 2])).resolves.toEqual([
        "0.000002",
        "0.000002",
      ]);
    } finally {
      client.release();
      await context.close();
    }
  });

  it("preserves equal future allowance when a survivor already has confirmed spend", async () => {
    const context = await isolatedMigratedContext();
    const client = await context.pool.connect();
    try {
      const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
      const attempts = new ItotoriLlmHttpAttemptRepository(context.pool, testCipher());
      const cohort = threeMemberCohort("profile-survivor-spend", "cohort-survivor-spend");
      await repository.activate(cohort);
      const spentA = directAttempt(cohort, "memo-spent-a", 0, "0.000002");
      const spentB = directAttempt(cohort, "memo-spent-b", 1, "0.000001");
      await attempts.admitAndStart(client, spentA, {
        ordinal: 1,
        startedAt: new Date().toISOString(),
      });
      await attempts.finish(client, spentA, {
        ordinal: 1,
        execution: confirmedExecution("0.000002"),
      });
      await attempts.admitAndStart(client, spentB, {
        ordinal: 1,
        startedAt: new Date().toISOString(),
      });
      await attempts.finish(client, spentB, {
        ordinal: 1,
        execution: confirmedExecution("0.000001"),
      });

      await repository.release(memberRelease(cohort, 0));
      await expect(activeShares(repository, cohort, [1, 2])).resolves.toEqual([
        "0.000002",
        "0.000001",
      ]);
    } finally {
      client.release();
      await context.close();
    }
  });

  it("accounts for a released member's unresolved in-flight exposure", async () => {
    const context = await isolatedMigratedContext();
    const client = await context.pool.connect();
    try {
      const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
      const attempts = new ItotoriLlmHttpAttemptRepository(context.pool, testCipher());
      const cohort = threeMemberCohort("profile-in-flight", "cohort-in-flight");
      await repository.activate(cohort);
      const inFlight = directAttempt(cohort, "memo-in-flight", 0, "0.000002");
      await attempts.admitAndStart(client, inFlight, {
        ordinal: 1,
        startedAt: new Date().toISOString(),
      });

      await repository.release(memberRelease(cohort, 0));
      await expect(activeShares(repository, cohort, [1, 2])).resolves.toEqual([
        "0.000002",
        "0.000002",
      ]);
    } finally {
      client.release();
      await context.close();
    }
  });

  it("requires lifecycle preactivation before a direct physical-attempt admission", async () => {
    const context = await isolatedMigratedContext();
    const client = await context.pool.connect();
    try {
      const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
      const cohort = {
        profileScope: "profile-direct",
        profileCostCapUsd: "0.000006",
        cohortId: "cohort-direct",
        members: [{ projectId: "project-a", runId: "run-a", runScope: "run-a" }],
      };
      const attempts = new ItotoriLlmHttpAttemptRepository(context.pool, testCipher());
      await expect(
        attempts.admitAndStart(client, directAttempt(cohort, "memo-before-preactivation"), {
          ordinal: 1,
          startedAt: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({
        diagnostic: { reason: "profile-cohort-busy", scope: cohort.profileScope },
      });
      const missing = await context.pool.query<{ cohort_count: number }>(
        `
          select count(*)::integer as cohort_count
          from itotori_llm_provider_budget_cohorts
          where profile_scope = $1
        `,
        [cohort.profileScope],
      );
      expect(missing.rows).toEqual([{ cohort_count: 0 }]);

      await repository.activate(cohort);
      await attempts.admitAndStart(client, directAttempt(cohort, "memo-after-preactivation"), {
        ordinal: 1,
        startedAt: new Date().toISOString(),
      });
      await expect(
        repository.activeMember({
          profileScope: cohort.profileScope,
          cohortId: cohort.cohortId,
          runScope: cohort.members[0]!.runScope,
        }),
      ).resolves.toMatchObject({ runCostCapUsd: "0.000006" });
      await repository.release(memberRelease(cohort, 0));
      await expect(
        attempts.admitAndStart(client, directAttempt(cohort, "memo-after-release"), {
          ordinal: 1,
          startedAt: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({
        diagnostic: { reason: "profile-cohort-busy", scope: cohort.profileScope },
      });
      await expect(
        repository.activate({ ...cohort, profileCostCapUsd: "0.000007" }),
      ).rejects.toBeInstanceOf(LlmProviderBudgetCohortDefinitionMismatchError);
      await client.query("begin");
      await expect(repository.activateInTransaction(client, cohort)).rejects.toBeInstanceOf(
        LlmProviderBudgetCohortMemberUnavailableError,
      );
      await client.query("rollback");
      await expect(repository.activate(cohort)).resolves.toEqual({
        profileScope: cohort.profileScope,
        cohortId: cohort.cohortId,
        profileCostCapUsd: cohort.profileCostCapUsd,
        memberCount: 1,
        runCostCapUsd: "0.000006",
      });
      await attempts.admitAndStart(client, directAttempt(cohort, "memo-after-reactivation"), {
        ordinal: 1,
        startedAt: new Date().toISOString(),
      });
    } finally {
      client.release();
      await context.close();
    }
  });

  it("keeps opaque project and run IDs outside the bounded hashed run scope", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
      const opaqueId = "x".repeat(1_000);
      await expect(
        repository.activate({
          profileScope: "profile-long-id",
          profileCostCapUsd: "0.000001",
          cohortId: "cohort-long-id",
          members: [{ projectId: opaqueId, runId: opaqueId, runScope: "run-long-id" }],
        }),
      ).resolves.toMatchObject({ runCostCapUsd: "0.000001" });
    } finally {
      await context.close();
    }
  });
});

function threeMemberCohort(profileScope: string, cohortId: string) {
  return {
    profileScope,
    profileCostCapUsd: "0.000006",
    cohortId,
    members: [
      { projectId: "project-a", runId: "run-a", runScope: "run-a" },
      { projectId: "project-b", runId: "run-b", runScope: "run-b" },
      { projectId: "project-c", runId: "run-c", runScope: "run-c" },
    ],
  };
}

function memberRelease(cohort: ReturnType<typeof threeMemberCohort>, index: number) {
  const member = cohort.members[index]!;
  return {
    profileScope: cohort.profileScope,
    cohortId: cohort.cohortId,
    projectId: member.projectId,
    runId: member.runId,
  };
}

async function activeShares(
  repository: ItotoriLlmProviderBudgetCohortRepository,
  cohort: ReturnType<typeof threeMemberCohort>,
  indices = [0, 1, 2],
): Promise<string[]> {
  return await Promise.all(
    indices.map(async (index) => {
      const member = cohort.members[index]!;
      return (
        await repository.activeMember({
          profileScope: cohort.profileScope,
          cohortId: cohort.cohortId,
          runScope: member.runScope,
        })
      ).runCostCapUsd;
    }),
  );
}

function directAttempt(
  cohort: ReturnType<typeof threeMemberCohort>,
  memo: string,
  memberIndex = 0,
  maxAttemptExposureUsd = "0.000001",
) {
  const member = cohort.members[memberIndex]!;
  return {
    memoKey: hash(memo),
    semanticHash: hash(`semantic-${memo}`),
    schemaVersion: "test",
    requestJson: "{}",
    admission: {
      scope: cohort.profileScope,
      confirmedCostCapUsd: cohort.profileCostCapUsd,
      runScope: member.runScope,
      cohortId: cohort.cohortId,
      cohort,
      maxAttemptExposureUsd,
      deadlineMs: 1_000,
    },
    execute: async () => {
      throw new Error("direct admission test never executes a provider request");
    },
  };
}

function confirmedExecution(costUsd: string): Extract<LlmStepExecution, { kind: "completed" }> {
  return {
    kind: "completed",
    responseJson: "{}",
    outcomeJson: "{}",
    outcomeKind: "terminal",
    generationId: null,
    requestedModel: "test-model",
    providerPolicy: {},
    served: { status: "unknown" },
    routerAttempts: [],
    usage: null,
    billing: { status: "confirmed", costUsd },
    reportedCostUsd: costUsd,
    completedAt: new Date().toISOString(),
    responseEvent: {
      eventId: "event-test",
      schemaVersion: "test",
      parentEventIds: [],
      snapshotKind: "localization",
      snapshotId: "snapshot-test",
      actorRole: "test",
      bodyJson: "{}",
    },
  };
}

function testCipher(): LlmMemoCipher {
  return {
    seal: async (plaintext) => ({ ciphertext: Buffer.from(plaintext), keyRef: "test-key" }),
    open: async (ciphertext) => Buffer.from(ciphertext).toString(),
    releaseKeyReference: async () => undefined,
  };
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
