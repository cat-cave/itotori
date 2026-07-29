import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  type CatalogArtifactMappingErrorCode,
  CatalogArtifactMappingError,
  ItotoriCatalogRepository,
} from "../src/repositories/catalog-repository.js";
import {
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConfidenceValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogLocalScanEntries,
  catalogPathRedactionClassValues,
  catalogReleaseKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceProvenance,
  catalogSourceValues,
  catalogWorks,
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

import {
  recordFixtureProvenance,
  provenance,
  uuid,
  hash,
} from "./catalog-repository.test.shared-01.js";

describe("ItotoriCatalogRepository", () => {
  it("persists source-independent work identity, provenance, releases, language status, conflicts, local scans, and seed targets", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const provenance = await recordFixtureProvenance(repo);

      const dlsiteOnly = await repo.upsertWork(localActor, {
        workId: uuid(101),
        canonicalTitle: "DLsite-only fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2022,
        engine: {
          engineName: "RPG Maker MV",
          engineSource: catalogEngineSourceValues.dlsiteWorktypeInferred,
          engineConfidence: catalogConfidenceValues.medium,
          engineProvenanceId: provenance.dlsite.sourceProvenanceId,
        },
        externalIds: [
          {
            externalIdId: uuid(201),
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJ349517",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
          },
        ],
        releases: [
          {
            releaseId: uuid(301),
            catalogSource: catalogSourceValues.dlsite,
            sourceReleaseId: "RJ349517",
            releaseTitle: "DLsite-only fixture",
            releaseKind: catalogReleaseKindValues.original,
            platform: "pc",
            language: "ja-JP",
            releaseYear: 2022,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
          },
        ],
        languageStatuses: [
          {
            languageStatusId: uuid(401),
            language: "en-US",
            status: catalogLanguageStatusValues.none,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
            confidence: catalogConfidenceValues.medium,
            observedAt: fetchedAt,
          },
        ],
      });

      await repo.upsertWork(localActor, {
        workId: uuid(102),
        canonicalTitle: "EGS-only fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2018,
        externalIds: [
          {
            externalIdId: uuid(202),
            catalogSource: catalogSourceValues.egs,
            sourceId: "12874",
            sourceProvenanceId: provenance.egs.sourceProvenanceId,
          },
        ],
        languageStatuses: [
          {
            languageStatusId: uuid(402),
            language: "en-US",
            status: catalogLanguageStatusValues.unknown,
            sourceProvenanceId: provenance.egs.sourceProvenanceId,
            confidence: catalogConfidenceValues.low,
            observedAt: fetchedAt,
          },
        ],
      });

      await repo.upsertWork(localActor, {
        workId: uuid(103),
        canonicalTitle: "VNDB-linked fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2011,
        externalIds: [
          {
            externalIdId: uuid(203),
            catalogSource: catalogSourceValues.vndb,
            sourceId: "v17",
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
          },
          {
            externalIdId: uuid(204),
            catalogSource: catalogSourceValues.egs,
            sourceId: "90017",
            sourceProvenanceId: provenance.egs.sourceProvenanceId,
          },
        ],
        releases: [
          {
            releaseId: uuid(302),
            catalogSource: catalogSourceValues.vndb,
            sourceReleaseId: "r123",
            releaseTitle: "VNDB-linked fixture",
            releaseKind: catalogReleaseKindValues.original,
            platform: "pc",
            language: "ja-JP",
            releaseYear: 2011,
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
          },
        ],
        languageStatuses: [
          {
            languageStatusId: uuid(403),
            language: "en-US",
            status: catalogLanguageStatusValues.fanPartial,
            statusScope: catalogLanguageStatusScopeValues.release,
            releaseId: uuid(302),
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
            observedAt: fetchedAt,
          },
        ],
      });

      const steamNoneStatusId = uuid(404);
      const steamOfficialStatusId = uuid(405);
      const steamConflictId = uuid(501);
      const steamLinked = await repo.upsertWork(localActor, {
        workId: uuid(104),
        canonicalTitle: "Steam-linked fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2016,
        externalIds: [
          {
            externalIdId: uuid(205),
            catalogSource: catalogSourceValues.steam,
            sourceId: "333600",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            sourceProvenanceId: provenance.steam.sourceProvenanceId,
          },
          {
            externalIdId: uuid(206),
            catalogSource: catalogSourceValues.vndb,
            sourceId: "v333600",
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
          },
        ],
        releases: [
          {
            releaseId: uuid(303),
            catalogSource: catalogSourceValues.steam,
            sourceReleaseId: "333600",
            releaseTitle: "Steam-linked fixture",
            releaseKind: catalogReleaseKindValues.officialTranslation,
            platform: "steam",
            language: "en-US",
            releaseYear: 2016,
            isOfficial: true,
            sourceProvenanceId: provenance.steam.sourceProvenanceId,
          },
        ],
        languageStatuses: [
          {
            languageStatusId: steamNoneStatusId,
            language: "en-US",
            status: catalogLanguageStatusValues.none,
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
            confidence: catalogConfidenceValues.medium,
            observedAt: fetchedAt,
          },
          {
            languageStatusId: steamOfficialStatusId,
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            statusScope: catalogLanguageStatusScopeValues.platform,
            platform: "steam",
            releaseId: uuid(303),
            sourceProvenanceId: provenance.steam.sourceProvenanceId,
            observedAt: fetchedAt,
          },
        ],
        conflicts: [
          {
            conflictId: steamConflictId,
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "VNDB lacks the English release that Steam reports.",
            detectedAt: fetchedAt,
            evidence: [
              {
                conflictEvidenceId: uuid(601),
                subjectKind: catalogConflictSubjectKindValues.languageStatus,
                subjectId: steamNoneStatusId,
                sourceProvenanceId: provenance.vndb.sourceProvenanceId,
              },
              {
                conflictEvidenceId: uuid(602),
                subjectKind: catalogConflictSubjectKindValues.languageStatus,
                subjectId: steamOfficialStatusId,
                sourceProvenanceId: provenance.steam.sourceProvenanceId,
                evidencePosition: 1,
              },
            ],
          },
        ],
      });

      await repo.upsertWork(localActor, {
        workId: uuid(105),
        canonicalTitle: "IGDB and Wikidata fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2019,
        externalIds: [
          {
            externalIdId: uuid(207),
            catalogSource: catalogSourceValues.igdb,
            sourceId: "1942",
            externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
            sourceProvenanceId: provenance.igdb.sourceProvenanceId,
          },
          {
            externalIdId: uuid(208),
            catalogSource: catalogSourceValues.wikidata,
            sourceId: "Q123456",
            externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
            sourceProvenanceId: provenance.wikidata.sourceProvenanceId,
          },
        ],
        releases: [
          {
            releaseId: uuid(304),
            catalogSource: catalogSourceValues.igdb,
            sourceReleaseId: "1942:switch",
            releaseTitle: "IGDB and Wikidata fixture",
            releaseKind: catalogReleaseKindValues.unknown,
            platform: "switch",
            language: "ja-JP",
            releaseYear: 2019,
            sourceProvenanceId: provenance.igdb.sourceProvenanceId,
          },
        ],
        languageStatuses: [
          {
            languageStatusId: uuid(406),
            language: "en-US",
            status: catalogLanguageStatusValues.unverifiedConsole,
            platform: "switch",
            sourceProvenanceId: provenance.igdb.sourceProvenanceId,
            confidence: catalogConfidenceValues.medium,
            observedAt: fetchedAt,
          },
        ],
      });

      const localOnly = await repo.upsertWork(localActor, {
        canonicalTitle: "Local-only fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2024,
        externalIds: [
          {
            externalIdId: uuid(209),
            catalogSource: catalogSourceValues.localCorpus,
            sourceId: "local-owned-hash-001",
            externalIdKind: catalogExternalIdKindValues.localDetection,
            sourceProvenanceId: provenance.local.sourceProvenanceId,
          },
        ],
        languageStatuses: [
          {
            languageStatusId: uuid(407),
            language: "en-US",
            status: catalogLanguageStatusValues.none,
            sourceProvenanceId: provenance.local.sourceProvenanceId,
            observedAt: fetchedAt,
          },
        ],
      });
      expect(localOnly.workId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );

      const localScan = await repo.recordLocalScan(localActor, {
        localScanId: uuid(701),
        scanRootLabel: "fixture library",
        scanRootPathHash: hash("scan-root"),
        scannerName: "kaifuu-local-scan-fixture",
        scannerVersion: "0.0.0",
        startedAt: fetchedAt,
        completedAt: "2026-06-17T12:01:00.000Z",
        entries: [
          {
            localScanEntryId: uuid(702),
            workId: localOnly.workId,
            pathHash: hash("local-only-fixture-path"),
            pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
            owned: true,
            engineName: "RPG Maker MV",
            engineSource: catalogEngineSourceValues.localScan,
            engineConfidence: catalogConfidenceValues.high,
            signals: { files: ["www/data/System.json"], archives: [] },
            sourceProvenanceId: provenance.local.sourceProvenanceId,
            detectedExternalIds: [
              {
                catalogSource: catalogSourceValues.dlsite,
                sourceId: "RJLOCAL001",
                externalIdKind: catalogExternalIdKindValues.localDetection,
                sourceProvenanceId: provenance.local.sourceProvenanceId,
              },
            ],
            seedTargets: [
              {
                seedTargetId: uuid(703),
                catalogSource: catalogSourceValues.dlsite,
                sourceId: "RJLOCAL001",
                seedOrigin: catalogSeedOriginValues.localScan,
                sourceProvenanceId: provenance.local.sourceProvenanceId,
                status: catalogSeedStatusValues.pending,
                priority: 10,
                addedAt: fetchedAt,
              },
            ],
          },
        ],
      });

      expect(dlsiteOnly.externalIds.map((externalId) => externalId.catalogSource)).toEqual([
        catalogSourceValues.dlsite,
      ]);
      expect(steamLinked.languageStatuses.map((status) => status.status).sort()).toEqual([
        catalogLanguageStatusValues.none,
        catalogLanguageStatusValues.officialFull,
      ]);
      expect(steamLinked.conflicts[0]).toMatchObject({
        conflictId: steamConflictId,
        evidence: expect.arrayContaining([
          expect.objectContaining({ sourceProvenanceId: provenance.vndb.sourceProvenanceId }),
          expect.objectContaining({ sourceProvenanceId: provenance.steam.sourceProvenanceId }),
        ]),
      });
      expect(localScan.entries[0]).toMatchObject({
        workId: localOnly.workId,
        owned: true,
        engineName: "RPG Maker MV",
      });
      expect(localScan.entries[0]?.detectedExternalIds).toHaveLength(1);
      expect(localScan.entries[0]?.seedTargets[0]).toMatchObject({
        catalogSource: catalogSourceValues.dlsite,
        sourceId: "RJLOCAL001",
        status: catalogSeedStatusValues.pending,
      });

      const steamLookup = await repo.getWorkByExternalId(
        localActor,
        catalogSourceValues.steam,
        "333600",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(steamLookup?.workId).toBe(steamLinked.workId);
      expect(steamLookup?.releases[0]).toMatchObject({
        platform: "steam",
        isOfficial: true,
        sourceProvenanceId: provenance.steam.sourceProvenanceId,
      });

      const pendingSeeds = await repo.listSeedTargets(localActor, catalogSeedStatusValues.pending);
      expect(pendingSeeds.map((seed) => seed.sourceId)).toContain("RJLOCAL001");

      const counts = await context.db.execute(sql`
        select
          (select count(*)::int from ${catalogWorks}) as work_count,
          (select count(*)::int from itotori_catalog_external_ids) as external_id_count,
          (select count(*)::int from ${catalogSourceProvenance}) as provenance_count,
          (select count(*)::int from itotori_catalog_releases) as release_count,
          (select count(*)::int from itotori_catalog_language_statuses) as language_status_count,
          (select count(*)::int from itotori_catalog_conflicts) as conflict_count,
          (select count(*)::int from itotori_catalog_conflict_evidence) as conflict_evidence_count,
          (select count(*)::int from ${catalogLocalScanEntries}) as local_scan_entry_count,
          (select count(*)::int from itotori_catalog_seed_targets) as seed_target_count
      `);
      expect(counts.rows[0]).toMatchObject({
        work_count: 6,
        external_id_count: 9,
        provenance_count: 7,
        release_count: 4,
        language_status_count: 7,
        conflict_count: 1,
        conflict_evidence_count: 2,
        local_scan_entry_count: 1,
        seed_target_count: 1,
      });

      const storedProvenance = await context.db
        .select()
        .from(catalogSourceProvenance)
        .where(eq(catalogSourceProvenance.sourceProvenanceId, provenance.dlsite.sourceProvenanceId))
        .limit(1);
      expect(storedProvenance[0]).toMatchObject({
        catalogSource: catalogSourceValues.dlsite,
        fetchedAt: new Date(fetchedAt),
        payloadHash: hash("dlsite:RJ349517"),
      });
    } finally {
      await context.close();
    }
  });
});
