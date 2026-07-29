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

import {
  recordWorkWithRelease,
  recordRuntimeReadinessCapabilityEvidence,
  runtimeReadinessWorkInput,
  recordFixtureProvenance,
  provenance,
  completenessStatus,
  uuid,
  hash,
  requiredTestRow,
  requiredOpportunityRow,
  runtimeEvidenceFactor,
} from "./catalog-repository.test.shared-01.js";

describe("ItotoriCatalogRepository", () => {
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
});
