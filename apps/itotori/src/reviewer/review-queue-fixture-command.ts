import {
  AuthorizationError,
  ItotoriReviewerQueueRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  localUserId,
  migrate,
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  type AuthorizationActor,
  type CreateReviewerQueueItemInput,
  type DatabaseContext,
  type ItotoriReviewerQueueRepositoryPort,
  type JobQueueRecord,
  type ReviewerQueueAction,
  type ReviewerQueueActionResult,
  type ReviewerQueueDiagnostic,
  type ReviewerQueueItemRecord,
} from "@itotori/db";
import {
  ReviewerQueueActionService,
  ReviewerQueueActionServiceInputError,
} from "./action-service.js";
import {
  ReviewerBatchActionService,
  type BatchActionPayload,
  type BatchActionPayloadResolver,
} from "./batch-execute.js";
import {
  ReviewerBatchPreviewService,
  type ReviewerBatchConsequenceResolverPort,
} from "./batch-preview.js";
import { fixtureBatchPermissionView, fixtureDecisionContextRefs } from "./batch-fixtures.js";
import { reviewQueueDashboardFixtures } from "./review-queue-dashboard-fixtures.js";

export const reviewQueueFixtureSchemaVersion = "itotori.review_queue_fixture.v1" as const;

export type ReviewQueueFixtureCommandOptions = {
  databaseUrl?: string;
  outputPath?: string;
  writeJson(path: string, value: unknown): void;
  log?(message: string): void;
};

type ArtifactDecision = {
  decisionId: string;
  findingId: string;
  sourceItemRef: string;
  itemKind: string;
  state: string;
  contextRefs: ReturnType<typeof fixtureDecisionContextRefs>;
};

type ArtifactTransition = {
  transitionId: string;
  decisionId: string;
  action: ReviewerQueueAction;
  priorState: string;
  nextState: string;
  diagnostics: ReviewerQueueDiagnostic[];
};

type ArtifactRerunRecord =
  | {
      decisionId: string;
      transitionId: string;
      rerunRequestIds: string[];
      jobIds: string[];
      persistedJobNames: string[];
      reason: "targeted_rerun_enqueued";
    }
  | {
      decisionId: string;
      transitionId: string;
      action: ReviewerQueueAction;
      reason: "no_rerun_reason_codes_for_action";
    };

type NegativeMutationRecord = {
  attemptId: string;
  expectedFailure:
    | "stale_source_revision"
    | "stale_lease"
    | "missing_permission"
    | "missing_context";
  mutated: boolean;
  diagnostics: ReviewerQueueDiagnostic[];
};

export type ReviewQueueFixtureBundle = {
  schemaVersion: typeof reviewQueueFixtureSchemaVersion;
  generatedAt: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  decisions: ArtifactDecision[];
  transitions: ArtifactTransition[];
  batchActions: Array<{
    batchActionId: string;
    action: ReviewerQueueAction;
    decisionIds: string[];
    appliedAll: boolean;
    transitionIds: string[];
  }>;
  reruns: ArtifactRerunRecord[];
  negativeMutations: NegativeMutationRecord[];
  diagnostics: ReviewerQueueDiagnostic[];
  dashboardFixtures: ReturnType<typeof reviewQueueDashboardFixtures>;
};

const actor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-itotori-023-denied" };
const projectId = "project-itotori-023";
const workspaceId = "workspace-itotori-023";
const localeBranchId = "locale-branch-itotori-023";
const sourceRevisionId = "source-revision-itotori-023";
const supersedingSourceRevisionId = "source-revision-itotori-023-next";
const sourceBundleId = "source-bundle-itotori-023";
const fixtureCreatedAt = new Date("2026-06-26T00:00:00Z");
const defaultDatabaseUrl = "postgres://itotori:itotori@127.0.0.1:55433/itotori";
const defaultOutputPath = "artifacts/itotori/review-queue-fixture.json";

export async function runReviewQueueFixtureCommand(
  options: ReviewQueueFixtureCommandOptions,
): Promise<ReviewQueueFixtureBundle> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? defaultDatabaseUrl;
  await migrate(databaseUrl);
  const context = createDatabaseContext(databaseUrl);
  try {
    await bootstrapLocalUser(context.db);
    await resetAndSeedProjectScope(context.pool);

    const repository = new ItotoriReviewerQueueRepository(context.db);
    const capturedJobs = new Map<string, JobQueueRecord[]>();
    const actionService = new ReviewerQueueActionService(
      captureEnqueuedJobsRepository(repository, capturedJobs),
    );
    const idByPersistedItemId = new Map<string, string>();
    const allResults: ReviewerQueueActionResult[] = [];

    const pending = await createDecision(repository, idByPersistedItemId, "pending", "qa");
    const approved = await createDecision(repository, idByPersistedItemId, "resolved", "qa");
    const deferred = await createDecision(repository, idByPersistedItemId, "deferred", "style");
    const escalated = await createDecision(
      repository,
      idByPersistedItemId,
      "escalated",
      "glossary",
    );
    const repair = await createDecision(
      repository,
      idByPersistedItemId,
      "repair-rerun",
      "runtimeEvidence",
    );

    allResults.push(
      await actionService.approve(actor, actionInput(approved)),
      await actionService.defer(actor, {
        ...actionInput(deferred),
        deferReason: "wait for bilingual owner review",
      }),
      await actionService.escalate(actor, {
        ...actionInput(escalated),
        escalationReason: "ambiguous glossary ownership",
        escalationTarget: "senior-reviewer",
      }),
      await actionService.requestRepair(actor, {
        ...actionInput(repair),
        repairHint: "rerun targeted draft with runtime trace context",
      }),
    );

    const batchResults = await runBatchScenarios(repository, actionService, idByPersistedItemId);
    allResults.push(...batchResults.flatMap((batch) => batch.rawResults));

    const negativeMutations = await runNegativeAttempts(actionService, approved, pending);
    const bundle = buildArtifactBundle({
      decisions: [
        pending,
        approved,
        deferred,
        escalated,
        repair,
        ...batchResults.flatMap((batch) => batch.items),
      ],
      results: allResults,
      batchResults,
      negativeMutations,
      idByPersistedItemId,
      capturedJobs,
    });
    options.writeJson(options.outputPath ?? defaultOutputPath, bundle);
    options.log?.(`wrote ${options.outputPath ?? defaultOutputPath}`);
    return bundle;
  } finally {
    await context.close();
  }
}

async function createDecision(
  repository: ItotoriReviewerQueueRepository,
  ids: Map<string, string>,
  suffix: string,
  kind: keyof typeof reviewerQueueItemKindValues,
): Promise<ReviewerQueueItemRecord> {
  const decisionId = `decision-itotori-023-${suffix}`;
  const findingId = `finding-itotori-023-${suffix}`;
  const contextRefs = decisionContextRefs(decisionId);
  const input: CreateReviewerQueueItemInput = {
    projectId,
    localeBranchId,
    sourceRevisionId,
    itemKind: reviewerQueueItemKindValues[kind],
    sourceItemRef: decisionId,
    summary: `ITOTORI-023 ${suffix} reviewer decision`,
    affectedArtifactIds: [`artifact-itotori-023-${suffix}`],
    priority: suffix === "pending" ? 5 : 10,
    metadata: {
      decisionId,
      findingId,
      contextRefs,
      leaseId: `lease-itotori-023-${suffix}`,
      policyVersions: {
        styleGuideVersionId: contextRefs.style.styleGuidePolicyVersionId,
        glossaryVersionId: "glossary-version-itotori-023",
        pairPolicyVersionId: "pair-policy-itotori-023",
        qaPolicyVersionId: "qa-policy-itotori-023",
        exportPolicyVersionId: "export-policy-itotori-023",
        runtimeValidationPolicyVersionId: "runtime-policy-itotori-023",
      },
      affectedUnitIds: [contextRefs.source.bridgeUnitId],
    },
    payload: {
      findingId,
      contextRefs,
    },
    createdAt: fixtureCreatedAt,
  };
  if (kind === "runtimeEvidence") {
    input.evidenceTier = "tier-2-trace";
    input.observationEventIds = contextRefs.runtime.observationEventIds;
    input.artifactHashes = contextRefs.runtime.artifactHashes;
  }
  const item = await repository.createItem(actor, input);
  ids.set(item.reviewItemId, decisionId);
  return item;
}

function decisionContextRefs(decisionId: string): ReturnType<typeof fixtureDecisionContextRefs> {
  const contextRefs = fixtureDecisionContextRefs(decisionId);
  return {
    ...contextRefs,
    source: {
      ...contextRefs.source,
      sourceRevisionId,
    },
  };
}

function actionInput(item: ReviewerQueueItemRecord) {
  const contextRefs = contextRefsOf(item);
  return {
    reviewItemId: item.reviewItemId,
    actorUserId: actor.userId,
    expectedSourceRevisionId: item.sourceRevisionId,
    expectedLeaseId: leaseIdOf(item),
    contextRefs,
    diagnostics: [
      {
        code: "itotori_023_context_refs_present",
        message: "source, draft, runtime, style, glossary, and QA refs verified before mutation",
      },
    ],
    metadata: {
      decisionId: decisionIdOf(item),
      findingId: findingIdOf(item),
      leaseId: leaseIdOf(item),
    },
  };
}

async function runBatchScenarios(
  repository: ItotoriReviewerQueueRepository,
  actionService: ReviewerQueueActionService,
  ids: Map<string, string>,
) {
  const scenarios = [
    { action: reviewerQueueActionValues.approve, suffix: "batch-accept" },
    { action: reviewerQueueActionValues.reject, suffix: "batch-reject" },
    { action: reviewerQueueActionValues.defer, suffix: "batch-defer" },
    { action: reviewerQueueActionValues.escalate, suffix: "batch-escalate" },
  ] as const;
  const out: Array<{
    batchActionId: string;
    action: ReviewerQueueAction;
    items: ReviewerQueueItemRecord[];
    rawResults: ReviewerQueueActionResult[];
    appliedAll: boolean;
  }> = [];
  for (const scenario of scenarios) {
    const item = await createDecision(repository, ids, scenario.suffix, "qa");
    const previewService = new ReviewerBatchPreviewService(batchResolver(repository));
    const executor = new ReviewerBatchActionService({
      previewService,
      actionService,
      resolvePayload: payloadForAction(scenario.action),
    });
    const result = await executor.execute(
      actor,
      {
        action: scenario.action,
        actorUserId: actor.userId,
        selections: [
          { reviewItemId: item.reviewItemId, expectedSourceRevisionId: item.sourceRevisionId },
        ],
      },
      fixtureBatchPermissionView(),
    );
    out.push({
      batchActionId: `batch-action-itotori-023-${scenario.suffix}`,
      action: scenario.action,
      items: [item],
      rawResults: result.applied.flatMap((entry) =>
        entry.kind === "applied" ? [entry.result] : [],
      ),
      appliedAll: result.appliedAll,
    });
  }
  return out;
}

function batchResolver(
  repository: ItotoriReviewerQueueRepository,
): ReviewerBatchConsequenceResolverPort {
  return {
    loadItem: (reviewItemId) => repository.getItem(actor, reviewItemId),
    resolveConsequences: async (input) => [
      {
        kind: "draft_state_change",
        draftId: contextRefsOf(input.item).draft.draftId,
        nextDraftStatus: input.nextState,
      },
    ],
  };
}

function payloadForAction(action: ReviewerQueueAction): BatchActionPayloadResolver {
  return (item): BatchActionPayload => {
    switch (action) {
      case reviewerQueueActionValues.approve:
        return { kind: "approve", metadata: { batch: true, decisionId: decisionIdOf(item) } };
      case reviewerQueueActionValues.reject:
        return { kind: "reject", metadata: { batch: true, decisionId: decisionIdOf(item) } };
      case reviewerQueueActionValues.defer:
        return {
          kind: "defer",
          deferReason: "batch deferred for owner review",
          metadata: { batch: true, decisionId: decisionIdOf(item) },
        };
      case reviewerQueueActionValues.escalate:
        return {
          kind: "escalate",
          escalationReason: "batch escalated for senior reviewer",
          escalationTarget: "senior-reviewer",
          metadata: { batch: true, decisionId: decisionIdOf(item) },
        };
      default:
        throw new Error(`batch scenario does not support ${action}`);
    }
  };
}

async function runNegativeAttempts(
  actionService: ReviewerQueueActionService,
  approved: ReviewerQueueItemRecord,
  pending: ReviewerQueueItemRecord,
): Promise<NegativeMutationRecord[]> {
  const attempts: NegativeMutationRecord[] = [];
  attempts.push(
    await captureNegative("negative-itotori-023-stale-source", "stale_source_revision", () =>
      actionService.approve(actor, {
        ...actionInput(pending),
        expectedSourceRevisionId: supersedingSourceRevisionId,
      }),
    ),
  );
  attempts.push(
    await captureNegative("negative-itotori-023-stale-lease", "stale_lease", () =>
      actionService.approve(actor, {
        ...actionInput(pending),
        expectedLeaseId: "lease-itotori-023-stale",
      }),
    ),
  );
  attempts.push(
    await captureNegative("negative-itotori-023-missing-permission", "missing_permission", () =>
      actionService.approve(deniedActor, {
        ...actionInput(approved),
        actorUserId: deniedActor.userId,
      }),
    ),
  );
  attempts.push(
    await captureNegative("negative-itotori-023-missing-context", "missing_context", () =>
      actionService.approve(actor, {
        reviewItemId: pending.reviewItemId,
        actorUserId: actor.userId,
        expectedSourceRevisionId: pending.sourceRevisionId,
      }),
    ),
  );
  return attempts;
}

async function captureNegative(
  attemptId: string,
  expectedFailure: NegativeMutationRecord["expectedFailure"],
  fn: () => Promise<unknown>,
): Promise<NegativeMutationRecord> {
  try {
    await fn();
  } catch (error) {
    return {
      attemptId,
      expectedFailure,
      mutated: false,
      diagnostics: diagnosticsForError(error),
    };
  }
  return {
    attemptId,
    expectedFailure,
    mutated: true,
    diagnostics: [
      {
        code: "itotori_023_negative_attempt_unexpected_success",
        message: `${attemptId} unexpectedly succeeded`,
      },
    ],
  };
}

function buildArtifactBundle(input: {
  decisions: ReviewerQueueItemRecord[];
  results: ReviewerQueueActionResult[];
  batchResults: Array<{
    batchActionId: string;
    action: ReviewerQueueAction;
    items: ReviewerQueueItemRecord[];
    rawResults: ReviewerQueueActionResult[];
    appliedAll: boolean;
  }>;
  negativeMutations: NegativeMutationRecord[];
  idByPersistedItemId: Map<string, string>;
  capturedJobs: Map<string, JobQueueRecord[]>;
}): ReviewQueueFixtureBundle {
  const transitionIds = new Map<string, string>();
  const transitions = input.results.map((result, index) => {
    const decisionId =
      input.idByPersistedItemId.get(result.item.reviewItemId) ?? decisionIdOf(result.item);
    const transitionId = `transition-itotori-023-${String(index + 1).padStart(2, "0")}`;
    transitionIds.set(result.transition.transitionId, transitionId);
    return {
      transitionId,
      decisionId,
      action: result.transition.action,
      priorState: result.transition.priorState,
      nextState: result.transition.nextState,
      diagnostics: result.transition.diagnostics,
    };
  });
  return {
    schemaVersion: reviewQueueFixtureSchemaVersion,
    generatedAt: "2026-06-26T00:00:00.000Z",
    projectId,
    localeBranchId,
    sourceRevisionId,
    decisions: input.decisions.map((item) => ({
      decisionId: input.idByPersistedItemId.get(item.reviewItemId) ?? decisionIdOf(item),
      findingId: findingIdOf(item),
      sourceItemRef: item.sourceItemRef,
      itemKind: item.itemKind,
      state: terminalStateFor(input.results, item),
      contextRefs: contextRefsOf(item),
    })),
    transitions,
    batchActions: input.batchResults.map((batch) => ({
      batchActionId: batch.batchActionId,
      action: batch.action,
      decisionIds: batch.items.map((item) => decisionIdOf(item)),
      appliedAll: batch.appliedAll,
      transitionIds: batch.rawResults.map(
        (result) =>
          transitionIds.get(result.transition.transitionId) ?? result.transition.transitionId,
      ),
    })),
    reruns: rerunRecords(input.results, transitionIds, input.capturedJobs),
    negativeMutations: input.negativeMutations,
    diagnostics: [
      {
        code: "itotori_023_fixture_complete",
        message:
          "review queue fixture includes pending, resolved, deferred, escalated, batch-applied, rerun, and negative mutation records",
      },
    ],
    dashboardFixtures: reviewQueueDashboardFixtures(),
  };
}

function rerunRecords(
  results: ReviewerQueueActionResult[],
  transitionIds: Map<string, string>,
  capturedJobs: Map<string, JobQueueRecord[]>,
): ArtifactRerunRecord[] {
  return results.map((result) => {
    const transitionId =
      transitionIds.get(result.transition.transitionId) ?? result.transition.transitionId;
    const jobs = capturedJobs.get(result.transition.transitionId) ?? [];
    if (jobs.length === 0) {
      return {
        decisionId: decisionIdOf(result.item),
        transitionId,
        action: result.transition.action,
        reason: "no_rerun_reason_codes_for_action",
      };
    }
    return {
      decisionId: decisionIdOf(result.item),
      transitionId,
      rerunRequestIds: jobs.map((job) => job.jobId),
      jobIds: jobs.map((job) => job.jobId),
      persistedJobNames: jobs.map((job) => job.jobName),
      reason: "targeted_rerun_enqueued",
    };
  });
}

function terminalStateFor(
  results: ReviewerQueueActionResult[],
  item: ReviewerQueueItemRecord,
): string {
  return (
    results.find((result) => result.item.reviewItemId === item.reviewItemId)?.item.state ??
    item.state
  );
}

function diagnosticsForError(error: unknown): ReviewerQueueDiagnostic[] {
  if (error instanceof ReviewerQueueActionServiceInputError) {
    return [{ code: "reviewer_queue_item_invalid_input", message: error.message }];
  }
  if (error instanceof AuthorizationError) {
    return [{ code: "reviewer_queue_permission_denied", message: error.message }];
  }
  if (error && typeof error === "object" && "diagnostics" in error) {
    const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(diagnostics) && diagnostics.length > 0) {
      return diagnostics as ReviewerQueueDiagnostic[];
    }
  }
  return [
    {
      code: "reviewer_queue_mutation_refused",
      message: error instanceof Error ? error.message : String(error),
    },
  ];
}

function decisionIdOf(item: ReviewerQueueItemRecord): string {
  return stringMetadata(item, "decisionId") ?? item.sourceItemRef;
}

function findingIdOf(item: ReviewerQueueItemRecord): string {
  return stringMetadata(item, "findingId") ?? `finding-${decisionIdOf(item)}`;
}

function leaseIdOf(item: ReviewerQueueItemRecord): string {
  return stringMetadata(item, "leaseId") ?? "missing-lease";
}

function contextRefsOf(
  item: ReviewerQueueItemRecord,
): ReturnType<typeof fixtureDecisionContextRefs> {
  const value = (item.metadata as { contextRefs?: unknown }).contextRefs;
  if (!value || typeof value !== "object") {
    throw new ReviewerQueueActionServiceInputError(
      "contextRefs",
      `item ${decisionIdOf(item)} is missing contextRefs`,
    );
  }
  return value as ReturnType<typeof fixtureDecisionContextRefs>;
}

function stringMetadata(item: ReviewerQueueItemRecord, key: string): string | undefined {
  const value = item.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function captureEnqueuedJobsRepository(
  repository: ItotoriReviewerQueueRepository,
  capturedJobs: Map<string, JobQueueRecord[]>,
): ItotoriReviewerQueueRepositoryPort {
  return {
    createItem: (actorArg, input) => repository.createItem(actorArg, input),
    applyAction: (actorArg, input) => repository.applyAction(actorArg, input),
    applyActionAndEnqueueJobs: async (actorArg, input, planJobs) => {
      const result = await repository.applyActionAndEnqueueJobs(actorArg, input, planJobs);
      capturedJobs.set(result.actionResult.transition.transitionId, result.jobs);
      return result;
    },
    applyActionsAndEnqueueJobs: async (actorArg, inputs, planJobs) => {
      const result = await repository.applyActionsAndEnqueueJobs(actorArg, inputs, planJobs);
      for (const actionResult of result.actionResults) {
        const jobsForTransition = result.jobs.filter(
          (job) => job.payload.transitionId === actionResult.transition.transitionId,
        );
        capturedJobs.set(actionResult.transition.transitionId, jobsForTransition);
      }
      return result;
    },
    getItem: (actorArg, reviewItemId) => repository.getItem(actorArg, reviewItemId),
    getItemForManage: (actorArg, reviewItemId) =>
      repository.getItemForManage(actorArg, reviewItemId),
    loadItemsByBranch: (actorArg, branchId, opts) =>
      repository.loadItemsByBranch(actorArg, branchId, opts),
    loadTransitionsByItem: (actorArg, reviewItemId) =>
      repository.loadTransitionsByItem(actorArg, reviewItemId),
  };
}

async function resetAndSeedProjectScope(pool: DatabaseContext["pool"]) {
  await pool.query("delete from itotori_reviewer_queue_transitions where locale_branch_id = $1", [
    localeBranchId,
  ]);
  await pool.query("delete from itotori_reviewer_queue_items where project_id = $1", [projectId]);
  await pool.query("delete from itotori_jobs where project_id = $1", [projectId]);
  await pool.query("delete from itotori_projects where project_id = $1", [projectId]);
  await pool.query(
    `insert into itotori_workspaces (workspace_id, name)
     values ($1, $2)
     on conflict (workspace_id) do nothing`,
    [workspaceId, "ITOTORI-023 review queue fixture"],
  );
  await pool.query(
    `insert into itotori_projects (
       project_id, workspace_id, project_key, name, source_locale, status
     )
     values ($1, $2, $3, $4, $5, $6)`,
    [
      projectId,
      workspaceId,
      "itotori-023-review-queue",
      "ITOTORI-023 Review Queue Fixture",
      "ja-JP",
      "imported",
    ],
  );
  await pool.query(
    `insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
     values
       ($1, $2, $3, $4),
       ($5, $2, $3, $6)`,
    [
      sourceRevisionId,
      projectId,
      "bridge_revision",
      "itotori-023-v1",
      supersedingSourceRevisionId,
      "itotori-023-v2",
    ],
  );
  await pool.query(
    `insert into itotori_source_bundles (
       source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
       schema_version, source_bundle_hash, source_locale,
       extractor_name, extractor_version, unit_count, asset_count
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0)`,
    [
      sourceBundleId,
      projectId,
      sourceRevisionId,
      "bridge-itotori-023",
      "0.2.0",
      "hash:itotori-023-review-queue",
      "ja-JP",
      "fixture-extractor",
      "1.0.0",
    ],
  );
  await pool.query(
    `insert into itotori_locale_branches (
       locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
     )
     values ($1, $2, $3, $4, $5, $6)`,
    [localeBranchId, projectId, sourceBundleId, "en-US", "English", "active"],
  );
}
