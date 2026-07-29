import { eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
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
import {
  type TranslationMemoryMatchRecord,
  type TranslationMemoryReuseCostImpact,
  type TranslationMemoryReuseEventRecord,
  type TranslationMemorySegmentRecord,
  TranslationMemorySourceScopeError,
  type TranslationMemoryUnitContext,
  type UpsertTranslationMemorySegmentInput,
} from "./translation-memory-repository-types.js";

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

export async function getUnitContextInDb(
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

export function assertExpectedUnitScope(
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

export function assertReusableSegmentScope(
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

export function segmentRecordFromRow(
  row: TranslationMemorySegmentRow,
): TranslationMemorySegmentRecord {
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

export function reuseEventRecordFromRow(
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

export function compareMatches(
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

export function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, maximum);
}

export function boundedScore(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(1000, Math.max(0, value));
}

export function requiredRow<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label} row`);
  }
  return row;
}

export function unitContextFromRow(row: UnitContextRow): TranslationMemoryUnitContext {
  return {
    ...row,
    sourceFingerprint: translationMemorySourceFingerprint(row.sourceText),
  };
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
