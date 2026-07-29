import { sql } from "drizzle-orm";
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
  catalogExternalIdKindValues,
  catalogExternalIds,
  catalogInstallStateValues,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
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
  provenance,
  uuid,
  requiredTestRow,
} from "./catalog-repository.test.support.js";

describe("ItotoriCatalogRepository", () => {
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
});
