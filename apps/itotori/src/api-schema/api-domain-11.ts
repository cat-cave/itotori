import {
  CatalogOpportunityDecision,
  CatalogOpportunityMarketPrevalenceSignal,
  CatalogOpportunityRankingReadModel,
  CatalogOpportunityRuntimeEvidenceSignal,
} from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import { assertWikiObjectView, assertWikiRouteScope } from "./api-domain-10.js";
import {
  assertCatalogOpportunityDemandFacts,
  assertCatalogOpportunityDemotions,
  assertCatalogOpportunityFactors,
} from "./api-domain-12.js";
import {
  assertCatalogBenchmarkSeedProvenance,
  assertCatalogBenchmarkSeedReadiness,
  assertCatalogBenchmarkSeedSourceIds,
  assertCatalogBenchmarkSeedTranslationStatuses,
  assertNullablePublicOpportunityString,
  assertPublicOpportunityString,
  assertPublicOpportunityStringArray,
} from "./api-domain-13.js";
import { asRecord } from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertFiniteNumber,
  assertLiteral,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertNullableString,
  assertPositiveInteger,
  assertString,
  assertStringArray,
} from "./api-domain-29.js";

export function assertWikiBadges(value: unknown, label: string): void {
  const badges = asStrictRecord(value, label, [
    "provisional",
    "contextScope",
    "runMode",
    "editedBy",
  ]);
  assertBoolean(badges.provisional, `${label}.provisional`);
  assertNullableString(badges.contextScope, `${label}.contextScope`);
  assertString(badges.runMode, `${label}.runMode`);
  assertNullableString(badges.editedBy, `${label}.editedBy`);
}

export function assertWikiClaim(value: unknown, label: string): void {
  const claim = asStrictRecord(value, label, [
    "claimId",
    "statement",
    "scope",
    "kind",
    "confidence",
    "supersedesClaimId",
    "citations",
  ]);
  assertString(claim.claimId, `${label}.claimId`);
  assertString(claim.statement, `${label}.statement`);
  assertWikiRouteScope(claim.scope, `${label}.scope`);
  assertString(claim.kind, `${label}.kind`);
  assertString(claim.confidence, `${label}.confidence`);
  assertNullableString(claim.supersedesClaimId, `${label}.supersedesClaimId`);
  asArray(claim.citations, `${label}.citations`).forEach((citation, index) =>
    assertWikiCitation(citation, `${label}.citations[${index}]`),
  );
}

export function assertWikiCitation(value: unknown, label: string): void {
  const citation = asStrictRecord(value, label, [
    "claimId",
    "evidenceId",
    "evidenceHash",
    "snapshotId",
    "subject",
    "role",
    "playOrderIndex",
    "quotedSpan",
  ]);
  assertString(citation.claimId, `${label}.claimId`);
  assertString(citation.evidenceId, `${label}.evidenceId`);
  assertString(citation.evidenceHash, `${label}.evidenceHash`);
  assertString(citation.snapshotId, `${label}.snapshotId`);
  asRecord(citation.subject, `${label}.subject`);
  assertString(citation.role, `${label}.role`);
  assertNonNegativeInteger(citation.playOrderIndex, `${label}.playOrderIndex`);
  assertNullableString(citation.quotedSpan, `${label}.quotedSpan`);
}

export function assertWikiHistory(value: unknown, label: string): void {
  asArray(value, label).forEach((entry, index) => {
    const history = asStrictRecord(entry, `${label}[${index}]`, [
      "version",
      "supersedesVersion",
      "contentHash",
      "editedBy",
      "provisional",
      "createdAt",
    ]);
    assertPositiveInteger(history.version, `${label}[${index}].version`);
    if (history.supersedesVersion !== null)
      assertPositiveInteger(history.supersedesVersion, `${label}[${index}].supersedesVersion`);
    assertString(history.contentHash, `${label}[${index}].contentHash`);
    assertNullableString(history.editedBy, `${label}[${index}].editedBy`);
    assertBoolean(history.provisional, `${label}[${index}].provisional`);
    assertDateLike(history.createdAt, `${label}[${index}].createdAt`);
  });
}

export function assertWikiDependent(value: unknown, label: string): void {
  const dependent = asStrictRecord(value, label, [
    "downstreamObjectId",
    "downstreamWikiKind",
    "downstreamVersion",
    "claimId",
    "fieldPath",
    "renderingId",
    "protectedHuman",
  ]);
  assertString(dependent.downstreamObjectId, `${label}.downstreamObjectId`);
  assertString(dependent.downstreamWikiKind, `${label}.downstreamWikiKind`);
  assertPositiveInteger(dependent.downstreamVersion, `${label}.downstreamVersion`);
  assertNullableString(dependent.claimId, `${label}.claimId`);
  assertStringArray(dependent.fieldPath, `${label}.fieldPath`);
  assertNullableString(dependent.renderingId, `${label}.renderingId`);
  assertBoolean(dependent.protectedHuman, `${label}.protectedHuman`);
}

export function assertWikiHead(value: unknown, label: string): void {
  const head = asStrictRecord(value, label, ["objectId", "version", "contentHash"]);
  assertString(head.objectId, `${label}.objectId`);
  assertPositiveInteger(head.version, `${label}.version`);
  assertString(head.contentHash, `${label}.contentHash`);
}

export function assertWikiWriteReceipt(value: unknown, label: string): void {
  const receipt = asStrictRecord(value, label, [
    "durable",
    "inputId",
    "head",
    "view",
    "badges",
    "dependencyImpact",
  ]);
  if (receipt.durable !== true) throw new Error(`${label}.durable must be true`);
  assertString(receipt.inputId, `${label}.inputId`);
  assertWikiHead(receipt.head, `${label}.head`);
  assertWikiObjectView(receipt.view, `${label}.view`);
  assertWikiBadges(receipt.badges, `${label}.badges`);
  assertImpactSet(receipt.dependencyImpact, `${label}.dependencyImpact`);
}

export function assertImpactSet(value: unknown, label: string): void {
  const impact = asStrictRecord(value, label, [
    "upstreamObjectId",
    "priorVersion",
    "nextVersion",
    "consumers",
    "enhancementWork",
    "reviewerWork",
    "impactSetHash",
  ]);
  assertString(impact.upstreamObjectId, `${label}.upstreamObjectId`);
  assertPositiveInteger(impact.priorVersion, `${label}.priorVersion`);
  assertPositiveInteger(impact.nextVersion, `${label}.nextVersion`);
  asArray(impact.consumers, `${label}.consumers`).forEach((consumer, index) => {
    const record = asRecord(consumer, `${label}.consumers[${index}]`);
    assertString(record.downstreamObjectId, `${label}.consumers[${index}].downstreamObjectId`);
  });
  assertStringArray(impact.enhancementWork, `${label}.enhancementWork`);
  assertStringArray(impact.reviewerWork, `${label}.reviewerWork`);
  assertString(impact.impactSetHash, `${label}.impactSetHash`);
}

export function assertCatalogOpportunityRankingReadModel(
  value: unknown,
  label = "CatalogOpportunityRankingReadModel",
): asserts value is CatalogOpportunityRankingReadModel {
  const model = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.CatalogOpportunityRankingReadModel,
  );
  assertLiteral(model.schemaVersion, "catalog.opportunity_ranking.v0.1", `${label}.schemaVersion`);
  assertPublicOpportunityString(model.targetLanguage, `${label}.targetLanguage`);
  assertDateLike(model.generatedAt, `${label}.generatedAt`);
  assertPublicOpportunityString(model.weightsVersion, `${label}.weightsVersion`);
  const rows = asArray(model.rows, `${label}.rows`);
  for (const [index, rowValue] of rows.entries()) {
    assertCatalogOpportunityRow(rowValue, `${label}.rows[${index}]`);
  }
}

export function assertCatalogOpportunityRow(value: unknown, label: string): void {
  const row = asStrictRecord(value, label, [
    "rank",
    "workId",
    "canonicalTitle",
    "originalLanguage",
    "sourceIds",
    "engineName",
    "adapterId",
    "readiness",
    "runtimeEvidenceReadiness",
    "completenessPool",
    "translationStatuses",
    "demandFacts",
    "localOwnership",
    "localEvidenceCount",
    "marketPrevalence",
    "decision",
    "score",
    "factorBreakdown",
    "explanationCodes",
    "provenance",
    "demotions",
  ]);
  assertNonNegativeInteger(row.rank, `${label}.rank`);
  assertPublicOpportunityString(row.workId, `${label}.workId`);
  assertPublicOpportunityString(row.canonicalTitle, `${label}.canonicalTitle`);
  assertNullablePublicOpportunityString(row.originalLanguage, `${label}.originalLanguage`);
  assertCatalogBenchmarkSeedSourceIds(row.sourceIds, `${label}.sourceIds`);
  assertNullablePublicOpportunityString(row.engineName, `${label}.engineName`);
  assertNullablePublicOpportunityString(row.adapterId, `${label}.adapterId`);
  assertCatalogBenchmarkSeedReadiness(row.readiness, `${label}.readiness`);
  assertCatalogOpportunityRuntimeEvidenceReadiness(
    row.runtimeEvidenceReadiness,
    `${label}.runtimeEvidenceReadiness`,
  );
  assertEnum(
    row.completenessPool,
    ["mtl_only", "fan_partial", "no_english", "unknown", "conflict"] as const,
    `${label}.completenessPool`,
  );
  assertCatalogBenchmarkSeedTranslationStatuses(
    row.translationStatuses,
    `${label}.translationStatuses`,
  );
  assertCatalogOpportunityDemandFacts(row.demandFacts, `${label}.demandFacts`);
  assertEnum(
    row.localOwnership,
    ["owned", "not_owned", "unknown"] as const,
    `${label}.localOwnership`,
  );
  assertNonNegativeNumber(row.localEvidenceCount, `${label}.localEvidenceCount`);
  assertEnum(
    row.marketPrevalence,
    [
      "public_and_local_aggregate",
      "public_only",
      "local_aggregate_only",
      "unknown",
    ] as CatalogOpportunityMarketPrevalenceSignal[],
    `${label}.marketPrevalence`,
  );
  assertEnum(
    row.decision,
    ["candidate", "demoted", "excluded"] as CatalogOpportunityDecision[],
    `${label}.decision`,
  );
  assertFiniteNumber(row.score, `${label}.score`);
  assertCatalogOpportunityFactors(row.factorBreakdown, `${label}.factorBreakdown`);
  assertPublicOpportunityStringArray(row.explanationCodes, `${label}.explanationCodes`);
  assertCatalogBenchmarkSeedProvenance(row.provenance, `${label}.provenance`);
  assertCatalogOpportunityDemotions(row.demotions, `${label}.demotions`);
}

export function assertCatalogOpportunityRuntimeEvidenceReadiness(
  value: unknown,
  label: string,
): void {
  const readiness = asStrictRecord(value, label, [
    "status",
    "publicFixtureEvidenceCount",
    "privateLocalAggregateEvidenceCount",
  ]);
  assertEnum(
    readiness.status,
    [
      "public_and_aggregate",
      "public_fixture",
      "private_local_aggregate",
      "partial_public_and_aggregate",
      "partial_public_fixture",
      "partial_private_local_aggregate",
      "unknown",
    ] as CatalogOpportunityRuntimeEvidenceSignal[],
    `${label}.status`,
  );
  assertNonNegativeNumber(
    readiness.publicFixtureEvidenceCount,
    `${label}.publicFixtureEvidenceCount`,
  );
  assertNonNegativeNumber(
    readiness.privateLocalAggregateEvidenceCount,
    `${label}.privateLocalAggregateEvidenceCount`,
  );
}
