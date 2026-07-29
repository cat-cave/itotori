import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";

import {
  type CatalogArtifactMappingErrorCode,
  CatalogArtifactMappingError,
  ItotoriCatalogRepository,
} from "../src/repositories/catalog-repository.js";
import {
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConfidenceValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  userPermissionGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-17T12:00:00.000Z";

/**
 * Asserts a catalog artifact-mapping validation failure exposes the expected
 * stable machine-readable code (not merely a matching message string), and
 * returns the caught error so callers can additionally assert the message.
 */
async function expectArtifactMappingError(
  promise: Promise<unknown>,
  expectedCode: CatalogArtifactMappingErrorCode,
): Promise<CatalogArtifactMappingError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected upsertWork to reject").toBeInstanceOf(CatalogArtifactMappingError);
  const error = caught as CatalogArtifactMappingError;
  expect(error.code).toBe(expectedCode);
  return error;
}

import { provenance, completenessStatus, uuid } from "./catalog-repository.test.shared-01.js";

describe("ItotoriCatalogRepository", () => {
  it("selects completeness benchmark pools with conflict-safe source evidence and public aggregates", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const provenanceRecords = {
        egs: await provenance(repo, 901, catalogSourceValues.egs, "egs-complete-002", {
          payload: { catalogSource: "egs", sourceId: "egs-complete-002", rawNote: "public fact" },
          rawContentRedactionClass: catalogRawContentRedactionClassValues.publicRaw,
        }),
        vndb: await provenance(repo, 902, catalogSourceValues.vndb, "v-complete-002"),
        steam: await provenance(repo, 903, catalogSourceValues.steam, "steam-complete-002"),
        local: await provenance(repo, 904, catalogSourceValues.localCorpus, "local-complete-002", {
          sourceRecordKind: catalogSourceRecordKindValues.localScan,
          payload: { privateCorpusLine: "PRIVATE_CORPUS_TEXT_SHOULD_NOT_APPEAR" },
          rawContentRedactionClass: catalogRawContentRedactionClassValues.privateCorpus,
        }),
      };

      await repo.upsertWork(localActor, {
        workId: uuid(911),
        canonicalTitle: "Completeness MTL-only fixture",
        originalLanguage: "ja-JP",
        languageStatuses: [
          completenessStatus(
            921,
            catalogLanguageStatusValues.mtl,
            provenanceRecords.egs.sourceProvenanceId,
          ),
        ],
      });
      await repo.upsertWork(localActor, {
        workId: uuid(912),
        canonicalTitle: "Completeness fan partial fixture",
        originalLanguage: "ja-JP",
        languageStatuses: [
          completenessStatus(
            922,
            catalogLanguageStatusValues.fanPartial,
            provenanceRecords.vndb.sourceProvenanceId,
          ),
        ],
      });
      await repo.upsertWork(localActor, {
        workId: uuid(913),
        canonicalTitle: "Completeness no English fixture",
        originalLanguage: "ja-JP",
        languageStatuses: [
          completenessStatus(
            923,
            catalogLanguageStatusValues.none,
            provenanceRecords.vndb.sourceProvenanceId,
          ),
        ],
      });
      await repo.upsertWork(localActor, {
        workId: uuid(914),
        canonicalTitle: "Completeness unknown fixture",
        originalLanguage: "ja-JP",
        languageStatuses: [
          completenessStatus(
            924,
            catalogLanguageStatusValues.unknown,
            provenanceRecords.egs.sourceProvenanceId,
          ),
        ],
      });

      const noEnglishStatusId = uuid(925);
      const officialStatusId = uuid(926);
      const localSidecarStatusId = uuid(927);
      await repo.upsertWork(localActor, {
        workId: uuid(915),
        canonicalTitle: "Completeness conflict fixture",
        originalLanguage: "ja-JP",
        languageStatuses: [
          {
            ...completenessStatus(
              925,
              catalogLanguageStatusValues.none,
              provenanceRecords.vndb.sourceProvenanceId,
            ),
            confidence: catalogConfidenceValues.medium,
          },
          {
            ...completenessStatus(
              926,
              catalogLanguageStatusValues.officialFull,
              provenanceRecords.steam.sourceProvenanceId,
            ),
            platform: "steam",
            statusScope: catalogLanguageStatusScopeValues.platform,
          },
          {
            ...completenessStatus(
              927,
              catalogLanguageStatusValues.fanFull,
              provenanceRecords.local.sourceProvenanceId,
            ),
            rawContentRedactionClass: catalogRawContentRedactionClassValues.privateCorpus,
            parserVersion: "local-sidecar-completeness.v0.1",
          },
        ],
        conflicts: [
          {
            conflictId: uuid(931),
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "VNDB, Steam, and local sidecar disagree on English completeness.",
            metadata: { reasonCode: "source_disagreement", severity: "warning" },
            evidence: [
              {
                conflictEvidenceId: uuid(941),
                subjectKind: catalogConflictSubjectKindValues.languageStatus,
                subjectId: noEnglishStatusId,
                sourceProvenanceId: provenanceRecords.vndb.sourceProvenanceId,
              },
              {
                conflictEvidenceId: uuid(942),
                subjectKind: catalogConflictSubjectKindValues.languageStatus,
                subjectId: officialStatusId,
                sourceProvenanceId: provenanceRecords.steam.sourceProvenanceId,
                evidencePosition: 1,
              },
              {
                conflictEvidenceId: uuid(943),
                subjectKind: catalogConflictSubjectKindValues.languageStatus,
                subjectId: localSidecarStatusId,
                sourceProvenanceId: provenanceRecords.local.sourceProvenanceId,
                evidencePosition: 2,
              },
            ],
          },
        ],
      });

      expect(Object.values(catalogLanguageStatusValues).sort()).toEqual([
        "fan_full",
        "fan_partial",
        "interface_only",
        "mtl",
        "none",
        "official_full",
        "unknown",
        "unverified_console",
      ]);

      const pools = await repo.catalogCompletenessBenchmarkPools(localActor, {
        targetLanguage: "en-US",
      });

      expect(pools.pools.mtl_only.map((work) => work.workId)).toEqual([uuid(911)]);
      expect(pools.pools.fan_partial.map((work) => work.workId)).toEqual([uuid(912)]);
      expect(pools.pools.no_english.map((work) => work.workId)).toEqual([uuid(913)]);
      expect(pools.pools.unknown.map((work) => work.workId)).toEqual([uuid(914)]);
      expect(pools.pools.conflict.map((work) => work.workId)).toEqual([uuid(915)]);

      const conflictWork = pools.pools.conflict[0];
      expect(conflictWork?.statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            languageStatusId: noEnglishStatusId,
            source: expect.objectContaining({
              sourceId: "v-complete-002",
              sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
              sourceVersion: "fixture-2026-06-17",
              fetchedAt: new Date(fetchedAt),
            }),
            importedAt: new Date("2026-06-17T12:05:00.000Z"),
            parserVersion: "catalog-completeness-fixture.v0.1",
          }),
          expect.objectContaining({
            languageStatusId: localSidecarStatusId,
            sourceProvenanceId: null,
            rawContentRedactionClass: catalogRawContentRedactionClassValues.redacted,
            source: null,
            privateSourceCount: 1,
          }),
        ]),
      );
      expect(conflictWork?.sourceIds).toEqual([
        { catalogSource: catalogSourceValues.steam, sourceId: "steam-complete-002" },
        { catalogSource: catalogSourceValues.vndb, sourceId: "v-complete-002" },
      ]);
      expect(conflictWork?.privateSourceCount).toBe(2);
      expect(conflictWork?.conflicts).toEqual([
        expect.objectContaining({
          conflictId: uuid(931),
          reasonCode: "source_disagreement",
          sourceIds: expect.arrayContaining([
            { catalogSource: catalogSourceValues.vndb, sourceId: "v-complete-002" },
            { catalogSource: catalogSourceValues.steam, sourceId: "steam-complete-002" },
          ]),
          privateSourceCount: 1,
        }),
      ]);

      const poolsJson = JSON.stringify(pools);
      expect(poolsJson).not.toContain("local-complete-002");
      expect(poolsJson).not.toContain(catalogSourceValues.localCorpus);
      expect(poolsJson).not.toContain(catalogSourceRecordKindValues.localScan);
      expect(poolsJson).not.toContain(catalogRawContentRedactionClassValues.privateCorpus);
      const publicReportJson = JSON.stringify(pools.publicReport);
      expect(publicReportJson).not.toContain("PRIVATE_CORPUS_TEXT_SHOULD_NOT_APPEAR");
      expect(pools.publicReport.pools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pool: "mtl_only", workCount: 1 }),
          expect.objectContaining({ pool: "fan_partial", workCount: 1 }),
          expect.objectContaining({ pool: "no_english", workCount: 1 }),
          expect.objectContaining({ pool: "unknown", workCount: 1 }),
          expect.objectContaining({ pool: "conflict", workCount: 1 }),
        ]),
      );

      const mtlOnly = await repo.catalogCompletenessBenchmarkPools(localActor, {
        targetLanguage: "en-US",
        pool: "mtl_only",
      });
      expect(mtlOnly.pools.mtl_only).toHaveLength(1);
      expect(mtlOnly.pools.conflict).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("dedupes public aggregate counts across overlapping pools while preserving pool-local counts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const vndb = await provenance(repo, 952, catalogSourceValues.vndb, "v-overlap-001");

      // Work A: fan_partial only -> belongs solely to the fan_partial pool.
      await repo.upsertWork(localActor, {
        workId: uuid(961),
        canonicalTitle: "Overlap fan partial only",
        originalLanguage: "ja-JP",
        languageStatuses: [
          completenessStatus(971, catalogLanguageStatusValues.fanPartial, vndb.sourceProvenanceId),
        ],
      });

      // Work B: a fan_partial status AND a conflict -> lands in BOTH the
      // fan_partial and conflict pools. This overlap is what the aggregate must
      // dedupe: its single fan_partial status + single conflict must each be
      // counted once in the aggregate, even though the work appears in two pools.
      const overlapStatusId = uuid(972);
      await repo.upsertWork(localActor, {
        workId: uuid(962),
        canonicalTitle: "Overlap fan partial with conflict",
        originalLanguage: "ja-JP",
        languageStatuses: [
          completenessStatus(972, catalogLanguageStatusValues.fanPartial, vndb.sourceProvenanceId),
        ],
        conflicts: [
          {
            conflictId: uuid(981),
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "Sources disagree on fan-translation completeness.",
            metadata: { reasonCode: "source_disagreement", severity: "warning" },
            evidence: [
              {
                conflictEvidenceId: uuid(991),
                subjectKind: catalogConflictSubjectKindValues.languageStatus,
                subjectId: overlapStatusId,
                sourceProvenanceId: vndb.sourceProvenanceId,
              },
            ],
          },
        ],
      });

      const pools = await repo.catalogCompletenessBenchmarkPools(localActor, {
        targetLanguage: "en-US",
      });

      // Pool-local counts are preserved: work B legitimately appears in BOTH pools.
      expect(pools.pools.fan_partial.map((work) => work.workId)).toEqual([uuid(961), uuid(962)]);
      expect(pools.pools.conflict.map((work) => work.workId)).toEqual([uuid(962)]);
      const poolWorkCounts = new Map(
        pools.publicReport.pools.map((pool) => [pool.pool, pool.workCount]),
      );
      expect(poolWorkCounts.get("fan_partial")).toBe(2);
      expect(poolWorkCounts.get("conflict")).toBe(1);

      // Aggregate counts dedupe by identity across the overlapping pools.
      // totalWorkCount: work B counted once even though it is in two pools.
      expect(pools.publicReport.totalWorkCount).toBe(2);
      // conflictCount: work B's single conflict counted ONCE (not once per pool).
      expect(pools.publicReport.conflictCount).toBe(1);
      // Status facts: work A + work B each contribute their fan_partial status
      // once; work B's status is not double-counted for its second pool.
      const fanPartialStatus = pools.publicReport.statuses.find(
        (status) => status.status === catalogLanguageStatusValues.fanPartial,
      );
      expect(fanPartialStatus?.factCount).toBe(2);
    } finally {
      await context.close();
    }
  });

  it("bootstraps catalog permissions and creates catalog lookup indexes", async () => {
    const context = await isolatedMigratedContext();
    try {
      const grants = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.userId, localUserId));

      const grantSet = new Set(grants.map((grant) => grant.permission));
      expect(grantSet.has(permissionValues.catalogRead)).toBe(true);
      expect(grantSet.has(permissionValues.catalogWrite)).toBe(true);

      const result = await context.db.execute(sql`
        select indexname
        from pg_indexes
        where schemaname = current_schema()
          and indexname in (
            'itotori_catalog_external_ids_source_idx',
            'itotori_catalog_source_provenance_lookup_idx',
            'itotori_catalog_language_statuses_work_lang_idx',
            'itotori_catalog_seed_targets_status_idx',
            'itotori_catalog_local_scan_entries_path_idx',
            'itotori_catalog_candidate_matches_source_target_idx',
            'itotori_catalog_release_mappings_relation_idx',
            'itotori_catalog_release_install_states_target_idx'
          )
      `);
      expect(new Set(result.rows.map((row) => String(row.indexname)))).toEqual(
        new Set([
          "itotori_catalog_external_ids_source_idx",
          "itotori_catalog_source_provenance_lookup_idx",
          "itotori_catalog_language_statuses_work_lang_idx",
          "itotori_catalog_seed_targets_status_idx",
          "itotori_catalog_local_scan_entries_path_idx",
          "itotori_catalog_candidate_matches_source_target_idx",
          "itotori_catalog_release_mappings_relation_idx",
          "itotori_catalog_release_install_states_target_idx",
        ]),
      );
    } finally {
      await context.close();
    }
  });
});
