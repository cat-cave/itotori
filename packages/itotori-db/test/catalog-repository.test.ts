import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriCatalogRepository,
  type CatalogSourceProvenanceRecord,
} from "../src/repositories/catalog-repository.js";
import {
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConfidenceValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogExternalIds,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogPathRedactionClassValues,
  catalogReleaseKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSeedTargets,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  catalogWorks,
  userPermissionGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-17T12:00:00.000Z";

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
            'itotori_catalog_local_scan_entries_path_idx'
          )
      `);
      expect(new Set(result.rows.map((row) => String(row.indexname)))).toEqual(
        new Set([
          "itotori_catalog_external_ids_source_idx",
          "itotori_catalog_source_provenance_lookup_idx",
          "itotori_catalog_language_statuses_work_lang_idx",
          "itotori_catalog_seed_targets_status_idx",
          "itotori_catalog_local_scan_entries_path_idx",
        ]),
      );
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
