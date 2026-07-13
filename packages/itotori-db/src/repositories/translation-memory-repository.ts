import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  localeBranches,
  localeBranchUnits,
  sourceBundles,
  sourceUnits,
  translationMemoryMatchKindValues,
  type TranslationMemoryMatchKind,
  translationMemoryReuseEvents,
  translationMemoryReuseStatusValues,
  type TranslationMemoryReuseStatus,
  translationMemorySegments,
  translationMemorySegmentStatusValues,
  type TranslationMemorySegmentStatus,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";

export const translationMemoryServiceVersion = "itotori.translation-memory.v1";
export const translationMemoryDefaultFuzzyThreshold = 720;
export const translationMemoryDefaultCandidateLimit = 20;
export const translationMemoryDefaultScoredCandidateLimit = 100;

export type TranslationMemoryDiagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  reasonCode: string;
  field?: string;
  metadata?: Record<string, unknown>;
};

export type TranslationMemorySourceScopeErrorCode =
  | "locale_branch_missing"
  | "source_unit_missing"
  | "stale_source_revision"
  | "stale_source_hash"
  | "target_locale_mismatch"
  | "memory_segment_missing"
  | "memory_segment_scope_mismatch"
  | "existing_target_text";

export class TranslationMemorySourceScopeError extends Error {
  constructor(
    readonly code: TranslationMemorySourceScopeErrorCode,
    message: string,
    readonly metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TranslationMemorySourceScopeError";
  }
}

export type TranslationMemoryJsonRecord = Record<string, unknown>;

export type TranslationMemoryReuseCostImpact = {
  providerCallAvoided: boolean;
  estimatedPromptTokensSaved: number;
  estimatedCompletionTokensSaved: number;
  estimatedTotalTokensSaved: number;
  estimatedCostUsdSaved: string | null;
  calculation: "deterministic_character_estimate_v1";
};

export type TranslationMemoryUnitContext = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  bridgeUnitId: string;
  sourceRevisionId: string;
  sourceUnitKey: string;
  sourceOccurrenceId: string;
  sourceHash: string;
  sourceFingerprint: string;
  sourceText: string;
  currentTargetText: string | null;
};

export type TranslationMemorySegmentRecord = {
  memorySegmentId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sourceBridgeUnitId: string | null;
  sourceUnitKey: string;
  sourceOccurrenceId: string;
  sourceHash: string;
  sourceFingerprint: string;
  sourceText: string;
  targetLocale: string;
  targetText: string;
  status: TranslationMemorySegmentStatus;
  provenance: TranslationMemoryJsonRecord;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TranslationMemoryMatchRecord = TranslationMemorySegmentRecord & {
  matchKind: TranslationMemoryMatchKind;
  matchScore: number;
};

export type TranslationMemoryMatchSet = {
  target: TranslationMemoryUnitContext;
  matches: TranslationMemoryMatchRecord[];
};

export type TranslationMemoryReuseEventRecord = {
  reuseEventId: string;
  projectId: string;
  localeBranchId: string;
  targetBridgeUnitId: string;
  sourceRevisionId: string;
  memorySegmentId: string;
  matchKind: TranslationMemoryMatchKind;
  matchScore: number;
  reuseStatus: TranslationMemoryReuseStatus;
  sourceHash: string;
  candidateSourceHash: string;
  targetText: string;
  provenance: TranslationMemoryJsonRecord;
  costImpact: TranslationMemoryReuseCostImpact;
  createdByUserId: string | null;
  createdAt: Date;
};

export type UpsertTranslationMemorySegmentInput = {
  projectId: string;
  localeBranchId: string;
  sourceBridgeUnitId: string;
  targetText: string;
  memorySegmentId?: string;
  status?: TranslationMemorySegmentStatus;
  provenance?: TranslationMemoryJsonRecord;
  expectedSourceRevisionId?: string;
  expectedSourceHash?: string;
  expectedTargetLocale?: string;
};

export type FindTranslationMemoryMatchesInput = {
  projectId: string;
  localeBranchId: string;
  requestedTargetLocale: string;
  targetBridgeUnitId: string;
  includeFuzzy?: boolean;
  minFuzzyScore?: number;
  candidateLimit?: number;
  scoredCandidateLimit?: number;
};

export type ListTranslationMemoryPrefillTargetsInput = {
  projectId: string;
  localeBranchId: string;
  bridgeUnitIds?: readonly string[];
  includeExistingTargets?: boolean;
};

export type RecordTranslationMemoryReuseInput = {
  projectId: string;
  localeBranchId: string;
  requestedTargetLocale: string;
  targetBridgeUnitId: string;
  memorySegmentId: string;
  matchKind: TranslationMemoryMatchKind;
  matchScore: number;
  reuseEventId?: string;
  reuseStatus?: TranslationMemoryReuseStatus;
  applyDraft: boolean;
  overwriteExistingTarget?: boolean;
  provenance?: TranslationMemoryJsonRecord;
  costImpact?: TranslationMemoryReuseCostImpact;
};

export type ListTranslationMemoryReuseEventsInput = {
  projectId: string;
  localeBranchId: string;
  targetBridgeUnitId?: string;
};

export type ListUnitsSharingSourceInput = {
  projectId: string;
  localeBranchId: string;
  bridgeUnitId: string;
};

/**
 * The set of locale-branch units that share a source segment with a given
 * bridge unit — i.e. every unit whose next draft a canonical correction on
 * that unit should propagate to via translation-memory reuse. `bridgeUnitIds`
 * always includes the anchor unit itself.
 */
export type UnitsSharingSourceResult = {
  sourceRevisionId: string;
  sourceHash: string;
  bridgeUnitIds: string[];
};

export interface ItotoriTranslationMemoryRepositoryPort {
  upsertSegment(
    actor: AuthorizationActor,
    input: UpsertTranslationMemorySegmentInput,
  ): Promise<TranslationMemorySegmentRecord>;
  findReusableSegments(
    input: FindTranslationMemoryMatchesInput,
  ): Promise<TranslationMemoryMatchSet | null>;
  listPrefillTargets(
    input: ListTranslationMemoryPrefillTargetsInput,
  ): Promise<TranslationMemoryUnitContext[]>;
  recordReuse(
    actor: AuthorizationActor,
    input: RecordTranslationMemoryReuseInput,
  ): Promise<TranslationMemoryReuseEventRecord>;
  listReuseEvents(
    input: ListTranslationMemoryReuseEventsInput,
  ): Promise<TranslationMemoryReuseEventRecord[]>;
  listUnitsSharingSource(
    input: ListUnitsSharingSourceInput,
  ): Promise<UnitsSharingSourceResult | null>;
}

export class ItotoriTranslationMemoryRepository implements ItotoriTranslationMemoryRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async upsertSegment(
    actor: AuthorizationActor,
    input: UpsertTranslationMemorySegmentInput,
  ): Promise<TranslationMemorySegmentRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const context = await this.getUnitContext(
      input.projectId,
      input.localeBranchId,
      input.sourceBridgeUnitId,
    );
    if (context === null) {
      throw new TranslationMemorySourceScopeError(
        "source_unit_missing",
        "translation memory source unit is not in the current locale branch source bundle",
        {
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceBridgeUnitId: input.sourceBridgeUnitId,
        },
      );
    }
    assertExpectedUnitScope(context, input);

    const memorySegmentId = input.memorySegmentId ?? createUuid7();
    const status = input.status ?? translationMemorySegmentStatusValues.reusable;
    const provenance = input.provenance ?? {};
    const rows = await this.db
      .insert(translationMemorySegments)
      .values({
        memorySegmentId,
        projectId: context.projectId,
        localeBranchId: context.localeBranchId,
        sourceRevisionId: context.sourceRevisionId,
        sourceBridgeUnitId: context.bridgeUnitId,
        sourceUnitKey: context.sourceUnitKey,
        sourceOccurrenceId: context.sourceOccurrenceId,
        sourceHash: context.sourceHash,
        sourceFingerprint: context.sourceFingerprint,
        sourceText: context.sourceText,
        targetLocale: context.targetLocale,
        targetText: input.targetText,
        status,
        provenance,
        createdByUserId: actor.userId,
      })
      .onConflictDoUpdate({
        target: translationMemorySegments.memorySegmentId,
        set: {
          projectId: context.projectId,
          localeBranchId: context.localeBranchId,
          sourceRevisionId: context.sourceRevisionId,
          sourceBridgeUnitId: context.bridgeUnitId,
          sourceUnitKey: context.sourceUnitKey,
          sourceOccurrenceId: context.sourceOccurrenceId,
          sourceHash: context.sourceHash,
          sourceFingerprint: context.sourceFingerprint,
          sourceText: context.sourceText,
          targetLocale: context.targetLocale,
          targetText: input.targetText,
          status,
          provenance,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    return segmentRecordFromRow(requiredRow(rows, "translation memory segment"));
  }

  async findReusableSegments(
    input: FindTranslationMemoryMatchesInput,
  ): Promise<TranslationMemoryMatchSet | null> {
    const target = await this.getUnitContext(
      input.projectId,
      input.localeBranchId,
      input.targetBridgeUnitId,
    );
    if (target === null) {
      return null;
    }
    if (target.targetLocale !== input.requestedTargetLocale) {
      return { target, matches: [] };
    }

    const candidateLimit = boundedPositiveInteger(
      input.candidateLimit,
      translationMemoryDefaultCandidateLimit,
      100,
    );
    const exactRows = await this.db
      .select()
      .from(translationMemorySegments)
      .where(
        sql`${translationMemorySegments.projectId} = ${target.projectId}
          and ${translationMemorySegments.localeBranchId} = ${target.localeBranchId}
          and ${translationMemorySegments.sourceRevisionId} = ${target.sourceRevisionId}
          and ${translationMemorySegments.sourceHash} = ${target.sourceHash}
          and ${translationMemorySegments.targetLocale} = ${input.requestedTargetLocale}
          and ${translationMemorySegments.status} = ${translationMemorySegmentStatusValues.reusable}`,
      )
      .orderBy(
        asc(translationMemorySegments.sourceUnitKey),
        asc(translationMemorySegments.sourceOccurrenceId),
        asc(translationMemorySegments.memorySegmentId),
      )
      .limit(candidateLimit);

    const exactMatches = exactRows.map((row) => ({
      ...segmentRecordFromRow(row),
      matchKind: translationMemoryMatchKindValues.exact,
      matchScore: 1000,
    }));

    if (input.includeFuzzy !== true || exactMatches.length >= candidateLimit) {
      return { target, matches: exactMatches };
    }

    const scoredCandidateLimit = boundedPositiveInteger(
      input.scoredCandidateLimit,
      translationMemoryDefaultScoredCandidateLimit,
      500,
    );
    const fuzzyRows = await this.db
      .select()
      .from(translationMemorySegments)
      .where(
        sql`${translationMemorySegments.projectId} = ${target.projectId}
          and ${translationMemorySegments.localeBranchId} = ${target.localeBranchId}
          and ${translationMemorySegments.sourceRevisionId} = ${target.sourceRevisionId}
          and ${translationMemorySegments.sourceHash} <> ${target.sourceHash}
          and ${translationMemorySegments.targetLocale} = ${input.requestedTargetLocale}
          and ${translationMemorySegments.status} = ${translationMemorySegmentStatusValues.reusable}`,
      )
      .orderBy(
        asc(translationMemorySegments.sourceFingerprint),
        asc(translationMemorySegments.sourceUnitKey),
        asc(translationMemorySegments.sourceOccurrenceId),
        asc(translationMemorySegments.memorySegmentId),
      )
      .limit(scoredCandidateLimit);

    const minFuzzyScore = boundedScore(input.minFuzzyScore, translationMemoryDefaultFuzzyThreshold);
    const fuzzyMatches = fuzzyRows
      .map((row) => {
        const segment = segmentRecordFromRow(row);
        return {
          ...segment,
          matchKind: translationMemoryMatchKindValues.fuzzy,
          matchScore: lexicalSimilarityScore(target.sourceText, segment.sourceText),
        };
      })
      .filter((match) => match.matchScore >= minFuzzyScore)
      .sort(compareMatches);

    return {
      target,
      matches: [...exactMatches, ...fuzzyMatches].slice(0, candidateLimit),
    };
  }

  async listPrefillTargets(
    input: ListTranslationMemoryPrefillTargetsInput,
  ): Promise<TranslationMemoryUnitContext[]> {
    const conditions = [
      eq(localeBranches.projectId, input.projectId),
      eq(localeBranches.localeBranchId, input.localeBranchId),
      sql`${sourceUnits.sourceBundleId} = ${localeBranches.sourceBundleId}`,
    ];
    if (input.includeExistingTargets !== true) {
      conditions.push(isNull(localeBranchUnits.targetText));
    }
    if (input.bridgeUnitIds !== undefined && input.bridgeUnitIds.length > 0) {
      conditions.push(inArray(sourceUnits.bridgeUnitId, [...input.bridgeUnitIds]));
    }

    const rows = await this.db
      .select({
        projectId: localeBranches.projectId,
        localeBranchId: localeBranches.localeBranchId,
        targetLocale: localeBranches.targetLocale,
        bridgeUnitId: sourceUnits.bridgeUnitId,
        sourceRevisionId: sourceBundles.sourceBundleRevisionId,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        sourceOccurrenceId: sourceUnits.occurrenceId,
        sourceHash: sourceUnits.sourceHash,
        sourceText: sourceUnits.sourceText,
        currentTargetText: localeBranchUnits.targetText,
      })
      .from(localeBranches)
      .innerJoin(
        localeBranchUnits,
        eq(localeBranchUnits.localeBranchId, localeBranches.localeBranchId),
      )
      .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
      .innerJoin(sourceUnits, eq(sourceUnits.bridgeUnitId, localeBranchUnits.bridgeUnitId))
      .where(and(...conditions))
      .orderBy(asc(sourceUnits.sourceUnitKey), asc(sourceUnits.occurrenceId));

    return rows.map(unitContextFromRow);
  }

  async recordReuse(
    actor: AuthorizationActor,
    input: RecordTranslationMemoryReuseInput,
  ): Promise<TranslationMemoryReuseEventRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    return await this.db.transaction(async (tx) => {
      const target = await getUnitContextInDb(
        tx,
        input.projectId,
        input.localeBranchId,
        input.targetBridgeUnitId,
      );
      if (target === null) {
        throw new TranslationMemorySourceScopeError(
          "source_unit_missing",
          "translation memory target unit is not in the current locale branch source bundle",
          {
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            targetBridgeUnitId: input.targetBridgeUnitId,
          },
        );
      }
      if (target.targetLocale !== input.requestedTargetLocale) {
        throw new TranslationMemorySourceScopeError(
          "target_locale_mismatch",
          "translation memory reuse target locale does not match the requested target locale",
          {
            requestedTargetLocale: input.requestedTargetLocale,
            currentTargetLocale: target.targetLocale,
          },
        );
      }
      if (
        input.applyDraft &&
        input.overwriteExistingTarget !== true &&
        target.currentTargetText !== null
      ) {
        throw new TranslationMemorySourceScopeError(
          "existing_target_text",
          "translation memory prefill refused to overwrite existing target text",
          {
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            targetBridgeUnitId: input.targetBridgeUnitId,
          },
        );
      }

      const segmentRows = await tx
        .select()
        .from(translationMemorySegments)
        .where(eq(translationMemorySegments.memorySegmentId, input.memorySegmentId))
        .limit(1);
      const segment = segmentRows[0];
      if (segment === undefined) {
        throw new TranslationMemorySourceScopeError(
          "memory_segment_missing",
          "translation memory segment does not exist",
          { memorySegmentId: input.memorySegmentId },
        );
      }
      assertReusableSegmentScope(
        target,
        segmentRecordFromRow(segment),
        input.requestedTargetLocale,
      );

      if (input.applyDraft) {
        await tx
          .update(localeBranchUnits)
          .set({ targetText: segment.targetText, updatedAt: sql`now()` })
          .where(
            sql`${localeBranchUnits.localeBranchId} = ${target.localeBranchId}
              and ${localeBranchUnits.bridgeUnitId} = ${target.bridgeUnitId}`,
          );
      }

      const reuseStatus =
        input.reuseStatus ??
        (input.applyDraft
          ? translationMemoryReuseStatusValues.applied
          : translationMemoryReuseStatusValues.suggested);
      const costImpact =
        input.costImpact ??
        estimateTranslationMemoryCostImpact(
          target.sourceText,
          segment.targetText,
          input.applyDraft,
        );
      const provenance = input.provenance ?? {};
      const rows = await tx
        .insert(translationMemoryReuseEvents)
        .values({
          reuseEventId: input.reuseEventId ?? createUuid7(),
          projectId: target.projectId,
          localeBranchId: target.localeBranchId,
          targetBridgeUnitId: target.bridgeUnitId,
          sourceRevisionId: target.sourceRevisionId,
          memorySegmentId: segment.memorySegmentId,
          matchKind: input.matchKind,
          matchScore: input.matchScore,
          reuseStatus,
          sourceHash: target.sourceHash,
          candidateSourceHash: segment.sourceHash,
          targetText: segment.targetText,
          provenance,
          costImpact,
          createdByUserId: actor.userId,
        })
        .returning();

      return reuseEventRecordFromRow(requiredRow(rows, "translation memory reuse event"));
    });
  }

  async listReuseEvents(
    input: ListTranslationMemoryReuseEventsInput,
  ): Promise<TranslationMemoryReuseEventRecord[]> {
    const rows = await this.db
      .select()
      .from(translationMemoryReuseEvents)
      .where(
        sql`${translationMemoryReuseEvents.projectId} = ${input.projectId}
          and ${translationMemoryReuseEvents.localeBranchId} = ${input.localeBranchId}
          ${
            input.targetBridgeUnitId === undefined
              ? sql``
              : sql`and ${translationMemoryReuseEvents.targetBridgeUnitId} = ${input.targetBridgeUnitId}`
          }`,
      )
      .orderBy(
        asc(translationMemoryReuseEvents.createdAt),
        asc(translationMemoryReuseEvents.reuseEventId),
      );

    return rows.map(reuseEventRecordFromRow);
  }

  async listUnitsSharingSource(
    input: ListUnitsSharingSourceInput,
  ): Promise<UnitsSharingSourceResult | null> {
    const anchor = await this.getUnitContext(
      input.projectId,
      input.localeBranchId,
      input.bridgeUnitId,
    );
    if (anchor === null) {
      return null;
    }
    const rows = await this.db
      .select({ bridgeUnitId: sourceUnits.bridgeUnitId })
      .from(localeBranches)
      .innerJoin(
        localeBranchUnits,
        eq(localeBranchUnits.localeBranchId, localeBranches.localeBranchId),
      )
      .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
      .innerJoin(sourceUnits, eq(sourceUnits.bridgeUnitId, localeBranchUnits.bridgeUnitId))
      .where(
        sql`${localeBranches.projectId} = ${input.projectId}
          and ${localeBranches.localeBranchId} = ${input.localeBranchId}
          and ${sourceUnits.sourceBundleId} = ${localeBranches.sourceBundleId}
          and ${sourceUnits.sourceHash} = ${anchor.sourceHash}`,
      )
      .orderBy(asc(sourceUnits.bridgeUnitId));
    const bridgeUnitIds = [...new Set(rows.map((row) => row.bridgeUnitId))].sort((a, b) =>
      a.localeCompare(b),
    );
    return {
      sourceRevisionId: anchor.sourceRevisionId,
      sourceHash: anchor.sourceHash,
      bridgeUnitIds,
    };
  }

  private async getUnitContext(
    projectId: string,
    localeBranchId: string,
    bridgeUnitId: string,
  ): Promise<TranslationMemoryUnitContext | null> {
    return await getUnitContextInDb(this.db, projectId, localeBranchId, bridgeUnitId);
  }
}

export type PrefillTranslationMemoryDraftsInput = {
  projectId: string;
  localeBranchId: string;
  requestedTargetLocale: string;
  bridgeUnitIds?: readonly string[];
  applyDrafts?: boolean;
  includeExistingTargets?: boolean;
  includeFuzzy?: boolean;
  minFuzzyScore?: number;
  candidateLimit?: number;
  scoredCandidateLimit?: number;
  requestId?: string;
};

export type TranslationMemoryPrefillReuse = {
  target: TranslationMemoryUnitContext;
  match: TranslationMemoryMatchRecord;
  event: TranslationMemoryReuseEventRecord;
};

export type TranslationMemoryPrefillSkip = {
  target: TranslationMemoryUnitContext;
  reasonCode: "no_reusable_segment" | "existing_target_text" | "target_locale_mismatch";
};

export type TranslationMemoryPrefillResult = {
  status: "completed" | "invalid";
  diagnostics: TranslationMemoryDiagnostic[];
  appliedCount: number;
  suggestedCount: number;
  skippedCount: number;
  reuses: TranslationMemoryPrefillReuse[];
  skipped: TranslationMemoryPrefillSkip[];
};

export class ItotoriTranslationMemoryService {
  constructor(private readonly repository: ItotoriTranslationMemoryRepositoryPort) {}

  async prefillDrafts(
    actor: AuthorizationActor,
    input: PrefillTranslationMemoryDraftsInput,
  ): Promise<TranslationMemoryPrefillResult> {
    const applyDrafts = input.applyDrafts ?? true;
    const targets = await this.repository.listPrefillTargets({
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      ...(input.bridgeUnitIds === undefined ? {} : { bridgeUnitIds: input.bridgeUnitIds }),
      ...(input.includeExistingTargets === undefined
        ? {}
        : { includeExistingTargets: input.includeExistingTargets }),
    });
    if (
      input.bridgeUnitIds !== undefined &&
      input.bridgeUnitIds.length > 0 &&
      targets.length === 0
    ) {
      return invalidPrefill(
        diagnostic(
          "translation_memory.locale_branch_or_units.missing",
          "error",
          "no current locale branch source units matched the prefill request",
          "missing_current_branch_units",
          "$.bridgeUnitIds",
          {
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            bridgeUnitIds: [...input.bridgeUnitIds],
          },
        ),
      );
    }

    const reuses: TranslationMemoryPrefillReuse[] = [];
    const skipped: TranslationMemoryPrefillSkip[] = [];
    const diagnostics: TranslationMemoryDiagnostic[] = [];

    for (const target of targets) {
      if (target.currentTargetText !== null && input.includeExistingTargets === true) {
        skipped.push({ target, reasonCode: "existing_target_text" });
        continue;
      }
      if (target.targetLocale !== input.requestedTargetLocale) {
        skipped.push({ target, reasonCode: "target_locale_mismatch" });
        continue;
      }

      const matchSet = await this.repository.findReusableSegments({
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        requestedTargetLocale: input.requestedTargetLocale,
        targetBridgeUnitId: target.bridgeUnitId,
        ...(input.includeFuzzy === undefined ? {} : { includeFuzzy: input.includeFuzzy }),
        ...(input.minFuzzyScore === undefined ? {} : { minFuzzyScore: input.minFuzzyScore }),
        ...(input.candidateLimit === undefined ? {} : { candidateLimit: input.candidateLimit }),
        ...(input.scoredCandidateLimit === undefined
          ? {}
          : { scoredCandidateLimit: input.scoredCandidateLimit }),
      });
      const match = matchSet?.matches[0];
      if (match === undefined) {
        skipped.push({ target, reasonCode: "no_reusable_segment" });
        continue;
      }

      const event = await this.repository.recordReuse(actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        requestedTargetLocale: input.requestedTargetLocale,
        targetBridgeUnitId: target.bridgeUnitId,
        memorySegmentId: match.memorySegmentId,
        matchKind: match.matchKind,
        matchScore: match.matchScore,
        applyDraft: applyDrafts,
        provenance: {
          schemaVersion: translationMemoryServiceVersion,
          requestId: input.requestId ?? null,
          selectedMemorySegmentId: match.memorySegmentId,
          selectedSourceBridgeUnitId: match.sourceBridgeUnitId,
          selectedSourceUnitKey: match.sourceUnitKey,
          selectedSourceOccurrenceId: match.sourceOccurrenceId,
          targetSourceUnitKey: target.sourceUnitKey,
        },
      });
      reuses.push({ target, match, event });
    }

    if (skipped.length > 0) {
      diagnostics.push(
        diagnostic(
          "translation_memory.prefill.skipped_units",
          "info",
          "some current source units had no applicable translation memory prefill",
          "skipped_units",
          undefined,
          {
            skippedCount: skipped.length,
            reasons: skipped.map((entry) => entry.reasonCode),
          },
        ),
      );
    }

    return {
      status: "completed",
      diagnostics,
      appliedCount: applyDrafts ? reuses.length : 0,
      suggestedCount: applyDrafts ? 0 : reuses.length,
      skippedCount: skipped.length,
      reuses,
      skipped,
    };
  }
}

export function translationMemorySourceFingerprint(sourceText: string): string {
  return normalizeTranslationMemoryText(sourceText);
}

export function lexicalSimilarityScore(left: string, right: string): number {
  const normalizedLeft = compactForSimilarity(left);
  const normalizedRight = compactForSimilarity(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return normalizedLeft === normalizedRight ? 1000 : 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1000;
  }

  const leftGrams = ngramCounts(normalizedLeft);
  const rightGrams = ngramCounts(normalizedRight);
  let intersection = 0;
  for (const [gram, leftCount] of leftGrams.entries()) {
    const rightCount = rightGrams.get(gram);
    if (rightCount !== undefined) {
      intersection += Math.min(leftCount, rightCount);
    }
  }

  const denominator = countTotal(leftGrams) + countTotal(rightGrams);
  return denominator === 0 ? 0 : Math.round((2000 * intersection) / denominator);
}

export function estimateTranslationMemoryCostImpact(
  sourceText: string,
  targetText: string,
  providerCallAvoided: boolean,
): TranslationMemoryReuseCostImpact {
  const estimatedPromptTokensSaved = estimateTokenCount(sourceText);
  const estimatedCompletionTokensSaved = estimateTokenCount(targetText);
  return {
    providerCallAvoided,
    estimatedPromptTokensSaved,
    estimatedCompletionTokensSaved,
    estimatedTotalTokensSaved: estimatedPromptTokensSaved + estimatedCompletionTokensSaved,
    estimatedCostUsdSaved: null,
    calculation: "deterministic_character_estimate_v1",
  };
}

type TranslationMemorySegmentRow = typeof translationMemorySegments.$inferSelect;
type TranslationMemoryReuseEventRow = typeof translationMemoryReuseEvents.$inferSelect;
type TranslationMemoryDb = Pick<ItotoriDatabase, "select" | "insert" | "update">;
type UnitContextRow = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  bridgeUnitId: string;
  sourceRevisionId: string;
  sourceUnitKey: string;
  sourceOccurrenceId: string;
  sourceHash: string;
  sourceText: string;
  currentTargetText: string | null;
};

async function getUnitContextInDb(
  db: TranslationMemoryDb,
  projectId: string,
  localeBranchId: string,
  bridgeUnitId: string,
): Promise<TranslationMemoryUnitContext | null> {
  const rows = await db
    .select({
      projectId: localeBranches.projectId,
      localeBranchId: localeBranches.localeBranchId,
      targetLocale: localeBranches.targetLocale,
      bridgeUnitId: sourceUnits.bridgeUnitId,
      sourceRevisionId: sourceBundles.sourceBundleRevisionId,
      sourceUnitKey: sourceUnits.sourceUnitKey,
      sourceOccurrenceId: sourceUnits.occurrenceId,
      sourceHash: sourceUnits.sourceHash,
      sourceText: sourceUnits.sourceText,
      currentTargetText: localeBranchUnits.targetText,
    })
    .from(localeBranches)
    .innerJoin(
      localeBranchUnits,
      eq(localeBranchUnits.localeBranchId, localeBranches.localeBranchId),
    )
    .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
    .innerJoin(sourceUnits, eq(sourceUnits.bridgeUnitId, localeBranchUnits.bridgeUnitId))
    .where(
      sql`${localeBranches.projectId} = ${projectId}
        and ${localeBranches.localeBranchId} = ${localeBranchId}
        and ${sourceUnits.bridgeUnitId} = ${bridgeUnitId}
        and ${sourceUnits.sourceBundleId} = ${localeBranches.sourceBundleId}`,
    )
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : unitContextFromRow(row);
}

function unitContextFromRow(row: UnitContextRow): TranslationMemoryUnitContext {
  return {
    ...row,
    sourceFingerprint: translationMemorySourceFingerprint(row.sourceText),
  };
}

function assertExpectedUnitScope(
  context: TranslationMemoryUnitContext,
  input: UpsertTranslationMemorySegmentInput,
): void {
  if (
    input.expectedSourceRevisionId !== undefined &&
    input.expectedSourceRevisionId !== context.sourceRevisionId
  ) {
    throw new TranslationMemorySourceScopeError(
      "stale_source_revision",
      "translation memory source revision is stale for this locale branch",
      {
        expectedSourceRevisionId: input.expectedSourceRevisionId,
        currentSourceRevisionId: context.sourceRevisionId,
      },
    );
  }
  if (input.expectedSourceHash !== undefined && input.expectedSourceHash !== context.sourceHash) {
    throw new TranslationMemorySourceScopeError(
      "stale_source_hash",
      "translation memory source hash is stale for this locale branch unit",
      {
        expectedSourceHash: input.expectedSourceHash,
        currentSourceHash: context.sourceHash,
      },
    );
  }
  if (
    input.expectedTargetLocale !== undefined &&
    input.expectedTargetLocale !== context.targetLocale
  ) {
    throw new TranslationMemorySourceScopeError(
      "target_locale_mismatch",
      "translation memory target locale does not match the locale branch",
      {
        expectedTargetLocale: input.expectedTargetLocale,
        currentTargetLocale: context.targetLocale,
      },
    );
  }
}

function assertReusableSegmentScope(
  target: TranslationMemoryUnitContext,
  segment: TranslationMemorySegmentRecord,
  requestedTargetLocale: string,
): void {
  if (
    segment.projectId !== target.projectId ||
    segment.localeBranchId !== target.localeBranchId ||
    segment.sourceRevisionId !== target.sourceRevisionId ||
    segment.status !== translationMemorySegmentStatusValues.reusable
  ) {
    throw new TranslationMemorySourceScopeError(
      "memory_segment_scope_mismatch",
      "translation memory segment is not reusable for the target locale branch source revision",
      {
        targetProjectId: target.projectId,
        segmentProjectId: segment.projectId,
        targetLocaleBranchId: target.localeBranchId,
        segmentLocaleBranchId: segment.localeBranchId,
        targetSourceRevisionId: target.sourceRevisionId,
        segmentSourceRevisionId: segment.sourceRevisionId,
        segmentStatus: segment.status,
      },
    );
  }
  if (
    target.targetLocale !== requestedTargetLocale ||
    segment.targetLocale !== requestedTargetLocale
  ) {
    throw new TranslationMemorySourceScopeError(
      "target_locale_mismatch",
      "translation memory segment target locale does not match the requested target locale",
      {
        requestedTargetLocale,
        targetLocale: target.targetLocale,
        segmentTargetLocale: segment.targetLocale,
      },
    );
  }
}

function segmentRecordFromRow(row: TranslationMemorySegmentRow): TranslationMemorySegmentRecord {
  return {
    memorySegmentId: row.memorySegmentId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    sourceBridgeUnitId: row.sourceBridgeUnitId,
    sourceUnitKey: row.sourceUnitKey,
    sourceOccurrenceId: row.sourceOccurrenceId,
    sourceHash: row.sourceHash,
    sourceFingerprint: row.sourceFingerprint,
    sourceText: row.sourceText,
    targetLocale: row.targetLocale,
    targetText: row.targetText,
    status: statusFromString(row.status),
    provenance: row.provenance,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reuseEventRecordFromRow(
  row: TranslationMemoryReuseEventRow,
): TranslationMemoryReuseEventRecord {
  return {
    reuseEventId: row.reuseEventId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    targetBridgeUnitId: row.targetBridgeUnitId,
    sourceRevisionId: row.sourceRevisionId,
    memorySegmentId: row.memorySegmentId,
    matchKind: matchKindFromString(row.matchKind),
    matchScore: row.matchScore,
    reuseStatus: reuseStatusFromString(row.reuseStatus),
    sourceHash: row.sourceHash,
    candidateSourceHash: row.candidateSourceHash,
    targetText: row.targetText,
    provenance: row.provenance,
    costImpact: costImpactFromJson(row.costImpact),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

function compareMatches(
  left: TranslationMemoryMatchRecord,
  right: TranslationMemoryMatchRecord,
): number {
  return (
    right.matchScore - left.matchScore ||
    left.sourceUnitKey.localeCompare(right.sourceUnitKey) ||
    left.sourceOccurrenceId.localeCompare(right.sourceOccurrenceId) ||
    left.memorySegmentId.localeCompare(right.memorySegmentId)
  );
}

function normalizeTranslationMemoryText(sourceText: string): string {
  return sourceText.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function compactForSimilarity(sourceText: string): string {
  return normalizeTranslationMemoryText(sourceText).replace(/\s+/gu, "");
}

function ngramCounts(value: string): Map<string, number> {
  const characters = [...value];
  const size = characters.length < 5 ? 2 : 3;
  const grams = new Map<string, number>();
  if (characters.length <= size) {
    grams.set(value, 1);
    return grams;
  }
  for (let index = 0; index <= characters.length - size; index += 1) {
    const gram = characters.slice(index, index + size).join("");
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function countTotal(counts: Map<string, number>): number {
  let total = 0;
  for (const value of counts.values()) {
    total += value;
  }
  return total;
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 4));
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, maximum);
}

function boundedScore(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(1000, Math.max(0, value));
}

function statusFromString(value: string): TranslationMemorySegmentStatus {
  if (
    value === translationMemorySegmentStatusValues.reusable ||
    value === translationMemorySegmentStatusValues.blocked
  ) {
    return value;
  }
  throw new Error(`unknown translation memory segment status: ${value}`);
}

function matchKindFromString(value: string): TranslationMemoryMatchKind {
  if (
    value === translationMemoryMatchKindValues.exact ||
    value === translationMemoryMatchKindValues.fuzzy
  ) {
    return value;
  }
  throw new Error(`unknown translation memory match kind: ${value}`);
}

function reuseStatusFromString(value: string): TranslationMemoryReuseStatus {
  if (
    value === translationMemoryReuseStatusValues.suggested ||
    value === translationMemoryReuseStatusValues.applied
  ) {
    return value;
  }
  throw new Error(`unknown translation memory reuse status: ${value}`);
}

function costImpactFromJson(value: Record<string, unknown>): TranslationMemoryReuseCostImpact {
  return {
    providerCallAvoided: booleanValue(value.providerCallAvoided),
    estimatedPromptTokensSaved: numberValue(value.estimatedPromptTokensSaved),
    estimatedCompletionTokensSaved: numberValue(value.estimatedCompletionTokensSaved),
    estimatedTotalTokensSaved: numberValue(value.estimatedTotalTokensSaved),
    estimatedCostUsdSaved:
      value.estimatedCostUsdSaved === null || typeof value.estimatedCostUsdSaved === "string"
        ? value.estimatedCostUsdSaved
        : null,
    calculation: "deterministic_character_estimate_v1",
  };
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requiredRow<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label} row`);
  }
  return row;
}

function diagnostic(
  code: string,
  severity: TranslationMemoryDiagnostic["severity"],
  message: string,
  reasonCode: string,
  field?: string,
  metadata?: Record<string, unknown>,
): TranslationMemoryDiagnostic {
  return {
    code,
    severity,
    message,
    reasonCode,
    ...(field === undefined ? {} : { field }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function invalidPrefill(
  diagnosticEntry: TranslationMemoryDiagnostic,
): TranslationMemoryPrefillResult {
  return {
    status: "invalid",
    diagnostics: [diagnosticEntry],
    appliedCount: 0,
    suggestedCount: 0,
    skippedCount: 0,
    reuses: [],
    skipped: [],
  };
}
