import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  catalogConfidenceValues,
  catalogCandidateMatches,
  catalogCandidateMatchStatusValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogLocalScanEntries,
  catalogLocalScanExternalIds,
  catalogPathRedactionClassValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSeedTargets,
  catalogSourceRecordKindValues,
  catalogSourceValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-17T12:00:00.000Z";

/**
 * Asserts a catalog artifact-mapping validation failure exposes the expected
 * stable machine-readable code (not merely a matching message string), and
 * returns the caught error so callers can additionally assert the message.
 */

import { provenance, uuid, hash, requiredTestRow } from "./catalog-repository.test.shared-01.js";

describe("ItotoriCatalogRepository", () => {
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
});
