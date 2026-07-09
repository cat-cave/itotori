// itotori-correction-feedback-writeback-e2e — the feedback loop's RETURN path,
// proven on a real Postgres via the correction service.
//
// A reviewer correction on a bridge unit must:
//   (a) WRITE BACK the corrected target into the translation-memory store (and,
//       when term-scoped, the glossary) so the correction PERSISTS, and
//   (b) SCHEDULE an affected rerun for every unit sharing that source, whose
//       NEXT DRAFT then reflects the correction (translation-memory prefill
//       rewrites the affected unit's target to the corrected text).
//   (c) be IDEMPOTENT: re-applying the same correction neither duplicates the
//       persisted term/segment nor re-schedules a fresh rerun.
//
// Runs only when DATABASE_URL is set (the `ci-itotori` lane stands up Postgres
// and migrates the public schema); otherwise it is skipped, matching the app
// package's otherwise DB-free test suite.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import {
  createDatabaseContext,
  ItotoriEventQueueRepository,
  ItotoriProjectRepository,
  ItotoriTerminologyRepository,
  ItotoriTranslationMemoryRepository,
  ItotoriTranslationMemoryService,
  feedbackContextStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  localUserId,
  type AuthorizationActor,
  type CreateReviewerQueueItemInput,
  type DatabaseContext,
  type ItotoriFeedbackRepositoryPort,
  type ItotoriReviewerQueueRepositoryPort,
  type ManualFeedbackImportInput,
  type ManualFeedbackImportResult,
  type ManualFeedbackReviewerQueueContext,
  type ReviewerQueueItemRecord,
  type WorkspaceCorrectionEditInput,
  type WorkspaceCorrectionEditRecord,
} from "@itotori/db";
import { ManualFeedbackImportService } from "../src/manual-feedback.js";
import { WorkspaceCorrectionFeedbackLoop } from "../src/workspace/correction-feedback-loop.js";
import {
  WorkspaceCorrectionService,
  type WorkspaceCorrectionComparisonPort,
} from "../src/workspace/correction-service.js";
import { deniedContextFixture } from "../src/reviewer/detail-fixtures.js";

const actor: AuthorizationActor = { userId: localUserId };
const databaseUrl = process.env.DATABASE_URL;

// The source line shared by unit-a (corrected) and unit-b (affected sibling).
const SHARED_SOURCE = "おはようございます、先輩。";
const SHARED_SOURCE_HASH = "hash:good-morning-shared";
const CORRECTED_TARGET = "Good morning, senpai! [reviewer-corrected]";
const GLOSSARY_SOURCE_TERM = "先輩";
const GLOSSARY_CORRECTED = "senpai";

describe.skipIf(!databaseUrl)(
  "workspace correction → writeback → affected rerun → changed draft",
  () => {
    it("persists the correction to TM + glossary, schedules an affected rerun, and the next draft reflects it", async () => {
      const context = createDatabaseContext(databaseUrl!);
      const ids = uniqueIds();
      try {
        await seedProject(context, ids);

        const translationMemoryRepository = new ItotoriTranslationMemoryRepository(context.db);
        const translationMemoryService = new ItotoriTranslationMemoryService(
          translationMemoryRepository,
        );
        const terminologyRepository = new ItotoriTerminologyRepository(context.db);
        const eventQueueRepository = new ItotoriEventQueueRepository(context.db);

        // The real source revision the seeded units belong to.
        const shared = await translationMemoryRepository.listUnitsSharingSource({
          projectId: ids.projectId,
          localeBranchId: ids.localeBranchId,
          bridgeUnitId: ids.unitA,
        });
        expect(shared).not.toBeNull();
        // unit-a and unit-b share the source line → both are affected.
        expect(shared!.bridgeUnitIds).toEqual([ids.unitA, ids.unitB].sort());
        const sourceRevisionId = shared!.sourceRevisionId;

        const feedbackLoop = new WorkspaceCorrectionFeedbackLoop({
          actor,
          translationMemory: translationMemoryRepository,
          glossary: terminologyRepository,
          rerunQueue: {
            enqueueJobs: (a, inputs) => eventQueueRepository.enqueueJobs(a, inputs),
          },
        });

        const feedbackRepo = new StubFeedbackRepository(ids.localeBranchId, sourceRevisionId);
        const reviewerQueue = new StubReviewerQueueRepository();
        const manualFeedback = new ManualFeedbackImportService(feedbackRepo, actor, reviewerQueue);
        const editRepo = new StubEditRepository();
        const comparisonPort: WorkspaceCorrectionComparisonPort = {
          loadComparisonContext: async () => deniedContextFixture(localUserId),
        };
        const service = new WorkspaceCorrectionService({
          importPort: manualFeedback,
          editRepository: editRepo,
          comparisonPort,
          feedbackLoop,
        });

        const submit = await service.submitCorrections({
          projectId: ids.projectId,
          localeBranchId: ids.localeBranchId,
          sourceBundleId: ids.sourceBundleId,
          targetLocale: "en-US",
          actorUserId: localUserId,
          actorDisplayName: "Reviewer One",
          permission: {
            actorUserId: localUserId,
            canReadQueue: true,
            canManageQueue: true,
            denialReasons: [],
          },
          corrections: [
            {
              bridgeUnitId: ids.unitA,
              sourceRevisionId,
              severity: "warning",
              scope: { kind: "line" },
              reason: "Draft dropped the greeting + honorific",
              correctedText: CORRECTED_TARGET,
              draftText: "morning",
              feedbackType: feedbackTypeValues.objectiveDefect,
            },
            {
              bridgeUnitId: ids.unitTerm,
              sourceRevisionId,
              severity: "warning",
              scope: { kind: "line" },
              reason: "Canonical honorific",
              correctedText: GLOSSARY_CORRECTED,
              sourceTerm: GLOSSARY_SOURCE_TERM,
              feedbackType: feedbackTypeValues.objectiveDefect,
            },
          ],
        });

        // ---- The loop CLOSED: both corrections wrote back + scheduled reruns. ----
        expect(submit.submittedCount).toBe(2);
        expect(submit.writebacks).toHaveLength(2);
        expect(submit.scheduledRerunJobIds.length).toBeGreaterThan(0);

        const unitAWriteback = submit.writebacks.find((w) => w.bridgeUnitId === ids.unitA);
        expect(unitAWriteback).toBeDefined();
        expect(unitAWriteback!.memorySegmentId).not.toBeNull();
        // The affected scope is unit-a + its source sibling unit-b.
        expect(unitAWriteback!.affectedBridgeUnitIds).toEqual([ids.unitA, ids.unitB].sort());
        expect(unitAWriteback!.scheduledJobIds.length).toBeGreaterThan(0);

        const termWriteback = submit.writebacks.find((w) => w.bridgeUnitId === ids.unitTerm);
        expect(termWriteback!.termId).not.toBeNull();

        // ---- (a) The corrected segment PERSISTED in translation memory. ----
        const matches = await translationMemoryRepository.findReusableSegments({
          projectId: ids.projectId,
          localeBranchId: ids.localeBranchId,
          requestedTargetLocale: "en-US",
          targetBridgeUnitId: ids.unitB,
        });
        const corrected = matches?.matches.find((m) => m.sourceBridgeUnitId === ids.unitA);
        expect(corrected?.targetText).toBe(CORRECTED_TARGET);

        // ---- (a) The corrected TERM PERSISTED in the glossary. ----
        const termSearch = await terminologyRepository.searchTerms(actor, {
          projectId: ids.projectId,
          localeBranchId: ids.localeBranchId,
          query: GLOSSARY_SOURCE_TERM,
        });
        const glossaryHit = termSearch.results.find(
          (r) => r.term.sourceTerm === GLOSSARY_SOURCE_TERM,
        );
        expect(glossaryHit?.term.preferredTranslation).toBe(GLOSSARY_CORRECTED);

        // ---- (b) The scheduled rerun jobs are durable on the shared queue. ----
        const scheduledJob = await eventQueueRepository.getJob(
          actor,
          submit.scheduledRerunJobIds[0]!,
        );
        expect(scheduledJob).not.toBeNull();
        expect(scheduledJob!.jobType).toBe("rerun");

        // ---- (b)+(c) The NEXT DRAFT for the affected sibling reflects it. ----
        // unit-b had no target; the affected rerun's translation-memory prefill
        // now exact-matches the corrected segment and rewrites unit-b's draft.
        const prefill = await translationMemoryService.prefillDrafts(actor, {
          projectId: ids.projectId,
          localeBranchId: ids.localeBranchId,
          requestedTargetLocale: "en-US",
          bridgeUnitIds: [ids.unitB],
          requestId: "affected-rerun-prefill",
        });
        expect(prefill.appliedCount).toBe(1);
        expect(prefill.reuses[0]?.event.targetText).toBe(CORRECTED_TARGET);

        // ---- (c) IDEMPOTENT: re-applying the SAME correction does not
        //          duplicate the segment/term nor grow the rerun. ----
        const jobCountBefore = submit.scheduledRerunJobIds.length;
        const replay = await feedbackLoop.applyCorrectionWriteback({
          projectId: ids.projectId,
          localeBranchId: ids.localeBranchId,
          sourceRevisionId,
          bridgeUnitId: ids.unitA,
          correctedText: CORRECTED_TARGET,
          reason: "Draft dropped the greeting + honorific",
        });
        expect(replay.memorySegmentId).toBe(unitAWriteback!.memorySegmentId);
        // Exactly ONE reusable segment for unit-a's source after the replay.
        const matchesAfter = await translationMemoryRepository.findReusableSegments({
          projectId: ids.projectId,
          localeBranchId: ids.localeBranchId,
          requestedTargetLocale: "en-US",
          targetBridgeUnitId: ids.unitB,
        });
        const unitASegments = (matchesAfter?.matches ?? []).filter(
          (m) => m.sourceBridgeUnitId === ids.unitA,
        );
        expect(unitASegments).toHaveLength(1);
        // The replay resolves to the SAME deterministic rerun jobs (idempotent).
        expect(replay.scheduledJobIds).toEqual(unitAWriteback!.scheduledJobIds);
        expect(unitAWriteback!.scheduledJobIds).toHaveLength(
          jobCountBefore >= 1 ? replay.scheduledJobIds.length : 0,
        );
      } finally {
        await context.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

type SeedIds = {
  projectId: string;
  localeBranchId: string;
  sourceBundleId: string;
  unitA: string;
  unitB: string;
  unitTerm: string;
};

function uniqueIds(): SeedIds {
  const suffix = randomBytes(6).toString("hex");
  return {
    projectId: `project-cfwb-${suffix}`,
    localeBranchId: `branch-cfwb-${suffix}`,
    sourceBundleId: `bundle-cfwb-${suffix}`,
    unitA: `unit-a-${suffix}`,
    unitB: `unit-b-${suffix}`,
    unitTerm: `unit-term-${suffix}`,
  };
}

async function seedProject(context: DatabaseContext, ids: SeedIds): Promise<void> {
  const repository = new ItotoriProjectRepository(context.db);
  await repository.importSourceBundle(actor, {
    projectId: ids.projectId,
    localeBranchId: ids.localeBranchId,
    targetLocale: "en-US",
    // Only unit-a starts with a (wrong) draft; unit-b and unit-term have no
    // target, so the affected rerun's prefill can write into unit-b.
    drafts: { [ids.unitA]: "morning" },
    bridge: bridgeFixture(ids),
  });
}

function bridgeFixture(ids: SeedIds): BridgeBundle {
  const assetId = `${ids.sourceBundleId}:scenario.ks`;
  return {
    schemaVersion: "0.1.0",
    bridgeId: ids.sourceBundleId,
    sourceBundleHash: `hash:${ids.sourceBundleId}`,
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      unit({
        bridgeUnitId: ids.unitA,
        sourceUnitKey: "scene.001.a",
        occurrenceId: "occ-a",
        sourceText: SHARED_SOURCE,
        sourceHash: SHARED_SOURCE_HASH,
        assetId,
      }),
      unit({
        bridgeUnitId: ids.unitB,
        sourceUnitKey: "scene.002.b",
        occurrenceId: "occ-b",
        sourceText: SHARED_SOURCE,
        sourceHash: SHARED_SOURCE_HASH,
        assetId,
      }),
      unit({
        bridgeUnitId: ids.unitTerm,
        sourceUnitKey: "scene.003.term",
        occurrenceId: "occ-term",
        sourceText: "先輩！",
        sourceHash: "hash:senpai-term",
        assetId,
      }),
    ],
  };
}

function unit(input: {
  bridgeUnitId: string;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceText: string;
  sourceHash: string;
  assetId: string;
}): BridgeBundle["units"][number] {
  return {
    bridgeUnitId: input.bridgeUnitId,
    sourceUnitKey: input.sourceUnitKey,
    occurrenceId: input.occurrenceId,
    sourceHash: input.sourceHash,
    sourceLocale: "ja-JP",
    sourceText: input.sourceText,
    textSurface: "dialogue",
    protectedSpans: [],
    patchRef: {
      assetId: input.assetId,
      writeMode: "replace",
      sourceUnitKey: input.sourceUnitKey,
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory feedback / reviewer-queue / edit stubs (not the subject under test)
// ---------------------------------------------------------------------------

class StubFeedbackRepository implements Pick<
  ItotoriFeedbackRepositoryPort,
  "importManualFeedback" | "loadManualFeedbackReviewerQueueContext"
> {
  private counter = 0;
  private readonly reports = new Map<string, ManualFeedbackReviewerQueueContext>();

  constructor(
    private readonly localeBranchId: string,
    private readonly sourceRevisionId: string,
  ) {}

  async importManualFeedback(
    _actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult> {
    this.counter += 1;
    const feedbackReportId = `feedback-report-${this.counter}`;
    const feedbackEvidenceId = `feedback-evidence-${this.counter}`;
    const bridgeUnitId = input.lineReference?.bridgeUnitId;
    this.reports.set(`${feedbackReportId}:${feedbackEvidenceId}`, {
      feedbackReportId,
      feedbackEvidenceId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId ?? this.localeBranchId,
      sourceRevisionId: this.sourceRevisionId,
      feedbackType: input.feedbackType,
      triageLabel: feedbackTriageLabelValues.objectiveDefectCandidate,
      contextStatus: feedbackContextStatusValues.contextualized,
      reporterNote: input.reporterNote,
      context:
        bridgeUnitId === undefined
          ? { lineReference: {} }
          : { lineReference: { bridgeUnitId }, affectedUnitIds: [bridgeUnitId] },
      attachments: [],
      affectedArtifactIds: [],
    });
    return {
      feedbackReportId,
      feedbackEvidenceId,
      feedbackSourceId: `feedback-source-${this.counter}`,
      dedupeKey: `dedupe-${this.counter}`,
      triageLabel: feedbackTriageLabelValues.objectiveDefectCandidate,
      reportStatus: "open",
      contextStatus: feedbackContextStatusValues.contextualized,
      reportCount: 1,
      duplicate: false,
    };
  }

  async loadManualFeedbackReviewerQueueContext(
    _actor: AuthorizationActor,
    feedbackReportId: string,
    feedbackEvidenceId: string,
  ): Promise<ManualFeedbackReviewerQueueContext | null> {
    return this.reports.get(`${feedbackReportId}:${feedbackEvidenceId}`) ?? null;
  }
}

class StubReviewerQueueRepository implements Pick<
  ItotoriReviewerQueueRepositoryPort,
  "createItem" | "loadItemsByBranch"
> {
  private counter = 0;
  readonly created: ReviewerQueueItemRecord[] = [];

  async createItem(
    _actor: AuthorizationActor,
    input: CreateReviewerQueueItemInput,
  ): Promise<ReviewerQueueItemRecord> {
    this.counter += 1;
    const now = new Date("2026-07-04T00:00:00Z");
    const record: ReviewerQueueItemRecord = {
      reviewItemId: `reviewer-queue-item-${this.counter}`,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      itemKind: input.itemKind,
      sourceItemRef: input.sourceItemRef,
      state: "pending",
      priority: input.priority ?? 0,
      summary: input.summary,
      affectedArtifactIds: input.affectedArtifactIds ?? [],
      evidenceTier: input.evidenceTier ?? null,
      observationEventIds: input.observationEventIds ?? null,
      artifactHashes: input.artifactHashes ?? null,
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      createdByUserId: input.createdByUserId ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    this.created.push(record);
    return record;
  }

  async loadItemsByBranch(): Promise<ReviewerQueueItemRecord[]> {
    return [...this.created];
  }
}

class StubEditRepository {
  readonly recorded: WorkspaceCorrectionEditRecord[] = [];

  async recordCorrectionEdit(
    input: WorkspaceCorrectionEditInput,
  ): Promise<WorkspaceCorrectionEditRecord> {
    const correctionEditId = `edit-${input.localeBranchId}-${input.bridgeUnitId}-${input.afterText}`;
    const duplicate = this.recorded.some((row) => row.correctionEditId === correctionEditId);
    const record: WorkspaceCorrectionEditRecord = {
      correctionEditId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      bridgeUnitId: input.bridgeUnitId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      beforeText: input.beforeText ?? null,
      afterText: input.afterText,
      disposition: input.disposition,
      triageLabel: input.triageLabel,
      feedbackReportId: input.feedbackReportId,
      feedbackEvidenceId: input.feedbackEvidenceId,
      reviewItemId: input.reviewItemId ?? null,
      batchId: input.batchId,
      metadata: input.metadata ?? {},
      createdAt: new Date("2026-07-04T00:00:00Z"),
      duplicate,
    };
    if (!duplicate) {
      this.recorded.push(record);
    }
    return record;
  }
}
