import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";
import { ProjectRepositoryBase } from "./project-repository-base.js";

export class ProjectImportRepository extends ProjectRepositoryBase {
  async reset(actor: deps.AuthorizationActor): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.systemReset);
    await this.db.execute(deps.sql`
      truncate
        ${deps.jobEvents},
        ${deps.jobQueue},
        ${deps.eventOutbox},
        ${deps.costLedgerEntries},
        ${deps.providerRuns},
        ${deps.promptPresets},
        ${deps.modelRegistry},
        ${deps.modelProviders},
        ${deps.feedbackReportEvidence},
        ${deps.feedbackReports},
        ${deps.feedbackSources},
        ${deps.runtimeEvidenceBridgeUnitRefs},
        ${deps.runtimeValidationFindings},
        ${deps.runtimeEvidenceItems},
        ${deps.runtimeEvidenceRuns},
        ${deps.artifacts},
        ${deps.findings},
        ${deps.events},
        ${deps.translationMemoryReuseEvents},
        ${deps.translationMemorySegments},
        ${deps.styleGuideVersions},
        ${deps.styleGuides},
        ${deps.localeBranchUnits},
        ${deps.localeBranches},
        ${deps.sourceUnits},
        ${deps.assets},
        ${deps.bridgeImports},
        ${deps.sourceBundles},
        ${deps.sourceRevisions},
        ${deps.projects},
        ${deps.workspaces}
      restart identity cascade
    `);
    await deps.bootstrapLocalUser(this.db);
  }

  async importSourceBundle(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
  ): Promise<api.BridgeImportStatus> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.projectImport);
    api.assertProjectEngineBinding(project, this.engineFamilyRegistry);
    helpers.assertImportableBridgeBundle(project.bridge);
    const normalized = helpers.normalizeSourceBundle(project);

    return await this.db.transaction(async (tx) => {
      const importTarget = await helpers.resolveSourceBundleImportTarget(
        tx,
        project.projectId,
        normalized,
      );
      await helpers.assertImportOwnership(tx, project.projectId, importTarget);
      const diff = await helpers.diffSourceBundleImport(tx, importTarget);
      const importedAt = new Date();
      const importStatus = helpers.bridgeImportStatusFor(
        project.projectId,
        importTarget,
        diff,
        importedAt,
      );

      await tx
        .insert(deps.workspaces)
        .values({ workspaceId: api.defaultWorkspaceId, name: api.defaultWorkspaceName })
        .onConflictDoNothing();

      await tx
        .insert(deps.projects)
        .values({
          projectId: project.projectId,
          workspaceId: api.defaultWorkspaceId,
          projectKey: project.projectId,
          name: project.projectId,
          sourceLocale: importTarget.sourceLocale,
          status: deps.projectStatusValues.imported,
          gameId: importTarget.sourceGame.gameId,
          gameVersion: importTarget.sourceGame.gameVersion,
          sourceProfileId: importTarget.sourceGame.sourceProfileId,
          engineFamily: project.engineFamily,
          sourceRoot: project.sourceRoot,
          buildRoot: project.buildRoot,
          extractProfile: project.extractProfile,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: deps.projects.projectId,
          set: {
            sourceLocale: importTarget.sourceLocale,
            status: deps.projectStatusValues.imported,
            gameId: importTarget.sourceGame.gameId,
            gameVersion: importTarget.sourceGame.gameVersion,
            sourceProfileId: importTarget.sourceGame.sourceProfileId,
            engineFamily: project.engineFamily,
            sourceRoot: project.sourceRoot,
            buildRoot: project.buildRoot,
            extractProfile: project.extractProfile,
            updatedAt: deps.sql`now()`,
          },
        });

      for (const revision of importTarget.revisions) {
        await tx
          .insert(deps.sourceRevisions)
          .values({
            sourceRevisionId: revision.revisionId,
            projectId: project.projectId,
            revisionKind: revision.revisionKind,
            value: revision.value,
            createdAt: revision.createdAt ? new Date(revision.createdAt) : new Date(),
          })
          .onConflictDoNothing();
      }

      await tx
        .insert(deps.sourceBundles)
        .values({
          sourceBundleId: importTarget.sourceBundleId,
          projectId: project.projectId,
          sourceBundleRevisionId: importTarget.sourceBundleRevision.revisionId,
          bridgeId: importTarget.bridgeId,
          schemaVersion: importTarget.schemaVersion,
          sourceBundleHash: importTarget.sourceBundleHash,
          sourceLocale: importTarget.sourceLocale,
          extractorName: importTarget.extractor.name,
          extractorVersion: importTarget.extractor.version,
          unitCount: importTarget.units.length,
          assetCount: importTarget.assets.length,
        })
        .onConflictDoUpdate({
          target: deps.sourceBundles.sourceBundleId,
          set: {
            sourceBundleRevisionId: importTarget.sourceBundleRevision.revisionId,
            schemaVersion: importTarget.schemaVersion,
            sourceBundleHash: importTarget.sourceBundleHash,
            sourceLocale: importTarget.sourceLocale,
            extractorName: importTarget.extractor.name,
            extractorVersion: importTarget.extractor.version,
            unitCount: importTarget.units.length,
            assetCount: importTarget.assets.length,
          },
        });

      for (const asset of importTarget.assets) {
        await tx
          .insert(deps.assets)
          .values({
            assetId: asset.assetId,
            projectId: project.projectId,
            sourceBundleId: importTarget.sourceBundleId,
            sourceRevisionId: asset.sourceRevision.revisionId,
            assetKey: asset.assetKey,
            assetKind: asset.assetKind,
            sourceHash: asset.sourceHash,
            path: asset.path ?? null,
          })
          .onConflictDoUpdate({
            target: deps.assets.assetId,
            set: {
              sourceRevisionId: asset.sourceRevision.revisionId,
              assetKey: asset.assetKey,
              assetKind: asset.assetKind,
              sourceHash: asset.sourceHash,
              path: asset.path ?? null,
              // Revive a previously-tombstoned asset on re-add.
              removedAt: null,
            },
          });
      }

      for (const unit of importTarget.units) {
        await tx
          .insert(deps.sourceUnits)
          .values({
            bridgeUnitId: unit.bridgeUnitId,
            projectId: project.projectId,
            sourceBundleId: importTarget.sourceBundleId,
            sourceAssetId: unit.sourceAssetRef.assetId,
            sourceRevisionId: unit.sourceRevision.revisionId,
            surfaceId: unit.surfaceId,
            surfaceKind: unit.surfaceKind,
            sourceUnitKey: unit.sourceUnitKey,
            occurrenceId: unit.occurrenceId,
            sourceLocale: unit.sourceLocale,
            sourceText: unit.sourceText,
            sourceHash: unit.sourceHash,
            sourceLocation: unit.sourceLocation,
            speaker: unit.speaker ?? null,
            context: unit.context,
            policy: unit.policy ?? null,
            spans: unit.spans,
            patchRef: unit.patchRef,
            runtimeExpectation: unit.runtimeExpectation,
          })
          .onConflictDoUpdate({
            target: deps.sourceUnits.bridgeUnitId,
            set: {
              sourceBundleId: importTarget.sourceBundleId,
              sourceAssetId: unit.sourceAssetRef.assetId,
              sourceRevisionId: unit.sourceRevision.revisionId,
              surfaceId: unit.surfaceId,
              surfaceKind: unit.surfaceKind,
              sourceUnitKey: unit.sourceUnitKey,
              occurrenceId: unit.occurrenceId,
              sourceLocale: unit.sourceLocale,
              sourceText: unit.sourceText,
              sourceHash: unit.sourceHash,
              sourceLocation: unit.sourceLocation,
              speaker: unit.speaker ?? null,
              context: unit.context,
              policy: unit.policy ?? null,
              spans: unit.spans,
              patchRef: unit.patchRef,
              runtimeExpectation: unit.runtimeExpectation,
              updatedAt: deps.sql`now()`,
              // Revive a previously-tombstoned unit that this reimport
              // re-adds, rather than leaving it archived or duplicating
              // the row.
              removedAt: null,
            },
          });
      }

      // Units/deps.assets omitted by this reimport are TOMBSTONED
      // (removed_at = now()), deps.not hard-deleted. Deleting them would CASCADE
      // away locale-branch unit rows + runtime evidence refs + TM reuse deps.events
      // deps.and sever every historical back-pointer; tombstoning keeps that history
      // intact while removing the row from the active/current set. Guard on
      // removed_at IS NULL so already-tombstoned rows are left untouched.
      if (diff.units.removedIds.length > 0) {
        await tx
          .update(deps.sourceUnits)
          .set({ removedAt: deps.sql`now()`, updatedAt: deps.sql`now()` })
          .where(
            deps.and(
              deps.inArray(deps.sourceUnits.bridgeUnitId, diff.units.removedIds),
              deps.isNull(deps.sourceUnits.removedAt),
            ),
          );
      }

      if (diff.assets.removedIds.length > 0) {
        await tx
          .update(deps.assets)
          .set({ removedAt: deps.sql`now()` })
          .where(
            deps.and(
              deps.inArray(deps.assets.assetId, diff.assets.removedIds),
              deps.isNull(deps.assets.removedAt),
            ),
          );
      }

      await tx
        .insert(deps.localeBranches)
        .values({
          localeBranchId: project.localeBranchId,
          projectId: project.projectId,
          sourceBundleId: importTarget.sourceBundleId,
          targetLocale: project.targetLocale,
          branchName: project.targetLocale,
          status: deps.localeBranchStatusValues.active,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: deps.localeBranches.localeBranchId,
          set: {
            sourceBundleId: importTarget.sourceBundleId,
            targetLocale: project.targetLocale,
            branchName: project.targetLocale,
            status: deps.localeBranchStatusValues.active,
            updatedAt: deps.sql`now()`,
          },
        });

      const draftStyleGuideVersionId = await helpers.getApprovedStyleGuideVersionIdInTx(
        tx,
        project.localeBranchId,
      );
      const hasDrafts = Object.keys(project.drafts).length > 0;
      const draftBranchReference = hasDrafts
        ? await deps.ensureBranchPolicyGlossaryReferenceInTx(tx, actor, {
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            styleGuideVersionId: draftStyleGuideVersionId,
            updateReason: "draft_import_reference",
            metadata: { source: "importSourceBundle" },
          })
        : null;
      for (const unit of importTarget.units) {
        const hasDraft = project.drafts[unit.bridgeUnitId] !== undefined;
        await tx
          .insert(deps.localeBranchUnits)
          .values({
            localeBranchId: project.localeBranchId,
            bridgeUnitId: unit.bridgeUnitId,
            targetText: project.drafts[unit.bridgeUnitId] ?? null,
            styleGuideVersionId: hasDraft ? draftStyleGuideVersionId : null,
            glossaryReferenceId: hasDraft ? (draftBranchReference?.referenceId ?? null) : null,
          })
          .onConflictDoUpdate({
            target: [deps.localeBranchUnits.localeBranchId, deps.localeBranchUnits.bridgeUnitId],
            set: {
              targetText: project.drafts[unit.bridgeUnitId] ?? null,
              styleGuideVersionId: hasDraft ? draftStyleGuideVersionId : null,
              glossaryReferenceId: hasDraft ? (draftBranchReference?.referenceId ?? null) : null,
              updatedAt: deps.sql`now()`,
            },
          });
      }

      await tx
        .insert(deps.bridgeImports)
        .values({
          bridgeImportId: importStatus.bridgeImportId,
          projectId: project.projectId,
          sourceBundleId: importTarget.sourceBundleId,
          sourceBundleRevisionId: importTarget.sourceBundleRevision.revisionId,
          bridgeId: importTarget.bridgeId,
          schemaVersion: importTarget.schemaVersion,
          sourceBundleHash: importTarget.sourceBundleHash,
          sourceLocale: importTarget.sourceLocale,
          unitCount: importStatus.unitCount,
          assetCount: importStatus.assetCount,
          sourceRevisionCount: importStatus.sourceRevisionCount,
          validationFailureCount: importStatus.validationFailureCount,
          addedUnitCount: importStatus.units.added,
          updatedUnitCount: importStatus.units.updated,
          removedUnitCount: importStatus.units.removed,
          unchangedUnitCount: importStatus.units.unchanged,
          addedAssetCount: importStatus.assets.added,
          updatedAssetCount: importStatus.assets.updated,
          removedAssetCount: importStatus.assets.removed,
          unchangedAssetCount: importStatus.assets.unchanged,
          addedSourceRevisionCount: importStatus.sourceRevisions.added,
          existingSourceRevisionCount: importStatus.sourceRevisions.existing,
          catalogWorkId: importStatus.futureReferences.catalogWorkId,
          localCorpusEntryId: importStatus.futureReferences.localCorpusEntryId,
          readinessProfileId: importStatus.futureReferences.readinessProfileId,
          completenessStatusId: importStatus.futureReferences.completenessStatusId,
          metadata: helpers.bridgeImportMetadata(importTarget),
          importedAt,
        })
        .onConflictDoUpdate({
          target: [deps.bridgeImports.sourceBundleId, deps.bridgeImports.sourceBundleRevisionId],
          set: {
            bridgeId: importTarget.bridgeId,
            schemaVersion: importTarget.schemaVersion,
            sourceBundleHash: importTarget.sourceBundleHash,
            sourceLocale: importTarget.sourceLocale,
            unitCount: importStatus.unitCount,
            assetCount: importStatus.assetCount,
            sourceRevisionCount: importStatus.sourceRevisionCount,
            validationFailureCount: importStatus.validationFailureCount,
            addedUnitCount: importStatus.units.added,
            updatedUnitCount: importStatus.units.updated,
            removedUnitCount: importStatus.units.removed,
            unchangedUnitCount: importStatus.units.unchanged,
            addedAssetCount: importStatus.assets.added,
            updatedAssetCount: importStatus.assets.updated,
            removedAssetCount: importStatus.assets.removed,
            unchangedAssetCount: importStatus.assets.unchanged,
            addedSourceRevisionCount: importStatus.sourceRevisions.added,
            existingSourceRevisionCount: importStatus.sourceRevisions.existing,
            catalogWorkId: importStatus.futureReferences.catalogWorkId,
            localCorpusEntryId: importStatus.futureReferences.localCorpusEntryId,
            readinessProfileId: importStatus.futureReferences.readinessProfileId,
            completenessStatusId: importStatus.futureReferences.completenessStatusId,
            metadata: helpers.bridgeImportMetadata(importTarget),
            importedAt,
          },
        });

      return importStatus;
    });
  }

  /**
   * Idempotently provision the parent project graph a whole-project localize run
   * requires before it persists a journal run. The whole-game localize
   * driver (the kept `itotori localize` command) writes a journal run with FKs
   * to deps.projects, locale branches, deps.and source revisions using the run identity
   * from its config, but never created those parent rows — so the first live
   * persist violated the FK. This upserts, in FK order, the
   * workspace -> project -> source_revision -> source_bundle -> locale_branch
   * chain those ids imply.
   *
   * Every insert is `onConflictDoNothing`, so it is safe to re-run deps.and NEVER
   * clobbers a richer graph a real `importSourceBundle` already wrote (a prior
   * real import keeps its own source bundle + locale-branch pointer; this only
   * fills in whatever parent rows are still missing — in particular the
   * config's `sourceRevisionId`, which the journal-run FK restricts to). The
   * synthesized source bundle is a minimal run-scope placeholder (0 units/0
   * deps.assets) that exists only to satisfy the locale-branch's `restrict` FK; the
   * real source units land later via the normal bridge-import path when a run
   * needs them.
   */
}
