import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";
import { ProjectRepositoryBase } from "./project-repository-base.js";

export class ProjectDraftRepository extends ProjectRepositoryBase {
  async ensureRunProjectScope(
    actor: deps.AuthorizationActor,
    scope: api.LocalizationRunProjectScope,
  ): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.projectImport);
    api.assertProjectEngineBinding(scope, this.engineFamilyRegistry);
    const runScopeBundleId = `${scope.projectId}:${scope.sourceRevisionId}:run-scope`;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(deps.workspaces)
        .values({ workspaceId: api.defaultWorkspaceId, name: api.defaultWorkspaceName })
        .onConflictDoNothing();

      await tx
        .insert(deps.projects)
        .values({
          projectId: scope.projectId,
          workspaceId: api.defaultWorkspaceId,
          projectKey: scope.projectId,
          name: scope.projectId,
          sourceLocale: scope.sourceLocale,
          status: deps.projectStatusValues.imported,
          engineFamily: scope.engineFamily,
          sourceRoot: scope.sourceRoot,
          buildRoot: scope.buildRoot,
          extractProfile: scope.extractProfile,
          createdByUserId: actor.userId,
        })
        .onConflictDoNothing();

      await tx
        .insert(deps.sourceRevisions)
        .values({
          sourceRevisionId: scope.sourceRevisionId,
          projectId: scope.projectId,
          revisionKind: "bridge_revision",
          value: scope.sourceRevisionId,
        })
        .onConflictDoNothing();

      await tx
        .insert(deps.sourceBundles)
        .values({
          sourceBundleId: runScopeBundleId,
          projectId: scope.projectId,
          sourceBundleRevisionId: scope.sourceRevisionId,
          bridgeId: `${scope.projectId}:run-scope`,
          schemaVersion: deps.BRIDGE_SCHEMA_VERSION_V02,
          sourceBundleHash: `run-scope:${scope.sourceRevisionId}`,
          sourceLocale: scope.sourceLocale,
          extractorName: "localize-run-scope",
          extractorVersion: "0",
          unitCount: 0,
          assetCount: 0,
        })
        .onConflictDoNothing();

      await tx
        .insert(deps.localeBranches)
        .values({
          localeBranchId: scope.localeBranchId,
          projectId: scope.projectId,
          sourceBundleId: runScopeBundleId,
          targetLocale: scope.targetLocale,
          branchName: scope.targetLocale,
          status: deps.localeBranchStatusValues.active,
          createdByUserId: actor.userId,
        })
        .onConflictDoNothing();
    });
  }

  async saveDrafts(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
  ): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.draftWrite);
    await this.db.transaction(async (tx) => {
      await tx
        .update(deps.projects)
        .set({ status: deps.projectStatusValues.drafted, updatedAt: deps.sql`now()` })
        .where(deps.eq(deps.projects.projectId, project.projectId));

      await tx
        .update(deps.localeBranches)
        .set({
          targetLocale: project.targetLocale,
          branchName: project.targetLocale,
          updatedAt: deps.sql`now()`,
        })
        .where(deps.eq(deps.localeBranches.localeBranchId, project.localeBranchId));

      const draftStyleGuideVersionId = await helpers.getApprovedStyleGuideVersionIdInTx(
        tx,
        project.localeBranchId,
      );
      const draftEntries = Object.entries(project.drafts);
      const draftBranchReference =
        draftEntries.length === 0
          ? null
          : await deps.ensureBranchPolicyGlossaryReferenceInTx(tx, actor, {
              projectId: project.projectId,
              localeBranchId: project.localeBranchId,
              styleGuideVersionId: draftStyleGuideVersionId,
              updateReason: "draft_save_reference",
              metadata: { source: "saveDrafts" },
            });
      for (const [bridgeUnitId, targetText] of draftEntries) {
        await tx
          .insert(deps.localeBranchUnits)
          .values({
            localeBranchId: project.localeBranchId,
            bridgeUnitId,
            targetText,
            styleGuideVersionId: draftStyleGuideVersionId,
            glossaryReferenceId: draftBranchReference?.referenceId ?? null,
          })
          .onConflictDoUpdate({
            target: [deps.localeBranchUnits.localeBranchId, deps.localeBranchUnits.bridgeUnitId],
            set: {
              targetText,
              styleGuideVersionId: draftStyleGuideVersionId,
              glossaryReferenceId: draftBranchReference?.referenceId ?? null,
              updatedAt: deps.sql`now()`,
            },
          });
      }
    });
  }

  async loadLocaleBranchDraftTexts(
    actor: deps.AuthorizationActor,
    input: api.LoadLocaleBranchDraftTextsInput,
  ): Promise<Map<string, string | null>> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.catalogRead);
    const result = new Map<string, string | null>();
    if (input.bridgeUnitIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({
        bridgeUnitId: deps.localeBranchUnits.bridgeUnitId,
        targetText: deps.localeBranchUnits.targetText,
      })
      .from(deps.localeBranchUnits)
      .innerJoin(
        deps.localeBranches,
        deps.eq(deps.localeBranches.localeBranchId, deps.localeBranchUnits.localeBranchId),
      )
      .where(
        deps.and(
          deps.eq(deps.localeBranches.projectId, input.projectId),
          deps.eq(deps.localeBranchUnits.localeBranchId, input.localeBranchId),
          deps.inArray(deps.localeBranchUnits.bridgeUnitId, [...input.bridgeUnitIds]),
        ),
      );
    for (const row of rows) {
      result.set(row.bridgeUnitId, row.targetText);
    }
    return result;
  }

  async savePatchExport(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
    patchExport: deps.PatchExport | deps.PatchExportV02,
  ): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.patchExport);
    helpers.validatePatchExportContract(patchExport, project.bridge);
    await this.db.transaction(async (tx) => {
      const { sourceBundleId } = await helpers.resolveSourceBundlePersistenceTarget(tx, project);
      await tx
        .insert(deps.artifacts)
        .values({
          artifactId: patchExport.patchExportId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceBundleId,
          artifactKind: "patch_export",
          hash: "patchExportHash" in patchExport ? (patchExport.patchExportHash ?? null) : null,
          metadata: {
            schemaVersion: patchExport.schemaVersion,
            sourceBridgeId: patchExport.sourceBridgeId,
            targetLocale: patchExport.targetLocale,
            entryCount: patchExport.entries.length,
          },
        })
        .onConflictDoUpdate({
          target: deps.artifacts.artifactId,
          set: {
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            hash: "patchExportHash" in patchExport ? (patchExport.patchExportHash ?? null) : null,
            metadata: {
              schemaVersion: patchExport.schemaVersion,
              sourceBridgeId: patchExport.sourceBridgeId,
              targetLocale: patchExport.targetLocale,
              entryCount: patchExport.entries.length,
            },
          },
        });

      await tx
        .update(deps.projects)
        .set({ status: deps.projectStatusValues.patchExported, updatedAt: deps.sql`now()` })
        .where(deps.eq(deps.projects.projectId, project.projectId));
    });
  }
}
