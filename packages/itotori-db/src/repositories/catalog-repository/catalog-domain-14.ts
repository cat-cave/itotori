import {
  CatalogConflictKind,
  CatalogConflictStatus,
  CatalogPlatformLanguageConflictOrigin,
  and,
  catalogConflictEvidence,
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConflicts,
  catalogPlatformLanguageConflictOriginValues,
} from "./dependencies.js";
import { CatalogJsonRecord, CatalogSourceProvenanceRecord } from "./catalog-domain-01.js";
import {
  CatalogConflictReviewExactLinkRef,
  CatalogConflictReviewSourceId,
} from "./catalog-domain-02.js";
import { CatalogCompletenessStatusFact, CatalogConflictReviewRow } from "./catalog-domain-03.js";
import {
  conflictReasonCode,
  conflictResolutionFromMetadata,
  conflictReviewProvenanceFromRecord,
  conflictSeverity,
} from "./catalog-domain-15.js";
import {
  compareExactLinkRefs,
  countPrivateSourceIdentities,
  isPrivateSourceProvenance,
  isPublicSourceId,
  metadataSourceIds,
  stringArrayMetadata,
  stringMetadata,
  uniqueProvenance,
  uniqueSourceIds,
  uniqueStrings,
} from "./catalog-domain-16.js";
import { parseCatalogSourceRecordIdentity } from "./catalog-domain-19.js";

export function compareCompletenessStatusFacts(
  left: CatalogCompletenessStatusFact,
  right: CatalogCompletenessStatusFact,
): number {
  return (
    left.status.localeCompare(right.status) ||
    left.languageStatusId.localeCompare(right.languageStatusId)
  );
}

export function catalogConflictReviewRowFromConflict(
  conflict: typeof catalogConflicts.$inferSelect,
  evidenceRows: (typeof catalogConflictEvidence.$inferSelect)[],
  provenanceById: Map<string, CatalogSourceProvenanceRecord>,
  exactLinkById: Map<string, CatalogConflictReviewExactLinkRef>,
): CatalogConflictReviewRow {
  const rawExactLinkRefs = evidenceRows
    .filter((evidence) => evidence.subjectKind === catalogConflictSubjectKindValues.externalId)
    .map((evidence) => exactLinkById.get(evidence.subjectId))
    .filter((ref): ref is CatalogConflictReviewExactLinkRef => ref !== undefined);
  const exactLinkRefs = rawExactLinkRefs.filter(isPublicSourceId);
  const rawProvenance = [
    ...evidenceRows
      .map((evidence) =>
        evidence.sourceProvenanceId === null
          ? undefined
          : provenanceById.get(evidence.sourceProvenanceId),
      )
      .filter((record): record is CatalogSourceProvenanceRecord => record !== undefined),
    ...rawExactLinkRefs
      .map((ref) =>
        ref.sourceProvenanceId === null ? undefined : provenanceById.get(ref.sourceProvenanceId),
      )
      .filter((record): record is CatalogSourceProvenanceRecord => record !== undefined),
  ];
  const provenance = rawProvenance
    .filter((record) => !isPrivateSourceProvenance(record))
    .map(conflictReviewProvenanceFromRecord);
  const metadata = conflict.metadata;
  const originMetadataDrop = catalogConflictOriginMetadataDropDiagnostic(conflict);
  if (originMetadataDrop !== null) {
    reportCatalogConflictOriginMetadataDrop(originMetadataDrop);
  }
  const metadataSourceIdRows = metadataSourceIds(metadata);
  // A provenance-less `sourceProvenance` evidence subject bearing a
  // `<catalogSource>:<sourceId>` identity is a FORWARD-REFERENCE to a source not
  // yet ingested (CATALOG-079): it carries no provenance row to look up, but its
  // subject identity still names the REAL cited source. Surface it into
  // `sourceIds` so review/demotion attributes the evidence to that source rather
  // than silently dropping it for lack of a provenance row. This mirrors how the
  // repository-derived conflict service surfaces cross-source identities.
  const crossSourceSubjectIdentities = evidenceRows
    .filter(
      (evidence) =>
        evidence.subjectKind === catalogConflictSubjectKindValues.sourceProvenance &&
        evidence.sourceProvenanceId === null,
    )
    .map((evidence) => parseCatalogSourceRecordIdentity(evidence.subjectId))
    .filter((identity): identity is CatalogConflictReviewSourceId => identity !== null);
  const priorCandidateIds = stringArrayMetadata(metadata, "priorCandidateIds");
  const candidateIds = uniqueStrings([
    ...priorCandidateIds,
    ...evidenceRows
      .filter((evidence) => evidence.subjectKind === catalogConflictSubjectKindValues.work)
      .flatMap((evidence) => stringArrayMetadata(evidence.metadata, "candidateIds")),
  ]);
  const candidateCatalogIds = uniqueStrings([
    conflict.workId,
    ...evidenceRows
      .filter((evidence) => evidence.subjectKind === catalogConflictSubjectKindValues.work)
      .map((evidence) => evidence.subjectId),
    ...exactLinkRefs.map((ref) => ref.workId),
  ]);

  return {
    reviewId: `catalog-conflict:${conflict.conflictId}`,
    catalogRecordId: conflict.workId,
    conflictId: conflict.conflictId,
    candidateIds,
    candidateCatalogIds,
    exactLinkRefs: exactLinkRefs.sort(compareExactLinkRefs),
    fuzzyScores: [],
    sourceIds: uniqueSourceIds([
      ...exactLinkRefs,
      ...metadataSourceIdRows.filter(isPublicSourceId),
      ...crossSourceSubjectIdentities.filter(isPublicSourceId),
      ...provenance.map(({ catalogSource, sourceId }) => ({ catalogSource, sourceId })),
    ]),
    provenance: uniqueProvenance(provenance),
    privateSourceCount: countPrivateSourceIdentities(
      rawExactLinkRefs,
      metadataSourceIdRows,
      crossSourceSubjectIdentities,
      rawProvenance,
    ),
    severity: conflictSeverity(conflict, exactLinkRefs),
    status: conflict.status as CatalogConflictStatus,
    reasonCode: conflictReasonCode(conflict, exactLinkRefs),
    reasonDetail: conflict.summary,
    conflictOrigin: conflictOriginFromMetadata(metadata),
    conflictKind: conflict.conflictKind as CatalogConflictKind,
    detectedAt: conflict.detectedAt,
    resolution: conflictResolutionFromMetadata(conflict.status as CatalogConflictStatus, metadata),
  };
}

/**
 * Read the fixture-authored vs repository-derived origin off a conflict's metadata,
 * defaulting to `fixture_authored` when unstamped (e.g. legacy conflicts).
 *
 * This default is the SAFE direction (it under-claims provenance), but it is silent:
 * a conflict that was *expected* to carry `conflictOrigin` yet lost it would be
 * indistinguishable from a legitimately-originless legacy row. See
 * {@link catalogConflictOriginMetadataDropDiagnostic} for the observability guard that
 * makes an expected-but-missing drop loud without changing this safe default.
 */
export function conflictOriginFromMetadata(
  metadata: CatalogJsonRecord,
): CatalogPlatformLanguageConflictOrigin {
  const origin = stringMetadata(metadata, "conflictOrigin");
  return origin === catalogPlatformLanguageConflictOriginValues.repositoryDerived
    ? catalogPlatformLanguageConflictOriginValues.repositoryDerived
    : catalogPlatformLanguageConflictOriginValues.fixtureAuthored;
}

/**
 * Stable diagnostic code for an expected-but-missing `conflictOrigin` metadata drop.
 */
export const catalogConflictOriginMetadataDropDiagnosticCode =
  "catalog.conflict_origin_metadata_drop" as const;

/**
 * Structured diagnostic emitted when a conflict that was expected to carry
 * `conflictOrigin` in its metadata has none (or an invalid value). Shaped like the
 * repo's other structured diagnostics (a stable `code` plus context) so it can be
 * asserted directly and surfaced observably.
 */
export type CatalogConflictOriginMetadataDropDiagnostic = {
  code: typeof catalogConflictOriginMetadataDropDiagnosticCode;
  conflictId: string;
  conflictKind: CatalogConflictKind | null;
  targetLanguage: string | null;
  observedConflictOrigin: unknown;
  safeDefault: CatalogPlatformLanguageConflictOrigin;
  message: string;
};

export function isCatalogPlatformLanguageConflictOrigin(
  value: unknown,
): value is CatalogPlatformLanguageConflictOrigin {
  return (
    value === catalogPlatformLanguageConflictOriginValues.fixtureAuthored ||
    value === catalogPlatformLanguageConflictOriginValues.repositoryDerived
  );
}

/**
 * Detect an expected-but-missing `conflictOrigin` metadata drop.
 *
 * Only platform-language conflicts (`conflictKind === languageStatus`) stamp
 * `conflictOrigin`, and the augment always writes it alongside `targetLanguage` (see
 * `buildPlatformLanguageConflict`). We therefore treat a `languageStatus` conflict whose
 * metadata carries that augment shape — `targetLanguage` present — but whose
 * `conflictOrigin` is absent or not a valid origin value as an expected-but-missing drop
 * (a regression that stripped the field after augment). This is deliberately scoped to
 * the narrowest observable signal: rows that never carried the augment shape (no
 * `targetLanguage` — minimal/legacy conflicts) legitimately lack an origin and do NOT
 * fire the diagnostic, so there is no noise on the safe `fixture_authored` default path.
 * Returns `null` when nothing was dropped.
 */
export function catalogConflictOriginMetadataDropDiagnostic(
  conflict: Pick<typeof catalogConflicts.$inferSelect, "conflictId" | "conflictKind" | "metadata">,
): CatalogConflictOriginMetadataDropDiagnostic | null {
  if (conflict.conflictKind !== catalogConflictKindValues.languageStatus) {
    return null;
  }
  const targetLanguage = stringMetadata(conflict.metadata, "targetLanguage");
  if (targetLanguage === null) {
    // Not an augment-shaped platform-language conflict: origin is legitimately absent.
    return null;
  }
  const observedConflictOrigin = conflict.metadata.conflictOrigin ?? null;
  if (isCatalogPlatformLanguageConflictOrigin(observedConflictOrigin)) {
    return null;
  }
  return {
    code: catalogConflictOriginMetadataDropDiagnosticCode,
    conflictId: conflict.conflictId,
    conflictKind: conflict.conflictKind as CatalogConflictKind,
    targetLanguage,
    observedConflictOrigin,
    safeDefault: catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
    message:
      `Catalog conflict ${conflict.conflictId} (languageStatus, targetLanguage=${targetLanguage}) ` +
      `was expected to carry conflictOrigin metadata but has none; defaulting to the safe ` +
      `${catalogPlatformLanguageConflictOriginValues.fixtureAuthored} origin. This indicates a ` +
      `metadata-drop regression on the augment path.`,
  };
}

/**
 * Surface an expected-but-missing `conflictOrigin` drop on Node's structured process
 * warning channel so a future regression is observable at runtime (rather than a silent
 * downgrade). The safe `fixture_authored` default is applied regardless.
 */
export function reportCatalogConflictOriginMetadataDrop(
  diagnostic: CatalogConflictOriginMetadataDropDiagnostic,
): void {
  process.emitWarning(diagnostic.message, {
    type: "CatalogConflictOriginMetadataDrop",
    code: diagnostic.code,
    detail: JSON.stringify({
      conflictId: diagnostic.conflictId,
      conflictKind: diagnostic.conflictKind,
      targetLanguage: diagnostic.targetLanguage,
      observedConflictOrigin: diagnostic.observedConflictOrigin,
      safeDefault: diagnostic.safeDefault,
    }),
  });
}
