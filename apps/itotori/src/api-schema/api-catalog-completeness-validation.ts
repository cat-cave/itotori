import {
  CatalogCompletenessBenchmarkPools,
  CatalogCompletenessPool,
  CatalogConfidence,
  CatalogConflictReviewStatus,
  CatalogConflictStatus,
  CatalogLanguageStatus,
  CatalogLanguageStatusScope,
  catalogCandidateMatchStatusValues,
  catalogCompletenessPoolValues,
  catalogConfidenceValues,
  catalogConflictStatusValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
} from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-strict-body-keys.js";
import {
  asArray,
  asStrictRecord,
  assertConflictReviewSourceIds,
  assertDateLike,
  assertEnum,
  assertNoCatalogPrivateLeakage,
  assertNonNegativeInteger,
  assertNullableString,
  assertPublicCatalogRedactionClass,
  assertPublicCatalogSource,
  assertPublicCatalogSourceRecordKind,
  assertString,
} from "./api-validation-primitives.js";

export function assertCatalogCompletenessBenchmarkPools(
  value: unknown,
  label = "CatalogCompletenessBenchmarkPools",
): asserts value is CatalogCompletenessBenchmarkPools {
  const model = asStrictRecord(
    value,
    label,
    STRICT_API_BODY_KEYS.CatalogCompletenessBenchmarkPools,
  );
  assertString(model.targetLanguage, `${label}.targetLanguage`);
  const pools = asStrictRecord(model.pools, `${label}.pools`, [
    "mtl_only",
    "fan_partial",
    "no_english",
    "unknown",
    "conflict",
  ]);
  for (const poolName of [
    "mtl_only",
    "fan_partial",
    "no_english",
    "unknown",
    "conflict",
  ] as const) {
    const works = asArray(pools[poolName], `${label}.pools.${poolName}`);
    for (const [index, workValue] of works.entries()) {
      const work = asStrictRecord(workValue, `${label}.pools.${poolName}[${index}]`, [
        "workId",
        "canonicalTitle",
        "originalLanguage",
        "sourceIds",
        "privateSourceCount",
        "statuses",
        "conflicts",
      ]);
      assertString(work.workId, `${label}.pools.${poolName}[${index}].workId`);
      assertString(work.canonicalTitle, `${label}.pools.${poolName}[${index}].canonicalTitle`);
      assertNullableString(
        work.originalLanguage,
        `${label}.pools.${poolName}[${index}].originalLanguage`,
      );
      assertConflictReviewSourceIds(
        work.sourceIds,
        `${label}.pools.${poolName}[${index}].sourceIds`,
      );
      assertNonNegativeInteger(
        work.privateSourceCount,
        `${label}.pools.${poolName}[${index}].privateSourceCount`,
      );
      const statuses = asArray(work.statuses, `${label}.pools.${poolName}[${index}].statuses`);
      for (const [statusIndex, statusValue] of statuses.entries()) {
        const statusLabel = `${label}.pools.${poolName}[${index}].statuses[${statusIndex}]`;
        const status = asStrictRecord(statusValue, statusLabel, [
          "languageStatusId",
          "language",
          "status",
          "statusScope",
          "platform",
          "releaseId",
          "sourceProvenanceId",
          "source",
          "privateSourceCount",
          "confidence",
          "observedAt",
          "importedAt",
          "parserVersion",
          "rawContentRedactionClass",
        ]);
        assertString(
          status.languageStatusId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].languageStatusId`,
        );
        assertString(
          status.language,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].language`,
        );
        assertEnum(
          status.status,
          Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].status`,
        );
        assertEnum(
          status.statusScope,
          Object.values(catalogLanguageStatusScopeValues) as CatalogLanguageStatusScope[],
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].statusScope`,
        );
        assertNullableString(
          status.platform,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].platform`,
        );
        assertNullableString(
          status.releaseId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].releaseId`,
        );
        assertNullableString(
          status.sourceProvenanceId,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].sourceProvenanceId`,
        );
        assertEnum(
          status.confidence,
          Object.values(catalogConfidenceValues) as CatalogConfidence[],
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].confidence`,
        );
        assertDateLike(
          status.observedAt,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].observedAt`,
        );
        assertDateLike(
          status.importedAt,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].importedAt`,
        );
        assertString(
          status.parserVersion,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].parserVersion`,
        );
        assertString(
          status.rawContentRedactionClass,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].rawContentRedactionClass`,
        );
        assertPublicCatalogRedactionClass(
          status.rawContentRedactionClass,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].rawContentRedactionClass`,
        );
        if (status.source !== null) {
          const sourceLabel = `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source`;
          const source = asStrictRecord(status.source, sourceLabel, [
            "sourceProvenanceId",
            "catalogSource",
            "sourceRecordKind",
            "sourceId",
            "sourceVersion",
            "fetchedAt",
            "rawContentRedactionClass",
          ]);
          assertString(
            source.sourceProvenanceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceProvenanceId`,
          );
          assertString(
            source.catalogSource,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.catalogSource`,
          );
          assertPublicCatalogSource(
            source.catalogSource,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.catalogSource`,
          );
          assertString(
            source.sourceRecordKind,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceRecordKind`,
          );
          assertPublicCatalogSourceRecordKind(
            source.sourceRecordKind,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceRecordKind`,
          );
          assertString(
            source.sourceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceId`,
          );
          assertNoCatalogPrivateLeakage(
            source.sourceId,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceId`,
          );
          assertNullableString(
            source.sourceVersion,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.sourceVersion`,
          );
          assertDateLike(
            source.fetchedAt,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.fetchedAt`,
          );
          assertString(
            source.rawContentRedactionClass,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.rawContentRedactionClass`,
          );
          assertPublicCatalogRedactionClass(
            source.rawContentRedactionClass,
            `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].source.rawContentRedactionClass`,
          );
        }
        assertNonNegativeInteger(
          status.privateSourceCount,
          `${label}.pools.${poolName}[${index}].statuses[${statusIndex}].privateSourceCount`,
        );
      }
      const conflicts = asArray(work.conflicts, `${label}.pools.${poolName}[${index}].conflicts`);
      for (const [conflictIndex, conflictValue] of conflicts.entries()) {
        const conflict = asStrictRecord(
          conflictValue,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}]`,
          ["conflictId", "status", "reasonCode", "sourceIds", "privateSourceCount"],
        );
        assertString(
          conflict.conflictId,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].conflictId`,
        );
        assertEnum(
          conflict.status,
          Object.values(catalogConflictStatusValues) as CatalogConflictStatus[],
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].status`,
        );
        assertString(
          conflict.reasonCode,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].reasonCode`,
        );
        assertConflictReviewSourceIds(
          conflict.sourceIds,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].sourceIds`,
        );
        assertNonNegativeInteger(
          conflict.privateSourceCount,
          `${label}.pools.${poolName}[${index}].conflicts[${conflictIndex}].privateSourceCount`,
        );
      }
    }
  }
  const publicReport = asStrictRecord(model.publicReport, `${label}.publicReport`, [
    "schemaVersion",
    "targetLanguage",
    "generatedAt",
    "totalWorkCount",
    "conflictCount",
    "pools",
    "statuses",
  ]);
  assertString(publicReport.schemaVersion, `${label}.publicReport.schemaVersion`);
  assertString(publicReport.targetLanguage, `${label}.publicReport.targetLanguage`);
  assertDateLike(publicReport.generatedAt, `${label}.publicReport.generatedAt`);
  assertNonNegativeInteger(publicReport.totalWorkCount, `${label}.publicReport.totalWorkCount`);
  assertNonNegativeInteger(publicReport.conflictCount, `${label}.publicReport.conflictCount`);
  const reportPools = asArray(publicReport.pools, `${label}.publicReport.pools`);
  for (const [index, poolValue] of reportPools.entries()) {
    const pool = asStrictRecord(poolValue, `${label}.publicReport.pools[${index}]`, [
      "pool",
      "workCount",
      "sourceIds",
    ]);
    assertEnum(
      pool.pool,
      Object.values(catalogCompletenessPoolValues) as CatalogCompletenessPool[],
      `${label}.publicReport.pools[${index}].pool`,
    );
    assertNonNegativeInteger(pool.workCount, `${label}.publicReport.pools[${index}].workCount`);
    assertConflictReviewSourceIds(
      pool.sourceIds,
      `${label}.publicReport.pools[${index}].sourceIds`,
    );
  }
  const reportStatuses = asArray(publicReport.statuses, `${label}.publicReport.statuses`);
  for (const [index, statusValue] of reportStatuses.entries()) {
    const status = asStrictRecord(statusValue, `${label}.publicReport.statuses[${index}]`, [
      "status",
      "factCount",
      "sourceIds",
    ]);
    assertEnum(
      status.status,
      Object.values(catalogLanguageStatusValues) as CatalogLanguageStatus[],
      `${label}.publicReport.statuses[${index}].status`,
    );
    assertNonNegativeInteger(
      status.factCount,
      `${label}.publicReport.statuses[${index}].factCount`,
    );
    assertConflictReviewSourceIds(
      status.sourceIds,
      `${label}.publicReport.statuses[${index}].sourceIds`,
    );
  }
}

export const catalogConflictReviewStatusValues: readonly CatalogConflictReviewStatus[] = [
  ...Object.values(catalogConflictStatusValues),
  ...Object.values(catalogCandidateMatchStatusValues),
];
