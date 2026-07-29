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
  catalogInstallStateValues,
  catalogPathRedactionClassValues,
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
  uuid,
  hash,
  requiredTestRow,
} from "./catalog-repository.test.support.js";

describe("ItotoriCatalogRepository", () => {
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

  it("rejects a child-kind subject bearing a cross-source identity as a caller error (parent-scoped by contract)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const workId = uuid(1350);
      const releaseId = uuid(1351);
      await recordWorkWithRelease(repo, workId, releaseId, "Child cross-source fixture");

      // CATALOG-079: child kinds (externalId/release/languageStatus) are PARENT-SCOPED
      // by contract. A child subject carrying a `<catalogSource>:<sourceId>` cross-source
      // identity is a CALLER ERROR (the identity belongs on the `sourceProvenance` kind),
      // NOT a silently over-rejected dangling id. This PINS the explicit policy: the same
      // `vndb:...` identity that `sourceProvenance` accepts (above) is rejected here with a
      // distinct code + a message pointing the caller to `sourceProvenance`.
      const childCrossSourceError = await expectArtifactMappingError(
        repo.upsertWork(localActor, {
          workId,
          canonicalTitle: "Child cross-source fixture",
          conflicts: [
            {
              conflictId: uuid(1352),
              conflictKind: catalogConflictKindValues.languageStatus,
              summary: "Evidence mis-routes a cross-source identity onto a child kind.",
              detectedAt: fetchedAt,
              evidence: [
                {
                  conflictEvidenceId: uuid(1353),
                  subjectKind: catalogConflictSubjectKindValues.languageStatus,
                  subjectId: "vndb:v9999",
                },
              ],
            },
          ],
        }),
        "conflict_evidence_child_subject_cross_source",
      );
      expect(childCrossSourceError.message).toContain("parent-scoped by contract");
      expect(childCrossSourceError.message).toContain("sourceProvenance");
      expect(childCrossSourceError.message).toContain("vndb:v9999");
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
});
