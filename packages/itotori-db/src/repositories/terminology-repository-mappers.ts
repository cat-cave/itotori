import {
  terminologyAliases,
  terminologyConflicts,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferences,
  terminologyTerms,
  type TerminologyAliasKind,
  type TerminologyConflictKind,
  type TerminologyConflictStatus,
  type TerminologySemanticIndexStatus,
  type TerminologySourceReferenceKind,
  type TerminologyTermKind,
  type TerminologyTermStatus,
} from "../schema.js";
import type {
  TerminologyAliasRecord,
  TerminologyConflictRecord,
  TerminologySemanticIndexRecord,
  TerminologySourceReferenceRecord,
  TerminologyTermRecord,
} from "./terminology-repository-types.js";

export function isSearchableLexicalIndexStatus(status: TerminologySemanticIndexStatus): boolean {
  return (
    status === terminologySemanticIndexStatusValues.indexedLexical ||
    status === terminologySemanticIndexStatusValues.ready
  );
}

export function termFromRow(
  row: typeof terminologyTerms.$inferSelect,
  aliases: TerminologyAliasRecord[],
  sourceReferences: TerminologySourceReferenceRecord[],
  semanticIndex: TerminologySemanticIndexRecord | null,
): TerminologyTermRecord {
  return {
    termId: row.termId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceTerm: row.sourceTerm,
    normalizedSourceTerm: row.normalizedSourceTerm,
    sourceLocale: row.sourceLocale,
    targetLocale: row.targetLocale,
    preferredTranslation: row.preferredTranslation,
    normalizedPreferredTranslation: row.normalizedPreferredTranslation,
    termKind: row.termKind as TerminologyTermKind,
    partOfSpeech: row.partOfSpeech,
    status: row.status as TerminologyTermStatus,
    caseSensitive: row.caseSensitive,
    notes: row.notes,
    metadata: row.metadata,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    aliases,
    sourceReferences,
    semanticIndex,
  };
}

export function aliasFromRow(row: typeof terminologyAliases.$inferSelect): TerminologyAliasRecord {
  return {
    aliasId: row.aliasId,
    termId: row.termId,
    aliasText: row.aliasText,
    normalizedAliasText: row.normalizedAliasText,
    aliasKind: row.aliasKind as TerminologyAliasKind,
    locale: row.locale,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export function sourceReferenceFromRow(
  row: typeof terminologySourceReferences.$inferSelect,
): TerminologySourceReferenceRecord {
  return {
    sourceRefId: row.sourceRefId,
    termId: row.termId,
    sourceRevisionId: row.sourceRevisionId,
    bridgeUnitId: row.bridgeUnitId,
    sourceProvenanceId: row.sourceProvenanceId,
    referenceKind: row.referenceKind as TerminologySourceReferenceKind,
    citation: row.citation,
    context: row.context,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export function semanticFromRow(
  row: typeof terminologySemanticIndex.$inferSelect,
): TerminologySemanticIndexRecord {
  return {
    semanticIndexId: row.semanticIndexId,
    termId: row.termId,
    searchDocument: row.searchDocument,
    searchTokens: row.searchTokens,
    embeddingProvider: row.embeddingProvider,
    embeddingModel: row.embeddingModel,
    embeddingDimension: row.embeddingDimension,
    embeddingVector: row.embeddingVector,
    contentHash: row.contentHash,
    status: row.status as TerminologySemanticIndexStatus,
    metadata: row.metadata,
    refreshedAt: row.refreshedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function conflictFromRow(
  row: typeof terminologyConflicts.$inferSelect,
): TerminologyConflictRecord {
  return {
    conflictId: row.conflictId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    normalizedSourceTerm: row.normalizedSourceTerm,
    conflictKind: row.conflictKind as TerminologyConflictKind,
    status: row.status as TerminologyConflictStatus,
    summary: row.summary,
    findingId: row.findingId,
    metadata: row.metadata,
    detectedAt: row.detectedAt,
    updatedAt: row.updatedAt,
  };
}
