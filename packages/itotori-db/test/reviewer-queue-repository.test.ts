// ITOTORI-081 — reviewer queue repository tests.
//
// Each test stands up an isolated migrated schema, seeds the project /
// locale branch / source revision the items reference, and exercises a
// distinct invariant: happy-path transition, atomic transition log,
// permission denial, stale-source rejection, duplicate enqueue,
// invalid-transition refusal, and the runtime-evidence tier-preservation
// guard.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { JobQueueInput } from "../src/repositories/event-queue-repository.js";
import {
  applyActionInTransaction,
  ItotoriReviewerQueueRepository,
  type ReviewerQueueTransaction,
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  ReviewerQueueRepositoryError,
} from "../src/repositories/reviewer-queue-repository.js";
import {
  jobIdempotencyPolicyValues,
  jobQueue,
  jobTaskTypeValues,
  reviewerQueueItems,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

const projectId = "project-reviewer-081";
const localeBranchId = "locale-branch-reviewer-081";
const sourceRevisionId = "source-revision-reviewer-081";
const supersedingSourceRevisionId = "source-revision-reviewer-081-next";

async function seedProjectScope(context: Awaited<ReturnType<typeof isolatedMigratedContext>>) {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-reviewer-081', 'Reviewer Workspace')
    on conflict (workspace_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    )
    values (
      ${projectId}, 'workspace-reviewer-081', 'reviewer-fixture', 'Reviewer Fixture', 'ja-JP', 'imported'
    )
    on conflict (project_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (
      source_revision_id, project_id, revision_kind, value
    )
    values
      (${sourceRevisionId}, ${projectId}, 'bridge_revision', 'reviewer-v1'),
      (${supersedingSourceRevisionId}, ${projectId}, 'bridge_revision', 'reviewer-v2')
    on conflict (source_revision_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    )
    values (
      'source-bundle-reviewer-081', ${projectId}, ${sourceRevisionId}, 'bridge-reviewer-081',
      '0.2.0', 'hash:reviewer-bundle', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )
    on conflict (source_bundle_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    )
    values (
      ${localeBranchId}, ${projectId}, 'source-bundle-reviewer-081', 'en-US', 'English', 'active'
    )
    on conflict (locale_branch_id) do nothing
  `);
}

function baseCreate(kind: keyof typeof reviewerQueueItemKindValues = "qa") {
  return {
    projectId,
    localeBranchId,
    sourceRevisionId,
    itemKind: reviewerQueueItemKindValues[kind],
    sourceItemRef: `qa-finding-${kind}-1`,
    summary: `reviewer queue ${kind} fixture`,
    affectedArtifactIds: [`artifact-${kind}-1`],
  } as const;
}

function rerunJobInput(overrides: Partial<JobQueueInput> = {}): JobQueueInput {
  return {
    jobId: "job-reviewer-084-draft-repair",
    projectId,
    localeBranchId,
    jobType: jobTaskTypeValues.rerun,
    jobName: "rerun.draft-repair",
    queueName: "reviewer-rerun",
    idempotency: {
      policy: jobIdempotencyPolicyValues.idempotent,
      key: "reviewer-084:job:draft-repair",
    },
    correlationId: "reviewer-rerun:reviewer-084",
    subjectRefs: [{ subjectKind: "bridge_unit", subjectId: "qa-finding-qa-1" }],
    payload: { reason: "reviewer_request_repair" },
    ...overrides,
  };
}

describe("ItotoriReviewerQueueRepository", () => {
  it("createItem persists a pending item with the per-kind discriminant", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const qa = await repo.createItem(localActor, baseCreate("qa"));

      expect(qa.reviewItemId).toMatch(/^reviewer-queue-/);
      expect(qa.state).toBe(reviewerQueueItemStateValues.pending);
      expect(qa.itemKind).toBe(reviewerQueueItemKindValues.qa);
      expect(qa.evidenceTier).toBeNull();
      expect(qa.observationEventIds).toBeNull();
      expect(qa.artifactHashes).toBeNull();
      expect(qa.resolvedAt).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("createItem rejects runtime evidence without evidence tier / observation refs", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      await expect(
        repo.createItem(localActor, {
          ...baseCreate("runtimeEvidence"),
          sourceItemRef: "runtime-evidence-1",
        }),
      ).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_runtime_evidence_invariant",
      });
    } finally {
      await context.close();
    }
  });

  it("createItem rejects evidence-tier metadata on non-runtime kinds", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      await expect(
        repo.createItem(localActor, {
          ...baseCreate("qa"),
          // @ts-expect-error — supplying tier on a non-runtime kind is invalid input.
          evidenceTier: "tier-2",
        }),
      ).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_runtime_evidence_invariant",
      });
    } finally {
      await context.close();
    }
  });

  it("createItem persists runtime evidence with tier + observation refs verbatim", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const runtime = await repo.createItem(localActor, {
        ...baseCreate("runtimeEvidence"),
        sourceItemRef: "runtime-evidence-1",
        evidenceTier: "tier-2-screenshot-and-event",
        observationEventIds: ["event-1", "event-2"],
        artifactHashes: ["sha256:abc", "sha256:def"],
      });

      expect(runtime.evidenceTier).toBe("tier-2-screenshot-and-event");
      expect(runtime.observationEventIds).toEqual(["event-1", "event-2"]);
      expect(runtime.artifactHashes).toEqual(["sha256:abc", "sha256:def"]);
    } finally {
      await context.close();
    }
  });

  it("createItem rejects a duplicate (branch + revision + kind + ref)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      await repo.createItem(localActor, baseCreate("qa"));
      await expect(repo.createItem(localActor, baseCreate("qa"))).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_duplicate",
      });
    } finally {
      await context.close();
    }
  });

  it("applyAction approve transitions pending → accepted and logs the transition", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const item = await repo.createItem(localActor, baseCreate("qa"));

      const result = await repo.applyAction(localActor, {
        reviewItemId: item.reviewItemId,
        action: reviewerQueueActionValues.approve,
        actorUserId: localUserId,
        expectedSourceRevisionId: sourceRevisionId,
        affectedArtifactIds: ["artifact-qa-after"],
        diagnostics: [],
        metadata: { reviewerNote: "approved-by-fixture" },
      });

      expect(result.item.state).toBe(reviewerQueueItemStateValues.accepted);
      expect(result.item.resolvedAt).not.toBeNull();
      expect(result.item.affectedArtifactIds).toEqual(["artifact-qa-after"]);

      expect(result.transition.priorState).toBe(reviewerQueueItemStateValues.pending);
      expect(result.transition.nextState).toBe(reviewerQueueItemStateValues.accepted);
      expect(result.transition.actorUserId).toBe(localUserId);
      expect(result.transition.action).toBe(reviewerQueueActionValues.approve);
      expect(result.transition.itemKind).toBe(reviewerQueueItemKindValues.qa);
      expect(result.transition.sourceRevisionId).toBe(sourceRevisionId);
      expect(result.transition.metadata).toMatchObject({ reviewerNote: "approved-by-fixture" });

      const transitions = await repo.loadTransitionsByItem(localActor, item.reviewItemId);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.transitionId).toBe(result.transition.transitionId);
    } finally {
      await context.close();
    }
  });

  it("applyAction defer transitions pending → deferred without resolving the item", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const item = await repo.createItem(localActor, {
        ...baseCreate("qa"),
        sourceItemRef: "qa-finding-defer-1",
      });

      const result = await repo.applyAction(localActor, {
        reviewItemId: item.reviewItemId,
        action: reviewerQueueActionValues.defer,
        actorUserId: localUserId,
        expectedSourceRevisionId: sourceRevisionId,
        diagnostics: [{ code: "reviewer_deferred", message: "waiting for owner review" }],
        metadata: { deferReason: "waiting for owner review" },
      });

      expect(result.item.state).toBe(reviewerQueueItemStateValues.deferred);
      expect(result.item.resolvedAt).toBeNull();
      expect(result.transition.action).toBe(reviewerQueueActionValues.defer);
      expect(result.transition.nextState).toBe(reviewerQueueItemStateValues.deferred);
      expect(result.transition.diagnostics).toEqual([
        { code: "reviewer_deferred", message: "waiting for owner review" },
      ]);
    } finally {
      await context.close();
    }
  });

  it("applyAction rejects stale-source decisions without partial writes", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const item = await repo.createItem(localActor, baseCreate("qa"));

      await expect(
        repo.applyAction(localActor, {
          reviewItemId: item.reviewItemId,
          action: reviewerQueueActionValues.approve,
          actorUserId: localUserId,
          expectedSourceRevisionId: supersedingSourceRevisionId,
        }),
      ).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_stale_revision",
      });

      // Item state must remain pending; no transition was logged.
      const reloaded = await repo.getItem(localActor, item.reviewItemId);
      expect(reloaded?.state).toBe(reviewerQueueItemStateValues.pending);
      const transitions = await repo.loadTransitionsByItem(localActor, item.reviewItemId);
      expect(transitions).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("applyAction rejects stale-lease decisions without partial writes", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const item = await repo.createItem(localActor, {
        ...baseCreate("qa"),
        sourceItemRef: "qa-finding-lease-1",
        metadata: { leaseId: "lease-current" },
      });

      await expect(
        repo.applyAction(localActor, {
          reviewItemId: item.reviewItemId,
          action: reviewerQueueActionValues.approve,
          actorUserId: localUserId,
          expectedSourceRevisionId: sourceRevisionId,
          expectedLeaseId: "lease-stale",
        }),
      ).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_stale_lease",
      });

      const reloaded = await repo.getItem(localActor, item.reviewItemId);
      expect(reloaded?.state).toBe(reviewerQueueItemStateValues.pending);
      const transitions = await repo.loadTransitionsByItem(localActor, item.reviewItemId);
      expect(transitions).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("applyActionAndEnqueueJobs rolls back the reviewer transition when enqueue fails mid-chain", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const item = await repo.createItem(localActor, baseCreate("qa"));

      await expect(
        repo.applyActionAndEnqueueJobs(
          localActor,
          {
            reviewItemId: item.reviewItemId,
            action: reviewerQueueActionValues.requestRepair,
            actorUserId: localUserId,
            expectedSourceRevisionId: sourceRevisionId,
            metadata: { repairHint: "retry with glossary context" },
          },
          () => [
            rerunJobInput(),
            rerunJobInput({
              jobName: "rerun.qa-replay",
              idempotency: {
                policy: jobIdempotencyPolicyValues.idempotent,
                key: "reviewer-084:job:qa-replay",
              },
              dependsOnJobIds: ["job-reviewer-084-draft-repair"],
            }),
          ],
        ),
      ).rejects.toThrow();

      const reloaded = await repo.getItem(localActor, item.reviewItemId);
      expect(reloaded?.state).toBe(reviewerQueueItemStateValues.pending);
      expect(reloaded?.resolvedAt).toBeNull();
      await expect(repo.loadTransitionsByItem(localActor, item.reviewItemId)).resolves.toEqual([]);

      const counts = await context.db.execute(sql`
        select count(*)::int as job_count
        from ${jobQueue}
        where project_id = ${projectId}
      `);
      expect(counts.rows[0]).toMatchObject({ job_count: 0 });
    } finally {
      await context.close();
    }
  });

  it("applyActionsAndEnqueueJobs rolls back all reviewer transitions when a later action is stale", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const first = await repo.createItem(localActor, {
        ...baseCreate("qa"),
        sourceItemRef: "qa-finding-batch-1",
      });
      const second = await repo.createItem(localActor, {
        ...baseCreate("style"),
        sourceItemRef: "style-finding-batch-2",
      });

      await expect(
        repo.applyActionsAndEnqueueJobs(
          localActor,
          [
            {
              reviewItemId: first.reviewItemId,
              action: reviewerQueueActionValues.approve,
              actorUserId: localUserId,
              expectedSourceRevisionId: sourceRevisionId,
            },
            {
              reviewItemId: second.reviewItemId,
              action: reviewerQueueActionValues.approve,
              actorUserId: localUserId,
              expectedSourceRevisionId: supersedingSourceRevisionId,
            },
          ],
          () => [],
        ),
      ).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_stale_revision",
      });

      await expect(repo.getItem(localActor, first.reviewItemId)).resolves.toMatchObject({
        state: reviewerQueueItemStateValues.pending,
        resolvedAt: null,
      });
      await expect(repo.getItem(localActor, second.reviewItemId)).resolves.toMatchObject({
        state: reviewerQueueItemStateValues.pending,
        resolvedAt: null,
      });
      await expect(repo.loadTransitionsByItem(localActor, first.reviewItemId)).resolves.toEqual([]);
      await expect(repo.loadTransitionsByItem(localActor, second.reviewItemId)).resolves.toEqual(
        [],
      );
    } finally {
      await context.close();
    }
  });

  it("applyAction refuses an invalid transition (accepted → repair_requested)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const item = await repo.createItem(localActor, baseCreate("qa"));

      await repo.applyAction(localActor, {
        reviewItemId: item.reviewItemId,
        action: reviewerQueueActionValues.approve,
        actorUserId: localUserId,
        expectedSourceRevisionId: sourceRevisionId,
      });

      await expect(
        repo.applyAction(localActor, {
          reviewItemId: item.reviewItemId,
          action: reviewerQueueActionValues.requestRepair,
          actorUserId: localUserId,
          expectedSourceRevisionId: sourceRevisionId,
        }),
      ).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_invalid_transition",
      });

      const transitions = await repo.loadTransitionsByItem(localActor, item.reviewItemId);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.nextState).toBe(reviewerQueueItemStateValues.accepted);
    } finally {
      await context.close();
    }
  });

  it("applyAction rejects an action whose kind does not match the item kind", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const glossaryItem = await repo.createItem(localActor, {
        ...baseCreate("glossary"),
        sourceItemRef: "glossary-proposal-1",
      });

      await expect(
        repo.applyAction(localActor, {
          reviewItemId: glossaryItem.reviewItemId,
          action: reviewerQueueActionValues.updateStyle,
          actorUserId: localUserId,
          expectedSourceRevisionId: sourceRevisionId,
        }),
      ).rejects.toMatchObject({
        name: "ReviewerQueueRepositoryError",
        code: "reviewer_queue_item_invalid_input",
      });
    } finally {
      await context.close();
    }
  });

  it("applyAction preserves style dispute rejection rationale metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const styleDispute = await repo.createItem(localActor, {
        ...baseCreate("style"),
        sourceItemRef: "feedback-style-dispute-1",
        payload: {
          feedbackReportId: "feedback-style-dispute-1",
          feedbackEvidenceId: "feedback-evidence-style-dispute-1",
          feedbackType: "style_preference",
          triageLabel: "style_dispute_candidate",
          styleDisputeKey: "feedback-style-dispute-1",
        },
        metadata: {
          source: "manual_feedback_import",
          styleDisputeKey: "feedback-style-dispute-1",
        },
      });

      const result = await repo.applyAction(localActor, {
        reviewItemId: styleDispute.reviewItemId,
        action: reviewerQueueActionValues.reject,
        actorUserId: localUserId,
        expectedSourceRevisionId: sourceRevisionId,
        metadata: {
          rejectionReason: "Existing protagonist voice rule already covers this preference.",
          styleDisputeKey: "feedback-style-dispute-1",
        },
      });

      expect(result.item.state).toBe(reviewerQueueItemStateValues.rejected);
      expect(result.transition.metadata).toMatchObject({
        rejectionReason: "Existing protagonist voice rule already covers this preference.",
        styleDisputeKey: "feedback-style-dispute-1",
      });

      const transitions = await repo.loadTransitionsByItem(localActor, styleDispute.reviewItemId);
      expect(transitions[0]?.metadata).toMatchObject({
        rejectionReason: "Existing protagonist voice rule already covers this preference.",
        styleDisputeKey: "feedback-style-dispute-1",
      });
    } finally {
      await context.close();
    }
  });

  it("importRuntimeFeedback preserves evidence tier on the transition log", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const runtime = await repo.createItem(localActor, {
        ...baseCreate("runtimeEvidence"),
        sourceItemRef: "runtime-evidence-import-1",
        evidenceTier: "tier-3-recording",
        observationEventIds: ["event-99"],
        artifactHashes: ["sha256:zzz"],
      });

      const result = await repo.applyAction(localActor, {
        reviewItemId: runtime.reviewItemId,
        action: reviewerQueueActionValues.importRuntimeFeedback,
        actorUserId: localUserId,
        expectedSourceRevisionId: sourceRevisionId,
        metadata: {
          evidenceTier: "tier-3-recording",
          observationEventIds: ["event-99"],
          artifactHashes: ["sha256:zzz"],
        },
      });

      expect(result.item.evidenceTier).toBe("tier-3-recording");
      expect(result.item.observationEventIds).toEqual(["event-99"]);
      expect(result.item.artifactHashes).toEqual(["sha256:zzz"]);
      expect(result.transition.metadata).toMatchObject({
        evidenceTier: "tier-3-recording",
        observationEventIds: ["event-99"],
        artifactHashes: ["sha256:zzz"],
      });
    } finally {
      await context.close();
    }
  });

  it("denies queue.manage actions for an actor missing the permission", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      await expect(repo.createItem(deniedActor, baseCreate("qa"))).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "queue.manage",
      });
      await expect(
        repo.applyAction(deniedActor, {
          reviewItemId: "reviewer-queue-not-real",
          action: reviewerQueueActionValues.approve,
          actorUserId: localUserId,
          expectedSourceRevisionId: sourceRevisionId,
        }),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "queue.manage" });
    } finally {
      await context.close();
    }
  });

  it("denies queue.read for an actor missing the permission", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      await expect(repo.getItem(deniedActor, "reviewer-queue-x")).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "queue.read",
      });
      await expect(repo.loadItemsByBranch(deniedActor, localeBranchId)).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "queue.read",
      });
      await expect(
        repo.loadTransitionsByItem(deniedActor, "reviewer-queue-x"),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "queue.read" });
    } finally {
      await context.close();
    }
  });

  it("loadItemsByBranch filters by state and kind", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProjectScope(context);
      const repo = new ItotoriReviewerQueueRepository(context.db);
      const qa = await repo.createItem(localActor, baseCreate("qa"));
      await repo.createItem(localActor, {
        ...baseCreate("style"),
        sourceItemRef: "style-proposal-1",
      });
      await repo.applyAction(localActor, {
        reviewItemId: qa.reviewItemId,
        action: reviewerQueueActionValues.approve,
        actorUserId: localUserId,
        expectedSourceRevisionId: sourceRevisionId,
      });

      const pending = await repo.loadItemsByBranch(localActor, localeBranchId, {
        stateFilter: reviewerQueueItemStateValues.pending,
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]!.itemKind).toBe(reviewerQueueItemKindValues.style);

      const styleOnly = await repo.loadItemsByBranch(localActor, localeBranchId, {
        kindFilter: reviewerQueueItemKindValues.style,
      });
      expect(styleOnly).toHaveLength(1);
      expect(styleOnly[0]!.itemKind).toBe(reviewerQueueItemKindValues.style);

      const all = await repo.loadItemsByBranch(localActor, localeBranchId);
      expect(all).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("ReviewerQueueRepositoryError is preserved across throw boundaries", () => {
    const error = new ReviewerQueueRepositoryError(
      "reviewer_queue_item_invalid_transition",
      "test",
    );
    expect(error.name).toBe("ReviewerQueueRepositoryError");
    expect(error.code).toBe("reviewer_queue_item_invalid_transition");
  });
});

// Optimistic-lock collision split. The 0-row UPDATE race is not
// reproducible through a single-snapshot live transaction, so these
// drive `applyActionInTransaction` with a stub transaction: the stub
// lets the transition validate against the freshly-read row, then forces
// the state-guarded UPDATE to match zero rows so we can assert how the
// re-read disambiguates a concurrent move from a deleted row. No DB
// required, so these run regardless of DATABASE_URL.
type ReviewerQueueItemRow = typeof reviewerQueueItems.$inferSelect;

function fakeItemRow(overrides: Partial<ReviewerQueueItemRow> = {}): ReviewerQueueItemRow {
  return {
    reviewItemId: "reviewer-queue-collision-1",
    projectId,
    localeBranchId,
    sourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    sourceItemRef: "qa-finding-collision-1",
    state: reviewerQueueItemStateValues.pending,
    priority: 0,
    summary: "collision fixture",
    affectedArtifactIds: ["artifact-collision-1"],
    evidenceTier: null,
    observationEventIds: null,
    artifactHashes: null,
    payload: {},
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: new Date("2026-06-28T00:00:00.000Z"),
    updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    resolvedAt: null,
    ...overrides,
  };
}

/**
 * Stub transaction returning queued SELECT results in order and a fixed
 * UPDATE result. `insert` throws — the paths under test never reach the
 * transition-log write.
 */
function stubTransaction(opts: {
  selectResults: ReviewerQueueItemRow[][];
  updateResult: ReviewerQueueItemRow[];
}): ReviewerQueueTransaction {
  let selectCall = 0;
  const selectBuilder = () => {
    const result = opts.selectResults[selectCall++] ?? [];
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: async () => result,
    };
    return builder;
  };
  const updateBuilder = () => {
    const builder = {
      set: () => builder,
      where: () => builder,
      returning: async () => opts.updateResult,
    };
    return builder;
  };
  return {
    select: selectBuilder,
    update: updateBuilder,
    insert: () => {
      throw new Error("stub transaction insert should not be reached");
    },
  } as unknown as ReviewerQueueTransaction;
}

const collisionActionInput = {
  reviewItemId: "reviewer-queue-collision-1",
  action: reviewerQueueActionValues.approve,
  actorUserId: localUserId,
  expectedSourceRevisionId: sourceRevisionId,
} as const;

describe("applyActionInTransaction optimistic-lock collision split", () => {
  it("maps a 0-row UPDATE on a still-present row to reviewer_queue_item_concurrent_modification", async () => {
    const tx = stubTransaction({
      // 1st select: the action's own re-read (valid pending item).
      // 2nd select: the post-0-row re-read confirming the row survives.
      selectResults: [
        [fakeItemRow()],
        [fakeItemRow({ state: reviewerQueueItemStateValues.accepted })],
      ],
      updateResult: [],
    });

    await expect(applyActionInTransaction(tx, collisionActionInput)).rejects.toMatchObject({
      name: "ReviewerQueueRepositoryError",
      code: "reviewer_queue_item_concurrent_modification",
    });
  });

  it("maps a 0-row UPDATE on a vanished row to reviewer_queue_item_not_found", async () => {
    const tx = stubTransaction({
      // 1st select reads the item; the post-0-row re-read finds nothing,
      // so the row was deleted rather than concurrently moved.
      selectResults: [[fakeItemRow()], []],
      updateResult: [],
    });

    await expect(applyActionInTransaction(tx, collisionActionInput)).rejects.toMatchObject({
      name: "ReviewerQueueRepositoryError",
      code: "reviewer_queue_item_not_found",
    });
  });

  it("still maps a genuinely illegal transition to reviewer_queue_item_invalid_transition", async () => {
    // Item already accepted; approve → accepted is not an allowed edge, so
    // the validator refuses before any UPDATE (the stub UPDATE/insert are
    // never reached). This guards that the new concurrency code did not
    // swallow the permanent-refusal path.
    const tx = stubTransaction({
      selectResults: [[fakeItemRow({ state: reviewerQueueItemStateValues.accepted })]],
      updateResult: [fakeItemRow()],
    });

    await expect(applyActionInTransaction(tx, collisionActionInput)).rejects.toMatchObject({
      name: "ReviewerQueueRepositoryError",
      code: "reviewer_queue_item_invalid_transition",
    });
  });
});
