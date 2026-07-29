import {
  CatalogConflictStatus,
  CatalogSource,
  ItotoriDatabase,
  catalogCandidateMatches,
  catalogConflictEvidence,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogConflicts,
  catalogExternalIds,
  catalogLanguageStatuses,
  catalogSourceProvenance,
  catalogWorks,
  eq,
  inArray,
} from "./dependencies.js";
import { CatalogConflictReviewExactLinkRef } from "./catalog-work-scan-types.js";
import {
  CatalogCompletenessBenchmarkPools,
  CatalogCompletenessPoolWork,
  CatalogCompletenessSourceSummary,
  CatalogConflictReviewRow,
} from "./catalog-read-model-types.js";
import { catalogCompletenessPools } from "./catalog-repository-port-and-enums.js";
import {
  completenessStatusFactFromRow,
  emptyCompletenessPools,
  poolsForCompletenessWork,
  sourceIdsForCompletenessWork,
  sourceSummaryFromRow,
} from "./catalog-benchmark-ranking.js";
import {
  compareCompletenessPoolWorks,
  publicCompletenessReport,
} from "./catalog-opportunity-ranking.js";
import {
  catalogConflictReviewRowFromConflict,
  compareCompletenessStatusFacts,
} from "./catalog-conflict-projection.js";
import {
  catalogConflictReviewRowFromCandidate,
  exactLinkRefFromExternalIdRow,
} from "./catalog-conflict-review.js";
import {
  compareCatalogConflictReviewRows,
  countPrivateSourceIds,
} from "./catalog-conflict-utils.js";
import {
  NormalizedCompletenessPoolFilter,
  sourceProvenanceFromRow,
} from "./catalog-scan-input-validation.js";

export async function readCatalogConflictReview(
  db: ItotoriDatabase,
): Promise<CatalogConflictReviewRow[]> {
  const [conflictRows, evidenceRows, candidateRows] = await Promise.all([
    db.select().from(catalogConflicts),
    db.select().from(catalogConflictEvidence),
    db.select().from(catalogCandidateMatches),
  ]);

  const provenanceIds = new Set<string>();
  const externalIdIds = new Set<string>();
  const workIds = new Set<string>();

  for (const evidence of evidenceRows) {
    if (evidence.sourceProvenanceId !== null) {
      provenanceIds.add(evidence.sourceProvenanceId);
    }
    if (evidence.subjectKind === catalogConflictSubjectKindValues.externalId) {
      externalIdIds.add(evidence.subjectId);
    }
    if (evidence.subjectKind === catalogConflictSubjectKindValues.work) {
      workIds.add(evidence.subjectId);
    }
  }
  for (const candidate of candidateRows) {
    workIds.add(candidate.targetWorkId);
    if (candidate.sourceProvenanceId !== null) {
      provenanceIds.add(candidate.sourceProvenanceId);
    }
  }

  const [externalIdRows, workExternalIdRows] = await Promise.all([
    externalIdIds.size === 0
      ? []
      : db
          .select()
          .from(catalogExternalIds)
          .where(inArray(catalogExternalIds.externalIdId, Array.from(externalIdIds))),
    workIds.size === 0
      ? []
      : db
          .select()
          .from(catalogExternalIds)
          .where(inArray(catalogExternalIds.workId, Array.from(workIds))),
  ]);
  for (const externalId of [...externalIdRows, ...workExternalIdRows]) {
    if (externalId.sourceProvenanceId !== null) {
      provenanceIds.add(externalId.sourceProvenanceId);
    }
  }

  const provenanceRows =
    provenanceIds.size === 0
      ? []
      : await db
          .select()
          .from(catalogSourceProvenance)
          .where(inArray(catalogSourceProvenance.sourceProvenanceId, Array.from(provenanceIds)));

  const provenanceById = new Map(
    provenanceRows.map((row) => [row.sourceProvenanceId, sourceProvenanceFromRow(row)]),
  );
  const exactLinkById = new Map(
    externalIdRows.map((row) => [row.externalIdId, exactLinkRefFromExternalIdRow(row)]),
  );
  const exactLinksByWorkId = new Map<string, CatalogConflictReviewExactLinkRef[]>();
  for (const row of workExternalIdRows) {
    const ref = exactLinkRefFromExternalIdRow(row);
    const existing = exactLinksByWorkId.get(ref.workId) ?? [];
    existing.push(ref);
    exactLinksByWorkId.set(ref.workId, existing);
  }
  const evidenceByConflictId = new Map<string, (typeof catalogConflictEvidence.$inferSelect)[]>();
  for (const evidence of evidenceRows) {
    const existing = evidenceByConflictId.get(evidence.conflictId) ?? [];
    existing.push(evidence);
    evidenceByConflictId.set(evidence.conflictId, existing);
  }

  const candidateRowsBySource = new Map<string, (typeof catalogCandidateMatches.$inferSelect)[]>();
  for (const candidate of candidateRows) {
    const sourceKey = `${candidate.sourceCatalogSource}:${candidate.sourceId}:${candidate.generatorVersion}`;
    const existing = candidateRowsBySource.get(sourceKey) ?? [];
    existing.push(candidate);
    candidateRowsBySource.set(sourceKey, existing);
  }

  const conflictReviewRows = conflictRows.map((conflict) =>
    catalogConflictReviewRowFromConflict(
      conflict,
      evidenceByConflictId.get(conflict.conflictId) ?? [],
      provenanceById,
      exactLinkById,
    ),
  );
  const candidateReviewRows = candidateRows.map((candidate) =>
    catalogConflictReviewRowFromCandidate(
      candidate,
      candidateRowsBySource.get(
        `${candidate.sourceCatalogSource}:${candidate.sourceId}:${candidate.generatorVersion}`,
      ) ?? [candidate],
      provenanceById,
      exactLinksByWorkId.get(candidate.targetWorkId) ?? [],
    ),
  );

  return [...conflictReviewRows, ...candidateReviewRows].sort(compareCatalogConflictReviewRows);
}

export async function readCatalogCompletenessBenchmarkPools(
  db: ItotoriDatabase,
  filter: NormalizedCompletenessPoolFilter,
): Promise<CatalogCompletenessBenchmarkPools> {
  const [workRows, statusRows, externalIdRows, conflictReviewRows] = await Promise.all([
    db.select().from(catalogWorks),
    db
      .select()
      .from(catalogLanguageStatuses)
      .where(eq(catalogLanguageStatuses.language, filter.targetLanguage)),
    db.select().from(catalogExternalIds),
    readCatalogConflictReview(db),
  ]);

  const sourceProvenanceIds = new Set<string>();
  for (const status of statusRows) {
    if (status.sourceProvenanceId !== null) {
      sourceProvenanceIds.add(status.sourceProvenanceId);
    }
  }
  for (const externalId of externalIdRows) {
    if (externalId.sourceProvenanceId !== null) {
      sourceProvenanceIds.add(externalId.sourceProvenanceId);
    }
  }

  const sourceRows =
    sourceProvenanceIds.size === 0
      ? []
      : await db
          .select()
          .from(catalogSourceProvenance)
          .where(
            inArray(catalogSourceProvenance.sourceProvenanceId, Array.from(sourceProvenanceIds)),
          );
  const sourcesById = new Map(
    sourceRows
      .map((row) => [row.sourceProvenanceId, sourceSummaryFromRow(row)] as const)
      .filter(
        (entry): entry is readonly [string, CatalogCompletenessSourceSummary] => entry[1] !== null,
      ),
  );

  const statusesByWorkId = new Map<string, (typeof catalogLanguageStatuses.$inferSelect)[]>();
  for (const status of statusRows) {
    if (!status.isCurrent) {
      continue;
    }
    const existing = statusesByWorkId.get(status.workId) ?? [];
    existing.push(status);
    statusesByWorkId.set(status.workId, existing);
  }

  const externalIdsByWorkId = new Map<string, (typeof catalogExternalIds.$inferSelect)[]>();
  for (const externalId of externalIdRows) {
    const existing = externalIdsByWorkId.get(externalId.workId) ?? [];
    existing.push(externalId);
    externalIdsByWorkId.set(externalId.workId, existing);
  }

  const languageConflictRows = conflictReviewRows.filter(
    (row) =>
      row.conflictKind === catalogConflictKindValues.languageStatus &&
      row.status === catalogConflictStatusValues.open,
  );
  const conflictsByWorkId = new Map<string, CatalogConflictReviewRow[]>();
  for (const conflict of languageConflictRows) {
    const existing = conflictsByWorkId.get(conflict.catalogRecordId) ?? [];
    existing.push(conflict);
    conflictsByWorkId.set(conflict.catalogRecordId, existing);
  }

  const pools = emptyCompletenessPools();
  for (const workRow of workRows) {
    const currentStatusRows = statusesByWorkId.get(workRow.workId) ?? [];
    const statusFacts = currentStatusRows
      .map((status) => completenessStatusFactFromRow(status, sourcesById))
      .sort(compareCompletenessStatusFacts);
    const sourceIds = sourceIdsForCompletenessWork(
      statusFacts,
      externalIdsByWorkId.get(workRow.workId) ?? [],
    );
    const privateExternalSourceCount = countPrivateSourceIds(
      (externalIdsByWorkId.get(workRow.workId) ?? []).map((externalId) => ({
        catalogSource: externalId.catalogSource as CatalogSource,
        sourceId: externalId.sourceId,
      })),
    );
    const conflicts = (conflictsByWorkId.get(workRow.workId) ?? []).map((row) => ({
      conflictId: row.conflictId ?? row.reviewId,
      status: row.status as CatalogConflictStatus,
      reasonCode: row.reasonCode,
      sourceIds: row.sourceIds,
      privateSourceCount: row.privateSourceCount,
    }));
    const poolWork: CatalogCompletenessPoolWork = {
      workId: workRow.workId,
      canonicalTitle: workRow.canonicalTitle,
      originalLanguage: workRow.originalLanguage,
      sourceIds,
      privateSourceCount:
        privateExternalSourceCount +
        statusFacts.reduce((sum, status) => sum + status.privateSourceCount, 0) +
        conflicts.reduce((sum, conflict) => sum + conflict.privateSourceCount, 0),
      statuses: statusFacts,
      conflicts,
    };

    for (const pool of poolsForCompletenessWork(poolWork)) {
      pools[pool].push(poolWork);
    }
  }

  for (const pool of catalogCompletenessPools) {
    pools[pool].sort(compareCompletenessPoolWorks);
  }

  const selectedPools =
    filter.pool === undefined
      ? pools
      : {
          ...emptyCompletenessPools(),
          [filter.pool]: pools[filter.pool],
        };

  return {
    targetLanguage: filter.targetLanguage,
    pools: selectedPools,
    publicReport: publicCompletenessReport(filter.targetLanguage, selectedPools),
  };
}
