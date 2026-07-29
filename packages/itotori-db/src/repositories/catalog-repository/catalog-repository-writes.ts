import {
  AuthorizationActor,
  ItotoriDatabase,
  catalogConflictEvidence,
  catalogConflicts,
  catalogDemandFacts,
  catalogExternalIds,
  catalogLanguageStatuses,
  catalogReleaseInstallStates,
  catalogReleaseMappings,
  catalogReleases,
  catalogWorks,
  permissionValues,
  requirePermission,
  sql,
} from "./dependencies.js";
import {
  CatalogSourceProvenanceInput,
  CatalogSourceProvenanceRecord,
} from "./catalog-record-types.js";
import { CatalogWorkInput, CatalogWorkSnapshot } from "./catalog-work-scan-types.js";
import { recordSourceProvenanceUnchecked } from "./catalog-conflict-utils.js";
import { assertSourceProvenanceInput, readWorkSnapshot } from "./catalog-input-normalization.js";
import {
  assertCatalogWorkInput,
  assertWorkScopedArtifactReferences,
} from "./catalog-work-input-validation.js";
import { assertConflictEvidenceSubjectReferences } from "./catalog-identity-validation.js";
import { requiredSnapshot } from "./catalog-row-mapping.js";
export class CatalogRepositoryWrites {
  constructor(protected readonly db: ItotoriDatabase) {}

  async recordSourceProvenance(
    actor: AuthorizationActor,
    input: CatalogSourceProvenanceInput,
  ): Promise<CatalogSourceProvenanceRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    return recordSourceProvenanceUnchecked(this.db, assertSourceProvenanceInput(input));
  }

  async upsertWork(
    actor: AuthorizationActor,
    input: CatalogWorkInput,
  ): Promise<CatalogWorkSnapshot> {
    await requirePermission(this.db, actor, permissionValues.catalogWrite);
    const normalized = assertCatalogWorkInput(input);

    await this.db.transaction(async (tx) => {
      // Run the existence/same-work guards on the TRANSACTION handle (not
      // this.db) so the committed-state checks and the writes below are atomic.
      // Querying this.db before the transaction opened a TOCTOU window: for an
      // FK-less conflict-evidence subject, a concurrent delete/reassign between
      // check and commit could persist a dangling evidence row. The
      // artifact-references guard shares the same check-then-write TOCTOU, so it
      // moves inside too. Both read committed state and MUST run before the
      // inserts below, whose onConflictDoUpdate writes reassign ownership and
      // would otherwise defeat the cross-work checks.
      await assertWorkScopedArtifactReferences(tx as ItotoriDatabase, normalized);
      await assertConflictEvidenceSubjectReferences(tx as ItotoriDatabase, normalized);

      await tx
        .insert(catalogWorks)
        .values({
          workId: normalized.workId,
          canonicalTitle: normalized.canonicalTitle,
          originalLanguage: normalized.originalLanguage,
          firstReleaseYear: normalized.firstReleaseYear,
          workKind: normalized.workKind,
          engineName: normalized.engine?.engineName ?? null,
          engineSource: normalized.engine?.engineSource ?? null,
          engineConfidence: normalized.engine?.engineConfidence ?? null,
          engineProvenanceId: normalized.engine?.engineProvenanceId ?? null,
          metadata: normalized.metadata,
        })
        .onConflictDoUpdate({
          target: catalogWorks.workId,
          set: {
            canonicalTitle: normalized.canonicalTitle,
            originalLanguage: normalized.originalLanguage,
            firstReleaseYear: normalized.firstReleaseYear,
            workKind: normalized.workKind,
            engineName: normalized.engine?.engineName ?? null,
            engineSource: normalized.engine?.engineSource ?? null,
            engineConfidence: normalized.engine?.engineConfidence ?? null,
            engineProvenanceId: normalized.engine?.engineProvenanceId ?? null,
            metadata: normalized.metadata,
            updatedAt: sql`now()`,
          },
        });

      for (const externalId of normalized.externalIds) {
        await tx
          .insert(catalogExternalIds)
          .values({
            externalIdId: externalId.externalIdId,
            workId: normalized.workId,
            catalogSource: externalId.catalogSource,
            sourceId: externalId.sourceId,
            externalIdKind: externalId.externalIdKind,
            sourceProvenanceId: externalId.sourceProvenanceId,
            confidence: externalId.confidence,
            discoveredAt: externalId.discoveredAt,
            metadata: externalId.metadata,
          })
          .onConflictDoUpdate({
            target: [
              catalogExternalIds.catalogSource,
              catalogExternalIds.sourceId,
              catalogExternalIds.externalIdKind,
            ],
            set: {
              workId: normalized.workId,
              catalogSource: externalId.catalogSource,
              sourceId: externalId.sourceId,
              externalIdKind: externalId.externalIdKind,
              sourceProvenanceId: externalId.sourceProvenanceId,
              confidence: externalId.confidence,
              metadata: externalId.metadata,
            },
          });
      }

      for (const release of normalized.releases) {
        await tx
          .insert(catalogReleases)
          .values({
            releaseId: release.releaseId,
            workId: normalized.workId,
            catalogSource: release.catalogSource,
            sourceReleaseId: release.sourceReleaseId,
            releaseTitle: release.releaseTitle,
            releaseKind: release.releaseKind,
            editionName: release.editionName,
            milestone: release.milestone,
            packageKind: release.packageKind,
            engineName: release.engine?.engineName ?? null,
            engineSource: release.engine?.engineSource ?? null,
            engineConfidence: release.engine?.engineConfidence ?? null,
            engineProvenanceId: release.engine?.engineProvenanceId ?? null,
            platform: release.platform,
            language: release.language,
            releaseDate: release.releaseDate,
            releaseYear: release.releaseYear,
            isOfficial: release.isOfficial,
            sourceProvenanceId: release.sourceProvenanceId,
            metadata: release.metadata,
          })
          .onConflictDoUpdate({
            target: catalogReleases.releaseId,
            set: {
              catalogSource: release.catalogSource,
              sourceReleaseId: release.sourceReleaseId,
              releaseTitle: release.releaseTitle,
              releaseKind: release.releaseKind,
              editionName: release.editionName,
              milestone: release.milestone,
              packageKind: release.packageKind,
              engineName: release.engine?.engineName ?? null,
              engineSource: release.engine?.engineSource ?? null,
              engineConfidence: release.engine?.engineConfidence ?? null,
              engineProvenanceId: release.engine?.engineProvenanceId ?? null,
              platform: release.platform,
              language: release.language,
              releaseDate: release.releaseDate,
              releaseYear: release.releaseYear,
              isOfficial: release.isOfficial,
              sourceProvenanceId: release.sourceProvenanceId,
              metadata: release.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const releaseMapping of normalized.releaseMappings) {
        await tx
          .insert(catalogReleaseMappings)
          .values({
            releaseMappingId: releaseMapping.releaseMappingId,
            workId: normalized.workId,
            sourceReleaseId: releaseMapping.sourceReleaseId,
            targetReleaseId: releaseMapping.targetReleaseId,
            relationKind: releaseMapping.relationKind,
            portability: releaseMapping.portability,
            sourceProvenanceId: releaseMapping.sourceProvenanceId,
            confidence: releaseMapping.confidence,
            observedAt: releaseMapping.observedAt,
            metadata: releaseMapping.metadata,
          })
          .onConflictDoUpdate({
            target: [
              catalogReleaseMappings.sourceReleaseId,
              catalogReleaseMappings.targetReleaseId,
              catalogReleaseMappings.relationKind,
            ],
            set: {
              workId: normalized.workId,
              portability: releaseMapping.portability,
              sourceProvenanceId: releaseMapping.sourceProvenanceId,
              confidence: releaseMapping.confidence,
              observedAt: releaseMapping.observedAt,
              metadata: releaseMapping.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const installState of normalized.installStates) {
        await tx.execute(sql`
          insert into ${catalogReleaseInstallStates} (
            install_state_id,
            work_id,
            release_id,
            local_scan_entry_id,
            install_state,
            target_artifact_label,
            source_provenance_id,
            confidence,
            observed_at,
            metadata
          ) values (
            ${installState.installStateId},
            ${normalized.workId},
            ${installState.releaseId},
            ${installState.localScanEntryId},
            ${installState.installState},
            ${installState.targetArtifactLabel},
            ${installState.sourceProvenanceId},
            ${installState.confidence},
            ${installState.observedAt},
            ${installState.metadata}::jsonb
          )
          on conflict (release_id, coalesce(local_scan_entry_id, ''), install_state)
          do update set
            work_id = excluded.work_id,
            target_artifact_label = excluded.target_artifact_label,
            source_provenance_id = excluded.source_provenance_id,
            confidence = excluded.confidence,
            observed_at = excluded.observed_at,
            metadata = excluded.metadata,
            updated_at = now()
        `);
      }

      for (const languageStatus of normalized.languageStatuses) {
        await tx
          .insert(catalogLanguageStatuses)
          .values({
            languageStatusId: languageStatus.languageStatusId,
            workId: normalized.workId,
            language: languageStatus.language,
            status: languageStatus.status,
            statusScope: languageStatus.statusScope,
            platform: languageStatus.platform,
            releaseId: languageStatus.releaseId,
            sourceProvenanceId: languageStatus.sourceProvenanceId,
            confidence: languageStatus.confidence,
            isCurrent: languageStatus.isCurrent,
            observedAt: languageStatus.observedAt,
            importedAt: languageStatus.importedAt,
            parserVersion: languageStatus.parserVersion,
            rawContentRedactionClass: languageStatus.rawContentRedactionClass,
            metadata: languageStatus.metadata,
          })
          .onConflictDoUpdate({
            target: catalogLanguageStatuses.languageStatusId,
            set: {
              language: languageStatus.language,
              status: languageStatus.status,
              statusScope: languageStatus.statusScope,
              platform: languageStatus.platform,
              releaseId: languageStatus.releaseId,
              sourceProvenanceId: languageStatus.sourceProvenanceId,
              confidence: languageStatus.confidence,
              isCurrent: languageStatus.isCurrent,
              observedAt: languageStatus.observedAt,
              importedAt: languageStatus.importedAt,
              parserVersion: languageStatus.parserVersion,
              rawContentRedactionClass: languageStatus.rawContentRedactionClass,
              metadata: languageStatus.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const demandFact of normalized.demandFacts) {
        await tx
          .insert(catalogDemandFacts)
          .values({
            demandFactId: demandFact.demandFactId,
            workId: normalized.workId,
            catalogSource: demandFact.catalogSource,
            sourceId: demandFact.sourceId,
            factKind: demandFact.factKind,
            factValue: demandFact.factValue,
            observedAt: demandFact.observedAt,
            sourceProvenanceId: demandFact.sourceProvenanceId,
            parserVersion: demandFact.parserVersion,
            metadata: demandFact.metadata,
          })
          .onConflictDoUpdate({
            target: catalogDemandFacts.demandFactId,
            set: {
              workId: normalized.workId,
              catalogSource: demandFact.catalogSource,
              sourceId: demandFact.sourceId,
              factKind: demandFact.factKind,
              factValue: demandFact.factValue,
              observedAt: demandFact.observedAt,
              sourceProvenanceId: demandFact.sourceProvenanceId,
              parserVersion: demandFact.parserVersion,
              metadata: demandFact.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      for (const conflict of normalized.conflicts) {
        await tx
          .insert(catalogConflicts)
          .values({
            conflictId: conflict.conflictId,
            workId: normalized.workId,
            conflictKind: conflict.conflictKind,
            status: conflict.status,
            summary: conflict.summary,
            detectedAt: conflict.detectedAt,
            metadata: conflict.metadata,
          })
          .onConflictDoUpdate({
            target: catalogConflicts.conflictId,
            set: {
              conflictKind: conflict.conflictKind,
              status: conflict.status,
              summary: conflict.summary,
              detectedAt: conflict.detectedAt,
              metadata: conflict.metadata,
              updatedAt: sql`now()`,
            },
          });

        for (const evidence of conflict.evidence) {
          await tx
            .insert(catalogConflictEvidence)
            .values({
              conflictEvidenceId: evidence.conflictEvidenceId,
              conflictId: conflict.conflictId,
              subjectKind: evidence.subjectKind,
              subjectId: evidence.subjectId,
              sourceProvenanceId: evidence.sourceProvenanceId,
              evidencePosition: evidence.evidencePosition,
              metadata: evidence.metadata,
            })
            .onConflictDoUpdate({
              target: catalogConflictEvidence.conflictEvidenceId,
              set: {
                subjectKind: evidence.subjectKind,
                subjectId: evidence.subjectId,
                sourceProvenanceId: evidence.sourceProvenanceId,
                evidencePosition: evidence.evidencePosition,
                metadata: evidence.metadata,
              },
            });
        }
      }
    });

    return requiredSnapshot(await readWorkSnapshot(this.db, normalized.workId), normalized.workId);
  }
}
