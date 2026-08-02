import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  localeBranches,
  localeBranchUnits,
  sourceBundles,
  sourceUnits,
  translationMemoryMatchKindValues,
  translationMemoryReuseEvents,
  translationMemoryReuseStatusValues,
  translationMemorySegments,
  translationMemorySegmentStatusValues,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";
import {
  assertExpectedUnitScope,
  assertReusableSegmentScope,
  boundedPositiveInteger,
  boundedScore,
  compareMatches,
  estimateTranslationMemoryCostImpact,
  getUnitContextInDb,
  lexicalSimilarityScore,
  requiredRow,
  reuseEventRecordFromRow,
  segmentRecordFromRow,
  unitContextFromRow,
} from "./translation-memory-repository-helpers.js";
import {
  translationMemoryDefaultCandidateLimit,
  translationMemoryDefaultFuzzyThreshold,
  translationMemoryDefaultScoredCandidateLimit,
  type FindTranslationMemoryMatchesInput,
  type ItotoriTranslationMemoryRepositoryPort,
  type ListTranslationMemoryPrefillTargetsInput,
  type ListTranslationMemoryReuseEventsInput,
  type ListUnitsSharingSourceInput,
  type RecordTranslationMemoryReuseInput,
  type TranslationMemoryMatchSet,
  type TranslationMemoryReuseEventRecord,
  type TranslationMemorySegmentRecord,
  TranslationMemorySourceScopeError,
  type TranslationMemoryUnitContext,
  type UnitsSharingSourceResult,
  type UpsertTranslationMemorySegmentInput,
} from "./translation-memory-repository-types.js";

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
          and ${translationMemorySegments.sourceFingerprint} = ${target.sourceFingerprint}
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
          and ${translationMemorySegments.sourceFingerprint} <> ${target.sourceFingerprint}
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
