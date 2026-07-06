import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  type CatalogArtifactMappingErrorCode,
  CatalogArtifactMappingError,
  type CatalogOpportunityFactorName,
  type CatalogOpportunityRow,
  ItotoriCatalogRepository,
  type CatalogSourceProvenanceRecord,
} from "../src/repositories/catalog-repository.js";
import {
  capabilityLevelStatusKindValues,
  capabilityLevelValues,
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConfidenceValues,
  catalogCandidateMatches,
  catalogCandidateMatchStatusValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogExternalIds,
  catalogInstallStateValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogPathRedactionClassValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseInstallStates,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleaseMappings,
  catalogReleasePackageKindValues,
  catalogTranslationPortabilityValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSeedTargets,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  catalogWorks,
  engineCapabilityEvidence,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
  engineCapabilityReports,
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

  it("models edition mappings, collection members, translation parentage, milestones, and install targets", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const provenance = await recordFixtureProvenance(repo);
      const workId = uuid(1201);
      const baseReleaseId = uuid(1202);
      const remasterReleaseId = uuid(1203);
      const fandiscReleaseId = uuid(1204);
      const bundleReleaseId = uuid(1205);
      const memberReleaseId = uuid(1206);
      const englishChildReleaseId = uuid(1207);
      const vndbMilestoneReleaseId = uuid(1208);

      const firstSnapshot = await repo.upsertWork(localActor, {
        workId,
        canonicalTitle: "Edition mapping fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2014,
        releases: [
          {
            releaseId: baseReleaseId,
            catalogSource: catalogSourceValues.dlsite,
            sourceReleaseId: "RJBASE001",
            releaseTitle: "Edition mapping fixture",
            releaseKind: catalogReleaseKindValues.original,
            editionName: "Japanese base edition",
            milestone: "dlsite-rjbase001-v1.00",
            packageKind: catalogReleasePackageKindValues.dlsiteProduct,
            engine: {
              engineName: "RPG Maker VX Ace",
              engineSource: catalogEngineSourceValues.dlsiteWorktypeInferred,
              engineConfidence: catalogConfidenceValues.medium,
              engineProvenanceId: provenance.dlsite.sourceProvenanceId,
            },
            platform: "pc",
            language: "ja-JP",
            releaseYear: 2014,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
          },
          {
            releaseId: remasterReleaseId,
            catalogSource: catalogSourceValues.steam,
            sourceReleaseId: "steam-remaster-001",
            releaseTitle: "Edition mapping fixture HD",
            releaseKind: catalogReleaseKindValues.remaster,
            editionName: "HD remaster",
            milestone: "steam-remaster-001-build-2026-06",
            packageKind: catalogReleasePackageKindValues.steamApp,
            engine: {
              engineName: "Unity",
              engineSource: catalogEngineSourceValues.manual,
              engineConfidence: catalogConfidenceValues.low,
            },
            platform: "steam",
            language: "ja-JP",
            releaseYear: 2021,
            sourceProvenanceId: provenance.steam.sourceProvenanceId,
          },
          {
            releaseId: fandiscReleaseId,
            catalogSource: catalogSourceValues.vndb,
            sourceReleaseId: "vndb-fandisc-r1",
            releaseTitle: "Edition mapping fixture fandisc",
            releaseKind: catalogReleaseKindValues.fandisc,
            editionName: "After story fandisc",
            milestone: "vndb-r-fandisc-1",
            packageKind: catalogReleasePackageKindValues.physicalMedia,
            platform: "pc",
            language: "ja-JP",
            releaseYear: 2015,
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
          },
          {
            releaseId: bundleReleaseId,
            catalogSource: catalogSourceValues.dlsite,
            sourceReleaseId: "RJBUNDLE001",
            releaseTitle: "Edition mapping fixture collection",
            releaseKind: catalogReleaseKindValues.bundle,
            editionName: "Anniversary collection",
            packageKind: catalogReleasePackageKindValues.bundle,
            platform: "pc",
            language: "ja-JP",
            releaseYear: 2022,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
          },
          {
            releaseId: memberReleaseId,
            catalogSource: catalogSourceValues.dlsite,
            sourceReleaseId: "RJBUNDLE001:member:base",
            releaseTitle: "Edition mapping fixture collection member",
            releaseKind: catalogReleaseKindValues.collectionMember,
            editionName: "Collection member base game",
            milestone: "dlsite-rjbase001-v1.00",
            packageKind: catalogReleasePackageKindValues.looseFiles,
            platform: "pc",
            language: "ja-JP",
            releaseYear: 2022,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
          },
          {
            releaseId: englishChildReleaseId,
            catalogSource: catalogSourceValues.dlsite,
            sourceReleaseId: "RJEN001",
            releaseTitle: "Edition mapping fixture English",
            releaseKind: catalogReleaseKindValues.officialTranslation,
            editionName: "Official English child edition",
            milestone: "dlsite-rjen001-v1.00",
            packageKind: catalogReleasePackageKindValues.dlsiteProduct,
            platform: "pc",
            language: "en-US",
            releaseYear: 2023,
            isOfficial: true,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
            metadata: { parentWorkno: "RJBASE001", childWorkno: "RJEN001" },
          },
          {
            releaseId: vndbMilestoneReleaseId,
            catalogSource: catalogSourceValues.vndb,
            sourceReleaseId: "vndb-r-base-1",
            releaseTitle: "Edition mapping fixture VNDB milestone",
            releaseKind: catalogReleaseKindValues.edition,
            editionName: "VNDB base release milestone",
            milestone: "dlsite-rjbase001-v1.00",
            packageKind: catalogReleasePackageKindValues.unknown,
            platform: "pc",
            language: "ja-JP",
            releaseYear: 2014,
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
          },
        ],
        releaseMappings: [
          {
            releaseMappingId: uuid(1210),
            sourceReleaseId: remasterReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.remasterOf,
            portability: catalogTranslationPortabilityValues.needsReview,
            sourceProvenanceId: provenance.steam.sourceProvenanceId,
            confidence: catalogConfidenceValues.medium,
            observedAt: fetchedAt,
            metadata: { reason: "engine changed from RPG Maker VX Ace to Unity" },
          },
          {
            releaseMappingId: uuid(1211),
            sourceReleaseId: fandiscReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.fandiscOf,
            portability: catalogTranslationPortabilityValues.incompatible,
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
            confidence: catalogConfidenceValues.high,
            observedAt: fetchedAt,
          },
          {
            releaseMappingId: uuid(1212),
            sourceReleaseId: bundleReleaseId,
            targetReleaseId: memberReleaseId,
            relationKind: catalogReleaseMappingKindValues.bundleContains,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
            confidence: catalogConfidenceValues.high,
            observedAt: fetchedAt,
          },
          {
            releaseMappingId: uuid(1213),
            sourceReleaseId: englishChildReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.translationOf,
            portability: catalogTranslationPortabilityValues.likelyPortable,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
            confidence: catalogConfidenceValues.high,
            observedAt: fetchedAt,
            metadata: { dlsiteParentWorkno: "RJBASE001", dlsiteChildWorkno: "RJEN001" },
          },
          {
            releaseMappingId: uuid(1214),
            sourceReleaseId: vndbMilestoneReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.sameMilestoneAs,
            portability: catalogTranslationPortabilityValues.exact,
            sourceProvenanceId: provenance.vndb.sourceProvenanceId,
            confidence: catalogConfidenceValues.medium,
            observedAt: fetchedAt,
            metadata: { vndbReleaseId: "vndb-r-base-1" },
          },
          {
            releaseMappingId: uuid(1215),
            sourceReleaseId: memberReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.collectionContains,
            portability: catalogTranslationPortabilityValues.exact,
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
            confidence: catalogConfidenceValues.high,
            observedAt: fetchedAt,
          },
        ],
      });

      expect(firstSnapshot.releases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            releaseId: baseReleaseId,
            editionName: "Japanese base edition",
            milestone: "dlsite-rjbase001-v1.00",
            packageKind: catalogReleasePackageKindValues.dlsiteProduct,
            engineName: "RPG Maker VX Ace",
            engineProvenanceId: provenance.dlsite.sourceProvenanceId,
          }),
          expect.objectContaining({
            releaseId: remasterReleaseId,
            releaseKind: catalogReleaseKindValues.remaster,
            engineName: "Unity",
            packageKind: catalogReleasePackageKindValues.steamApp,
          }),
          expect.objectContaining({
            releaseId: memberReleaseId,
            releaseKind: catalogReleaseKindValues.collectionMember,
            milestone: "dlsite-rjbase001-v1.00",
          }),
        ]),
      );
      expect(firstSnapshot.releaseMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceReleaseId: englishChildReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.translationOf,
            portability: catalogTranslationPortabilityValues.likelyPortable,
          }),
          expect.objectContaining({
            sourceReleaseId: remasterReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.remasterOf,
            portability: catalogTranslationPortabilityValues.needsReview,
          }),
          expect.objectContaining({
            sourceReleaseId: bundleReleaseId,
            targetReleaseId: memberReleaseId,
            relationKind: catalogReleaseMappingKindValues.bundleContains,
          }),
        ]),
      );

      const localScan = await repo.recordLocalScan(localActor, {
        localScanId: uuid(1220),
        scanRootLabel: "edition fixture library",
        scanRootPathHash: hash("edition-fixture-scan-root"),
        scannerName: "edition-mapping-regression",
        scannerVersion: "0.0.0",
        startedAt: fetchedAt,
        completedAt: "2026-06-17T12:03:00.000Z",
        entries: [
          {
            localScanEntryId: uuid(1221),
            workId,
            pathHash: hash("edition-fixture-installed-member"),
            pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
            owned: true,
            engineName: "RPG Maker VX Ace",
            engineSource: catalogEngineSourceValues.localScan,
            engineConfidence: catalogConfidenceValues.high,
            sourceProvenanceId: provenance.local.sourceProvenanceId,
            metadata: { packageIdentity: "RJBUNDLE001:member:base" },
          },
        ],
      });
      const localEntry = requiredTestRow(localScan.entries, "edition local scan entry");

      const installedSnapshot = await repo.upsertWork(localActor, {
        workId,
        canonicalTitle: "Edition mapping fixture",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2014,
        installStates: [
          {
            installStateId: uuid(1222),
            releaseId: memberReleaseId,
            localScanEntryId: localEntry.localScanEntryId,
            installState: catalogInstallStateValues.patchTarget,
            targetArtifactLabel: "Anniversary collection / base game member",
            sourceProvenanceId: provenance.local.sourceProvenanceId,
            confidence: catalogConfidenceValues.high,
            observedAt: fetchedAt,
            metadata: { patchExportTarget: true },
          },
          {
            installStateId: uuid(1223),
            releaseId: englishChildReleaseId,
            installState: catalogInstallStateValues.notInstalled,
            targetArtifactLabel: "Official English child edition",
            sourceProvenanceId: provenance.dlsite.sourceProvenanceId,
            confidence: catalogConfidenceValues.medium,
            observedAt: fetchedAt,
          },
        ],
      });

      expect(installedSnapshot.installStates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            releaseId: memberReleaseId,
            localScanEntryId: localEntry.localScanEntryId,
            installState: catalogInstallStateValues.patchTarget,
            targetArtifactLabel: "Anniversary collection / base game member",
          }),
          expect.objectContaining({
            releaseId: englishChildReleaseId,
            installState: catalogInstallStateValues.notInstalled,
          }),
        ]),
      );
      expect(installedSnapshot.localScanEntries[0]).toMatchObject({
        localScanEntryId: localEntry.localScanEntryId,
        workId,
      });

      const counts = await context.db.execute(sql`
        select
          (select count(*)::int from itotori_catalog_releases where work_id = ${workId}) as release_count,
          (select count(*)::int from ${catalogReleaseMappings} where work_id = ${workId}) as mapping_count,
          (select count(*)::int from ${catalogReleaseInstallStates} where work_id = ${workId}) as install_state_count
      `);
      expect(counts.rows[0]).toMatchObject({
        release_count: 7,
        mapping_count: 6,
        install_state_count: 2,
      });
    } finally {
      await context.close();
    }
  });

  it("rejects release mappings that reference releases from another work", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const parentWorkId = uuid(1230);
      const parentReleaseId = uuid(1231);
      const otherWorkId = uuid(1232);
      const otherReleaseId = uuid(1233);
      await recordWorkWithRelease(repo, parentWorkId, parentReleaseId, "Mapping parent fixture");
      await recordWorkWithRelease(repo, otherWorkId, otherReleaseId, "Mapping other fixture");

      const sourceError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Mapping parent fixture",
          releaseMappings: [
            {
              releaseMappingId: uuid(1234),
              sourceReleaseId: otherReleaseId,
              targetReleaseId: parentReleaseId,
              relationKind: catalogReleaseMappingKindValues.remasterOf,
            },
          ],
        }),
        "release_mapping_release_belongs_to_other_work",
      );
      expect(sourceError.message).toContain(
        "releaseMapping.sourceReleaseId must belong to the parent work",
      );

      const targetError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Mapping parent fixture",
          releaseMappings: [
            {
              releaseMappingId: uuid(1235),
              sourceReleaseId: parentReleaseId,
              targetReleaseId: otherReleaseId,
              relationKind: catalogReleaseMappingKindValues.remasterOf,
            },
          ],
        }),
        "release_mapping_release_belongs_to_other_work",
      );
      expect(targetError.message).toContain(
        "releaseMapping.targetReleaseId must belong to the parent work",
      );

      // A mapping endpoint that references no known release for the parent work
      // surfaces the distinct "not in work" code.
      const unknownError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Mapping parent fixture",
          releaseMappings: [
            {
              releaseMappingId: uuid(1236),
              sourceReleaseId: parentReleaseId,
              targetReleaseId: uuid(1237),
              relationKind: catalogReleaseMappingKindValues.remasterOf,
            },
          ],
        }),
        "release_mapping_release_not_in_work",
      );
      expect(unknownError.message).toContain(
        "releaseMapping.targetReleaseId must reference a release for the parent work",
      );

      // Source and target being identical is a distinct, machine-classifiable mode.
      const identicalError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Mapping parent fixture",
          releaseMappings: [
            {
              releaseMappingId: uuid(1238),
              sourceReleaseId: parentReleaseId,
              targetReleaseId: parentReleaseId,
              relationKind: catalogReleaseMappingKindValues.remasterOf,
            },
          ],
        }),
        "release_mapping_endpoints_identical",
      );
      expect(identicalError.message).toContain(
        "releaseMapping source and target releases must differ",
      );
    } finally {
      await context.close();
    }
  });

  it("rejects install states that reference a release from another work", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const parentWorkId = uuid(1240);
      const parentReleaseId = uuid(1241);
      const otherWorkId = uuid(1242);
      const otherReleaseId = uuid(1243);
      await recordWorkWithRelease(repo, parentWorkId, parentReleaseId, "Install parent fixture");
      await recordWorkWithRelease(repo, otherWorkId, otherReleaseId, "Install other fixture");

      const belongsError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Install parent fixture",
          installStates: [
            {
              installStateId: uuid(1244),
              releaseId: otherReleaseId,
              installState: catalogInstallStateValues.patchTarget,
            },
          ],
        }),
        "install_state_release_belongs_to_other_work",
      );
      expect(belongsError.message).toContain(
        "installState.releaseId must belong to the parent work",
      );

      // An install-state referencing an entirely unknown release exposes the
      // distinct "not in work" code.
      const unknownError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Install parent fixture",
          installStates: [
            {
              installStateId: uuid(1245),
              releaseId: uuid(1246),
              installState: catalogInstallStateValues.patchTarget,
            },
          ],
        }),
        "install_state_release_not_in_work",
      );
      expect(unknownError.message).toContain(
        "installState.releaseId must reference a release for the parent work",
      );
    } finally {
      await context.close();
    }
  });

  it("rejects install states that reference a local scan entry from another work", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const parentWorkId = uuid(1250);
      const parentReleaseId = uuid(1251);
      const otherWorkId = uuid(1252);
      await recordWorkWithRelease(repo, parentWorkId, parentReleaseId, "Scan parent fixture");
      await recordWorkWithRelease(repo, otherWorkId, uuid(1256), "Scan other fixture");
      const localScan = await repo.recordLocalScan(localActor, {
        localScanId: uuid(1253),
        scanRootLabel: "cross-work scan fixture",
        scanRootPathHash: hash("cross-work-scan-root"),
        scannerName: "catalog-cross-work-regression",
        scannerVersion: "0.0.0",
        startedAt: fetchedAt,
        entries: [
          {
            localScanEntryId: uuid(1254),
            workId: otherWorkId,
            pathHash: hash("cross-work-scan-entry"),
            pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
          },
        ],
      });
      const otherEntry = requiredTestRow(localScan.entries, "cross-work local scan entry");

      const scanError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Scan parent fixture",
          installStates: [
            {
              installStateId: uuid(1255),
              releaseId: parentReleaseId,
              localScanEntryId: otherEntry.localScanEntryId,
              installState: catalogInstallStateValues.patchTarget,
            },
          ],
        }),
        "install_state_local_scan_entry_belongs_to_other_work",
      );
      expect(scanError.message).toContain(
        "installState.localScanEntryId must belong to the install state work",
      );
    } finally {
      await context.close();
    }
  });

  it("rejects reusing a release id that already belongs to a different work", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const parentWorkId = uuid(1260);
      const parentReleaseId = uuid(1261);
      const otherWorkId = uuid(1262);
      const otherReleaseId = uuid(1263);
      await recordWorkWithRelease(repo, parentWorkId, parentReleaseId, "Reuse parent fixture");
      await recordWorkWithRelease(repo, otherWorkId, otherReleaseId, "Reuse other fixture");

      const reuseError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Reuse parent fixture",
          releases: [
            {
              releaseId: otherReleaseId,
              catalogSource: catalogSourceValues.dlsite,
              sourceReleaseId: otherReleaseId,
              releaseTitle: "Reuse other fixture",
              releaseKind: catalogReleaseKindValues.original,
            },
          ],
        }),
        "release_belongs_to_other_work",
      );
      expect(reuseError.message).toContain(
        "release.releaseId must not already belong to a different work",
      );
    } finally {
      await context.close();
    }
  });

  it("rejects conflict evidence that references an unknown subject id (dangling)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const workId = uuid(1290);
      const releaseId = uuid(1291);
      await recordWorkWithRelease(repo, workId, releaseId, "Dangling evidence fixture");

      const danglingError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId,
          canonicalTitle: "Dangling evidence fixture",
          conflicts: [
            {
              conflictId: uuid(1292),
              conflictKind: catalogConflictKindValues.languageStatus,
              summary: "Evidence points at a language status that does not exist.",
              detectedAt: fetchedAt,
              evidence: [
                {
                  conflictEvidenceId: uuid(1293),
                  subjectKind: catalogConflictSubjectKindValues.languageStatus,
                  subjectId: uuid(1294),
                },
              ],
            },
          ],
        }),
        "conflict_evidence_subject_unknown",
      );
      expect(danglingError.message).toContain(
        "conflict.evidence subjectId must reference a known language status",
      );
    } finally {
      await context.close();
    }
  });

  it("accepts sourceProvenance evidence naming an uncatalogued cross-source identity", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const workId = uuid(1320);
      const releaseId = uuid(1321);
      await recordWorkWithRelease(repo, workId, releaseId, "Cross-source evidence fixture");

      // A platform-language / source-disagreement conflict names the disagreeing
      // source by its `<catalogSource>:<sourceId>` identity. That source may not
      // be catalogued locally, so the guard accepts the well-formed identity
      // without requiring a persisted provenance row.
      const snapshot = await repo.upsertWork(localActor, {
        workId,
        canonicalTitle: "Cross-source evidence fixture",
        conflicts: [
          {
            conflictId: uuid(1322),
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "Evidence cites a VNDB source we have not ingested.",
            detectedAt: fetchedAt,
            evidence: [
              {
                conflictEvidenceId: uuid(1323),
                subjectKind: catalogConflictSubjectKindValues.sourceProvenance,
                subjectId: "vndb:v9999",
              },
            ],
          },
        ],
      });

      const conflict = requiredTestRow(snapshot.conflicts, "persisted cross-source conflict");
      expect(conflict.evidence).toHaveLength(1);
      expect(conflict.evidence[0]).toMatchObject({
        subjectKind: catalogConflictSubjectKindValues.sourceProvenance,
        subjectId: "vndb:v9999",
      });
    } finally {
      await context.close();
    }
  });

  it("rejects sourceProvenance evidence that is neither a known provenance nor a source identity", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const workId = uuid(1330);
      const releaseId = uuid(1331);
      await recordWorkWithRelease(repo, workId, releaseId, "Dangling provenance fixture");

      const danglingError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId,
          canonicalTitle: "Dangling provenance fixture",
          conflicts: [
            {
              conflictId: uuid(1332),
              conflictKind: catalogConflictKindValues.languageStatus,
              summary: "Evidence points at a provenance row that does not exist.",
              detectedAt: fetchedAt,
              evidence: [
                {
                  conflictEvidenceId: uuid(1333),
                  subjectKind: catalogConflictSubjectKindValues.sourceProvenance,
                  subjectId: uuid(1334),
                },
              ],
            },
          ],
        }),
        "conflict_evidence_subject_unknown",
      );
      expect(danglingError.message).toContain(
        "conflict.evidence subjectId must reference a known source provenance",
      );
    } finally {
      await context.close();
    }
  });

  it("rejects conflict evidence whose subject belongs to another work", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const parentWorkId = uuid(1300);
      const parentReleaseId = uuid(1301);
      const otherWorkId = uuid(1302);
      const otherReleaseId = uuid(1303);
      await recordWorkWithRelease(repo, parentWorkId, parentReleaseId, "Evidence parent fixture");
      await recordWorkWithRelease(repo, otherWorkId, otherReleaseId, "Evidence other fixture");

      const crossWorkError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId: parentWorkId,
          canonicalTitle: "Evidence parent fixture",
          conflicts: [
            {
              conflictId: uuid(1304),
              conflictKind: catalogConflictKindValues.languageStatus,
              summary: "Evidence points at a release owned by another work.",
              detectedAt: fetchedAt,
              evidence: [
                {
                  conflictEvidenceId: uuid(1305),
                  subjectKind: catalogConflictSubjectKindValues.release,
                  subjectId: otherReleaseId,
                },
              ],
            },
          ],
        }),
        "conflict_evidence_subject_belongs_to_other_work",
      );
      expect(crossWorkError.message).toContain(
        "conflict.evidence subjectId must reference a release in the parent work",
      );
    } finally {
      await context.close();
    }
  });

  it("persists conflict evidence that references a known same-work subject", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const workId = uuid(1310);
      const releaseId = uuid(1311);
      // The release is written in a prior upsert, so the evidence resolves it via
      // the DB lookup path (not the same-transaction input path).
      await recordWorkWithRelease(repo, workId, releaseId, "Valid evidence fixture");

      const snapshot = await repo.upsertWork(localActor, {
        workId,
        canonicalTitle: "Valid evidence fixture",
        conflicts: [
          {
            conflictId: uuid(1312),
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "Evidence points at a release owned by this same work.",
            detectedAt: fetchedAt,
            evidence: [
              {
                conflictEvidenceId: uuid(1313),
                subjectKind: catalogConflictSubjectKindValues.release,
                subjectId: releaseId,
              },
            ],
          },
        ],
      });

      expect(snapshot.conflicts).toHaveLength(1);
      const conflict = requiredTestRow(snapshot.conflicts, "persisted conflict");
      expect(conflict.evidence).toHaveLength(1);
      expect(conflict.evidence[0]).toMatchObject({
        conflictEvidenceId: uuid(1313),
        subjectKind: catalogConflictSubjectKindValues.release,
        subjectId: releaseId,
      });

      const persisted = await context.db.execute(sql`
        select count(*)::int as evidence_count
        from itotori_catalog_conflict_evidence
        where subject_id = ${releaseId}
      `);
      expect(persisted.rows[0]).toMatchObject({ evidence_count: 1 });
    } finally {
      await context.close();
    }
  });

  it("persists conflict evidence whose work subject references a known competing work", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const parentWorkId = uuid(1340);
      const parentReleaseId = uuid(1341);
      const competingWorkId = uuid(1342);
      const competingReleaseId = uuid(1343);
      // A duplicate/competing-work conflict inherently references the OTHER work
      // it competes with. Both works are persisted before the upsert, so the
      // guard resolves the cross-work `work` subject via the committed-state
      // lookup and accepts it (known cross-work reference, not dangling).
      await recordWorkWithRelease(repo, parentWorkId, parentReleaseId, "Competing parent fixture");
      await recordWorkWithRelease(
        repo,
        competingWorkId,
        competingReleaseId,
        "Competing rival fixture",
      );

      const snapshot = await repo.upsertWork(localActor, {
        workId: parentWorkId,
        canonicalTitle: "Competing parent fixture",
        conflicts: [
          {
            conflictId: uuid(1344),
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: "Evidence cites a competing duplicate work.",
            detectedAt: fetchedAt,
            evidence: [
              {
                conflictEvidenceId: uuid(1345),
                subjectKind: catalogConflictSubjectKindValues.work,
                subjectId: competingWorkId,
              },
            ],
          },
        ],
      });

      expect(snapshot.conflicts).toHaveLength(1);
      const conflict = requiredTestRow(snapshot.conflicts, "persisted competing-work conflict");
      expect(conflict.evidence).toHaveLength(1);
      expect(conflict.evidence[0]).toMatchObject({
        conflictEvidenceId: uuid(1345),
        subjectKind: catalogConflictSubjectKindValues.work,
        subjectId: competingWorkId,
      });

      const persisted = await context.db.execute(sql`
        select count(*)::int as evidence_count
        from itotori_catalog_conflict_evidence
        where subject_id = ${competingWorkId}
      `);
      expect(persisted.rows[0]).toMatchObject({ evidence_count: 1 });
    } finally {
      await context.close();
    }
  });

  it("rejects conflict evidence whose work subject references an unknown work (dangling)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const workId = uuid(1350);
      const releaseId = uuid(1351);
      await recordWorkWithRelease(repo, workId, releaseId, "Dangling work-subject fixture");

      const danglingError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId,
          canonicalTitle: "Dangling work-subject fixture",
          conflicts: [
            {
              conflictId: uuid(1352),
              conflictKind: catalogConflictKindValues.languageStatus,
              summary: "Evidence cites a work that does not exist.",
              detectedAt: fetchedAt,
              evidence: [
                {
                  conflictEvidenceId: uuid(1353),
                  subjectKind: catalogConflictSubjectKindValues.work,
                  subjectId: uuid(1354),
                },
              ],
            },
          ],
        }),
        "conflict_evidence_subject_unknown",
      );
      expect(danglingError.message).toContain(
        "conflict.evidence subjectId must reference a known work",
      );
    } finally {
      await context.close();
    }
  });

  it("maps valid cross-work release mappings and install states without error", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const workId = uuid(1270);
      const baseReleaseId = uuid(1271);
      const remasterReleaseId = uuid(1272);

      const snapshot = await repo.upsertWork(localActor, {
        workId,
        canonicalTitle: "Valid mapping fixture",
        originalLanguage: "ja-JP",
        releases: [
          {
            releaseId: baseReleaseId,
            catalogSource: catalogSourceValues.dlsite,
            sourceReleaseId: baseReleaseId,
            releaseTitle: "Base edition",
            releaseKind: catalogReleaseKindValues.original,
          },
          {
            releaseId: remasterReleaseId,
            catalogSource: catalogSourceValues.dlsite,
            sourceReleaseId: remasterReleaseId,
            releaseTitle: "Remastered edition",
            releaseKind: catalogReleaseKindValues.remaster,
          },
        ],
        releaseMappings: [
          {
            releaseMappingId: uuid(1273),
            sourceReleaseId: remasterReleaseId,
            targetReleaseId: baseReleaseId,
            relationKind: catalogReleaseMappingKindValues.remasterOf,
          },
        ],
        installStates: [
          {
            installStateId: uuid(1274),
            releaseId: baseReleaseId,
            installState: catalogInstallStateValues.patchTarget,
          },
        ],
      });

      expect(snapshot.releaseMappings).toHaveLength(1);
      expect(snapshot.releaseMappings[0]).toMatchObject({
        sourceReleaseId: remasterReleaseId,
        targetReleaseId: baseReleaseId,
      });
      expect(snapshot.installStates).toHaveLength(1);
      expect(snapshot.installStates[0]).toMatchObject({
        releaseId: baseReleaseId,
        installState: catalogInstallStateValues.patchTarget,
      });
    } finally {
      await context.close();
    }
  });

  it("upserts catalog external IDs by natural key when child IDs are omitted or differ", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const provenanceRecord = await provenance(
        repo,
        801,
        catalogSourceValues.dlsite,
        "RJNATURAL001",
      );

      const first = await repo.upsertWork(localActor, {
        workId: uuid(811),
        canonicalTitle: "Natural external ID fixture",
        originalLanguage: "ja-JP",
        externalIds: [
          {
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJNATURAL001",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            sourceProvenanceId: provenanceRecord.sourceProvenanceId,
            confidence: catalogConfidenceValues.low,
            metadata: { revision: 1 },
          },
        ],
      });
      const firstExternalId = requiredTestRow(first.externalIds, "external ID").externalIdId;

      const second = await repo.upsertWork(localActor, {
        workId: uuid(811),
        canonicalTitle: "Natural external ID fixture updated",
        originalLanguage: "ja-JP",
        externalIds: [
          {
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJNATURAL001",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            sourceProvenanceId: provenanceRecord.sourceProvenanceId,
            confidence: catalogConfidenceValues.high,
            metadata: { revision: 2 },
          },
        ],
      });
      const secondExternalId = requiredTestRow(second.externalIds, "external ID");
      expect(secondExternalId).toMatchObject({
        externalIdId: firstExternalId,
        confidence: catalogConfidenceValues.high,
        metadata: { revision: 2 },
      });

      const third = await repo.upsertWork(localActor, {
        workId: uuid(811),
        canonicalTitle: "Natural external ID fixture updated again",
        originalLanguage: "ja-JP",
        externalIds: [
          {
            externalIdId: uuid(812),
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJNATURAL001",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            sourceProvenanceId: provenanceRecord.sourceProvenanceId,
            confidence: catalogConfidenceValues.medium,
            metadata: { revision: 3 },
          },
        ],
      });
      expect(requiredTestRow(third.externalIds, "external ID")).toMatchObject({
        externalIdId: firstExternalId,
        confidence: catalogConfidenceValues.medium,
        metadata: { revision: 3 },
      });

      const counts = await context.db.execute(sql`
        select count(*)::int as external_id_count
        from ${catalogExternalIds}
        where catalog_source = ${catalogSourceValues.dlsite}
          and source_id = ${"RJNATURAL001"}
          and external_id_kind = ${catalogExternalIdKindValues.storeProduct}
      `);
      expect(counts.rows[0]).toMatchObject({ external_id_count: 1 });
    } finally {
      await context.close();
    }
  });

  it("upserts local scan entries and nested scan children by natural key without precomputed child IDs", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const provenanceRecord = await provenance(
        repo,
        802,
        catalogSourceValues.localCorpus,
        "local-natural-scan",
        { sourceRecordKind: catalogSourceRecordKindValues.localScan },
      );
      const work = await repo.upsertWork(localActor, {
        workId: uuid(821),
        canonicalTitle: "Natural local scan fixture",
        originalLanguage: "ja-JP",
      });
      const localScanInput = {
        localScanId: uuid(822),
        scanRootLabel: "natural fixture library",
        scanRootPathHash: hash("natural-scan-root"),
        scannerName: "natural-scan-regression",
        scannerVersion: "0.0.0",
        startedAt: fetchedAt,
        completedAt: "2026-06-17T12:02:00.000Z",
        entries: [
          {
            workId: work.workId,
            pathHash: hash("natural-scan-entry-path"),
            pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
            owned: true,
            engineName: "RPG Maker MV",
            engineSource: catalogEngineSourceValues.localScan,
            engineConfidence: catalogConfidenceValues.low,
            signals: { files: ["data/System.json"] },
            sourceProvenanceId: provenanceRecord.sourceProvenanceId,
            detectedExternalIds: [
              {
                catalogSource: catalogSourceValues.dlsite,
                sourceId: "RJSCAN001",
                externalIdKind: catalogExternalIdKindValues.localDetection,
                sourceProvenanceId: provenanceRecord.sourceProvenanceId,
                metadata: { revision: 1 },
              },
            ],
            seedTargets: [
              {
                catalogSource: catalogSourceValues.dlsite,
                sourceId: "RJSCAN001",
                seedOrigin: catalogSeedOriginValues.localScan,
                sourceProvenanceId: provenanceRecord.sourceProvenanceId,
                status: catalogSeedStatusValues.pending,
                priority: 1,
                addedAt: fetchedAt,
                metadata: { revision: 1 },
              },
            ],
          },
        ],
      } satisfies Parameters<ItotoriCatalogRepository["recordLocalScan"]>[1];

      const first = await repo.recordLocalScan(localActor, localScanInput);
      const firstEntry = requiredTestRow(first.entries, "local scan entry");
      const firstSeedTarget = requiredTestRow(firstEntry.seedTargets, "seed target");
      const localScanEntryInput = requiredTestRow(localScanInput.entries, "local scan entry input");
      const detectedExternalIdInput = requiredTestRow(
        localScanEntryInput.detectedExternalIds,
        "detected external ID input",
      );
      const seedTargetInput = requiredTestRow(localScanEntryInput.seedTargets, "seed target input");

      const second = await repo.recordLocalScan(localActor, {
        ...localScanInput,
        entries: [
          {
            ...localScanEntryInput,
            engineConfidence: catalogConfidenceValues.high,
            detectedExternalIds: [
              {
                ...detectedExternalIdInput,
                metadata: { revision: 2 },
              },
            ],
            seedTargets: [
              {
                ...seedTargetInput,
                priority: 9,
                metadata: { revision: 2 },
              },
            ],
          },
        ],
      });
      const secondEntry = requiredTestRow(second.entries, "local scan entry");
      expect(secondEntry).toMatchObject({
        localScanEntryId: firstEntry.localScanEntryId,
        engineConfidence: catalogConfidenceValues.high,
      });
      expect(requiredTestRow(secondEntry.seedTargets, "seed target")).toMatchObject({
        seedTargetId: firstSeedTarget.seedTargetId,
        localScanEntryId: firstEntry.localScanEntryId,
        priority: 9,
        metadata: { revision: 2 },
      });

      const counts = await context.db.execute(sql`
        select
          (
            select count(*)::int
            from ${catalogLocalScanEntries}
            where local_scan_id = ${localScanInput.localScanId}
              and path_hash = ${localScanEntryInput.pathHash}
          ) as local_scan_entry_count,
          (
            select count(*)::int
            from ${catalogLocalScanExternalIds}
            where local_scan_entry_id = ${firstEntry.localScanEntryId}
          ) as detected_external_id_count,
          (
            select count(*)::int
            from ${catalogSeedTargets}
            where catalog_source = ${catalogSourceValues.dlsite}
              and source_id = ${"RJSCAN001"}
              and seed_origin = ${catalogSeedOriginValues.localScan}
              and coalesce(origin_ref, '') = ''
          ) as seed_target_count
      `);
      expect(counts.rows[0]).toMatchObject({
        local_scan_entry_count: 1,
        detected_external_id_count: 1,
        seed_target_count: 1,
      });
    } finally {
      await context.close();
    }
  });

  it("links nested seed targets to the persisted local scan entry after entry re-upsert", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const localScanInput = {
        localScanId: uuid(841),
        scanRootLabel: "focused natural fixture library",
        scanRootPathHash: hash("focused-natural-scan-root"),
        scannerName: "focused-natural-scan-regression",
        scannerVersion: "0.0.0",
        startedAt: fetchedAt,
        completedAt: "2026-06-17T12:02:00.000Z",
        entries: [
          {
            pathHash: hash("focused-natural-scan-entry-path"),
            seedTargets: [
              {
                catalogSource: catalogSourceValues.dlsite,
                sourceId: "RJFOCUSED001",
                seedOrigin: catalogSeedOriginValues.localScan,
                status: catalogSeedStatusValues.pending,
                priority: 1,
                addedAt: fetchedAt,
                metadata: { revision: 1 },
              },
            ],
          },
        ],
      } satisfies Parameters<ItotoriCatalogRepository["recordLocalScan"]>[1];

      const first = await repo.recordLocalScan(localActor, localScanInput);
      const firstEntry = requiredTestRow(first.entries, "local scan entry");
      const firstSeedTarget = requiredTestRow(firstEntry.seedTargets, "seed target");
      const entryInput = requiredTestRow(localScanInput.entries, "local scan entry input");
      const seedTargetInput = requiredTestRow(entryInput.seedTargets, "seed target input");

      const second = await repo.recordLocalScan(localActor, {
        ...localScanInput,
        entries: [
          {
            ...entryInput,
            seedTargets: [
              {
                ...seedTargetInput,
                priority: 7,
                metadata: { revision: 2 },
              },
            ],
          },
        ],
      });

      const secondEntry = requiredTestRow(second.entries, "local scan entry");
      const secondSeedTarget = requiredTestRow(secondEntry.seedTargets, "seed target");
      expect(secondEntry.localScanEntryId).toBe(firstEntry.localScanEntryId);
      expect(secondSeedTarget).toMatchObject({
        seedTargetId: firstSeedTarget.seedTargetId,
        localScanEntryId: firstEntry.localScanEntryId,
        priority: 7,
        metadata: { revision: 2 },
      });

      const counts = await context.db.execute(sql`
        select
          (
            select count(*)::int
            from ${catalogLocalScanEntries}
            where local_scan_id = ${localScanInput.localScanId}
              and path_hash = ${entryInput.pathHash}
          ) as local_scan_entry_count,
          (
            select count(*)::int
            from ${catalogSeedTargets}
            where catalog_source = ${catalogSourceValues.dlsite}
              and source_id = ${"RJFOCUSED001"}
              and seed_origin = ${catalogSeedOriginValues.localScan}
          ) as seed_target_count
      `);
      expect(counts.rows[0]).toMatchObject({
        local_scan_entry_count: 1,
        seed_target_count: 1,
      });
    } finally {
      await context.close();
    }
  });

  it("upserts seed targets by coalesced natural origin and lists higher priority first", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const first = await repo.recordSeedTarget(localActor, {
        catalogSource: catalogSourceValues.vndb,
        sourceId: "v-seed-natural",
        seedOrigin: catalogSeedOriginValues.importer,
        status: catalogSeedStatusValues.pending,
        priority: 2,
        addedAt: "2026-06-17T12:03:00.000Z",
        metadata: { revision: 1 },
      });
      const second = await repo.recordSeedTarget(localActor, {
        seedTargetId: uuid(831),
        catalogSource: catalogSourceValues.vndb,
        sourceId: "v-seed-natural",
        seedOrigin: catalogSeedOriginValues.importer,
        status: catalogSeedStatusValues.pending,
        priority: 8,
        addedAt: "2026-06-17T12:04:00.000Z",
        metadata: { revision: 2 },
      });
      await repo.recordSeedTarget(localActor, {
        catalogSource: catalogSourceValues.vndb,
        sourceId: "v-seed-lower-priority",
        seedOrigin: catalogSeedOriginValues.importer,
        status: catalogSeedStatusValues.pending,
        priority: 1,
        addedAt: "2026-06-17T12:02:00.000Z",
      });

      expect(second).toMatchObject({
        seedTargetId: first.seedTargetId,
        priority: 8,
        metadata: { revision: 2 },
      });
      const pendingSeeds = await repo.listSeedTargets(localActor, catalogSeedStatusValues.pending);
      expect(pendingSeeds.map((seed) => seed.sourceId)).toEqual([
        "v-seed-natural",
        "v-seed-lower-priority",
      ]);

      const counts = await context.db.execute(sql`
        select count(*)::int as seed_target_count
        from ${catalogSeedTargets}
        where catalog_source = ${catalogSourceValues.vndb}
          and seed_origin = ${catalogSeedOriginValues.importer}
      `);
      expect(counts.rows[0]).toMatchObject({ seed_target_count: 2 });
    } finally {
      await context.close();
    }
  });

  it("records fuzzy candidate matches as reviewable read-model rows without mutating works", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const work = await repo.upsertWork(localActor, {
        workId: uuid(861),
        canonicalTitle: "Moonlight Refrain HD",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
      });

      const first = await repo.recordCatalogCandidateMatch(localActor, {
        candidateId: uuid(862),
        sourceCatalogSource: catalogSourceValues.egs,
        sourceId: "egs-moonlight-001",
        sourceTitle: "Moonlight Refrain",
        targetWorkId: work.workId,
        score: 860,
        matchedFields: {
          title: { score: 760, algorithm: "normalized_token_dice" },
          releaseYear: { score: 100, algorithm: "exact_year_bonus" },
        },
        status: catalogCandidateMatchStatusValues.reviewPending,
        diagnosticCode: "catalog.fuzzy_candidate.generated",
        generatorVersion: "deterministic-title-year.v0.1",
        metadata: { autoMerge: false },
      });
      const second = await repo.recordCatalogCandidateMatch(localActor, {
        candidateId: uuid(863),
        sourceCatalogSource: catalogSourceValues.egs,
        sourceId: "egs-moonlight-001",
        sourceTitle: "Moonlight Refrain updated",
        targetWorkId: work.workId,
        score: 850,
        matchedFields: {
          title: { score: 750, algorithm: "normalized_token_dice" },
          releaseYear: { score: 100, algorithm: "exact_year_bonus" },
        },
        status: catalogCandidateMatchStatusValues.reviewPending,
        diagnosticCode: "catalog.fuzzy_candidate.generated",
        generatorVersion: "deterministic-title-year.v0.1",
        metadata: { autoMerge: false, revision: 2 },
      });

      expect(second).toMatchObject({
        candidateId: first.candidateId,
        sourceTitle: "Moonlight Refrain updated",
        score: 850,
        status: catalogCandidateMatchStatusValues.reviewPending,
        metadata: { autoMerge: false, revision: 2 },
      });
      const candidates = await repo.listCatalogCandidateMatches(
        localActor,
        catalogCandidateMatchStatusValues.reviewPending,
      );
      expect(candidates).toEqual([expect.objectContaining({ candidateId: first.candidateId })]);

      const snapshot = await repo.getWorkSnapshot(localActor, work.workId);
      expect(snapshot).toMatchObject({
        workId: work.workId,
        canonicalTitle: "Moonlight Refrain HD",
        externalIds: [],
      });

      const counts = await context.db.execute(sql`
        select count(*)::int as candidate_count
        from ${catalogCandidateMatches}
        where source_catalog_source = ${catalogSourceValues.egs}
          and source_id = ${"egs-moonlight-001"}
          and target_work_id = ${work.workId}
      `);
      expect(counts.rows[0]).toMatchObject({ candidate_count: 1 });
    } finally {
      await context.close();
    }
  });

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

  it("counts public fixture and private aggregate runtime evidence in opportunity ranking", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const publicProvenance = await provenance(repo, 810, catalogSourceValues.dlsite, "RJRT810");
      const privateProvenance = await provenance(repo, 811, catalogSourceValues.dlsite, "RJRT811");
      const mixedProvenance = await provenance(repo, 812, catalogSourceValues.dlsite, "RJRT812");

      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "public-fixture-runtime-engine",
        idBase: 8100,
        publicFixture: true,
        privateLocalAggregate: false,
      });
      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "private-aggregate-runtime-engine",
        idBase: 8200,
        publicFixture: false,
        privateLocalAggregate: true,
      });
      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "mixed-runtime-engine",
        idBase: 8300,
        publicFixture: true,
        privateLocalAggregate: true,
      });

      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(810),
          title: "Public fixture runtime readiness",
          provenance: publicProvenance,
          sourceId: "RJRT810",
          adapterId: "public-fixture-runtime-engine",
          languageStatusId: uuid(8810),
        }),
      );
      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(811),
          title: "Private aggregate runtime readiness",
          provenance: privateProvenance,
          sourceId: "RJRT811",
          adapterId: "private-aggregate-runtime-engine",
          languageStatusId: uuid(8811),
        }),
      );
      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(812),
          title: "Mixed runtime readiness",
          provenance: mixedProvenance,
          sourceId: "RJRT812",
          adapterId: "mixed-runtime-engine",
          languageStatusId: uuid(8812),
        }),
      );

      const model = await repo.catalogOpportunityRanking(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const publicOnly = requiredOpportunityRow(model.rows, uuid(810));
      const privateOnly = requiredOpportunityRow(model.rows, uuid(811));
      const mixed = requiredOpportunityRow(model.rows, uuid(812));

      expect(publicOnly.runtimeEvidenceReadiness).toEqual({
        status: "public_fixture",
        publicFixtureEvidenceCount: 1,
        privateLocalAggregateEvidenceCount: 0,
      });
      expect(privateOnly.runtimeEvidenceReadiness).toEqual({
        status: "private_local_aggregate",
        publicFixtureEvidenceCount: 0,
        privateLocalAggregateEvidenceCount: 1,
      });
      expect(mixed.runtimeEvidenceReadiness).toEqual({
        status: "public_and_aggregate",
        publicFixtureEvidenceCount: 1,
        privateLocalAggregateEvidenceCount: 1,
      });

      expect(runtimeEvidenceFactor(publicOnly)).toMatchObject({
        weightedScore: 4.2,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:0",
          "public_fixture_evidence_count:1",
        ],
        explanationCode: "runtime_evidence_readiness:public_fixture",
      });
      expect(runtimeEvidenceFactor(privateOnly)).toMatchObject({
        weightedScore: 3.3,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:1",
          "public_fixture_evidence_count:0",
        ],
        explanationCode: "runtime_evidence_readiness:private_local_aggregate",
      });
      expect(runtimeEvidenceFactor(mixed)).toMatchObject({
        weightedScore: 6,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:1",
          "public_fixture_evidence_count:1",
        ],
        explanationCode: "runtime_evidence_readiness:public_and_aggregate",
      });
      expect(runtimeEvidenceFactor(mixed).weightedScore).toBeGreaterThan(
        runtimeEvidenceFactor(publicOnly).weightedScore,
      );
      expect(runtimeEvidenceFactor(mixed).weightedScore).toBeGreaterThan(
        runtimeEvidenceFactor(privateOnly).weightedScore,
      );
    } finally {
      await context.close();
    }
  });

  it("does not count public_fixture adapter_matrix evidence as runtime readiness", async () => {
    // Locks the intentional source split clarified in catalog-repository.ts: only
    // `public_fixture` `key_validation` evidence increments publicFixtureEvidenceCount. A
    // `public_fixture` `adapter_matrix` row (the static capability matrix, which is what the
    // production catalog-local producer emits) must NOT advertise public runtime readiness, so the
    // read-model never promises a state the production producer fabricates.
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const matrixProvenance = await provenance(repo, 820, catalogSourceValues.dlsite, "RJRT820");

      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "public-matrix-only-engine",
        idBase: 8400,
        publicFixture: true,
        publicFixtureKind: engineCapabilityEvidenceKindValues.adapterMatrix,
        privateLocalAggregate: false,
      });

      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(820),
          title: "Public matrix only runtime readiness",
          provenance: matrixProvenance,
          sourceId: "RJRT820",
          adapterId: "public-matrix-only-engine",
          languageStatusId: uuid(8820),
        }),
      );

      const model = await repo.catalogOpportunityRanking(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const matrixOnly = requiredOpportunityRow(model.rows, uuid(820));

      expect(matrixOnly.runtimeEvidenceReadiness).toEqual({
        status: "unknown",
        publicFixtureEvidenceCount: 0,
        privateLocalAggregateEvidenceCount: 0,
      });
      expect(runtimeEvidenceFactor(matrixOnly)).toMatchObject({
        weightedScore: 0,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:0",
          "public_fixture_evidence_count:0",
        ],
        explanationCode: "runtime_evidence_readiness:unknown",
      });
    } finally {
      await context.close();
    }
  });

  it("rejects catalog writes and reads without catalog permissions", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);

      await expect(
        repo.recordSourceProvenance(
          { userId: "user-without-grants" },
          {
            catalogSource: catalogSourceValues.dlsite,
            sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
            sourceId: "RJ000001",
            fetchedAt,
          },
        ),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: permissionValues.catalogWrite,
      });

      await expect(
        repo.getWorkSnapshot({ userId: "user-without-grants" }, uuid(101)),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: permissionValues.catalogRead,
      });
    } finally {
      await context.close();
    }
  });
});

async function recordWorkWithRelease(
  repo: ItotoriCatalogRepository,
  workId: string,
  releaseId: string,
  title: string,
): Promise<void> {
  await repo.upsertWork(localActor, {
    workId,
    canonicalTitle: title,
    originalLanguage: "ja-JP",
    releases: [
      {
        releaseId,
        catalogSource: catalogSourceValues.dlsite,
        sourceReleaseId: releaseId,
        releaseTitle: title,
        releaseKind: catalogReleaseKindValues.original,
        platform: "pc",
        language: "ja-JP",
      },
    ],
  });
}

async function recordRuntimeReadinessCapabilityEvidence(
  db: ItotoriDatabase,
  input: {
    adapterId: string;
    idBase: number;
    publicFixture: boolean;
    privateLocalAggregate: boolean;
    publicFixtureKind?: (typeof engineCapabilityEvidenceKindValues)[
      | "keyValidation"
      | "adapterMatrix"];
  },
): Promise<void> {
  await db.insert(engineCapabilityReports).values(
    Object.values(capabilityLevelValues).map((level, index) => ({
      engineCapabilityReportId: uuid(input.idBase + index),
      adapterId: input.adapterId,
      level,
      statusKind: capabilityLevelStatusKindValues.supported,
      limitations: [],
      reason: null,
    })),
  );

  const evidenceRows: (typeof engineCapabilityEvidence.$inferInsert)[] = [];
  if (input.publicFixture) {
    evidenceRows.push({
      engineCapabilityEvidenceId: uuid(input.idBase + 10),
      adapterId: input.adapterId,
      level: capabilityLevelValues.extract,
      evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
      evidenceKind: input.publicFixtureKind ?? engineCapabilityEvidenceKindValues.keyValidation,
      schemaVersion: "catalog.capability_evidence.v0.1",
      status: engineCapabilityEvidenceStatusValues.present,
      aggregateCounts: { fixture_rows: 1 },
      evidenceLabels: [],
      limitations: [],
      publicFixtureId: `${input.adapterId}-runtime-fixture`,
    });
  }
  if (input.privateLocalAggregate) {
    evidenceRows.push({
      engineCapabilityEvidenceId: uuid(input.idBase + 11),
      adapterId: input.adapterId,
      level: capabilityLevelValues.extract,
      evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
      evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
      schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
      status: engineCapabilityEvidenceStatusValues.present,
      aggregateCounts: { marker_kinds: 1 },
      evidenceLabels: [],
      limitations: [],
      publicFixtureId: null,
    });
  }
  await db.insert(engineCapabilityEvidence).values(evidenceRows);
}

function runtimeReadinessWorkInput(input: {
  workId: string;
  title: string;
  provenance: CatalogSourceProvenanceRecord;
  sourceId: string;
  adapterId: string;
  languageStatusId: string;
}): Parameters<ItotoriCatalogRepository["upsertWork"]>[1] {
  return {
    workId: input.workId,
    canonicalTitle: input.title,
    originalLanguage: "ja-JP",
    engine: {
      engineName: input.adapterId,
      engineSource: catalogEngineSourceValues.manual,
      engineConfidence: catalogConfidenceValues.high,
      engineProvenanceId: input.provenance.sourceProvenanceId,
    },
    externalIds: [
      {
        externalIdId: `${input.workId}:dlsite`,
        catalogSource: catalogSourceValues.dlsite,
        sourceId: input.sourceId,
        externalIdKind: catalogExternalIdKindValues.storeProduct,
        sourceProvenanceId: input.provenance.sourceProvenanceId,
      },
    ],
    languageStatuses: [
      {
        languageStatusId: input.languageStatusId,
        language: "en-US",
        status: catalogLanguageStatusValues.none,
        sourceProvenanceId: input.provenance.sourceProvenanceId,
        confidence: catalogConfidenceValues.high,
        observedAt: fetchedAt,
      },
    ],
  };
}

async function recordFixtureProvenance(repo: ItotoriCatalogRepository): Promise<{
  vndb: CatalogSourceProvenanceRecord;
  egs: CatalogSourceProvenanceRecord;
  dlsite: CatalogSourceProvenanceRecord;
  steam: CatalogSourceProvenanceRecord;
  igdb: CatalogSourceProvenanceRecord;
  wikidata: CatalogSourceProvenanceRecord;
  local: CatalogSourceProvenanceRecord;
}> {
  const [vndb, egs, dlsite, steam, igdb, wikidata, local] = await Promise.all([
    provenance(repo, 1, catalogSourceValues.vndb, "v17"),
    provenance(repo, 2, catalogSourceValues.egs, "12874"),
    provenance(repo, 3, catalogSourceValues.dlsite, "RJ349517"),
    provenance(repo, 4, catalogSourceValues.steam, "333600"),
    provenance(repo, 5, catalogSourceValues.igdb, "1942"),
    provenance(repo, 6, catalogSourceValues.wikidata, "Q123456"),
    provenance(repo, 7, catalogSourceValues.localCorpus, "local-owned-hash-001", {
      sourceRecordKind: catalogSourceRecordKindValues.localScan,
    }),
  ]);
  return { vndb, egs, dlsite, steam, igdb, wikidata, local };
}

async function provenance(
  repo: ItotoriCatalogRepository,
  id: number,
  catalogSource: (typeof catalogSourceValues)[keyof typeof catalogSourceValues],
  sourceId: string,
  overrides: Partial<Parameters<ItotoriCatalogRepository["recordSourceProvenance"]>[1]> = {},
): Promise<CatalogSourceProvenanceRecord> {
  return repo.recordSourceProvenance(localActor, {
    sourceProvenanceId: uuid(id),
    catalogSource,
    sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
    sourceId,
    sourceVersion: "fixture-2026-06-17",
    requestId: `fixture:${catalogSource}:${sourceId}`,
    httpStatus: 200,
    ok: true,
    payloadHash: hash(`${catalogSource}:${sourceId}`),
    payload: { catalogSource, sourceId },
    fetchedAt,
    metadata: { fixture: true },
    ...overrides,
  });
}

function completenessStatus(
  id: number,
  status: (typeof catalogLanguageStatusValues)[keyof typeof catalogLanguageStatusValues],
  sourceProvenanceId: string,
): NonNullable<Parameters<ItotoriCatalogRepository["upsertWork"]>[1]["languageStatuses"]>[number] {
  return {
    languageStatusId: uuid(id),
    language: "en-US",
    status,
    sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
    observedAt: fetchedAt,
    importedAt: "2026-06-17T12:05:00.000Z",
    parserVersion: "catalog-completeness-fixture.v0.1",
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
  };
}

function uuid(id: number): string {
  return `019ed004-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function requiredTestRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${label}`);
  }
  return row;
}

function requiredOpportunityRow(
  rows: CatalogOpportunityRow[],
  workId: string,
): CatalogOpportunityRow {
  const row = rows.find((candidate) => candidate.workId === workId);
  if (row === undefined) {
    throw new Error(`expected opportunity row ${workId}`);
  }
  return row;
}

function runtimeEvidenceFactor(
  row: CatalogOpportunityRow,
): CatalogOpportunityRow["factorBreakdown"][number] {
  const factor = row.factorBreakdown.find(
    (entry) =>
      entry.factor === ("runtime_evidence_readiness" satisfies CatalogOpportunityFactorName),
  );
  if (factor === undefined) {
    throw new Error("expected runtime evidence readiness factor");
  }
  return factor;
}
