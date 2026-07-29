import { TerminologySearchReadModel } from "./dependencies.js";
import { benchmarkSeedPrivateLeakagePatterns } from "./api-private-leakage.js";
import { asRecord } from "./api-domain-28.js";
import {
  asArray,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertNonNegativeInteger,
  assertNullableString,
  assertString,
  assertStringArray,
} from "./api-domain-29.js";

export const opportunityPrivateLeakagePatterns = [
  ...benchmarkSeedPrivateLeakagePatterns,
  /(?:localScanEntryId|local_scan_entry_id|pathHash|path_hash|rawText|raw_text)/iu,
  /(?:SECRET_KEY|helper log|rawPayloadSecret|screenshot)/iu,
  /\.(?:xp3|wolf|rvdata2|rpgmvp|rpgmvm|rpgmvo|unity3d|assetbundle)(?:$|[\\/!?#:])/iu,
] as const;

export function assertNoOpportunityPrivateLeakage(value: string, label: string): void {
  if (opportunityPrivateLeakagePatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not expose private response data`);
  }
}

export function assertTerminologySearchReadModel(
  value: unknown,
  label = "TerminologySearchReadModel",
): asserts value is TerminologySearchReadModel {
  const model = asRecord(value, label);
  assertString(model.query, `${label}.query`);
  assertString(model.normalizedQuery, `${label}.normalizedQuery`);
  assertString(model.localeBranchId, `${label}.localeBranchId`);
  const results = asArray(model.results, `${label}.results`);
  for (const [index, resultValue] of results.entries()) {
    const result = asRecord(resultValue, `${label}.results[${index}]`);
    assertNonNegativeInteger(result.score, `${label}.results[${index}].score`);
    const matchKinds = asArray(result.matchKinds, `${label}.results[${index}].matchKinds`);
    for (const [matchIndex, matchKind] of matchKinds.entries()) {
      assertEnum(
        matchKind,
        ["exact_source", "exact_translation", "alias", "lexical_hook"] as const,
        `${label}.results[${index}].matchKinds[${matchIndex}]`,
      );
    }
    const term = asRecord(result.term, `${label}.results[${index}].term`);
    assertString(term.termId, `${label}.results[${index}].term.termId`);
    assertString(term.projectId, `${label}.results[${index}].term.projectId`);
    assertString(term.localeBranchId, `${label}.results[${index}].term.localeBranchId`);
    assertString(term.sourceTerm, `${label}.results[${index}].term.sourceTerm`);
    assertString(term.normalizedSourceTerm, `${label}.results[${index}].term.normalizedSourceTerm`);
    assertString(term.sourceLocale, `${label}.results[${index}].term.sourceLocale`);
    assertString(term.targetLocale, `${label}.results[${index}].term.targetLocale`);
    assertString(term.preferredTranslation, `${label}.results[${index}].term.preferredTranslation`);
    assertString(
      term.normalizedPreferredTranslation,
      `${label}.results[${index}].term.normalizedPreferredTranslation`,
    );
    assertString(term.termKind, `${label}.results[${index}].term.termKind`);
    assertNullableString(term.partOfSpeech, `${label}.results[${index}].term.partOfSpeech`);
    assertString(term.status, `${label}.results[${index}].term.status`);
    assertBoolean(term.caseSensitive, `${label}.results[${index}].term.caseSensitive`);
    assertNullableString(term.notes, `${label}.results[${index}].term.notes`);
    asRecord(term.metadata, `${label}.results[${index}].term.metadata`);
    assertNullableString(term.createdByUserId, `${label}.results[${index}].term.createdByUserId`);
    assertDateLike(term.createdAt, `${label}.results[${index}].term.createdAt`);
    assertDateLike(term.updatedAt, `${label}.results[${index}].term.updatedAt`);
    assertTerminologyAliases(term.aliases, `${label}.results[${index}].term.aliases`);
    assertTerminologySourceReferences(
      term.sourceReferences,
      `${label}.results[${index}].term.sourceReferences`,
    );
    if (term.semanticIndex !== null) {
      assertTerminologySemanticIndex(
        term.semanticIndex,
        `${label}.results[${index}].term.semanticIndex`,
      );
    }
  }
}

export function assertTerminologyAliases(value: unknown, label: string): void {
  const aliases = asArray(value, label);
  for (const [index, aliasValue] of aliases.entries()) {
    const alias = asRecord(aliasValue, `${label}[${index}]`);
    assertString(alias.aliasId, `${label}[${index}].aliasId`);
    assertString(alias.termId, `${label}[${index}].termId`);
    assertString(alias.aliasText, `${label}[${index}].aliasText`);
    assertString(alias.normalizedAliasText, `${label}[${index}].normalizedAliasText`);
    assertString(alias.aliasKind, `${label}[${index}].aliasKind`);
    assertNullableString(alias.locale, `${label}[${index}].locale`);
    asRecord(alias.metadata, `${label}[${index}].metadata`);
    assertDateLike(alias.createdAt, `${label}[${index}].createdAt`);
  }
}

export function assertTerminologySourceReferences(value: unknown, label: string): void {
  const references = asArray(value, label);
  for (const [index, referenceValue] of references.entries()) {
    const reference = asRecord(referenceValue, `${label}[${index}]`);
    assertString(reference.sourceRefId, `${label}[${index}].sourceRefId`);
    assertString(reference.termId, `${label}[${index}].termId`);
    assertNullableString(reference.sourceRevisionId, `${label}[${index}].sourceRevisionId`);
    assertNullableString(reference.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNullableString(reference.sourceProvenanceId, `${label}[${index}].sourceProvenanceId`);
    assertString(reference.referenceKind, `${label}[${index}].referenceKind`);
    assertString(reference.citation, `${label}[${index}].citation`);
    assertNullableString(reference.context, `${label}[${index}].context`);
    asRecord(reference.metadata, `${label}[${index}].metadata`);
    assertDateLike(reference.createdAt, `${label}[${index}].createdAt`);
  }
}

export function assertTerminologySemanticIndex(value: unknown, label: string): void {
  const semantic = asRecord(value, label);
  assertString(semantic.semanticIndexId, `${label}.semanticIndexId`);
  assertString(semantic.termId, `${label}.termId`);
  assertString(semantic.searchDocument, `${label}.searchDocument`);
  assertStringArray(semantic.searchTokens, `${label}.searchTokens`);
  assertString(semantic.embeddingProvider, `${label}.embeddingProvider`);
  assertString(semantic.embeddingModel, `${label}.embeddingModel`);
  assertNonNegativeInteger(semantic.embeddingDimension, `${label}.embeddingDimension`);
  if (semantic.embeddingVector !== null) {
    const vector = asArray(semantic.embeddingVector, `${label}.embeddingVector`);
    for (const [index, component] of vector.entries()) {
      if (typeof component !== "number") {
        throw new Error(`${label}.embeddingVector[${index}] must be a number`);
      }
    }
  }
  assertString(semantic.contentHash, `${label}.contentHash`);
  assertString(semantic.status, `${label}.status`);
  asRecord(semantic.metadata, `${label}.metadata`);
  if (semantic.refreshedAt !== null) {
    assertDateLike(semantic.refreshedAt, `${label}.refreshedAt`);
  }
  assertDateLike(semantic.createdAt, `${label}.createdAt`);
  assertDateLike(semantic.updatedAt, `${label}.updatedAt`);
}
