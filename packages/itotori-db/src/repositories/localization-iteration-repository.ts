// p0-core-iterative-patch-versioning-and-playtest-feedback — iteration
// read/write boundary. This composes the existing journal, finalizer, result
// revision, and wiki stores; it deliberately does not create a second patcher
// or context system.

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  contextArtifacts,
  contextEntryVersions,
  localizationJournalRuns,
  localizationPatchVersionUnits,
  localizationPatchVersions,
  localizationRefinementRunFeedbackBatches,
  localizationRefinementRunFeedbackEvents,
  localizationRefinementRunMembers,
  localizationRefinementRunWikiHeads,
  localizationResultRevisions,
  playSessionQaCallouts,
  playSessions,
  playTestFeedbackBatches,
  playTestFeedbackEvents,
  playTestFeedbackEventUnits,
  writtenQaFindings,
  type LocalizationPatchVersionMemberOrigin,
  type LocalizationPatchVersionOrigin,
  type LocalizationRefinementMemberStrategy,
  type PlaySessionStatus,
  type PlayTestFeedbackBatchSelectionKind,
  type PlayTestFeedbackEventKind,
} from "../schema.js";
import {
  ItotoriLocalizationJournalRepository,
  type LocalizationJournalRunRecord,
  type SeedLocalizationJournalRefinementWikiHeadInput,
  type SeedLocalizationJournalRunInput,
} from "./localization-journal-repository.js";

export const PLAY_TEST_QA_LOW_CONFIDENCE_THRESHOLD = "0.7";

export type CreateRefinementRunInput = Omit<SeedLocalizationJournalRunInput, "refinement"> & {
  basePatchVersionId: string;
  /** Whole durable batches selected by the play tester. */
  feedbackBatchIds: readonly string[];
  /** Individually selected events; these do not imply selecting siblings in their batch. */
  feedbackEventIds?: readonly string[];
  /** Omit to atomically snapshot every current wiki head in this branch. */
  wikiHeads?: readonly SeedLocalizationJournalRefinementWikiHeadInput[];
  /** Units forced to redraft in addition to selected feedback/wiki impact. */
  redraftUnitIds?: readonly string[];
};

export type RefinementRunMemberPlan = {
  bridgeUnitId: string;
  strategy: LocalizationRefinementMemberStrategy;
  basePatchVersionId: string | null;
  baseSourceRunId: string | null;
  baseJournalOutcomeId: string | null;
  baseResultRevisionId: string | null;
};

export type RefinementRunFeedbackBatchSnapshot = {
  feedbackBatchId: string;
  observedPatchVersionId: string;
  eventIds: string[];
};

export type RefinementRunWikiHeadSnapshot = {
  contextArtifactId: string;
  contextEntryVersionId: string;
};

export type LocalizationRefinementRunRecord = {
  run: LocalizationJournalRunRecord;
  basePatchVersionId: string;
  feedbackBatches: RefinementRunFeedbackBatchSnapshot[];
  wikiHeads: RefinementRunWikiHeadSnapshot[];
  members: RefinementRunMemberPlan[];
};

export type CreatePlayTestFeedbackBatchInput = {
  feedbackBatchId?: string;
  observedPatchVersionId: string;
  selectionKind?: PlayTestFeedbackBatchSelectionKind;
  label?: string;
};

export type PlayTestFeedbackBatchRecord = {
  feedbackBatchId: string;
  observedPatchVersionId: string;
  actorUserId: string;
  selectionKind: PlayTestFeedbackBatchSelectionKind;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordPlayTestFeedbackEventInput = {
  feedbackEventId?: string;
  /** Omit to create a first-class singleton/individual batch. */
  feedbackBatchId?: string;
  observedPatchVersionId: string;
  playSessionId?: string;
  eventKind: PlayTestFeedbackEventKind;
  body?: string;
  metadata?: Record<string, unknown>;
  resultRevisionId?: string;
  contextArtifactId?: string;
  contextEntryVersionId?: string;
  affectedBridgeUnitIds?: readonly string[];
};

export type PlayTestFeedbackEventRecord = {
  feedbackEventId: string;
  feedbackBatchId: string;
  observedPatchVersionId: string;
  playSessionId: string | null;
  actorUserId: string;
  eventKind: PlayTestFeedbackEventKind;
  body: string | null;
  metadata: Record<string, unknown>;
  resultRevisionId: string | null;
  contextArtifactId: string | null;
  contextEntryVersionId: string | null;
  affectedBridgeUnitIds: string[];
  createdAt: Date;
};

/** Patch-scoped first-class inbox used by both Play and Refine surfaces. */
export type PlayTestFeedbackInbox = {
  observedPatchVersionId: string;
  batches: Array<PlayTestFeedbackBatchRecord & { events: PlayTestFeedbackEventRecord[] }>;
};

export type StartPlaySessionInput = {
  playSessionId?: string;
  observedPatchVersionId: string;
  launchDescriptor?: Record<string, unknown>;
  startedAt?: Date;
};

export type PlaySessionQaCallout = {
  journalFindingId: string;
  bridgeUnitId: string;
  severity: string;
  category: string;
  note: string;
  confidence: string;
  contested: boolean;
  informational: true;
};

export type PlaySessionRecord = {
  playSessionId: string;
  observedPatchVersionId: string;
  actorUserId: string;
  status: PlaySessionStatus;
  launchDescriptor: Record<string, unknown>;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  qaCallouts: PlaySessionQaCallout[];
};

export type PatchPlaySurface = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: LocalizationPatchVersionOrigin;
  status: string;
  playableAt: Date | null;
  selectedAt: Date | null;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  units: Array<{
    bridgeUnitId: string;
    sourceRunId: string;
    journalOutcomeId: string;
    resultRevisionId: string;
    targetBody: string;
    memberOrigin: LocalizationPatchVersionMemberOrigin;
    reusedFromPatchVersionId: string | null;
    unitOrdinal: number;
  }>;
  qaCallouts: PlaySessionQaCallout[];
};

export type PatchVersionIterationRecord = Pick<
  PatchPlaySurface,
  | "patchVersionId"
  | "runId"
  | "parentPatchVersionId"
  | "origin"
  | "status"
  | "playableAt"
  | "selectedAt"
  | "artifactHashes"
  | "artifactRefs"
> & { basePatchVersionId: string | null };

export interface ItotoriLocalizationIterationRepositoryPort {
  createRefinementRun(
    actor: AuthorizationActor,
    input: CreateRefinementRunInput,
  ): Promise<LocalizationRefinementRunRecord>;
  loadRefinementRun(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationRefinementRunRecord | null>;
  createFeedbackBatch(
    actor: AuthorizationActor,
    input: CreatePlayTestFeedbackBatchInput,
  ): Promise<PlayTestFeedbackBatchRecord>;
  recordFeedbackEvent(
    actor: AuthorizationActor,
    input: RecordPlayTestFeedbackEventInput,
  ): Promise<PlayTestFeedbackEventRecord>;
  loadFeedbackInbox(
    actor: AuthorizationActor,
    observedPatchVersionId: string,
  ): Promise<PlayTestFeedbackInbox>;
  startPlaySession(
    actor: AuthorizationActor,
    input: StartPlaySessionInput,
  ): Promise<PlaySessionRecord>;
  finishPlaySession(
    actor: AuthorizationActor,
    input: { playSessionId: string; status?: "completed" | "abandoned"; endedAt?: Date },
  ): Promise<PlaySessionRecord>;
  loadPatchPlaySurface(
    actor: AuthorizationActor,
    patchVersionId: string,
  ): Promise<PatchPlaySurface | null>;
  listPatchVersions(
    actor: AuthorizationActor,
    filter: { localeBranchId: string },
  ): Promise<PatchVersionIterationRecord[]>;
}

export class LocalizationIterationRepositoryError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "patch_not_found"
      | "patch_not_playable"
      | "feedback_batch_conflict"
      | "feedback_event_conflict"
      | "play_session_not_found"
      | "play_session_conflict"
      | "refinement_not_found",
    message: string,
  ) {
    super(message);
    this.name = "LocalizationIterationRepositoryError";
  }
}

/**
 * The shared transaction shape used when one durable operation needs to add a
 * feedback event before its surrounding mutation commits.  In particular, a
 * play-tester result edit uses this to make its selected child patch and the
 * feedback fact one database commit.
 */
export type LocalizationIterationTransaction = Parameters<
  Parameters<ItotoriDatabase["transaction"]>[0]
>[0];

type Tx = LocalizationIterationTransaction;

/**
 * First-class iteration persistence. It delegates run seeding to the existing
 * journal so scope/routing/cost and refinement mappings are one transaction.
 */
export class ItotoriLocalizationIterationRepository implements ItotoriLocalizationIterationRepositoryPort {
  private readonly journal: ItotoriLocalizationJournalRepository;

  constructor(private readonly db: ItotoriDatabase) {
    this.journal = new ItotoriLocalizationJournalRepository(db);
  }

  async createRefinementRun(
    actor: AuthorizationActor,
    input: CreateRefinementRunInput,
  ): Promise<LocalizationRefinementRunRecord> {
    const run = await this.journal.seedRun(actor, {
      ...input,
      refinement: {
        basePatchVersionId: input.basePatchVersionId,
        feedbackBatchIds: input.feedbackBatchIds,
        ...(input.feedbackEventIds === undefined
          ? {}
          : { feedbackEventIds: input.feedbackEventIds }),
        ...(input.wikiHeads === undefined ? {} : { wikiHeads: input.wikiHeads }),
        ...(input.redraftUnitIds === undefined ? {} : { redraftUnitIds: input.redraftUnitIds }),
      },
    });
    const snapshot = await this.loadRefinementRun(actor, run.runId);
    if (snapshot === null) {
      throw new LocalizationIterationRepositoryError(
        "refinement_not_found",
        `refinement run ${run.runId} disappeared after creation`,
      );
    }
    return snapshot;
  }

  async loadRefinementRun(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationRefinementRunRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(runId, "runId");
    const run = await this.journal.loadRun(actor, runId);
    if (run === null || run.basePatchVersionId === null) return null;
    const [batchRows, eventRows, wikiRows, memberRows] = await Promise.all([
      this.db
        .select()
        .from(localizationRefinementRunFeedbackBatches)
        .where(eq(localizationRefinementRunFeedbackBatches.runId, runId))
        .orderBy(asc(localizationRefinementRunFeedbackBatches.batchOrdinal)),
      this.db
        .select()
        .from(localizationRefinementRunFeedbackEvents)
        .where(eq(localizationRefinementRunFeedbackEvents.runId, runId))
        .orderBy(asc(localizationRefinementRunFeedbackEvents.eventOrdinal)),
      this.db
        .select()
        .from(localizationRefinementRunWikiHeads)
        .where(eq(localizationRefinementRunWikiHeads.runId, runId))
        .orderBy(asc(localizationRefinementRunWikiHeads.contextArtifactId)),
      this.db
        .select()
        .from(localizationRefinementRunMembers)
        .where(eq(localizationRefinementRunMembers.runId, runId))
        .orderBy(asc(localizationRefinementRunMembers.bridgeUnitId)),
    ]);
    const eventIdsByBatch = new Map<string, string[]>();
    for (const event of eventRows) {
      const ids = eventIdsByBatch.get(event.feedbackBatchId) ?? [];
      ids.push(event.feedbackEventId);
      eventIdsByBatch.set(event.feedbackBatchId, ids);
    }
    return {
      run,
      basePatchVersionId: run.basePatchVersionId,
      feedbackBatches: batchRows.map((batch) => ({
        feedbackBatchId: batch.feedbackBatchId,
        observedPatchVersionId: batch.observedPatchVersionId,
        eventIds: eventIdsByBatch.get(batch.feedbackBatchId) ?? [],
      })),
      wikiHeads: wikiRows.map((head) => ({
        contextArtifactId: head.contextArtifactId,
        contextEntryVersionId: head.contextEntryVersionId,
      })),
      members: memberRows.map((member) => ({
        bridgeUnitId: member.bridgeUnitId,
        strategy: member.strategy,
        basePatchVersionId: member.basePatchVersionId,
        baseSourceRunId: member.baseSourceRunId,
        baseJournalOutcomeId: member.baseJournalOutcomeId,
        baseResultRevisionId: member.baseResultRevisionId,
      })),
    };
  }

  async createFeedbackBatch(
    actor: AuthorizationActor,
    input: CreatePlayTestFeedbackBatchInput,
  ): Promise<PlayTestFeedbackBatchRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.observedPatchVersionId, "observedPatchVersionId");
    const feedbackBatchId = input.feedbackBatchId ?? `feedback-batch:${randomUUID()}`;
    assertNonBlank(feedbackBatchId, "feedbackBatchId");
    const selectionKind = input.selectionKind ?? "batch";
    if (selectionKind !== "batch" && selectionKind !== "individual") {
      throw new LocalizationIterationRepositoryError(
        "invalid_input",
        "unsupported feedback batch kind",
      );
    }
    if (input.label !== undefined) assertNonBlank(input.label, "label");
    return this.db.transaction(async (tx) => {
      await requirePlayablePatchInTx(tx, input.observedPatchVersionId);
      const existing = await loadFeedbackBatchInTx(tx, feedbackBatchId);
      if (existing !== null) {
        if (
          existing.observedPatchVersionId !== input.observedPatchVersionId ||
          existing.actorUserId !== actor.userId ||
          existing.selectionKind !== selectionKind ||
          existing.label !== (input.label ?? null)
        ) {
          throw new LocalizationIterationRepositoryError(
            "feedback_batch_conflict",
            `feedback batch ${feedbackBatchId} already has different immutable facts`,
          );
        }
        return feedbackBatchFromRow(existing);
      }
      const now = new Date();
      const inserted = await tx
        .insert(playTestFeedbackBatches)
        .values({
          feedbackBatchId,
          observedPatchVersionId: input.observedPatchVersionId,
          actorUserId: actor.userId,
          selectionKind,
          label: input.label ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return feedbackBatchFromRow(inserted[0]!);
    });
  }

  async recordFeedbackEvent(
    actor: AuthorizationActor,
    input: RecordPlayTestFeedbackEventInput,
  ): Promise<PlayTestFeedbackEventRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    return this.db.transaction(async (tx) => this.recordFeedbackEventInTx(tx, actor, input));
  }

  /**
   * Record immutable play-test feedback inside a caller-owned transaction.
   *
   * The result-revision repository uses this boundary so a target edit cannot
   * select a child patch unless the linked feedback fact commits with it.  It
   * deliberately keeps all of the ordinary feedback validation here; callers
   * do not receive a weaker write path merely because they share a transaction.
   */
  async recordFeedbackEventInTx(
    tx: LocalizationIterationTransaction,
    actor: AuthorizationActor,
    input: RecordPlayTestFeedbackEventInput,
  ): Promise<PlayTestFeedbackEventRecord> {
    assertNonBlank(input.observedPatchVersionId, "observedPatchVersionId");
    const feedbackEventId = input.feedbackEventId ?? `feedback-event:${randomUUID()}`;
    assertNonBlank(feedbackEventId, "feedbackEventId");
    const body = input.body === undefined ? null : input.body;
    if (body !== null) assertNonBlank(body, "body");
    const metadata = input.metadata ?? {};
    assertJsonObject(metadata, "metadata");
    const affectedBridgeUnitIds = uniqueNonBlank(
      input.affectedBridgeUnitIds ?? [],
      "affectedBridgeUnitIds",
    );
    if (input.eventKind === "result_edit" && input.resultRevisionId === undefined) {
      throw new LocalizationIterationRepositoryError(
        "invalid_input",
        "result_edit feedback requires resultRevisionId",
      );
    }
    if (input.eventKind === "result_edit" && affectedBridgeUnitIds.length !== 1) {
      throw new LocalizationIterationRepositoryError(
        "invalid_input",
        "result_edit feedback requires exactly one affectedBridgeUnitId",
      );
    }
    if (input.resultRevisionId !== undefined)
      assertNonBlank(input.resultRevisionId, "resultRevisionId");
    const hasContextArtifact = input.contextArtifactId !== undefined;
    const hasContextEntryVersion = input.contextEntryVersionId !== undefined;
    if (hasContextArtifact) assertNonBlank(input.contextArtifactId!, "contextArtifactId");
    if (hasContextEntryVersion)
      assertNonBlank(input.contextEntryVersionId!, "contextEntryVersionId");
    if (hasContextArtifact !== hasContextEntryVersion) {
      throw new LocalizationIterationRepositoryError(
        "invalid_input",
        "contextArtifactId and contextEntryVersionId must be supplied together",
      );
    }
    if (
      (input.eventKind === "added_context" || input.eventKind === "wiki_edit") &&
      !hasContextArtifact
    ) {
      throw new LocalizationIterationRepositoryError(
        "invalid_input",
        `${input.eventKind} feedback requires an immutable context artifact/version pair`,
      );
    }
    const observedPatch = await requirePlayablePatchInTx(tx, input.observedPatchVersionId);
    const feedbackBatchId = input.feedbackBatchId ?? `feedback-batch:individual:${feedbackEventId}`;
    const batch = await loadFeedbackBatchInTx(tx, feedbackBatchId);
    if (batch === null) {
      const now = new Date();
      await tx.insert(playTestFeedbackBatches).values({
        feedbackBatchId,
        observedPatchVersionId: input.observedPatchVersionId,
        actorUserId: actor.userId,
        selectionKind: "individual",
        label: null,
        createdAt: now,
        updatedAt: now,
      });
    } else if (batch.observedPatchVersionId !== input.observedPatchVersionId) {
      throw new LocalizationIterationRepositoryError(
        "feedback_batch_conflict",
        `feedback batch ${feedbackBatchId} belongs to another observed patch`,
      );
    }
    if (input.playSessionId !== undefined) {
      const [session] = await tx
        .select()
        .from(playSessions)
        .where(eq(playSessions.playSessionId, input.playSessionId))
        .limit(1);
      if (
        session === undefined ||
        session.observedPatchVersionId !== input.observedPatchVersionId
      ) {
        throw new LocalizationIterationRepositoryError(
          "invalid_input",
          `play session ${input.playSessionId} is not for the observed patch`,
        );
      }
    }
    if (input.resultRevisionId !== undefined) {
      const [revision] = await tx
        .select({
          resultRevisionId: localizationResultRevisions.resultRevisionId,
          runId: localizationResultRevisions.runId,
          bridgeUnitId: localizationResultRevisions.bridgeUnitId,
          journalOutcomeId: localizationResultRevisions.journalOutcomeId,
          parentRevisionId: localizationResultRevisions.parentRevisionId,
        })
        .from(localizationResultRevisions)
        .where(eq(localizationResultRevisions.resultRevisionId, input.resultRevisionId))
        .limit(1);
      if (revision === undefined) {
        throw new LocalizationIterationRepositoryError(
          "invalid_input",
          `result revision ${input.resultRevisionId} does not exist`,
        );
      }
      const observedMembers = await tx
        .select({
          sourceRunId: localizationPatchVersionUnits.sourceRunId,
          bridgeUnitId: localizationPatchVersionUnits.bridgeUnitId,
          journalOutcomeId: localizationPatchVersionUnits.journalOutcomeId,
          resultRevisionId: localizationPatchVersionUnits.resultRevisionId,
        })
        .from(localizationPatchVersionUnits)
        .where(
          and(
            eq(localizationPatchVersionUnits.patchVersionId, input.observedPatchVersionId),
            eq(localizationPatchVersionUnits.bridgeUnitId, revision.bridgeUnitId),
          ),
        );
      const anchoredToObservedPatch = observedMembers.some(
        (member) =>
          member.sourceRunId === revision.runId &&
          member.journalOutcomeId === revision.journalOutcomeId &&
          (member.resultRevisionId === revision.resultRevisionId ||
            member.resultRevisionId === revision.parentRevisionId),
      );
      if (!anchoredToObservedPatch) {
        throw new LocalizationIterationRepositoryError(
          "invalid_input",
          `result revision ${input.resultRevisionId} does not derive from observed patch ${input.observedPatchVersionId}`,
        );
      }
      if (input.eventKind === "result_edit" && affectedBridgeUnitIds[0] !== revision.bridgeUnitId) {
        throw new LocalizationIterationRepositoryError(
          "invalid_input",
          `result_edit revision ${input.resultRevisionId} belongs to ${revision.bridgeUnitId}, not ${affectedBridgeUnitIds[0]}`,
        );
      }
    }
    if (input.contextArtifactId !== undefined) {
      const [observedRun] = await tx
        .select({
          projectId: localizationJournalRuns.projectId,
          localeBranchId: localizationJournalRuns.localeBranchId,
          sourceRevisionId: localizationJournalRuns.sourceRevisionId,
        })
        .from(localizationJournalRuns)
        .where(eq(localizationJournalRuns.runId, observedPatch.runId))
        .limit(1);
      if (observedRun === undefined) {
        throw new LocalizationIterationRepositoryError(
          "invalid_input",
          `observed patch ${input.observedPatchVersionId} has no owning run`,
        );
      }
      const [contextArtifact] = await tx
        .select({
          projectId: contextArtifacts.projectId,
          localeBranchId: contextArtifacts.localeBranchId,
          sourceRevisionId: contextArtifacts.sourceRevisionId,
        })
        .from(contextArtifacts)
        .where(eq(contextArtifacts.contextArtifactId, input.contextArtifactId))
        .limit(1);
      if (
        contextArtifact === undefined ||
        contextArtifact.projectId !== observedRun.projectId ||
        contextArtifact.localeBranchId !== observedRun.localeBranchId ||
        contextArtifact.sourceRevisionId !== observedRun.sourceRevisionId
      ) {
        throw new LocalizationIterationRepositoryError(
          "invalid_input",
          `context artifact ${input.contextArtifactId} is not scoped to observed patch ${input.observedPatchVersionId}`,
        );
      }
      if (input.contextEntryVersionId !== undefined) {
        const [contextVersion] = await tx
          .select({
            contextArtifactId: contextEntryVersions.contextArtifactId,
            projectId: contextEntryVersions.projectId,
            localeBranchId: contextEntryVersions.localeBranchId,
            sourceRevisionId: contextEntryVersions.sourceRevisionId,
          })
          .from(contextEntryVersions)
          .where(eq(contextEntryVersions.contextEntryVersionId, input.contextEntryVersionId))
          .limit(1);
        if (
          contextVersion === undefined ||
          contextVersion.contextArtifactId !== input.contextArtifactId
        ) {
          throw new LocalizationIterationRepositoryError(
            "invalid_input",
            `context entry version ${input.contextEntryVersionId} does not belong to ${input.contextArtifactId}`,
          );
        }
        if (
          contextVersion.projectId !== observedRun.projectId ||
          contextVersion.localeBranchId !== observedRun.localeBranchId ||
          contextVersion.sourceRevisionId !== observedRun.sourceRevisionId
        ) {
          throw new LocalizationIterationRepositoryError(
            "invalid_input",
            `context entry version ${input.contextEntryVersionId} is not scoped to observed patch ${input.observedPatchVersionId}`,
          );
        }
      }
    }
    if (affectedBridgeUnitIds.length > 0) {
      const members = await tx
        .select({ bridgeUnitId: localizationPatchVersionUnits.bridgeUnitId })
        .from(localizationPatchVersionUnits)
        .where(
          and(
            eq(localizationPatchVersionUnits.patchVersionId, input.observedPatchVersionId),
            inArray(localizationPatchVersionUnits.bridgeUnitId, affectedBridgeUnitIds),
          ),
        );
      if (members.length !== affectedBridgeUnitIds.length) {
        throw new LocalizationIterationRepositoryError(
          "invalid_input",
          "feedback units must belong to the exact patch version observed",
        );
      }
    }
    const existing = await loadFeedbackEventInTx(tx, feedbackEventId);
    if (existing !== null) {
      const existingUnits = await loadFeedbackEventUnitsInTx(tx, feedbackEventId);
      if (
        !feedbackEventMatchesInput({
          row: existing,
          affectedBridgeUnitIds: existingUnits,
          actorUserId: actor.userId,
          feedbackBatchId,
          observedPatchVersionId: input.observedPatchVersionId,
          playSessionId: input.playSessionId ?? null,
          eventKind: input.eventKind,
          body,
          metadata,
          resultRevisionId: input.resultRevisionId ?? null,
          contextArtifactId: input.contextArtifactId ?? null,
          contextEntryVersionId: input.contextEntryVersionId ?? null,
          requestedAffectedBridgeUnitIds: affectedBridgeUnitIds,
        })
      ) {
        throw new LocalizationIterationRepositoryError(
          "feedback_event_conflict",
          `feedback event ${feedbackEventId} already has different immutable facts`,
        );
      }
      return feedbackEventFromRows(existing, existingUnits);
    }
    const now = new Date();
    await tx.insert(playTestFeedbackEvents).values({
      feedbackEventId,
      feedbackBatchId,
      observedPatchVersionId: input.observedPatchVersionId,
      playSessionId: input.playSessionId ?? null,
      actorUserId: actor.userId,
      eventKind: input.eventKind,
      body,
      metadata,
      resultRevisionId: input.resultRevisionId ?? null,
      contextArtifactId: input.contextArtifactId ?? null,
      contextEntryVersionId: input.contextEntryVersionId ?? null,
      createdAt: now,
    });
    if (affectedBridgeUnitIds.length > 0) {
      await tx.insert(playTestFeedbackEventUnits).values(
        affectedBridgeUnitIds.map((bridgeUnitId) => ({
          feedbackEventId,
          observedPatchVersionId: input.observedPatchVersionId,
          bridgeUnitId,
          createdAt: now,
        })),
      );
    }
    const event = await loadFeedbackEventInTx(tx, feedbackEventId);
    if (event === null) throw new Error("feedback event write unexpectedly disappeared");
    return feedbackEventFromRows(event, affectedBridgeUnitIds);
  }

  async loadFeedbackInbox(
    actor: AuthorizationActor,
    observedPatchVersionId: string,
  ): Promise<PlayTestFeedbackInbox> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(observedPatchVersionId, "observedPatchVersionId");
    // Feedback remains an immutable fact about the exact patch a tester
    // observed. A selected child patch nevertheless needs to expose its
    // ancestor observations so the normal "latest playable" dashboard route
    // can refine them without reopening v1. Do not rewrite the event/batch
    // observedPatchVersionId: the refinement snapshot retains that provenance
    // and validates it as an ancestor of the chosen base patch.
    const lineage = await this.db.execute(sql<{ patch_version_id: string }>`
      with recursive lineage as (
        select patch_version_id, parent_patch_version_id
        from itotori_localization_patch_versions
        where patch_version_id = ${observedPatchVersionId}
        union all
        select parent.patch_version_id, parent.parent_patch_version_id
        from itotori_localization_patch_versions parent
        join lineage child on child.parent_patch_version_id = parent.patch_version_id
      )
      select patch_version_id from lineage
    `);
    const lineagePatchVersionIds = lineage.rows
      .map((row) => row.patch_version_id)
      .filter((patchVersionId): patchVersionId is string => typeof patchVersionId === "string");
    if (lineagePatchVersionIds.length === 0) {
      return { observedPatchVersionId, batches: [] };
    }
    const [batches, events] = await Promise.all([
      this.db
        .select()
        .from(playTestFeedbackBatches)
        .where(inArray(playTestFeedbackBatches.observedPatchVersionId, lineagePatchVersionIds))
        .orderBy(
          asc(playTestFeedbackBatches.createdAt),
          asc(playTestFeedbackBatches.feedbackBatchId),
        ),
      this.db
        .select()
        .from(playTestFeedbackEvents)
        .where(inArray(playTestFeedbackEvents.observedPatchVersionId, lineagePatchVersionIds))
        .orderBy(
          asc(playTestFeedbackEvents.createdAt),
          asc(playTestFeedbackEvents.feedbackEventId),
        ),
    ]);
    const eventIds = events.map((event) => event.feedbackEventId);
    const unitRows =
      eventIds.length === 0
        ? []
        : await this.db
            .select()
            .from(playTestFeedbackEventUnits)
            .where(inArray(playTestFeedbackEventUnits.feedbackEventId, eventIds))
            .orderBy(asc(playTestFeedbackEventUnits.bridgeUnitId));
    const unitIdsByEvent = new Map<string, string[]>();
    for (const unit of unitRows) {
      const ids = unitIdsByEvent.get(unit.feedbackEventId) ?? [];
      ids.push(unit.bridgeUnitId);
      unitIdsByEvent.set(unit.feedbackEventId, ids);
    }
    const eventsByBatch = new Map<string, PlayTestFeedbackEventRecord[]>();
    for (const event of events) {
      const records = eventsByBatch.get(event.feedbackBatchId) ?? [];
      records.push(feedbackEventFromRows(event, unitIdsByEvent.get(event.feedbackEventId) ?? []));
      eventsByBatch.set(event.feedbackBatchId, records);
    }
    return {
      observedPatchVersionId,
      batches: batches.map((batch) => ({
        ...feedbackBatchFromRow(batch),
        events: eventsByBatch.get(batch.feedbackBatchId) ?? [],
      })),
    };
  }

  async startPlaySession(
    actor: AuthorizationActor,
    input: StartPlaySessionInput,
  ): Promise<PlaySessionRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.observedPatchVersionId, "observedPatchVersionId");
    const playSessionId = input.playSessionId ?? `play-session:${randomUUID()}`;
    assertNonBlank(playSessionId, "playSessionId");
    const launchDescriptor = input.launchDescriptor ?? {};
    assertJsonObject(launchDescriptor, "launchDescriptor");
    return this.db.transaction(async (tx) => {
      await requirePlayablePatchInTx(tx, input.observedPatchVersionId);
      const existing = await loadPlaySessionInTx(tx, playSessionId);
      if (existing !== null) {
        if (
          existing.observedPatchVersionId !== input.observedPatchVersionId ||
          existing.actorUserId !== actor.userId ||
          !sameJsonValue(existing.launchDescriptor, launchDescriptor)
        ) {
          throw new LocalizationIterationRepositoryError(
            "play_session_conflict",
            `play session ${playSessionId} already has different immutable facts`,
          );
        }
        return playSessionFromRow(
          existing,
          await loadQaCalloutsInTx(tx, existing.observedPatchVersionId),
        );
      }
      const startedAt = input.startedAt ?? new Date();
      const inserted = await tx
        .insert(playSessions)
        .values({
          playSessionId,
          observedPatchVersionId: input.observedPatchVersionId,
          actorUserId: actor.userId,
          status: "active",
          launchDescriptor,
          startedAt,
          endedAt: null,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .returning();
      const qaCallouts = await loadQaCalloutsInTx(tx, input.observedPatchVersionId);
      if (qaCallouts.length > 0) {
        await tx.insert(playSessionQaCallouts).values(
          qaCallouts.map((callout) => ({
            playSessionId,
            journalFindingId: callout.journalFindingId,
            presentedAt: startedAt,
          })),
        );
      }
      return playSessionFromRow(inserted[0]!, qaCallouts);
    });
  }

  async finishPlaySession(
    actor: AuthorizationActor,
    input: { playSessionId: string; status?: "completed" | "abandoned"; endedAt?: Date },
  ): Promise<PlaySessionRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.playSessionId, "playSessionId");
    const status = input.status ?? "completed";
    return this.db.transaction(async (tx) => {
      const existing = await loadPlaySessionInTx(tx, input.playSessionId);
      if (existing === null) {
        throw new LocalizationIterationRepositoryError(
          "play_session_not_found",
          `play session ${input.playSessionId} does not exist`,
        );
      }
      const endedAt = input.endedAt ?? new Date();
      if (
        existing.status !== "active" &&
        (existing.status !== status ||
          (input.endedAt !== undefined && existing.endedAt?.getTime() !== input.endedAt.getTime()))
      ) {
        throw new LocalizationIterationRepositoryError(
          "play_session_conflict",
          `play session ${input.playSessionId} is already ${existing.status}`,
        );
      }
      const row =
        existing.status === "active"
          ? (
              await tx
                .update(playSessions)
                .set({ status, endedAt, updatedAt: endedAt })
                .where(eq(playSessions.playSessionId, input.playSessionId))
                .returning()
            )[0]!
          : existing;
      return playSessionFromRow(row, await loadQaCalloutsInTx(tx, row.observedPatchVersionId));
    });
  }

  async loadPatchPlaySurface(
    actor: AuthorizationActor,
    patchVersionId: string,
  ): Promise<PatchPlaySurface | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(patchVersionId, "patchVersionId");
    const patch = await loadPatchPlaySurfaceInDb(this.db, patchVersionId);
    return patch;
  }

  async listPatchVersions(
    actor: AuthorizationActor,
    filter: { localeBranchId: string },
  ): Promise<PatchVersionIterationRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(filter.localeBranchId, "localeBranchId");
    const rows = await this.db
      .select({
        patch: localizationPatchVersions,
        basePatchVersionId: localizationJournalRuns.basePatchVersionId,
      })
      .from(localizationPatchVersions)
      .innerJoin(
        localizationJournalRuns,
        eq(localizationPatchVersions.runId, localizationJournalRuns.runId),
      )
      .where(eq(localizationJournalRuns.localeBranchId, filter.localeBranchId))
      .orderBy(asc(localizationPatchVersions.createdAt));
    return rows.map(({ patch, basePatchVersionId }) => ({
      patchVersionId: patch.patchVersionId,
      runId: patch.runId,
      parentPatchVersionId: patch.parentPatchVersionId ?? null,
      origin: patch.origin,
      status: patch.status,
      playableAt: patch.playableAt,
      selectedAt: patch.selectedAt,
      artifactHashes: { ...patch.artifactHashes },
      artifactRefs: { ...patch.artifactRefs },
      basePatchVersionId: basePatchVersionId ?? null,
    }));
  }
}

async function requirePlayablePatchInTx(tx: Tx, patchVersionId: string) {
  const [patch] = await tx
    .select()
    .from(localizationPatchVersions)
    .where(eq(localizationPatchVersions.patchVersionId, patchVersionId))
    .limit(1);
  if (patch === undefined) {
    throw new LocalizationIterationRepositoryError(
      "patch_not_found",
      `patch ${patchVersionId} does not exist`,
    );
  }
  if (patch.status !== "playable") {
    throw new LocalizationIterationRepositoryError(
      "patch_not_playable",
      `patch ${patchVersionId} is not playable`,
    );
  }
  return patch;
}

async function loadFeedbackBatchInTx(tx: Tx, feedbackBatchId: string) {
  const [row] = await tx
    .select()
    .from(playTestFeedbackBatches)
    .where(eq(playTestFeedbackBatches.feedbackBatchId, feedbackBatchId))
    .limit(1);
  return row ?? null;
}

async function loadFeedbackEventInTx(tx: Tx, feedbackEventId: string) {
  const [row] = await tx
    .select()
    .from(playTestFeedbackEvents)
    .where(eq(playTestFeedbackEvents.feedbackEventId, feedbackEventId))
    .limit(1);
  return row ?? null;
}

async function loadFeedbackEventUnitsInTx(tx: Tx, feedbackEventId: string): Promise<string[]> {
  const rows = await tx
    .select({ bridgeUnitId: playTestFeedbackEventUnits.bridgeUnitId })
    .from(playTestFeedbackEventUnits)
    .where(eq(playTestFeedbackEventUnits.feedbackEventId, feedbackEventId))
    .orderBy(asc(playTestFeedbackEventUnits.bridgeUnitId));
  return rows.map((row) => row.bridgeUnitId);
}

async function loadPlaySessionInTx(tx: Tx, playSessionId: string) {
  const [row] = await tx
    .select()
    .from(playSessions)
    .where(eq(playSessions.playSessionId, playSessionId))
    .limit(1);
  return row ?? null;
}

async function loadPatchPlaySurfaceInDb(
  db: Pick<ItotoriDatabase, "select">,
  patchVersionId: string,
): Promise<PatchPlaySurface | null> {
  const [patch] = await db
    .select()
    .from(localizationPatchVersions)
    .where(eq(localizationPatchVersions.patchVersionId, patchVersionId))
    .limit(1);
  if (patch === undefined) return null;
  const units = await db
    .select({
      bridgeUnitId: localizationPatchVersionUnits.bridgeUnitId,
      sourceRunId: localizationPatchVersionUnits.sourceRunId,
      journalOutcomeId: localizationPatchVersionUnits.journalOutcomeId,
      resultRevisionId: localizationPatchVersionUnits.resultRevisionId,
      targetBody: localizationResultRevisions.targetBody,
      memberOrigin: localizationPatchVersionUnits.memberOrigin,
      reusedFromPatchVersionId: localizationPatchVersionUnits.reusedFromPatchVersionId,
      unitOrdinal: localizationPatchVersionUnits.unitOrdinal,
    })
    .from(localizationPatchVersionUnits)
    .innerJoin(
      localizationResultRevisions,
      and(
        eq(
          localizationPatchVersionUnits.resultRevisionId,
          localizationResultRevisions.resultRevisionId,
        ),
        eq(
          localizationPatchVersionUnits.journalOutcomeId,
          localizationResultRevisions.journalOutcomeId,
        ),
        eq(localizationPatchVersionUnits.sourceRunId, localizationResultRevisions.runId),
        eq(localizationPatchVersionUnits.bridgeUnitId, localizationResultRevisions.bridgeUnitId),
      ),
    )
    .where(eq(localizationPatchVersionUnits.patchVersionId, patchVersionId))
    .orderBy(asc(localizationPatchVersionUnits.unitOrdinal));
  return {
    patchVersionId: patch.patchVersionId,
    runId: patch.runId,
    parentPatchVersionId: patch.parentPatchVersionId ?? null,
    origin: patch.origin,
    status: patch.status,
    playableAt: patch.playableAt,
    selectedAt: patch.selectedAt,
    artifactHashes: { ...patch.artifactHashes },
    artifactRefs: { ...patch.artifactRefs },
    units: units.map((unit) => ({
      ...unit,
      reusedFromPatchVersionId: unit.reusedFromPatchVersionId ?? null,
    })),
    qaCallouts: await loadQaCalloutsInDb(db, patchVersionId),
  };
}

async function loadQaCalloutsInTx(tx: Tx, patchVersionId: string): Promise<PlaySessionQaCallout[]> {
  return loadQaCalloutsInDb(tx, patchVersionId);
}

async function loadQaCalloutsInDb(
  db: Pick<ItotoriDatabase, "select"> | Tx,
  patchVersionId: string,
): Promise<PlaySessionQaCallout[]> {
  const rows = await db
    .select({
      journalFindingId: writtenQaFindings.journalFindingId,
      bridgeUnitId: localizationPatchVersionUnits.bridgeUnitId,
      severity: writtenQaFindings.severity,
      category: writtenQaFindings.category,
      note: writtenQaFindings.note,
      confidence: writtenQaFindings.confidence,
      contested: writtenQaFindings.contested,
    })
    .from(localizationPatchVersionUnits)
    .innerJoin(
      writtenQaFindings,
      eq(localizationPatchVersionUnits.journalOutcomeId, writtenQaFindings.journalOutcomeId),
    )
    .where(
      and(
        eq(localizationPatchVersionUnits.patchVersionId, patchVersionId),
        or(
          eq(writtenQaFindings.contested, true),
          lt(writtenQaFindings.confidence, PLAY_TEST_QA_LOW_CONFIDENCE_THRESHOLD),
        ),
      ),
    )
    .orderBy(asc(localizationPatchVersionUnits.unitOrdinal), asc(writtenQaFindings.findingOrdinal));
  return rows.map((row) => ({ ...row, informational: true }));
}

function feedbackBatchFromRow(
  row: typeof playTestFeedbackBatches.$inferSelect,
): PlayTestFeedbackBatchRecord {
  return {
    feedbackBatchId: row.feedbackBatchId,
    observedPatchVersionId: row.observedPatchVersionId,
    actorUserId: row.actorUserId,
    selectionKind: row.selectionKind,
    label: row.label ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function feedbackEventFromRows(
  row: typeof playTestFeedbackEvents.$inferSelect,
  affectedBridgeUnitIds: string[],
): PlayTestFeedbackEventRecord {
  return {
    feedbackEventId: row.feedbackEventId,
    feedbackBatchId: row.feedbackBatchId,
    observedPatchVersionId: row.observedPatchVersionId,
    playSessionId: row.playSessionId ?? null,
    actorUserId: row.actorUserId,
    eventKind: row.eventKind,
    body: row.body ?? null,
    metadata: { ...row.metadata },
    resultRevisionId: row.resultRevisionId ?? null,
    contextArtifactId: row.contextArtifactId ?? null,
    contextEntryVersionId: row.contextEntryVersionId ?? null,
    affectedBridgeUnitIds,
    createdAt: row.createdAt,
  };
}

function feedbackEventMatchesInput(input: {
  row: typeof playTestFeedbackEvents.$inferSelect;
  affectedBridgeUnitIds: string[];
  actorUserId: string;
  feedbackBatchId: string;
  observedPatchVersionId: string;
  playSessionId: string | null;
  eventKind: PlayTestFeedbackEventKind;
  body: string | null;
  metadata: Record<string, unknown>;
  resultRevisionId: string | null;
  contextArtifactId: string | null;
  contextEntryVersionId: string | null;
  requestedAffectedBridgeUnitIds: string[];
}): boolean {
  const { row } = input;
  return (
    row.feedbackBatchId === input.feedbackBatchId &&
    row.observedPatchVersionId === input.observedPatchVersionId &&
    row.playSessionId === input.playSessionId &&
    row.actorUserId === input.actorUserId &&
    row.eventKind === input.eventKind &&
    row.body === input.body &&
    sameJsonValue(row.metadata, input.metadata) &&
    row.resultRevisionId === input.resultRevisionId &&
    row.contextArtifactId === input.contextArtifactId &&
    row.contextEntryVersionId === input.contextEntryVersionId &&
    sameStringSet(input.affectedBridgeUnitIds, input.requestedAffectedBridgeUnitIds)
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function playSessionFromRow(
  row: typeof playSessions.$inferSelect,
  qaCallouts: PlaySessionQaCallout[],
): PlaySessionRecord {
  return {
    playSessionId: row.playSessionId,
    observedPatchVersionId: row.observedPatchVersionId,
    actorUserId: row.actorUserId,
    status: row.status,
    launchDescriptor: { ...row.launchDescriptor },
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    qaCallouts,
  };
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new LocalizationIterationRepositoryError("invalid_input", `${label} must be non-blank`);
  }
}

function assertJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalizationIterationRepositoryError("invalid_input", `${label} must be an object`);
  }
}

function uniqueNonBlank(values: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    assertNonBlank(value, `${label}[${index}]`);
    if (seen.has(value)) {
      throw new LocalizationIterationRepositoryError(
        "invalid_input",
        `${label} contains duplicate ${value}`,
      );
    }
    seen.add(value);
  }
  return [...seen];
}
