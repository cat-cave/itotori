import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogExternalIdRecord,
  CatalogLanguageStatusRecord,
  CatalogWorkSnapshot,
} from "../repositories/catalog-repository.js";
import {
  catalogExternalIdKindValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogSource,
} from "../schema.js";
import {
  augmentCatalogPlatformLanguageConflicts,
  catalogPlatformLanguageConflictOriginValues,
  type CatalogPlatformLanguageConflictEvidence,
  type CatalogPlatformLanguageConflictRequest,
  type CatalogPlatformLanguageConflictResult,
} from "./catalog-platform-language-conflicts.js";

/**
 * The catalog sources whose candidate rows are compared against the official
 * platform-language fact by default: VNDB, ErogameScape, DLsite, and the local
 * corpus. These are the "candidate" catalogues — the authoritative official-English
 * claim (e.g. IGDB / Steam / Wikidata) is supplied as the comparison input, not read
 * from these rows.
 */
export const catalogRepositoryDerivedCandidateSourceValues = {
  vndb: catalogSourceValues.vndb,
  egs: catalogSourceValues.egs,
  dlsite: catalogSourceValues.dlsite,
  localCorpus: catalogSourceValues.localCorpus,
} as const;

const defaultCandidateSources: CatalogSource[] = Object.values(
  catalogRepositoryDerivedCandidateSourceValues,
);

export const catalogRepositoryDerivedConflictDiagnosticCodeValues = {
  workNotFound: "catalog.repository_derived_platform_language_conflict.work_not_found",
  candidateRowUnattributed:
    "catalog.repository_derived_platform_language_conflict.candidate_row_unattributed",
  noComparableCandidateRows:
    "catalog.repository_derived_platform_language_conflict.no_comparable_candidate_rows",
  provenanceCollision: "catalog.repository_derived_platform_language_conflict.provenance_collision",
} as const;

export type CatalogRepositoryDerivedConflictDiagnosticCode =
  (typeof catalogRepositoryDerivedConflictDiagnosticCodeValues)[keyof typeof catalogRepositoryDerivedConflictDiagnosticCodeValues];

export type CatalogRepositoryDerivedConflictDiagnostic = {
  code: CatalogRepositoryDerivedConflictDiagnosticCode;
  message: string;
  metadata?: Record<string, unknown>;
};

/**
 * A read-only snapshot reader. Only the read path used by the derivation is exposed,
 * so the derivation provably cannot mutate the candidate rows, merge works, or
 * reassign external ids — it just observes what the repository already holds. The
 * production `ItotoriCatalogRepository` satisfies this interface directly.
 */
export type CatalogRepositoryDerivedConflictReader = {
  getWorkByExternalId(
    actor: AuthorizationActor,
    catalogSource: CatalogSource,
    sourceId: string,
    externalIdKind?: CatalogExternalIdKind,
  ): Promise<CatalogWorkSnapshot | null>;
};

export type CatalogRepositoryDerivedConflictWorkLookup = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
};

export type CatalogRepositoryDerivedPlatformLanguageConflictRequest = {
  targetLanguage?: string;
  /**
   * The authoritative official-English (or other target-language) platform-language
   * fact being validated. The candidate side of the comparison is derived from the
   * repository; this side is the claim under scrutiny.
   */
  officialEvidence: CatalogPlatformLanguageConflictEvidence;
  /**
   * How to locate the work whose candidate rows should be compared. The work is
   * resolved read-only by external id; its VNDB/EGS/DLsite/local language-status rows
   * become the derived candidate evidence.
   */
  workLookup: CatalogRepositoryDerivedConflictWorkLookup;
  /** Restrict which catalog sources count as candidate rows. Defaults to the four candidate catalogues. */
  candidateSources?: CatalogSource[];
  summary?: string;
  sourceField?: string;
  detectedAt?: string;
};

/**
 * A candidate row that was read out of the repository and compared against the
 * official fact. Carries the row's own provenance and source identity verbatim so
 * callers can audit that nothing was reassigned.
 */
export type CatalogRepositoryDerivedComparedRow = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  languageStatusId: string;
  sourceProvenanceId: string | null;
  language: string;
  status: CatalogLanguageStatusRecord["status"];
  statusScope: CatalogLanguageStatusRecord["statusScope"];
  platform: string | null;
};

export type CatalogRepositoryDerivedPlatformLanguageConflictResult =
  CatalogPlatformLanguageConflictResult & {
    origin: typeof catalogPlatformLanguageConflictOriginValues.repositoryDerived;
    workId: string | null;
    comparedCandidateRows: CatalogRepositoryDerivedComparedRow[];
    readDiagnostics: CatalogRepositoryDerivedConflictDiagnostic[];
  };

/**
 * Derive platform-language conflict facts from CURRENT repository evidence rather than
 * from a hand-authored candidate payload.
 *
 * The official platform-language fact is compared against the target-language
 * language-status rows the repository already holds for the work — attributed to their
 * originating VNDB / EGS / DLsite / local candidate row via the row's own source
 * provenance. The comparison is read-only: it never merges works or reassigns external
 * ids, and every emitted candidate preserves the source identity + provenance of the
 * row it came from. The generated conflict facts are stamped `repository_derived` so
 * demotion explanations can distinguish them from fixture-authored conflicts.
 */
export async function deriveCatalogPlatformLanguageConflictsFromRepository(
  reader: CatalogRepositoryDerivedConflictReader,
  actor: AuthorizationActor,
  request: CatalogRepositoryDerivedPlatformLanguageConflictRequest,
): Promise<CatalogRepositoryDerivedPlatformLanguageConflictResult> {
  const targetLanguage = request.targetLanguage ?? "en-US";
  const candidateSources = new Set<CatalogSource>(
    request.candidateSources ?? defaultCandidateSources,
  );
  const readDiagnostics: CatalogRepositoryDerivedConflictDiagnostic[] = [];

  const snapshot = await reader.getWorkByExternalId(
    actor,
    request.workLookup.catalogSource,
    request.workLookup.sourceId,
    request.workLookup.externalIdKind ?? catalogExternalIdKindValues.sourceRecord,
  );

  if (snapshot === null) {
    readDiagnostics.push({
      code: catalogRepositoryDerivedConflictDiagnosticCodeValues.workNotFound,
      message: `No work resolved for ${request.workLookup.catalogSource} ${request.workLookup.sourceId}; no repository candidate rows to compare.`,
      metadata: {
        catalogSource: request.workLookup.catalogSource,
        sourceId: request.workLookup.sourceId,
      },
    });
    return finalize(
      augmentCatalogPlatformLanguageConflicts(buildAugmentRequest(request, targetLanguage, [])),
      null,
      [],
      readDiagnostics,
    );
  }

  // Index external-id rows by their source provenance so a language-status row can be
  // attributed to the exact candidate row it came from — without ever reassigning an
  // external id. A status is attributed only when it shares a provenance with a stored
  // external id from a candidate source.
  //
  // Provenance is normally per-source-record-unique. If two external ids nonetheless share
  // one provenance the attribution is AMBIGUOUS: last-wins would silently stamp a status
  // with the wrong catalogSource/sourceId. We refuse to keep either colliding external id
  // for that provenance (the provenance becomes unattributable) and record a diagnostic, so
  // a status routed through it is skipped-and-diagnosed rather than mis-stamped.
  const externalIdByProvenance = new Map<string, CatalogExternalIdRecord>();
  const collidedProvenanceIds = new Set<string>();
  for (const externalId of snapshot.externalIds) {
    const provenanceId = externalId.sourceProvenanceId;
    if (provenanceId === null) {
      continue;
    }
    if (collidedProvenanceIds.has(provenanceId)) {
      // Already known ambiguous (>= 3 external ids share it); keep it unattributable.
      continue;
    }
    const existing = externalIdByProvenance.get(provenanceId);
    if (existing !== undefined) {
      // Collision: do NOT keep the last-wins external id. Mark the provenance ambiguous.
      externalIdByProvenance.delete(provenanceId);
      collidedProvenanceIds.add(provenanceId);
      readDiagnostics.push({
        code: catalogRepositoryDerivedConflictDiagnosticCodeValues.provenanceCollision,
        message:
          "Two external ids share one source provenance; the provenance is ambiguous and cannot attribute a status to a single source identity without risking a wrong stamp. The provenance is treated as unattributable.",
        metadata: {
          sourceProvenanceId: provenanceId,
          externalIds: [
            {
              externalIdId: existing.externalIdId,
              catalogSource: existing.catalogSource,
              sourceId: existing.sourceId,
            },
            {
              externalIdId: externalId.externalIdId,
              catalogSource: externalId.catalogSource,
              sourceId: externalId.sourceId,
            },
          ],
        },
      });
      continue;
    }
    externalIdByProvenance.set(provenanceId, externalId);
  }

  const comparedCandidateRows: CatalogRepositoryDerivedComparedRow[] = [];
  const candidateEvidence: CatalogPlatformLanguageConflictEvidence[] = [];

  for (const status of snapshot.languageStatuses) {
    if (status.language !== targetLanguage) {
      continue;
    }
    const externalId =
      status.sourceProvenanceId === null
        ? undefined
        : externalIdByProvenance.get(status.sourceProvenanceId);
    if (externalId === undefined) {
      readDiagnostics.push({
        code: catalogRepositoryDerivedConflictDiagnosticCodeValues.candidateRowUnattributed,
        message:
          "A target-language status row could not be attributed to a stored external id via its provenance; skipped to avoid reassigning source identity.",
        metadata: {
          languageStatusId: status.languageStatusId,
          sourceProvenanceId: status.sourceProvenanceId,
        },
      });
      continue;
    }
    if (!candidateSources.has(externalId.catalogSource)) {
      continue;
    }

    const evidence: CatalogPlatformLanguageConflictEvidence = {
      catalogSource: externalId.catalogSource,
      sourceId: externalId.sourceId,
      externalIdKind: externalId.externalIdKind,
      language: status.language,
      status: status.status,
      statusScope: status.statusScope,
      platform: status.platform,
      languageStatusId: status.languageStatusId,
    };
    if (status.sourceProvenanceId !== null) {
      evidence.sourceProvenanceId = status.sourceProvenanceId;
    }
    if (readCrossPlatformComparable(status)) {
      evidence.crossPlatformComparable = true;
    }
    candidateEvidence.push(evidence);
    comparedCandidateRows.push({
      catalogSource: externalId.catalogSource,
      sourceId: externalId.sourceId,
      externalIdKind: externalId.externalIdKind,
      languageStatusId: status.languageStatusId,
      sourceProvenanceId: status.sourceProvenanceId,
      language: status.language,
      status: status.status,
      statusScope: status.statusScope,
      platform: status.platform,
    });
  }

  if (comparedCandidateRows.length === 0) {
    readDiagnostics.push({
      code: catalogRepositoryDerivedConflictDiagnosticCodeValues.noComparableCandidateRows,
      message: `Work ${snapshot.workId} has no ${targetLanguage} candidate rows from ${Array.from(
        candidateSources,
      ).join(", ")} to compare against the official fact.`,
      metadata: { workId: snapshot.workId, targetLanguage },
    });
  }

  return finalize(
    augmentCatalogPlatformLanguageConflicts(
      buildAugmentRequest(request, targetLanguage, candidateEvidence),
    ),
    snapshot.workId,
    comparedCandidateRows,
    readDiagnostics,
  );
}

function buildAugmentRequest(
  request: CatalogRepositoryDerivedPlatformLanguageConflictRequest,
  targetLanguage: string,
  candidateEvidence: CatalogPlatformLanguageConflictEvidence[],
): CatalogPlatformLanguageConflictRequest {
  const augmentRequest: CatalogPlatformLanguageConflictRequest = {
    targetLanguage,
    officialEvidence: request.officialEvidence,
    candidateEvidence,
    conflictOrigin: catalogPlatformLanguageConflictOriginValues.repositoryDerived,
  };
  if (request.summary !== undefined) {
    augmentRequest.summary = request.summary;
  }
  if (request.sourceField !== undefined) {
    augmentRequest.sourceField = request.sourceField;
  }
  if (request.detectedAt !== undefined) {
    augmentRequest.detectedAt = request.detectedAt;
  }
  return augmentRequest;
}

function readCrossPlatformComparable(status: CatalogLanguageStatusRecord): boolean {
  return status.metadata.crossPlatformComparable === true;
}

function finalize(
  result: CatalogPlatformLanguageConflictResult,
  workId: string | null,
  comparedCandidateRows: CatalogRepositoryDerivedComparedRow[],
  readDiagnostics: CatalogRepositoryDerivedConflictDiagnostic[],
): CatalogRepositoryDerivedPlatformLanguageConflictResult {
  return {
    ...result,
    origin: catalogPlatformLanguageConflictOriginValues.repositoryDerived,
    workId,
    comparedCandidateRows,
    readDiagnostics,
  };
}
