import { and, eq, inArray, not, sql } from "drizzle-orm";
import {
  assertBridgeBundle,
  assertBridgeBundleV02,
  BRIDGE_SCHEMA_VERSION_V02,
  type BridgeAssetV02,
  type BridgeBundle,
  type BridgeBundleV02,
  type FindingRecordV02,
  type LocalizationUnitV02,
  type PatchExport,
  type PatchExportV02,
  type RuntimeArtifactRefV02,
  type RuntimeBridgeUnitRefV02,
  type RuntimeEvidenceReportV02,
  type RuntimeValidationFindingV02,
  type RuntimeVerificationReport,
  type SourceRevisionV02,
  type TriageEventV02,
} from "@itotori/localization-bridge-schema";
import type { ItotoriDatabase } from "../connection.js";
import {
  type AuthorizationActor,
  bootstrapLocalUser,
  permissionValues,
  requirePermission,
} from "../authorization.js";
import { ItotoriModelLedgerRepository, type ProjectCostReport } from "./model-ledger-repository.js";
import {
  artifacts,
  assets,
  bridgeImports,
  costLedgerEntries,
  eventOutbox,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  findings,
  jobQueue,
  localeBranches,
  localeBranchStatusValues,
  localeBranchUnits,
  modelProviders,
  modelRegistry,
  promptPresets,
  projectStatusValues,
  projects,
  providerRuns,
  runtimeBridgeUnitRefRoleValues,
  runtimeEvidenceBridgeUnitRefs,
  runtimeEvidenceItems,
  runtimeEvidenceKindValues,
  runtimeEvidenceRuns,
  runtimeValidationFindings,
  sourceBundles,
  sourceRevisions,
  sourceUnits,
  workspaces,
} from "../schema.js";
import type { RuntimeBridgeUnitRefRole, RuntimeEvidenceKind } from "../schema.js";

export const defaultWorkspaceId = "local-workspace";
export const defaultWorkspaceName = "Local workspace";

export type ItotoriProjectRecord = {
  projectId: string;
  bridge: BridgeBundle | BridgeBundleV02;
  localeBranchId: string;
  targetLocale: string;
  drafts: Record<string, string>;
  importStatus?: BridgeImportStatus;
  patchExport?: PatchExport | PatchExportV02;
  runtimeReport?: RuntimeVerificationReport | RuntimeEvidenceReportV02;
};

export type BridgeImportFutureReferences = {
  catalogWorkId: string | null;
  localCorpusEntryId: string | null;
  readinessProfileId: string | null;
  completenessStatusId: string | null;
};

export type BridgeImportDiffCounts = {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
};

export type BridgeImportRevisionDiffCounts = {
  added: number;
  existing: number;
};

export type BridgeImportStatus = {
  bridgeImportId: string;
  projectId: string;
  bridgeId: string;
  sourceBundleId: string;
  sourceBundleHash: string;
  sourceBundleRevisionId: string;
  schemaVersion: string;
  sourceLocale: string;
  importedAt: string;
  unitCount: number;
  assetCount: number;
  sourceRevisionCount: number;
  validationFailureCount: number;
  units: BridgeImportDiffCounts;
  assets: BridgeImportDiffCounts;
  sourceRevisions: BridgeImportRevisionDiffCounts;
  futureReferences: BridgeImportFutureReferences;
};

export type ArtifactInput = {
  artifactId: string;
  projectId: string;
  artifactKind: string;
  localeBranchId?: string;
  sourceBundleId?: string;
  bridgeUnitId?: string;
  findingId?: string;
  uri?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
};

export type FindingInput = {
  projectId: string;
  localeBranchId?: string;
  finding: FindingRecordV02;
  status?: "open" | "resolved" | "superseded";
};

export type EventInput = {
  projectId: string;
  localeBranchId?: string;
  event: TriageEventV02;
};

export type LocaleBranchStatus = {
  localeBranchId: string;
  targetLocale: string;
  status: string;
  unitCount: number;
  translatedUnitCount: number;
  openFindingCount: number;
  artifactCount: number;
};

export type ProjectDashboardStatus = {
  projectId: string;
  projectKey: string;
  name: string;
  status: string;
  sourceLocale: string;
  sourceBundleId: string;
  sourceBundleHash: string;
  sourceBundleRevisionId: string;
  branchCount: number;
  unitCount: number;
  findingCount: number;
  artifactCount: number;
  latestEventKind: string | null;
  latestEventAt: string | null;
  importStatus: BridgeImportStatus;
  cost: ProjectCostReport;
  localeBranches: LocaleBranchStatus[];
};

export type RuntimeDashboardStatus = {
  finalStatus: string;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  textEventCount: number;
  frameCaptureCount: number;
  evidenceTier: string | null;
  screenshotArtifactCount: number;
  recordingArtifactCount: number;
  validationFindingCount: number;
};

export type DashboardPendingDecisionKind =
  | "project_finding"
  | "locale_branch_finding"
  | "runtime_validation";

export type DashboardPendingDecision = {
  decisionId: string;
  decisionKind: DashboardPendingDecisionKind;
  projectId: string;
  findingId: string;
  findingKind: string;
  severity: string;
  qualityCategory: string | null;
  title: string;
  localeBranchId: string | null;
  targetLocale: string | null;
  branchStatus: string | null;
  runtimeRunId: string | null;
  runtimeStatus: string | null;
  createdAt: string;
};

export type DashboardDecisionCounts = {
  pendingDecisionCount: number;
  projectFindingDecisionCount: number;
  localeBranchFindingDecisionCount: number;
  runtimeValidationDecisionCount: number;
};

export type DashboardDecisionReadModel = {
  projectId: string;
  counts: DashboardDecisionCounts;
  pendingDecisions: DashboardPendingDecision[];
};

export interface ItotoriProjectRepositoryPort {
  reset(actor: AuthorizationActor): Promise<void>;
  importSourceBundle(
    actor: AuthorizationActor,
    project: ItotoriProjectRecord,
  ): Promise<BridgeImportStatus>;
  saveDrafts(actor: AuthorizationActor, project: ItotoriProjectRecord): Promise<void>;
  savePatchExport(
    actor: AuthorizationActor,
    project: ItotoriProjectRecord,
    patchExport: PatchExport | PatchExportV02,
  ): Promise<void>;
  saveRuntimeReport(
    actor: AuthorizationActor,
    project: ItotoriProjectRecord,
    runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02,
    patchResultId: string,
  ): Promise<ProjectDashboardStatus>;
  appendEvent(actor: AuthorizationActor, input: EventInput): Promise<void>;
  recordFinding(actor: AuthorizationActor, input: FindingInput): Promise<void>;
  linkArtifact(actor: AuthorizationActor, input: ArtifactInput): Promise<void>;
  getDashboardStatus(): Promise<ProjectDashboardStatus>;
  getRuntimeStatus(): Promise<RuntimeDashboardStatus>;
  getDashboardDecisions(projectId?: string): Promise<DashboardDecisionReadModel>;
}

export class ItotoriProjectRepository implements ItotoriProjectRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async reset(actor: AuthorizationActor): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.systemReset);
    await this.db.execute(sql`
      truncate
        ${jobQueue},
        ${eventOutbox},
        ${costLedgerEntries},
        ${providerRuns},
        ${promptPresets},
        ${modelRegistry},
        ${modelProviders},
        ${feedbackReportEvidence},
        ${feedbackReports},
        ${feedbackSources},
        ${runtimeEvidenceBridgeUnitRefs},
        ${runtimeValidationFindings},
        ${runtimeEvidenceItems},
        ${runtimeEvidenceRuns},
        ${artifacts},
        ${findings},
        ${events},
        ${localeBranchUnits},
        ${localeBranches},
        ${sourceUnits},
        ${assets},
        ${bridgeImports},
        ${sourceBundles},
        ${sourceRevisions},
        ${projects},
        ${workspaces}
      restart identity cascade
    `);
    await bootstrapLocalUser(this.db);
  }

  async importSourceBundle(
    actor: AuthorizationActor,
    project: ItotoriProjectRecord,
  ): Promise<BridgeImportStatus> {
    await requirePermission(this.db, actor, permissionValues.projectImport);
    assertImportableBridgeBundle(project.bridge);
    const normalized = normalizeSourceBundle(project);

    return await this.db.transaction(async (tx) => {
      const importTarget = await resolveSourceBundleImportTarget(tx, project.projectId, normalized);
      await assertImportOwnership(tx, project.projectId, importTarget);
      const diff = await diffSourceBundleImport(tx, importTarget);
      const importedAt = new Date();
      const importStatus = bridgeImportStatusFor(project.projectId, importTarget, diff, importedAt);

      await tx
        .insert(workspaces)
        .values({ workspaceId: defaultWorkspaceId, name: defaultWorkspaceName })
        .onConflictDoNothing();

      await tx
        .insert(projects)
        .values({
          projectId: project.projectId,
          workspaceId: defaultWorkspaceId,
          projectKey: project.projectId,
          name: project.projectId,
          sourceLocale: importTarget.sourceLocale,
          status: projectStatusValues.imported,
          gameId: importTarget.sourceGame.gameId,
          gameVersion: importTarget.sourceGame.gameVersion,
          sourceProfileId: importTarget.sourceGame.sourceProfileId,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: projects.projectId,
          set: {
            sourceLocale: importTarget.sourceLocale,
            status: projectStatusValues.imported,
            gameId: importTarget.sourceGame.gameId,
            gameVersion: importTarget.sourceGame.gameVersion,
            sourceProfileId: importTarget.sourceGame.sourceProfileId,
            updatedAt: sql`now()`,
          },
        });

      for (const revision of importTarget.revisions) {
        await tx
          .insert(sourceRevisions)
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
        .insert(sourceBundles)
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
          target: sourceBundles.sourceBundleId,
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
          .insert(assets)
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
            target: assets.assetId,
            set: {
              sourceRevisionId: asset.sourceRevision.revisionId,
              assetKey: asset.assetKey,
              assetKind: asset.assetKind,
              sourceHash: asset.sourceHash,
              path: asset.path ?? null,
            },
          });
      }

      for (const unit of importTarget.units) {
        await tx
          .insert(sourceUnits)
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
            target: sourceUnits.bridgeUnitId,
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
              updatedAt: sql`now()`,
            },
          });
      }

      if (diff.units.removedIds.length > 0) {
        await tx
          .delete(sourceUnits)
          .where(inArray(sourceUnits.bridgeUnitId, diff.units.removedIds));
      }

      if (diff.assets.removedIds.length > 0) {
        await tx.delete(assets).where(inArray(assets.assetId, diff.assets.removedIds));
      }

      await tx
        .insert(localeBranches)
        .values({
          localeBranchId: project.localeBranchId,
          projectId: project.projectId,
          sourceBundleId: importTarget.sourceBundleId,
          targetLocale: project.targetLocale,
          branchName: project.targetLocale,
          status: localeBranchStatusValues.active,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: localeBranches.localeBranchId,
          set: {
            sourceBundleId: importTarget.sourceBundleId,
            targetLocale: project.targetLocale,
            branchName: project.targetLocale,
            status: localeBranchStatusValues.active,
            updatedAt: sql`now()`,
          },
        });

      for (const unit of importTarget.units) {
        await tx
          .insert(localeBranchUnits)
          .values({
            localeBranchId: project.localeBranchId,
            bridgeUnitId: unit.bridgeUnitId,
            targetText: project.drafts[unit.bridgeUnitId] ?? null,
          })
          .onConflictDoUpdate({
            target: [localeBranchUnits.localeBranchId, localeBranchUnits.bridgeUnitId],
            set: {
              targetText: project.drafts[unit.bridgeUnitId] ?? null,
              updatedAt: sql`now()`,
            },
          });
      }

      await tx
        .insert(bridgeImports)
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
          metadata: bridgeImportMetadata(importTarget),
          importedAt,
        })
        .onConflictDoUpdate({
          target: [bridgeImports.sourceBundleId, bridgeImports.sourceBundleRevisionId],
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
            metadata: bridgeImportMetadata(importTarget),
            importedAt,
          },
        });

      return importStatus;
    });
  }

  async saveDrafts(actor: AuthorizationActor, project: ItotoriProjectRecord): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    await this.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({ status: projectStatusValues.drafted, updatedAt: sql`now()` })
        .where(eq(projects.projectId, project.projectId));

      await tx
        .update(localeBranches)
        .set({
          targetLocale: project.targetLocale,
          branchName: project.targetLocale,
          updatedAt: sql`now()`,
        })
        .where(eq(localeBranches.localeBranchId, project.localeBranchId));

      for (const [bridgeUnitId, targetText] of Object.entries(project.drafts)) {
        await tx
          .insert(localeBranchUnits)
          .values({
            localeBranchId: project.localeBranchId,
            bridgeUnitId,
            targetText,
          })
          .onConflictDoUpdate({
            target: [localeBranchUnits.localeBranchId, localeBranchUnits.bridgeUnitId],
            set: { targetText, updatedAt: sql`now()` },
          });
      }
    });
  }

  async savePatchExport(
    actor: AuthorizationActor,
    project: ItotoriProjectRecord,
    patchExport: PatchExport | PatchExportV02,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.patchExport);
    await this.db.transaction(async (tx) => {
      const { sourceBundleId } = await resolveSourceBundlePersistenceTarget(tx, project);
      await tx
        .insert(artifacts)
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
          target: artifacts.artifactId,
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
        .update(projects)
        .set({ status: projectStatusValues.patchExported, updatedAt: sql`now()` })
        .where(eq(projects.projectId, project.projectId));
    });
  }

  async saveRuntimeReport(
    actor: AuthorizationActor,
    project: ItotoriProjectRecord,
    runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02,
    patchResultId: string,
  ): Promise<ProjectDashboardStatus> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    const runtimeReportId = runtimeReportIdFor(runtimeReport);
    const adapterName = runtimeAdapterName(runtimeReport);
    const adapterVersion = runtimeAdapterVersion(runtimeReport);
    const runtimeStatus = runtimeReportStatus(runtimeReport);
    const finalStatus = runtimeFinalStatus(runtimeStatus);
    const fidelityTier = runtimeFidelityTier(runtimeReport);
    const evidenceTier = runtimeEvidenceTier(runtimeReport);
    const textEventCount = runtimeTextEventCount(runtimeReport);
    const branchEventCount = runtimeBranchEventCount(runtimeReport);
    const frameCaptureCount = runtimeFrameCaptureCount(runtimeReport);
    const screenshotArtifactCount = runtimeScreenshotArtifactCount(runtimeReport);
    const recordingArtifactCount = runtimeRecordingArtifactCount(runtimeReport);
    const validationFindingCount = runtimeValidationFindingCount(runtimeReport);
    const referenceComparisonCount = runtimeReferenceComparisonCount(runtimeReport);
    const reportCreatedAt = runtimeReportCreatedAt(runtimeReport);
    const runtimeReportMetadata = runtimeReportMetadataFor(runtimeReport, {
      adapterName,
      adapterVersion,
      finalStatus,
      runtimeStatus,
      fidelityTier,
      evidenceTier,
      textEventCount,
      branchEventCount,
      frameCaptureCount,
      screenshotArtifactCount,
      recordingArtifactCount,
      validationFindingCount,
      referenceComparisonCount,
    });
    const artifactLinks = runtimeArtifactLinks(runtimeReport);
    const eventArtifacts = runtimeEvidenceEventArtifacts(runtimeReport);
    const evidenceItems = runtimeEvidenceItemsFor(runtimeReport);
    const validationRecords = runtimeValidationFindingRecords(runtimeReport);
    const recordedEventId = `${runtimeReportId}:recorded`;

    await this.db.transaction(async (tx) => {
      const { sourceBundleId, sourceBundleRevisionId } = await resolveSourceBundlePersistenceTarget(
        tx,
        project,
      );
      const retainedRuntimeArtifactIds = runtimeProjectionArtifactIds(
        runtimeReportId,
        patchResultId,
        artifactLinks,
        eventArtifacts,
        validationRecords,
      );

      await tx
        .insert(artifacts)
        .values({
          artifactId: runtimeReportId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceBundleId,
          artifactKind: "runtime_report",
          metadata: runtimeReportMetadata,
        })
        .onConflictDoUpdate({
          target: artifacts.artifactId,
          set: {
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            metadata: runtimeReportMetadata,
          },
        });

      await tx
        .insert(artifacts)
        .values({
          artifactId: patchResultId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceBundleId,
          artifactKind: "patch_result",
          metadata: { status: runtimeStatus, finalStatus, runtimeReportId },
        })
        .onConflictDoUpdate({
          target: artifacts.artifactId,
          set: {
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            metadata: { status: runtimeStatus, finalStatus, runtimeReportId },
          },
        });

      for (const artifactLink of artifactLinks) {
        await tx
          .insert(artifacts)
          .values({
            artifactId: artifactLink.artifactId,
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            bridgeUnitId: artifactLink.bridgeUnitId ?? null,
            artifactKind: artifactLink.artifactKind,
            uri: artifactLink.uri,
            hash: artifactLink.hash ?? null,
            metadata: {
              schemaVersion: runtimeReport.schemaVersion,
              runtimeReportId,
              ...artifactLink.metadata,
            },
          })
          .onConflictDoUpdate({
            target: artifacts.artifactId,
            set: {
              localeBranchId: project.localeBranchId,
              sourceBundleId,
              bridgeUnitId: artifactLink.bridgeUnitId ?? null,
              artifactKind: artifactLink.artifactKind,
              uri: artifactLink.uri,
              hash: artifactLink.hash ?? null,
              metadata: {
                schemaVersion: runtimeReport.schemaVersion,
                runtimeReportId,
                ...artifactLink.metadata,
              },
            },
          });
      }

      for (const eventArtifact of eventArtifacts) {
        await tx
          .insert(artifacts)
          .values({
            artifactId: eventArtifact.artifactId,
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            bridgeUnitId: eventArtifact.bridgeUnitId,
            artifactKind: eventArtifact.artifactKind,
            metadata: eventArtifact.metadata,
          })
          .onConflictDoUpdate({
            target: artifacts.artifactId,
            set: {
              localeBranchId: project.localeBranchId,
              sourceBundleId,
              bridgeUnitId: eventArtifact.bridgeUnitId,
              metadata: eventArtifact.metadata,
            },
          });
      }

      await cleanupRuntimeReportProjection(
        tx,
        runtimeReportId,
        project.projectId,
        retainedRuntimeArtifactIds,
      );

      await tx
        .insert(runtimeEvidenceRuns)
        .values({
          runtimeRunId: runtimeReportId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceBundleId,
          sourceBundleRevisionId,
          runtimeReportArtifactId: runtimeReportId,
          patchResultArtifactId: patchResultId,
          adapterName,
          adapterVersion,
          status: runtimeStatus,
          fidelityTier,
          evidenceTier,
          textEventCount,
          branchEventCount,
          captureCount: frameCaptureCount,
          recordingCount: recordingArtifactCount,
          validationFindingCount,
          referenceComparisonCount,
          reportCreatedAt,
          metadata: runtimeReportMetadata,
        })
        .onConflictDoUpdate({
          target: runtimeEvidenceRuns.runtimeRunId,
          set: {
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            sourceBundleRevisionId,
            runtimeReportArtifactId: runtimeReportId,
            patchResultArtifactId: patchResultId,
            adapterName,
            adapterVersion,
            status: runtimeStatus,
            fidelityTier,
            evidenceTier,
            textEventCount,
            branchEventCount,
            captureCount: frameCaptureCount,
            recordingCount: recordingArtifactCount,
            validationFindingCount,
            referenceComparisonCount,
            reportCreatedAt,
            metadata: runtimeReportMetadata,
            updatedAt: sql`now()`,
          },
        });

      for (const item of evidenceItems) {
        await tx
          .insert(runtimeEvidenceItems)
          .values({
            runtimeEvidenceId: item.runtimeEvidenceId,
            runtimeRunId: runtimeReportId,
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            sourceBundleRevisionId,
            bridgeUnitId: item.bridgeUnitId ?? null,
            artifactId: item.artifactId ?? null,
            evidenceKind: item.evidenceKind,
            evidenceTier: item.evidenceTier ?? null,
            artifactKind: item.artifactKind ?? null,
            portableArtifactUri: item.portableArtifactUri ?? null,
            frame: item.frame ?? null,
            metadata: {
              schemaVersion: runtimeReport.schemaVersion,
              runtimeReportId,
              ...item.metadata,
            },
          })
          .onConflictDoUpdate({
            target: runtimeEvidenceItems.runtimeEvidenceId,
            set: {
              runtimeRunId: runtimeReportId,
              localeBranchId: project.localeBranchId,
              sourceBundleId,
              sourceBundleRevisionId,
              bridgeUnitId: item.bridgeUnitId ?? null,
              artifactId: item.artifactId ?? null,
              evidenceKind: item.evidenceKind,
              evidenceTier: item.evidenceTier ?? null,
              artifactKind: item.artifactKind ?? null,
              portableArtifactUri: item.portableArtifactUri ?? null,
              frame: item.frame ?? null,
              metadata: {
                schemaVersion: runtimeReport.schemaVersion,
                runtimeReportId,
                ...item.metadata,
              },
              updatedAt: sql`now()`,
            },
          });

        await tx
          .delete(runtimeEvidenceBridgeUnitRefs)
          .where(eq(runtimeEvidenceBridgeUnitRefs.runtimeEvidenceId, item.runtimeEvidenceId));

        for (const ref of item.bridgeUnitRefs) {
          await tx.insert(runtimeEvidenceBridgeUnitRefs).values({
            runtimeEvidenceId: item.runtimeEvidenceId,
            bridgeUnitId: ref.bridgeUnitId,
            refRole: ref.refRole,
            sourceUnitKey: ref.sourceUnitKey ?? "",
            metadata: ref.metadata ?? {},
          });
        }
      }

      await tx
        .insert(events)
        .values({
          eventId: recordedEventId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          eventKind: "patch_result_recorded",
          occurredAt: reportCreatedAt,
          actor: { actorKind: "tool", displayName: adapterName },
          subjectRefs: [
            {
              subjectKind: "runtime_report",
              subjectId: runtimeReportId,
              label: runtimeStatus,
            },
          ],
          provenance: [],
          causalLinks: [],
          payload: { patchResultId, finalStatus, status: runtimeStatus, evidenceTier },
        })
        .onConflictDoNothing();

      for (const validation of validationRecords) {
        await tx
          .insert(findings)
          .values({
            findingId: validation.findingId,
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            findingKind: validation.findingKind,
            severity: validation.severity,
            qualityCategory: "runtime_validation",
            title: validation.title,
            description: validation.message,
            impact: validation.impact,
            status: "open",
            createdAt: reportCreatedAt,
            firstSeenEventId: recordedEventId,
            affectedRefs: validation.affectedRefs,
            evidence: validation.evidence,
            provenance: validation.provenance,
            causalLinks: [],
          })
          .onConflictDoUpdate({
            target: findings.findingId,
            set: {
              severity: validation.severity,
              qualityCategory: "runtime_validation",
              title: validation.title,
              description: validation.message,
              impact: validation.impact,
              status: "open",
              firstSeenEventId: recordedEventId,
              affectedRefs: validation.affectedRefs,
              evidence: validation.evidence,
              provenance: validation.provenance,
              causalLinks: [],
              updatedAt: sql`now()`,
            },
          });

        if (validation.artifactRef !== undefined) {
          await tx
            .insert(artifacts)
            .values({
              artifactId: validation.artifactRef.artifactId,
              projectId: project.projectId,
              localeBranchId: project.localeBranchId,
              sourceBundleId,
              bridgeUnitId: validation.bridgeUnitId ?? null,
              findingId: validation.findingId,
              artifactKind: validation.artifactRef.artifactKind,
              uri: validation.artifactRef.uri,
              hash: validation.artifactRef.hash ?? null,
              metadata: {
                schemaVersion: runtimeReport.schemaVersion,
                runtimeReportId,
                validationFindingId: validation.findingId,
                artifactRef: validation.artifactRef,
              },
            })
            .onConflictDoUpdate({
              target: artifacts.artifactId,
              set: {
                localeBranchId: project.localeBranchId,
                sourceBundleId,
                bridgeUnitId: validation.bridgeUnitId ?? null,
                findingId: validation.findingId,
                artifactKind: validation.artifactRef.artifactKind,
                uri: validation.artifactRef.uri,
                hash: validation.artifactRef.hash ?? null,
                metadata: {
                  schemaVersion: runtimeReport.schemaVersion,
                  runtimeReportId,
                  validationFindingId: validation.findingId,
                  artifactRef: validation.artifactRef,
                },
              },
            });
        }

        await tx
          .insert(runtimeValidationFindings)
          .values({
            findingId: validation.findingId,
            runtimeRunId: runtimeReportId,
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            sourceBundleRevisionId,
            bridgeUnitId: validation.bridgeUnitId ?? null,
            artifactId: validation.artifactRef?.artifactId ?? null,
            findingKind: validation.findingKind,
            severity: validation.severity,
            message: validation.message,
            evidenceTier: validation.evidenceTier,
            metadata: validation.metadata,
          })
          .onConflictDoUpdate({
            target: runtimeValidationFindings.findingId,
            set: {
              runtimeRunId: runtimeReportId,
              localeBranchId: project.localeBranchId,
              sourceBundleId,
              sourceBundleRevisionId,
              bridgeUnitId: validation.bridgeUnitId ?? null,
              artifactId: validation.artifactRef?.artifactId ?? null,
              findingKind: validation.findingKind,
              severity: validation.severity,
              message: validation.message,
              evidenceTier: validation.evidenceTier,
              metadata: validation.metadata,
              updatedAt: sql`now()`,
            },
          });
      }

      await tx
        .update(projects)
        .set({ status: projectStatusValues.runtimeIngested, updatedAt: sql`now()` })
        .where(eq(projects.projectId, project.projectId));
    });

    return this.getDashboardStatus();
  }

  async appendEvent(actor: AuthorizationActor, input: EventInput): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    await this.db.insert(events).values({
      eventId: input.event.eventId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId ?? null,
      eventKind: input.event.eventKind,
      occurredAt: new Date(input.event.occurredAt),
      actor: input.event.actor,
      taskId: input.event.taskId ?? null,
      findingId: input.event.findingId ?? null,
      subjectRefs: input.event.subjectRefs,
      provenance: input.event.provenance,
      causalLinks: input.event.causalLinks,
      payload: input.event.payload ?? null,
    });
  }

  async recordFinding(actor: AuthorizationActor, input: FindingInput): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    const finding = input.finding;
    await this.db
      .insert(findings)
      .values({
        findingId: finding.findingId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId ?? null,
        findingKind: finding.findingKind,
        severity: finding.severity,
        qualityCategory: finding.qualityCategory ?? null,
        title: finding.title,
        description: finding.description,
        impact: finding.impact,
        status: input.status ?? "open",
        createdAt: new Date(finding.createdAt),
        reportedByTaskId: finding.reportedByTaskId ?? null,
        firstSeenEventId: finding.firstSeenEventId ?? null,
        affectedRefs: finding.affectedRefs,
        evidence: finding.evidence,
        provenance: finding.provenance,
        causalLinks: finding.causalLinks,
      })
      .onConflictDoUpdate({
        target: findings.findingId,
        set: {
          severity: finding.severity,
          qualityCategory: finding.qualityCategory ?? null,
          title: finding.title,
          description: finding.description,
          impact: finding.impact,
          status: input.status ?? "open",
          affectedRefs: finding.affectedRefs,
          evidence: finding.evidence,
          provenance: finding.provenance,
          causalLinks: finding.causalLinks,
          updatedAt: sql`now()`,
        },
      });
  }

  async linkArtifact(actor: AuthorizationActor, input: ArtifactInput): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    await this.db
      .insert(artifacts)
      .values({
        artifactId: input.artifactId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId ?? null,
        sourceBundleId: input.sourceBundleId ?? null,
        bridgeUnitId: input.bridgeUnitId ?? null,
        findingId: input.findingId ?? null,
        artifactKind: input.artifactKind,
        uri: input.uri ?? null,
        hash: input.hash ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: artifacts.artifactId,
        set: {
          localeBranchId: input.localeBranchId ?? null,
          sourceBundleId: input.sourceBundleId ?? null,
          bridgeUnitId: input.bridgeUnitId ?? null,
          findingId: input.findingId ?? null,
          artifactKind: input.artifactKind,
          uri: input.uri ?? null,
          hash: input.hash ?? null,
          metadata: input.metadata ?? {},
        },
      });
  }

  async getDashboardStatus(): Promise<ProjectDashboardStatus> {
    const result = await this.db.execute(sql`
      with latest_project as (
        select project_id
        from ${projects}
        order by updated_at desc
        limit 1
      ),
      latest_import_bundle as (
        select
          sb.source_bundle_id,
          sb.bridge_id,
          sb.project_id,
          sb.schema_version,
          sb.source_bundle_hash,
          sb.source_bundle_revision_id,
          sb.source_locale,
          sb.unit_count,
          sb.asset_count,
          sb.imported_at,
          li.bridge_import_id,
          li.source_bundle_id as import_source_bundle_id,
          li.source_bundle_hash as import_source_bundle_hash,
          li.source_bundle_revision_id as import_source_bundle_revision_id,
          li.bridge_id as import_bridge_id,
          li.schema_version as import_schema_version,
          li.source_locale as import_source_locale,
          li.imported_at as import_imported_at,
          li.unit_count as import_unit_count,
          li.asset_count as import_asset_count,
          li.source_revision_count as import_source_revision_count,
          li.validation_failure_count as import_validation_failure_count,
          li.added_unit_count as import_added_unit_count,
          li.updated_unit_count as import_updated_unit_count,
          li.removed_unit_count as import_removed_unit_count,
          li.unchanged_unit_count as import_unchanged_unit_count,
          li.added_asset_count as import_added_asset_count,
          li.updated_asset_count as import_updated_asset_count,
          li.removed_asset_count as import_removed_asset_count,
          li.unchanged_asset_count as import_unchanged_asset_count,
          li.added_source_revision_count as import_added_source_revision_count,
          li.existing_source_revision_count as import_existing_source_revision_count,
          li.catalog_work_id as import_catalog_work_id,
          li.local_corpus_entry_id as import_local_corpus_entry_id,
          li.readiness_profile_id as import_readiness_profile_id,
          li.completeness_status_id as import_completeness_status_id
        from ${bridgeImports} li
        join ${sourceBundles} sb
          on sb.source_bundle_id = li.source_bundle_id
          and sb.source_bundle_revision_id = li.source_bundle_revision_id
        where li.project_id in (select project_id from latest_project)
        order by li.imported_at desc
        limit 1
      ),
      latest_bundle as (
        select
          source_bundle_id,
          bridge_id,
          project_id,
          schema_version,
          source_bundle_hash,
          source_bundle_revision_id,
          source_locale,
          unit_count,
          asset_count,
          imported_at
        from ${sourceBundles}
        where project_id in (select project_id from latest_project)
          and not exists (select 1 from latest_import_bundle)
        order by imported_at desc
        limit 1
      ),
      selected_bundle as (
        select *
        from latest_import_bundle
        union all
        select
          lb.source_bundle_id,
          lb.bridge_id,
          lb.project_id,
          lb.schema_version,
          lb.source_bundle_hash,
          lb.source_bundle_revision_id,
          lb.source_locale,
          lb.unit_count,
          lb.asset_count,
          lb.imported_at,
          null as bridge_import_id,
          null as import_source_bundle_id,
          null as import_source_bundle_hash,
          null as import_source_bundle_revision_id,
          null as import_bridge_id,
          null as import_schema_version,
          null as import_source_locale,
          null as import_imported_at,
          null as import_unit_count,
          null as import_asset_count,
          null as import_source_revision_count,
          null as import_validation_failure_count,
          null as import_added_unit_count,
          null as import_updated_unit_count,
          null as import_removed_unit_count,
          null as import_unchanged_unit_count,
          null as import_added_asset_count,
          null as import_updated_asset_count,
          null as import_removed_asset_count,
          null as import_unchanged_asset_count,
          null as import_added_source_revision_count,
          null as import_existing_source_revision_count,
          null as import_catalog_work_id,
          null as import_local_corpus_entry_id,
          null as import_readiness_profile_id,
          null as import_completeness_status_id
        from latest_bundle lb
      )
      select
        p.project_id,
        p.project_key,
        p.name,
        p.status,
        p.source_locale,
        sb.source_bundle_id,
        sb.source_bundle_hash,
        sb.source_bundle_revision_id,
        coalesce(
          sb.bridge_import_id,
          'bridge-import:' || p.project_id || ':' || sb.source_bundle_id || ':' || sb.source_bundle_revision_id
        ) as bridge_import_id,
        coalesce(sb.import_source_bundle_id, sb.source_bundle_id) as import_source_bundle_id,
        coalesce(sb.import_source_bundle_hash, sb.source_bundle_hash) as import_source_bundle_hash,
        coalesce(sb.import_source_bundle_revision_id, sb.source_bundle_revision_id)
          as import_source_bundle_revision_id,
        coalesce(sb.import_bridge_id, sb.bridge_id) as bridge_id,
        coalesce(sb.import_schema_version, sb.schema_version) as import_schema_version,
        coalesce(sb.import_source_locale, sb.source_locale) as import_source_locale,
        coalesce(sb.import_imported_at, sb.imported_at) as imported_at,
        coalesce(sb.import_unit_count, sb.unit_count)::int as import_unit_count,
        coalesce(sb.import_asset_count, sb.asset_count)::int as import_asset_count,
        coalesce(sb.import_source_revision_count, 0)::int as import_source_revision_count,
        coalesce(sb.import_validation_failure_count, 0)::int as import_validation_failure_count,
        coalesce(sb.import_added_unit_count, 0)::int as import_added_unit_count,
        coalesce(sb.import_updated_unit_count, 0)::int as import_updated_unit_count,
        coalesce(sb.import_removed_unit_count, 0)::int as import_removed_unit_count,
        coalesce(sb.import_unchanged_unit_count, sb.unit_count)::int as import_unchanged_unit_count,
        coalesce(sb.import_added_asset_count, 0)::int as import_added_asset_count,
        coalesce(sb.import_updated_asset_count, 0)::int as import_updated_asset_count,
        coalesce(sb.import_removed_asset_count, 0)::int as import_removed_asset_count,
        coalesce(sb.import_unchanged_asset_count, sb.asset_count)::int as import_unchanged_asset_count,
        coalesce(sb.import_added_source_revision_count, 0)::int as import_added_source_revision_count,
        coalesce(sb.import_existing_source_revision_count, 0)::int as import_existing_source_revision_count,
        sb.import_catalog_work_id,
        sb.import_local_corpus_entry_id,
        sb.import_readiness_profile_id,
        sb.import_completeness_status_id,
        b.locale_branch_id,
        b.target_locale,
        b.status as branch_status,
        count(distinct su.bridge_unit_id)::int as unit_count,
        count(distinct lbu.bridge_unit_id) filter (where lbu.target_text is not null)::int as translated_unit_count,
        totals.finding_count::int as finding_count,
        count(distinct f_branch.finding_id) filter (
          where f_branch.status = 'open'
            and rvf_branch.finding_id is null
        )::int as open_finding_count,
        totals.artifact_count::int as artifact_count,
        count(distinct a_branch.artifact_id)::int as branch_artifact_count,
        latest_event.event_kind as latest_event_kind,
        latest_event.occurred_at as latest_event_at
      from ${projects} p
      join latest_project lp on lp.project_id = p.project_id
      join selected_bundle sb on sb.project_id = p.project_id
      left join ${localeBranches} b on b.project_id = p.project_id
      left join ${sourceUnits} su on su.source_bundle_id = sb.source_bundle_id
      left join ${localeBranchUnits} lbu
        on lbu.locale_branch_id = b.locale_branch_id
        and lbu.bridge_unit_id = su.bridge_unit_id
      left join itotori_findings f_branch
        on f_branch.project_id = p.project_id
        and f_branch.locale_branch_id = b.locale_branch_id
      left join ${runtimeValidationFindings} rvf_branch
        on rvf_branch.finding_id = f_branch.finding_id
      left join itotori_artifacts a_branch
        on a_branch.project_id = p.project_id
        and a_branch.locale_branch_id = b.locale_branch_id
      left join lateral (
        select
          count(distinct f.finding_id) as finding_count,
          count(distinct a.artifact_id) as artifact_count
        from itotori_projects p_total
        left join itotori_findings f on f.project_id = p_total.project_id
        left join itotori_artifacts a on a.project_id = p_total.project_id
        where p_total.project_id = p.project_id
      ) totals on true
      left join lateral (
        select event_kind, occurred_at
        from ${events} e
        where e.project_id = p.project_id
        order by occurred_at desc
        limit 1
      ) latest_event on true
      group by
        p.project_id,
        p.project_key,
        p.name,
        p.status,
        p.source_locale,
        sb.source_bundle_id,
        sb.bridge_id,
        sb.schema_version,
        sb.source_bundle_hash,
        sb.source_bundle_revision_id,
        sb.source_locale,
        sb.unit_count,
        sb.asset_count,
        sb.imported_at,
        sb.bridge_import_id,
        sb.import_source_bundle_id,
        sb.import_source_bundle_hash,
        sb.import_source_bundle_revision_id,
        sb.import_bridge_id,
        sb.import_schema_version,
        sb.import_source_locale,
        sb.import_imported_at,
        sb.import_unit_count,
        sb.import_asset_count,
        sb.import_source_revision_count,
        sb.import_validation_failure_count,
        sb.import_added_unit_count,
        sb.import_updated_unit_count,
        sb.import_removed_unit_count,
        sb.import_unchanged_unit_count,
        sb.import_added_asset_count,
        sb.import_updated_asset_count,
        sb.import_removed_asset_count,
        sb.import_unchanged_asset_count,
        sb.import_added_source_revision_count,
        sb.import_existing_source_revision_count,
        sb.import_catalog_work_id,
        sb.import_local_corpus_entry_id,
        sb.import_readiness_profile_id,
        sb.import_completeness_status_id,
        b.locale_branch_id,
        b.target_locale,
        b.status,
        totals.finding_count,
        totals.artifact_count,
        latest_event.event_kind,
        latest_event.occurred_at
      order by b.created_at asc nulls last
    `);

    const rows = result.rows as Array<Record<string, unknown>>;
    const first = rows[0];
    if (!first) {
      throw new Error("no Itotori project state found");
    }

    const branches = rows
      .filter((row) => row.locale_branch_id !== null)
      .map(
        (row): LocaleBranchStatus => ({
          localeBranchId: String(row.locale_branch_id),
          targetLocale: String(row.target_locale),
          status: String(row.branch_status),
          unitCount: Number(row.unit_count),
          translatedUnitCount: Number(row.translated_unit_count),
          openFindingCount: Number(row.open_finding_count),
          artifactCount: Number(row.branch_artifact_count),
        }),
      );

    const projectId = String(first.project_id);
    const cost = await new ItotoriModelLedgerRepository(this.db).getProjectCostReport(projectId);

    return {
      projectId,
      projectKey: String(first.project_key),
      name: String(first.name),
      status: String(first.status),
      sourceLocale: String(first.source_locale),
      sourceBundleId: String(first.source_bundle_id),
      sourceBundleHash: String(first.source_bundle_hash),
      sourceBundleRevisionId: String(first.source_bundle_revision_id),
      branchCount: branches.length,
      unitCount: Number(first.unit_count),
      findingCount: Number(first.finding_count),
      artifactCount: Number(first.artifact_count),
      latestEventKind: nullableString(first.latest_event_kind),
      latestEventAt:
        first.latest_event_at instanceof Date ? first.latest_event_at.toISOString() : null,
      importStatus: bridgeImportStatusFromRow(first),
      cost,
      localeBranches: branches,
    };
  }

  async getDashboardDecisions(projectId?: string): Promise<DashboardDecisionReadModel> {
    const selectedProjectId = await this.resolveDashboardProjectId(projectId);
    const result = await this.db.execute(sql`
      select
        f.finding_id,
        f.project_id,
        f.locale_branch_id,
        f.finding_kind,
        f.severity,
        f.quality_category,
        f.title,
        f.created_at,
        b.target_locale,
        b.status as branch_status,
        rvf.runtime_run_id,
        rr.status as runtime_status,
        case
          when rvf.finding_id is not null then 'runtime_validation'
          when f.locale_branch_id is null then 'project_finding'
          else 'locale_branch_finding'
        end as decision_kind
      from ${findings} f
      left join ${localeBranches} b on b.locale_branch_id = f.locale_branch_id
      left join ${runtimeValidationFindings} rvf on rvf.finding_id = f.finding_id
      left join ${runtimeEvidenceRuns} rr on rr.runtime_run_id = rvf.runtime_run_id
      where f.project_id = ${selectedProjectId}
        and f.status = 'open'
      order by f.created_at asc, f.finding_id asc
    `);

    const pendingDecisions = (result.rows as Array<Record<string, unknown>>).map(
      dashboardPendingDecisionFromRow,
    );

    return {
      projectId: selectedProjectId,
      counts: dashboardDecisionCounts(pendingDecisions),
      pendingDecisions,
    };
  }

  private async resolveDashboardProjectId(projectId?: string): Promise<string> {
    const rows =
      projectId === undefined
        ? await this.db
            .select({ projectId: projects.projectId })
            .from(projects)
            .orderBy(sql`${projects.updatedAt} desc`)
            .limit(1)
        : await this.db
            .select({ projectId: projects.projectId })
            .from(projects)
            .where(eq(projects.projectId, projectId))
            .limit(1);
    const project = rows[0];
    if (project === undefined) {
      throw new Error("no Itotori project state found");
    }
    return project.projectId;
  }

  async getRuntimeStatus(): Promise<RuntimeDashboardStatus> {
    const result = await this.db.execute(sql`
      with latest_project as (
        select project_id
        from ${projects}
        order by updated_at desc
        limit 1
      ),
      latest_runtime_run as (
        select
          runtime_run_id,
          status,
          fidelity_tier,
          evidence_tier,
          text_event_count,
          capture_count,
          recording_count,
          validation_finding_count,
          metadata,
          report_created_at,
          created_at
        from ${runtimeEvidenceRuns}
        where project_id in (select project_id from latest_project)
        order by report_created_at desc, created_at desc
        limit 1
      ),
      latest_runtime_report as (
        select
          artifact_id,
          metadata,
          created_at
        from ${artifacts}
        where project_id in (select project_id from latest_project)
          and artifact_kind = 'runtime_report'
        order by created_at desc
        limit 1
      ),
      latest_patch_result as (
        select
          artifact_id,
          metadata,
          created_at
        from ${artifacts}
        where project_id in (select project_id from latest_project)
          and artifact_kind = 'patch_result'
        order by created_at desc
        limit 1
      )
      select
        coalesce(
          latest_runtime_run.metadata->>'finalStatus',
          latest_patch_result.metadata->>'finalStatus',
          case
            when latest_patch_result.metadata->>'status' in (
              'hello_world_passed',
              'hello_world_failed'
            )
              then latest_patch_result.metadata->>'status'
            when latest_runtime_run.status = 'passed'
              then 'hello_world_passed'
            when latest_runtime_run.status = 'failed'
              then 'hello_world_failed'
            when latest_runtime_report.metadata->>'status' = 'passed'
              then 'hello_world_passed'
            when latest_runtime_report.metadata->>'status' = 'failed'
              then 'hello_world_failed'
            else latest_patch_result.metadata->>'status'
          end
        ) as final_status,
        coalesce(latest_runtime_run.runtime_run_id, latest_runtime_report.artifact_id)
          as runtime_report_id,
        coalesce(latest_runtime_run.status, latest_runtime_report.metadata->>'status')
          as runtime_status,
        coalesce(latest_runtime_run.fidelity_tier, latest_runtime_report.metadata->>'fidelityTier')
          as fidelity_tier,
        coalesce(latest_runtime_run.evidence_tier, latest_runtime_report.metadata->>'evidenceTier')
          as evidence_tier,
        coalesce(latest_runtime_run.text_event_count::text, latest_runtime_report.metadata->>'textEventCount')
          as text_event_count,
        coalesce(latest_runtime_run.capture_count::text, latest_runtime_report.metadata->>'frameCaptureCount')
          as frame_capture_count,
        coalesce(latest_runtime_run.capture_count::text, latest_runtime_report.metadata->>'screenshotArtifactCount')
          as screenshot_artifact_count,
        coalesce(latest_runtime_run.recording_count::text, latest_runtime_report.metadata->>'recordingArtifactCount')
          as recording_artifact_count,
        coalesce(latest_runtime_run.validation_finding_count::text, latest_runtime_report.metadata->>'validationFindingCount')
          as validation_finding_count
      from latest_project
      left join latest_runtime_run on true
      left join latest_runtime_report on true
      left join latest_patch_result on true
    `);

    const first = result.rows[0] as Record<string, unknown> | undefined;
    if (!first) {
      throw new Error("no Itotori runtime status found");
    }

    return {
      finalStatus: String(first.final_status ?? "missing"),
      runtimeReportId: nullableString(first.runtime_report_id),
      runtimeStatus: nullableString(first.runtime_status),
      fidelityTier: nullableString(first.fidelity_tier),
      evidenceTier: nullableString(first.evidence_tier),
      textEventCount: Number(first.text_event_count ?? 0),
      frameCaptureCount: Number(first.frame_capture_count ?? 0),
      screenshotArtifactCount: Number(first.screenshot_artifact_count ?? 0),
      recordingArtifactCount: Number(first.recording_artifact_count ?? 0),
      validationFindingCount: Number(first.validation_finding_count ?? 0),
    };
  }
}

type ItotoriTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];
type ExistingSourceRevision = typeof sourceRevisions.$inferSelect;
type ExistingAsset = typeof assets.$inferSelect;
type ExistingSourceUnit = typeof sourceUnits.$inferSelect;

type IndexedImportDiff = BridgeImportDiffCounts & {
  removedIds: string[];
};

type SourceBundleImportDiff = {
  sourceRevisions: BridgeImportRevisionDiffCounts;
  assets: IndexedImportDiff;
  units: IndexedImportDiff;
};

type NormalizedSourceBundle = {
  sourceBundleId: string;
  bridgeId: string;
  schemaVersion: string;
  sourceBundleHash: string;
  sourceBundleRevision: SourceRevisionV02;
  sourceLocale: string;
  sourceGame: {
    gameId: string | null;
    gameVersion: string | null;
    sourceProfileId: string | null;
  };
  extractor: { name: string; version: string };
  revisions: SourceRevisionV02[];
  assets: BridgeAssetV02[];
  units: LocalizationUnitV02[];
};

async function resolveSourceBundleImportTarget(
  tx: ItotoriTransaction,
  projectId: string,
  normalized: NormalizedSourceBundle,
): Promise<NormalizedSourceBundle> {
  const [sourceBundleMatch] = await tx
    .select({
      sourceBundleId: sourceBundles.sourceBundleId,
      projectId: sourceBundles.projectId,
      bridgeId: sourceBundles.bridgeId,
    })
    .from(sourceBundles)
    .where(eq(sourceBundles.sourceBundleId, normalized.sourceBundleId))
    .limit(1);

  if (sourceBundleMatch !== undefined) {
    if (sourceBundleMatch.projectId !== projectId) {
      throw new Error(
        `source bundle ${normalized.sourceBundleId} already belongs to project ${sourceBundleMatch.projectId}`,
      );
    }
    if (sourceBundleMatch.bridgeId !== normalized.bridgeId) {
      throw new Error(
        `source bundle ${normalized.sourceBundleId} already belongs to bridge ${sourceBundleMatch.bridgeId}`,
      );
    }
  }

  const [bridgeMatch] = await tx
    .select({
      sourceBundleId: sourceBundles.sourceBundleId,
      projectId: sourceBundles.projectId,
      bridgeId: sourceBundles.bridgeId,
    })
    .from(sourceBundles)
    .where(eq(sourceBundles.bridgeId, normalized.bridgeId))
    .limit(1);

  if (bridgeMatch === undefined) {
    return normalized;
  }
  if (bridgeMatch.projectId !== projectId) {
    throw new Error(
      `bridge ${normalized.bridgeId} already belongs to project ${bridgeMatch.projectId}`,
    );
  }
  if (
    sourceBundleMatch !== undefined &&
    sourceBundleMatch.sourceBundleId !== bridgeMatch.sourceBundleId
  ) {
    throw new Error(
      `bridge ${normalized.bridgeId} is already linked to source bundle ${bridgeMatch.sourceBundleId}`,
    );
  }
  if (bridgeMatch.sourceBundleId === normalized.sourceBundleId) {
    return normalized;
  }
  return { ...normalized, sourceBundleId: bridgeMatch.sourceBundleId };
}

async function assertImportOwnership(
  tx: ItotoriTransaction,
  projectId: string,
  normalized: NormalizedSourceBundle,
): Promise<void> {
  assertUniqueNormalizedUnitIds(normalized.units);
  await assertStableSourceUnitKeys(tx, normalized);

  const revisionIds = normalized.revisions.map((revisionRecord) => revisionRecord.revisionId);
  if (revisionIds.length > 0) {
    const revisionRows = await tx
      .select({
        sourceRevisionId: sourceRevisions.sourceRevisionId,
        projectId: sourceRevisions.projectId,
      })
      .from(sourceRevisions)
      .where(inArray(sourceRevisions.sourceRevisionId, revisionIds));
    for (const row of revisionRows) {
      if (row.projectId !== projectId) {
        throw new Error(
          `source revision ${row.sourceRevisionId} already belongs to project ${row.projectId}`,
        );
      }
    }
  }

  const assetIds = normalized.assets.map((asset) => asset.assetId);
  if (assetIds.length > 0) {
    const assetRows = await tx
      .select({
        assetId: assets.assetId,
        projectId: assets.projectId,
        sourceBundleId: assets.sourceBundleId,
      })
      .from(assets)
      .where(inArray(assets.assetId, assetIds));
    for (const row of assetRows) {
      if (row.projectId !== projectId || row.sourceBundleId !== normalized.sourceBundleId) {
        throw new Error(
          `asset ${row.assetId} already belongs to project ${row.projectId} source bundle ${row.sourceBundleId}`,
        );
      }
    }
  }

  const bridgeUnitIds = normalized.units.map((unit) => unit.bridgeUnitId);
  if (bridgeUnitIds.length > 0) {
    const unitRows = await tx
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        projectId: sourceUnits.projectId,
        sourceBundleId: sourceUnits.sourceBundleId,
      })
      .from(sourceUnits)
      .where(inArray(sourceUnits.bridgeUnitId, bridgeUnitIds));
    for (const row of unitRows) {
      if (row.projectId !== projectId || row.sourceBundleId !== normalized.sourceBundleId) {
        throw new Error(
          `bridge unit ${row.bridgeUnitId} already belongs to project ${row.projectId} source bundle ${row.sourceBundleId}`,
        );
      }
    }
  }
}

function assertUniqueNormalizedUnitIds(units: LocalizationUnitV02[]): void {
  const bridgeUnitIds = new Set<string>();
  const sourceUnitKeys = new Set<string>();
  for (const unit of units) {
    if (bridgeUnitIds.has(unit.bridgeUnitId)) {
      throw new Error(`bridgeUnitId ${unit.bridgeUnitId} must be unique within the import`);
    }
    bridgeUnitIds.add(unit.bridgeUnitId);
    if (sourceUnitKeys.has(unit.sourceUnitKey)) {
      throw new Error(`sourceUnitKey ${unit.sourceUnitKey} must be unique within the import`);
    }
    sourceUnitKeys.add(unit.sourceUnitKey);
  }
}

async function assertStableSourceUnitKeys(
  tx: ItotoriTransaction,
  normalized: NormalizedSourceBundle,
): Promise<void> {
  const incomingBySourceUnitKey = new Map(
    normalized.units.map((unit) => [unit.sourceUnitKey, unit]),
  );
  const sourceUnitKeys = [...incomingBySourceUnitKey.keys()];
  if (sourceUnitKeys.length === 0) {
    return;
  }

  const unitRows = await tx
    .select({
      bridgeUnitId: sourceUnits.bridgeUnitId,
      sourceUnitKey: sourceUnits.sourceUnitKey,
    })
    .from(sourceUnits)
    .where(
      and(
        eq(sourceUnits.sourceBundleId, normalized.sourceBundleId),
        inArray(sourceUnits.sourceUnitKey, sourceUnitKeys),
      ),
    );

  for (const row of unitRows) {
    const incoming = incomingBySourceUnitKey.get(row.sourceUnitKey);
    if (incoming !== undefined && incoming.bridgeUnitId !== row.bridgeUnitId) {
      throw new Error(
        `sourceUnitKey ${row.sourceUnitKey} is already linked to bridgeUnitId ${row.bridgeUnitId}; reimport cannot change it to ${incoming.bridgeUnitId}`,
      );
    }
  }
}

async function resolveSourceBundlePersistenceTarget(
  tx: ItotoriTransaction,
  project: ItotoriProjectRecord,
): Promise<{ sourceBundleId: string; sourceBundleRevisionId: string }> {
  if (project.importStatus !== undefined) {
    const [sourceBundle] = await tx
      .select({
        sourceBundleId: sourceBundles.sourceBundleId,
        projectId: sourceBundles.projectId,
        bridgeId: sourceBundles.bridgeId,
      })
      .from(sourceBundles)
      .where(eq(sourceBundles.sourceBundleId, project.importStatus.sourceBundleId))
      .limit(1);
    if (sourceBundle === undefined) {
      throw new Error(
        `source bundle ${project.importStatus.sourceBundleId} has not been imported for project ${project.projectId}`,
      );
    }
    if (sourceBundle.projectId !== project.projectId) {
      throw new Error(
        `source bundle ${sourceBundle.sourceBundleId} belongs to project ${sourceBundle.projectId}`,
      );
    }
    if (sourceBundle.bridgeId !== project.importStatus.bridgeId) {
      throw new Error(
        `source bundle ${sourceBundle.sourceBundleId} belongs to bridge ${sourceBundle.bridgeId}`,
      );
    }
    return {
      sourceBundleId: project.importStatus.sourceBundleId,
      sourceBundleRevisionId: project.importStatus.sourceBundleRevisionId,
    };
  }

  const [sourceBundle] = await tx
    .select({
      sourceBundleId: sourceBundles.sourceBundleId,
      sourceBundleRevisionId: sourceBundles.sourceBundleRevisionId,
    })
    .from(sourceBundles)
    .where(
      and(
        eq(sourceBundles.projectId, project.projectId),
        eq(sourceBundles.bridgeId, sourceBundleIdFor(project.bridge)),
      ),
    )
    .limit(1);
  if (sourceBundle === undefined) {
    throw new Error(
      `bridge ${project.bridge.bridgeId} has no imported source bundle for project ${project.projectId}`,
    );
  }
  return sourceBundle;
}

async function diffSourceBundleImport(
  tx: ItotoriTransaction,
  normalized: NormalizedSourceBundle,
): Promise<SourceBundleImportDiff> {
  const revisionRows = await tx
    .select()
    .from(sourceRevisions)
    .where(
      inArray(
        sourceRevisions.sourceRevisionId,
        normalized.revisions.map((revisionRecord) => revisionRecord.revisionId),
      ),
    );
  const existingRevisions = new Map(
    revisionRows.map((revisionRecord) => [revisionRecord.sourceRevisionId, revisionRecord]),
  );
  const sourceRevisionsDiff = diffSourceRevisions(normalized.revisions, existingRevisions);

  const assetRows = await tx
    .select()
    .from(assets)
    .where(eq(assets.sourceBundleId, normalized.sourceBundleId));
  const unitRows = await tx
    .select()
    .from(sourceUnits)
    .where(eq(sourceUnits.sourceBundleId, normalized.sourceBundleId));

  return {
    sourceRevisions: sourceRevisionsDiff,
    assets: diffAssets(normalized.assets, assetRows),
    units: diffUnits(normalized.units, unitRows),
  };
}

function diffSourceRevisions(
  revisions: SourceRevisionV02[],
  existingRevisions: ReadonlyMap<string, ExistingSourceRevision>,
): BridgeImportRevisionDiffCounts {
  let added = 0;
  let existing = 0;
  for (const revisionRecord of revisions) {
    const existingRevision = existingRevisions.get(revisionRecord.revisionId);
    if (existingRevision === undefined) {
      added += 1;
      continue;
    }
    if (
      existingRevision.revisionKind !== revisionRecord.revisionKind ||
      existingRevision.value !== revisionRecord.value
    ) {
      throw new Error(
        `source revision ${revisionRecord.revisionId} already exists with different content`,
      );
    }
    existing += 1;
  }
  return { added, existing };
}

function diffAssets(incomingAssets: BridgeAssetV02[], existingAssets: ExistingAsset[]) {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const incomingIds = new Set(incomingAssets.map((asset) => asset.assetId));
  const existingById = new Map(existingAssets.map((asset) => [asset.assetId, asset]));

  for (const asset of incomingAssets) {
    const existingAsset = existingById.get(asset.assetId);
    if (existingAsset === undefined) {
      added += 1;
    } else if (assetMatchesExisting(asset, existingAsset)) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }

  const removedIds = existingAssets
    .filter((asset) => !incomingIds.has(asset.assetId))
    .map((asset) => asset.assetId);
  return { added, updated, removed: removedIds.length, unchanged, removedIds };
}

function diffUnits(incomingUnits: LocalizationUnitV02[], existingUnits: ExistingSourceUnit[]) {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const incomingIds = new Set(incomingUnits.map((unit) => unit.bridgeUnitId));
  const existingById = new Map(existingUnits.map((unit) => [unit.bridgeUnitId, unit]));

  for (const unit of incomingUnits) {
    const existingUnit = existingById.get(unit.bridgeUnitId);
    if (existingUnit === undefined) {
      added += 1;
    } else if (unitMatchesExisting(unit, existingUnit)) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }

  const removedIds = existingUnits
    .filter((unit) => !incomingIds.has(unit.bridgeUnitId))
    .map((unit) => unit.bridgeUnitId);
  return { added, updated, removed: removedIds.length, unchanged, removedIds };
}

function assetMatchesExisting(asset: BridgeAssetV02, existingAsset: ExistingAsset): boolean {
  return (
    existingAsset.sourceRevisionId === asset.sourceRevision.revisionId &&
    existingAsset.assetKey === asset.assetKey &&
    existingAsset.assetKind === asset.assetKind &&
    existingAsset.sourceHash === asset.sourceHash &&
    existingAsset.path === (asset.path ?? null)
  );
}

function unitMatchesExisting(unit: LocalizationUnitV02, existingUnit: ExistingSourceUnit): boolean {
  return (
    existingUnit.sourceAssetId === unit.sourceAssetRef.assetId &&
    existingUnit.sourceRevisionId === unit.sourceRevision.revisionId &&
    existingUnit.surfaceId === unit.surfaceId &&
    existingUnit.surfaceKind === unit.surfaceKind &&
    existingUnit.sourceUnitKey === unit.sourceUnitKey &&
    existingUnit.occurrenceId === unit.occurrenceId &&
    existingUnit.sourceLocale === unit.sourceLocale &&
    existingUnit.sourceText === unit.sourceText &&
    existingUnit.sourceHash === unit.sourceHash &&
    jsonEquals(existingUnit.sourceLocation, unit.sourceLocation) &&
    jsonEquals(existingUnit.speaker, unit.speaker ?? null) &&
    jsonEquals(existingUnit.context, unit.context) &&
    jsonEquals(existingUnit.policy, unit.policy ?? null) &&
    jsonEquals(existingUnit.spans, unit.spans) &&
    jsonEquals(existingUnit.patchRef, unit.patchRef) &&
    jsonEquals(existingUnit.runtimeExpectation, unit.runtimeExpectation)
  );
}

function bridgeImportStatusFor(
  projectId: string,
  normalized: NormalizedSourceBundle,
  diff: SourceBundleImportDiff,
  importedAt: Date,
): BridgeImportStatus {
  return {
    bridgeImportId: bridgeImportIdFor(projectId, normalized),
    projectId,
    bridgeId: normalized.bridgeId,
    sourceBundleId: normalized.sourceBundleId,
    sourceBundleHash: normalized.sourceBundleHash,
    sourceBundleRevisionId: normalized.sourceBundleRevision.revisionId,
    schemaVersion: normalized.schemaVersion,
    sourceLocale: normalized.sourceLocale,
    importedAt: importedAt.toISOString(),
    unitCount: normalized.units.length,
    assetCount: normalized.assets.length,
    sourceRevisionCount: normalized.revisions.length,
    validationFailureCount: 0,
    units: countsOnly(diff.units),
    assets: countsOnly(diff.assets),
    sourceRevisions: diff.sourceRevisions,
    futureReferences: emptyFutureReferences(),
  };
}

function bridgeImportStatusFromRow(row: Record<string, unknown>): BridgeImportStatus {
  return {
    bridgeImportId: String(row.bridge_import_id),
    projectId: String(row.project_id),
    bridgeId: String(row.bridge_id),
    sourceBundleId: String(row.import_source_bundle_id),
    sourceBundleHash: String(row.import_source_bundle_hash),
    sourceBundleRevisionId: String(row.import_source_bundle_revision_id),
    schemaVersion: String(row.import_schema_version),
    sourceLocale: String(row.import_source_locale),
    importedAt: timestampString(row.imported_at),
    unitCount: Number(row.import_unit_count),
    assetCount: Number(row.import_asset_count),
    sourceRevisionCount: Number(row.import_source_revision_count),
    validationFailureCount: Number(row.import_validation_failure_count),
    units: {
      added: Number(row.import_added_unit_count),
      updated: Number(row.import_updated_unit_count),
      removed: Number(row.import_removed_unit_count),
      unchanged: Number(row.import_unchanged_unit_count),
    },
    assets: {
      added: Number(row.import_added_asset_count),
      updated: Number(row.import_updated_asset_count),
      removed: Number(row.import_removed_asset_count),
      unchanged: Number(row.import_unchanged_asset_count),
    },
    sourceRevisions: {
      added: Number(row.import_added_source_revision_count),
      existing: Number(row.import_existing_source_revision_count),
    },
    futureReferences: {
      catalogWorkId: nullableString(row.import_catalog_work_id),
      localCorpusEntryId: nullableString(row.import_local_corpus_entry_id),
      readinessProfileId: nullableString(row.import_readiness_profile_id),
      completenessStatusId: nullableString(row.import_completeness_status_id),
    },
  };
}

function bridgeImportIdFor(projectId: string, normalized: NormalizedSourceBundle): string {
  return [
    "bridge-import",
    projectId,
    normalized.sourceBundleId,
    normalized.sourceBundleRevision.revisionId,
  ].join(":");
}

function bridgeImportMetadata(normalized: NormalizedSourceBundle): Record<string, unknown> {
  return {
    importKind: "validated_bridge_import_foundation",
    sourceGame: normalized.sourceGame,
    extractor: normalized.extractor,
    futureReferenceFields: [
      "catalogWorkId",
      "localCorpusEntryId",
      "readinessProfileId",
      "completenessStatusId",
    ],
  };
}

function countsOnly(diff: IndexedImportDiff): BridgeImportDiffCounts {
  return {
    added: diff.added,
    updated: diff.updated,
    removed: diff.removed,
    unchanged: diff.unchanged,
  };
}

function emptyFutureReferences(): BridgeImportFutureReferences {
  return {
    catalogWorkId: null,
    localCorpusEntryId: null,
    readinessProfileId: null,
    completenessStatusId: null,
  };
}

function timestampString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return "";
}

function dashboardPendingDecisionFromRow(row: Record<string, unknown>): DashboardPendingDecision {
  const decisionKind = dashboardDecisionKind(row.decision_kind);
  const findingId = String(row.finding_id);
  return {
    decisionId: `${decisionKind}:${findingId}`,
    decisionKind,
    projectId: String(row.project_id),
    findingId,
    findingKind: String(row.finding_kind),
    severity: String(row.severity),
    qualityCategory: nullableString(row.quality_category),
    title: String(row.title),
    localeBranchId: nullableString(row.locale_branch_id),
    targetLocale: nullableString(row.target_locale),
    branchStatus: nullableString(row.branch_status),
    runtimeRunId: nullableString(row.runtime_run_id),
    runtimeStatus: nullableString(row.runtime_status),
    createdAt: timestampString(row.created_at),
  };
}

function dashboardDecisionKind(value: unknown): DashboardPendingDecisionKind {
  if (
    value === "project_finding" ||
    value === "locale_branch_finding" ||
    value === "runtime_validation"
  ) {
    return value;
  }
  throw new Error(`unknown dashboard decision kind: ${String(value)}`);
}

function dashboardDecisionCounts(
  pendingDecisions: DashboardPendingDecision[],
): DashboardDecisionCounts {
  const counts: DashboardDecisionCounts = {
    pendingDecisionCount: pendingDecisions.length,
    projectFindingDecisionCount: 0,
    localeBranchFindingDecisionCount: 0,
    runtimeValidationDecisionCount: 0,
  };
  for (const decision of pendingDecisions) {
    switch (decision.decisionKind) {
      case "project_finding":
        counts.projectFindingDecisionCount += 1;
        break;
      case "locale_branch_finding":
        counts.localeBranchFindingDecisionCount += 1;
        break;
      case "runtime_validation":
        counts.runtimeValidationDecisionCount += 1;
        break;
    }
  }
  return counts;
}

function assertImportableBridgeBundle(bridge: BridgeBundle | BridgeBundleV02): void {
  const schemaVersion =
    typeof bridge === "object" && bridge !== null
      ? (bridge as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertBridgeBundleV02(bridge);
    return;
  }
  assertBridgeBundle(bridge);
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeSourceBundle(project: ItotoriProjectRecord): NormalizedSourceBundle {
  if (isBridgeBundleV02(project.bridge)) {
    const revisions = uniqueRevisions([
      project.bridge.sourceGame.sourceProfileRevision,
      project.bridge.sourceBundleRevision,
      ...project.bridge.assets.map((asset) => asset.sourceRevision),
      ...project.bridge.units.map((unit) => unit.sourceRevision),
    ]);
    return {
      sourceBundleId: project.bridge.bridgeId,
      bridgeId: project.bridge.bridgeId,
      schemaVersion: project.bridge.schemaVersion,
      sourceBundleHash: project.bridge.sourceBundleHash,
      sourceBundleRevision: project.bridge.sourceBundleRevision,
      sourceLocale: project.bridge.sourceLocale,
      sourceGame: {
        gameId: project.bridge.sourceGame.gameId,
        gameVersion: project.bridge.sourceGame.gameVersion,
        sourceProfileId: project.bridge.sourceGame.sourceProfileId,
      },
      extractor: project.bridge.extractor,
      revisions,
      assets: project.bridge.assets,
      units: project.bridge.units,
    };
  }

  const sourceBundleRevision = revision(
    `${project.bridge.bridgeId}:bundle-revision`,
    project.bridge.sourceBundleHash,
  );
  const assetById = new Map<string, BridgeAssetV02>();
  for (const unit of project.bridge.units) {
    const assetId = unit.patchRef.assetId;
    if (!assetById.has(assetId)) {
      assetById.set(assetId, {
        assetId,
        assetKey: assetId,
        assetKind: "text",
        sourceHash: project.bridge.sourceBundleHash,
        sourceRevision: revision(
          `${project.bridge.bridgeId}:asset:${assetId}`,
          project.bridge.sourceBundleHash,
        ),
        path: assetId,
      });
    }
  }

  const assetsV02 = [...assetById.values()];
  const revisions = uniqueRevisions([
    revision(`${project.bridge.bridgeId}:source-profile`, project.bridge.sourceBundleHash),
    sourceBundleRevision,
    ...assetsV02.map((asset) => asset.sourceRevision),
    ...project.bridge.units.map((unit) =>
      revision(`${project.bridge.bridgeId}:unit:${unit.bridgeUnitId}`, unit.sourceHash),
    ),
  ]);

  return {
    sourceBundleId: project.bridge.bridgeId,
    bridgeId: project.bridge.bridgeId,
    schemaVersion: project.bridge.schemaVersion,
    sourceBundleHash: project.bridge.sourceBundleHash,
    sourceBundleRevision,
    sourceLocale: project.bridge.sourceLocale,
    sourceGame: {
      gameId: "hello-game",
      gameVersion: "fixture",
      sourceProfileId: "kaifuu-fixture",
    },
    extractor: {
      name: project.bridge.extractorName,
      version: project.bridge.extractorVersion,
    },
    revisions,
    assets: assetsV02,
    units: project.bridge.units.map(
      (unit): LocalizationUnitV02 => ({
        bridgeUnitId: unit.bridgeUnitId,
        surfaceId: unit.bridgeUnitId,
        surfaceKind: unit.textSurface === "system" ? "ui_label" : "dialogue",
        sourceUnitKey: unit.sourceUnitKey,
        occurrenceId: unit.occurrenceId,
        sourceLocale: unit.sourceLocale,
        sourceText: unit.sourceText,
        sourceHash: unit.sourceHash,
        sourceRevision: revision(
          `${project.bridge.bridgeId}:unit:${unit.bridgeUnitId}`,
          unit.sourceHash,
        ),
        sourceAssetRef: { assetId: unit.patchRef.assetId, assetKey: unit.patchRef.assetId },
        sourceLocation: {},
        speaker: unit.speaker
          ? {
              knowledgeState: "known",
              speakerId: `${unit.bridgeUnitId}:speaker`,
              displayName: unit.speaker,
            }
          : { knowledgeState: "not_applicable" },
        context: {},
        spans: unit.protectedSpans.map((span) => ({
          spanId: `${unit.bridgeUnitId}:${span.start}:${span.end}`,
          spanKind: "variable_placeholder",
          raw: span.raw,
          startByte: span.start,
          endByte: span.end,
          preserveMode: span.preserveMode,
        })),
        patchRef: {
          assetId: unit.patchRef.assetId,
          writeMode: unit.patchRef.writeMode,
          sourceUnitKey: unit.patchRef.sourceUnitKey,
          sourceRevision: revision(
            `${project.bridge.bridgeId}:unit:${unit.bridgeUnitId}`,
            unit.sourceHash,
          ),
        },
        runtimeExpectation: { expectationKind: "trace_text" },
      }),
    ),
  };
}

function revision(revisionId: string, value: string): SourceRevisionV02 {
  return {
    revisionId,
    revisionKind: "content_hash",
    value,
  };
}

function uniqueRevisions(revisions: SourceRevisionV02[]): SourceRevisionV02[] {
  const byId = new Map<string, SourceRevisionV02>();
  for (const revisionRecord of revisions) {
    const existing = byId.get(revisionRecord.revisionId);
    if (
      existing !== undefined &&
      (existing.revisionKind !== revisionRecord.revisionKind ||
        existing.value !== revisionRecord.value)
    ) {
      throw new Error(
        `source revision ${revisionRecord.revisionId} appears multiple times with different content`,
      );
    }
    byId.set(revisionRecord.revisionId, revisionRecord);
  }
  return [...byId.values()];
}

function isBridgeBundleV02(bundle: BridgeBundle | BridgeBundleV02): bundle is BridgeBundleV02 {
  return bundle.schemaVersion === "0.2.0";
}

function sourceBundleIdFor(bundle: BridgeBundle | BridgeBundleV02): string {
  return bundle.bridgeId;
}

type RuntimeReportInput = RuntimeVerificationReport | RuntimeEvidenceReportV02;

type RuntimeArtifactLink = {
  artifactId: string;
  artifactKind: string;
  uri: string;
  hash: string | undefined;
  bridgeUnitId: string | undefined;
  metadata: Record<string, unknown>;
};

type RuntimeEvidenceEventArtifact = {
  artifactId: string;
  bridgeUnitId: string;
  artifactKind: "runtime_trace_event" | "runtime_branch_event";
  metadata: Record<string, unknown>;
};

type RuntimeBridgeUnitRef = {
  bridgeUnitId: string;
  sourceUnitKey?: string;
};

type RuntimeBridgeUnitLink = RuntimeBridgeUnitRef & {
  refRole: RuntimeBridgeUnitRefRole;
  metadata?: Record<string, unknown>;
};

type RuntimeEvidenceItemInput = {
  runtimeEvidenceId: string;
  evidenceKind: RuntimeEvidenceKind;
  bridgeUnitId: string | undefined;
  artifactId: string | undefined;
  artifactKind: string | undefined;
  portableArtifactUri: string | undefined;
  evidenceTier: string | null | undefined;
  frame: number | undefined;
  metadata: Record<string, unknown>;
  bridgeUnitRefs: RuntimeBridgeUnitLink[];
};

type RuntimeValidationFindingRecord = {
  findingId: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceTier: string;
  bridgeUnitId: string | undefined;
  artifactRef: RuntimeArtifactRefV02 | undefined;
  title: string;
  impact: string;
  affectedRefs: unknown[];
  evidence: unknown[];
  provenance: unknown[];
  metadata: Record<string, unknown>;
};

function runtimeProjectionArtifactIds(
  runtimeReportId: string,
  patchResultId: string,
  artifactLinks: RuntimeArtifactLink[],
  eventArtifacts: RuntimeEvidenceEventArtifact[],
  validationRecords: RuntimeValidationFindingRecord[],
): string[] {
  return Array.from(
    new Set([
      runtimeReportId,
      patchResultId,
      ...artifactLinks.map((artifact) => artifact.artifactId),
      ...eventArtifacts.map((artifact) => artifact.artifactId),
      ...validationRecords.flatMap((validation) =>
        validation.artifactRef === undefined ? [] : [validation.artifactRef.artifactId],
      ),
    ]),
  );
}

async function cleanupRuntimeReportProjection(
  tx: ItotoriTransaction,
  runtimeReportId: string,
  projectId: string,
  retainedArtifactIds: string[],
): Promise<void> {
  await tx.execute(sql`
    delete from ${findings}
    where finding_id in (
      select finding_id
      from ${runtimeValidationFindings}
      where runtime_run_id = ${runtimeReportId}
    )
  `);

  await tx
    .delete(runtimeEvidenceItems)
    .where(eq(runtimeEvidenceItems.runtimeRunId, runtimeReportId));

  await tx
    .delete(artifacts)
    .where(
      and(
        eq(artifacts.projectId, projectId),
        sql`${artifacts.metadata}->>'runtimeReportId' = ${runtimeReportId}`,
        not(inArray(artifacts.artifactId, retainedArtifactIds)),
      ),
    );
}

function runtimeReportIdFor(report: RuntimeReportInput): string {
  return report.runtimeReportId;
}

function runtimeAdapterName(report: RuntimeReportInput): string {
  return report.adapterName;
}

function runtimeAdapterVersion(report: RuntimeReportInput): string | null {
  return isRuntimeEvidenceReportV02(report) ? report.adapterVersion : null;
}

function runtimeReportStatus(report: RuntimeReportInput): "passed" | "failed" {
  return report.status;
}

function runtimeFinalStatus(
  status: "passed" | "failed",
): "hello_world_passed" | "hello_world_failed" {
  return status === "passed" ? "hello_world_passed" : "hello_world_failed";
}

function runtimeFidelityTier(report: RuntimeReportInput): string {
  return report.fidelityTier;
}

function runtimeEvidenceTier(report: RuntimeReportInput): string | null {
  return isRuntimeEvidenceReportV02(report) ? report.evidenceTier : null;
}

function runtimeTextEventCount(report: RuntimeReportInput): number {
  return isRuntimeEvidenceReportV02(report) ? report.traceEvents.length : report.textEvents.length;
}

function runtimeBranchEventCount(report: RuntimeReportInput): number {
  return isRuntimeEvidenceReportV02(report) ? report.branchEvents.length : 0;
}

function runtimeFrameCaptureCount(report: RuntimeReportInput): number {
  return isRuntimeEvidenceReportV02(report) ? report.captures.length : report.frameCaptures.length;
}

function runtimeScreenshotArtifactCount(report: RuntimeReportInput): number {
  return isRuntimeEvidenceReportV02(report) ? report.captures.length : report.frameCaptures.length;
}

function runtimeRecordingArtifactCount(report: RuntimeReportInput): number {
  return isRuntimeEvidenceReportV02(report) ? report.recordings.length : 0;
}

function runtimeValidationFindingCount(report: RuntimeReportInput): number {
  return isRuntimeEvidenceReportV02(report) ? report.validationFindings.length : 0;
}

function runtimeReferenceComparisonCount(report: RuntimeReportInput): number {
  return isRuntimeEvidenceReportV02(report) ? (report.referenceComparisons ?? []).length : 0;
}

function runtimeReportCreatedAt(report: RuntimeReportInput): Date {
  return isRuntimeEvidenceReportV02(report) ? new Date(report.createdAt) : new Date();
}

function runtimeApproximations(report: RuntimeReportInput): unknown[] {
  return report.approximations;
}

function runtimeReportMetadataFor(
  report: RuntimeReportInput,
  summary: {
    adapterName: string;
    adapterVersion: string | null;
    finalStatus: string;
    runtimeStatus: string;
    fidelityTier: string;
    evidenceTier: string | null;
    textEventCount: number;
    branchEventCount: number;
    frameCaptureCount: number;
    screenshotArtifactCount: number;
    recordingArtifactCount: number;
    validationFindingCount: number;
    referenceComparisonCount: number;
  },
): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    adapterName: summary.adapterName,
    adapterVersion: summary.adapterVersion,
    sourceBridgeId: isRuntimeEvidenceReportV02(report) ? (report.sourceBridgeId ?? null) : null,
    sourceBundleHash: isRuntimeEvidenceReportV02(report) ? (report.sourceBundleHash ?? null) : null,
    sourceLocale: isRuntimeEvidenceReportV02(report) ? (report.sourceLocale ?? null) : null,
    targetLocale: isRuntimeEvidenceReportV02(report) ? (report.targetLocale ?? null) : null,
    fidelityTier: summary.fidelityTier,
    evidenceTier: summary.evidenceTier,
    status: summary.runtimeStatus,
    finalStatus: summary.finalStatus,
    textEventCount: summary.textEventCount,
    branchEventCount: summary.branchEventCount,
    frameCaptureCount: summary.frameCaptureCount,
    screenshotArtifactCount: summary.screenshotArtifactCount,
    recordingArtifactCount: summary.recordingArtifactCount,
    validationFindingCount: summary.validationFindingCount,
    referenceComparisonCount: summary.referenceComparisonCount,
    approximations: runtimeApproximations(report),
    runtimeCapabilities: isRuntimeEvidenceReportV02(report)
      ? (report.runtimeCapabilities ?? null)
      : null,
    controlledPlaybackSession: isRuntimeEvidenceReportV02(report)
      ? (report.controlledPlaybackSession ?? null)
      : null,
    limitations: isRuntimeEvidenceReportV02(report) ? report.limitations : [],
    reportCreatedAt: runtimeReportCreatedAt(report).toISOString(),
  };
}

function runtimeArtifactLinks(report: RuntimeReportInput): RuntimeArtifactLink[] {
  if (!isRuntimeEvidenceReportV02(report)) {
    return report.frameCaptures.map((frame) => {
      assertPortableLegacyRuntimeArtifactUri(frame.artifactPath);
      return {
        artifactId: frame.frameCaptureId,
        artifactKind: "frame_capture",
        uri: frame.artifactPath,
        hash: undefined,
        bridgeUnitId: frame.bridgeUnitId,
        metadata: {
          captureId: frame.frameCaptureId,
          evidenceTier: null,
          width: frame.width,
          height: frame.height,
          nonZeroPixels: frame.nonZeroPixels,
        },
      };
    });
  }

  return [
    ...report.traceEvents.flatMap((event) =>
      event.artifactRef === undefined
        ? []
        : [
            artifactLinkFromRef(event.artifactRef, event.bridgeUnitRef.bridgeUnitId, {
              evidenceKind: runtimeEvidenceKindValues.traceEvent,
              traceEventId: event.traceEventId,
              frame: event.frame,
              traceKey: event.traceKey,
            }),
          ],
    ),
    ...report.captures.map((capture) => ({
      ...artifactLinkFromRef(capture.artifactRef, capture.bridgeUnitRef.bridgeUnitId, {
        evidenceKind: runtimeEvidenceKindValues.capture,
        captureId: capture.captureId,
        evidenceTier: capture.evidenceTier,
        frame: capture.frame,
        width: capture.width,
        height: capture.height,
        nonZeroPixels: capture.nonZeroPixels,
        region: capture.region ?? null,
      }),
    })),
    ...report.recordings.map((recording) => ({
      ...artifactLinkFromRef(recording.artifactRef, recording.bridgeUnitRef.bridgeUnitId, {
        evidenceKind: runtimeEvidenceKindValues.recording,
        recordingId: recording.recordingId,
        evidenceTier: recording.evidenceTier,
        startedAtFrame: recording.startedAtFrame,
        frameCount: recording.frameCount,
        width: recording.width,
        height: recording.height,
        encoding: recording.encoding,
      }),
    })),
    ...(report.referenceComparisons ?? []).map((comparison) =>
      artifactLinkFromRef(
        comparison.artifactRef,
        comparison.coveredBridgeUnitRefs[0]?.bridgeUnitId,
        {
          evidenceKind: runtimeEvidenceKindValues.referenceComparison,
          comparisonId: comparison.comparisonId,
          comparisonKind: comparison.comparisonKind,
          status: comparison.status,
          scope: comparison.scope,
        },
      ),
    ),
  ];
}

function artifactLinkFromRef(
  artifactRef: RuntimeArtifactRefV02,
  bridgeUnitId: string | undefined,
  metadata: Record<string, unknown>,
): RuntimeArtifactLink {
  assertPortableRelativeArtifactUri(artifactRef.uri);
  const storedArtifactRef = runtimeArtifactRefForDb(artifactRef);
  return {
    artifactId: storedArtifactRef.artifactId,
    artifactKind: storedArtifactRef.artifactKind,
    uri: storedArtifactRef.uri,
    hash: storedArtifactRef.hash,
    bridgeUnitId,
    metadata: {
      ...metadata,
      artifactRef: storedArtifactRef,
      mediaType: storedArtifactRef.mediaType ?? null,
      byteSize: storedArtifactRef.byteSize ?? null,
    },
  };
}

function runtimeEvidenceEventArtifacts(report: RuntimeReportInput): RuntimeEvidenceEventArtifact[] {
  if (!isRuntimeEvidenceReportV02(report)) {
    return [];
  }

  return [
    ...report.traceEvents.map((event) => ({
      artifactId: event.traceEventId,
      bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
      artifactKind: "runtime_trace_event" as const,
      metadata: {
        runtimeReportId: report.runtimeReportId,
        schemaVersion: report.schemaVersion,
        eventKind: event.eventKind,
        frame: event.frame,
        traceKey: event.traceKey,
        sourceUnitKey: event.bridgeUnitRef.sourceUnitKey,
        bridgeUnitRefs: [event.bridgeUnitRef],
        event: runtimeTraceEventForDb(event),
      },
    })),
    ...report.branchEvents.map((event) => ({
      artifactId: event.branchEventId,
      bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
      artifactKind: "runtime_branch_event" as const,
      metadata: {
        runtimeReportId: report.runtimeReportId,
        schemaVersion: report.schemaVersion,
        frame: event.frame,
        branchPointKey: event.branchPointKey,
        sourceUnitKey: event.bridgeUnitRef.sourceUnitKey,
        selectedOptionId: event.selectedOptionId,
        bridgeUnitRefs: runtimeBranchEventBridgeUnitRefs(event),
        event: runtimeBranchEventForDb(event),
      },
    })),
  ];
}

function runtimeEvidenceItemsFor(report: RuntimeReportInput): RuntimeEvidenceItemInput[] {
  if (!isRuntimeEvidenceReportV02(report)) {
    return [
      ...report.textEvents.map((event) => ({
        runtimeEvidenceId: event.runtimeTextEventId,
        evidenceKind: runtimeEvidenceKindValues.traceEvent,
        bridgeUnitId: event.bridgeUnitId,
        artifactId: undefined,
        artifactKind: undefined,
        portableArtifactUri: undefined,
        evidenceTier: null,
        frame: event.frame,
        metadata: { event },
        bridgeUnitRefs: [
          {
            bridgeUnitId: event.bridgeUnitId,
            refRole: runtimeBridgeUnitRefRoleValues.primary,
          },
        ],
      })),
      ...report.frameCaptures.map((frame) => ({
        runtimeEvidenceId: frame.frameCaptureId,
        evidenceKind: runtimeEvidenceKindValues.capture,
        bridgeUnitId: frame.bridgeUnitId,
        artifactId: frame.frameCaptureId,
        artifactKind: "frame_capture",
        portableArtifactUri: undefined,
        evidenceTier: null,
        frame: undefined,
        metadata: {
          capture: frame,
          width: frame.width,
          height: frame.height,
          nonZeroPixels: frame.nonZeroPixels,
        },
        bridgeUnitRefs: [
          {
            bridgeUnitId: frame.bridgeUnitId,
            refRole: runtimeBridgeUnitRefRoleValues.primary,
          },
        ],
      })),
    ];
  }

  return [
    ...report.traceEvents.map((event) => {
      const artifactRef = event.artifactRef;
      if (artifactRef !== undefined) {
        assertPortableRelativeArtifactUri(artifactRef.uri);
      }
      return {
        runtimeEvidenceId: event.traceEventId,
        evidenceKind: runtimeEvidenceKindValues.traceEvent,
        bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
        artifactId: artifactRef?.artifactId ?? event.traceEventId,
        artifactKind: artifactRef?.artifactKind ?? "runtime_trace_event",
        portableArtifactUri: artifactRef?.uri,
        evidenceTier: null,
        frame: event.frame,
        metadata: {
          eventKind: event.eventKind,
          traceKey: event.traceKey,
          observedText: event.observedText,
          artifactRef: artifactRef === undefined ? null : runtimeArtifactRefForDb(artifactRef),
          event: runtimeTraceEventForDb(event),
        },
        bridgeUnitRefs: [
          bridgeUnitLink(event.bridgeUnitRef, runtimeBridgeUnitRefRoleValues.primary),
        ],
      };
    }),
    ...report.branchEvents.map((event) => ({
      runtimeEvidenceId: event.branchEventId,
      evidenceKind: runtimeEvidenceKindValues.branchEvent,
      bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
      artifactId: event.branchEventId,
      artifactKind: "runtime_branch_event",
      portableArtifactUri: undefined,
      evidenceTier: null,
      frame: event.frame,
      metadata: {
        branchPointKey: event.branchPointKey,
        selectedOptionId: event.selectedOptionId,
        event: runtimeBranchEventForDb(event),
      },
      bridgeUnitRefs: runtimeBranchEventBridgeUnitLinks(event),
    })),
    ...report.captures.map((capture) => {
      assertPortableRelativeArtifactUri(capture.artifactRef.uri);
      return {
        runtimeEvidenceId: capture.captureId,
        evidenceKind: runtimeEvidenceKindValues.capture,
        bridgeUnitId: capture.bridgeUnitRef.bridgeUnitId,
        artifactId: capture.artifactRef.artifactId,
        artifactKind: capture.artifactRef.artifactKind,
        portableArtifactUri: capture.artifactRef.uri,
        evidenceTier: capture.evidenceTier,
        frame: capture.frame,
        metadata: {
          width: capture.width,
          height: capture.height,
          nonZeroPixels: capture.nonZeroPixels,
          region: capture.region ?? null,
          artifactRef: runtimeArtifactRefForDb(capture.artifactRef),
          capture: runtimeCaptureForDb(capture),
        },
        bridgeUnitRefs: [
          bridgeUnitLink(capture.bridgeUnitRef, runtimeBridgeUnitRefRoleValues.primary),
        ],
      };
    }),
    ...report.recordings.map((recording) => {
      assertPortableRelativeArtifactUri(recording.artifactRef.uri);
      return {
        runtimeEvidenceId: recording.recordingId,
        evidenceKind: runtimeEvidenceKindValues.recording,
        bridgeUnitId: recording.bridgeUnitRef.bridgeUnitId,
        artifactId: recording.artifactRef.artifactId,
        artifactKind: recording.artifactRef.artifactKind,
        portableArtifactUri: recording.artifactRef.uri,
        evidenceTier: recording.evidenceTier,
        frame: recording.startedAtFrame,
        metadata: {
          recording: runtimeRecordingForDb(recording),
          frameCount: recording.frameCount,
          width: recording.width,
          height: recording.height,
          encoding: recording.encoding,
          artifactRef: runtimeArtifactRefForDb(recording.artifactRef),
        },
        bridgeUnitRefs: [
          bridgeUnitLink(recording.bridgeUnitRef, runtimeBridgeUnitRefRoleValues.primary),
        ],
      };
    }),
    ...report.approximations.map((approximation) => ({
      runtimeEvidenceId: approximation.approximationId,
      evidenceKind: runtimeEvidenceKindValues.approximation,
      bridgeUnitId: approximation.affectedBridgeUnitRefs[0]?.bridgeUnitId,
      artifactId: undefined,
      artifactKind: undefined,
      portableArtifactUri: undefined,
      evidenceTier: approximation.evidenceTierCeiling,
      frame: undefined,
      metadata: { approximation },
      bridgeUnitRefs: approximation.affectedBridgeUnitRefs.map((ref) =>
        bridgeUnitLink(ref, runtimeBridgeUnitRefRoleValues.affected),
      ),
    })),
    ...(report.referenceComparisons ?? []).map((comparison) => {
      assertPortableRelativeArtifactUri(comparison.artifactRef.uri);
      return {
        runtimeEvidenceId: comparison.comparisonId,
        evidenceKind: runtimeEvidenceKindValues.referenceComparison,
        bridgeUnitId: comparison.coveredBridgeUnitRefs[0]?.bridgeUnitId,
        artifactId: comparison.artifactRef.artifactId,
        artifactKind: comparison.artifactRef.artifactKind,
        portableArtifactUri: comparison.artifactRef.uri,
        evidenceTier: "E4",
        frame: undefined,
        metadata: {
          comparison: runtimeReferenceComparisonForDb(comparison),
          artifactRef: runtimeArtifactRefForDb(comparison.artifactRef),
        },
        bridgeUnitRefs: comparison.coveredBridgeUnitRefs.map((ref) =>
          bridgeUnitLink(ref, runtimeBridgeUnitRefRoleValues.covered),
        ),
      };
    }),
  ].map((item) => ({
    ...item,
    bridgeUnitRefs: uniqueBridgeUnitLinks(item.bridgeUnitRefs),
  }));
}

function runtimeBranchEventBridgeUnitRefs(
  event: RuntimeEvidenceReportV02["branchEvents"][number],
): RuntimeBridgeUnitRef[] {
  const uniqueRefs = new Map<string, RuntimeBridgeUnitRef>();
  for (const ref of runtimeBranchEventBridgeUnitLinks(event)) {
    uniqueRefs.set(`${ref.bridgeUnitId}\0${ref.sourceUnitKey ?? ""}`, {
      bridgeUnitId: ref.bridgeUnitId,
      ...(ref.sourceUnitKey === undefined ? {} : { sourceUnitKey: ref.sourceUnitKey }),
    });
  }
  return Array.from(uniqueRefs.values());
}

function runtimeBranchEventBridgeUnitLinks(
  event: RuntimeEvidenceReportV02["branchEvents"][number],
): RuntimeBridgeUnitLink[] {
  const refs = [bridgeUnitLink(event.bridgeUnitRef, runtimeBridgeUnitRefRoleValues.primary)];
  for (const option of event.options) {
    if (option.labelBridgeUnitRef !== undefined) {
      refs.push(
        bridgeUnitLink(option.labelBridgeUnitRef, runtimeBridgeUnitRefRoleValues.branchLabel, {
          optionId: option.optionId,
        }),
      );
    }
    if (option.targetBridgeUnitRef !== undefined) {
      refs.push(
        bridgeUnitLink(option.targetBridgeUnitRef, runtimeBridgeUnitRefRoleValues.branchTarget, {
          optionId: option.optionId,
        }),
      );
    }
  }
  return uniqueBridgeUnitLinks(refs);
}

function bridgeUnitLink(
  ref: RuntimeBridgeUnitRefV02,
  refRole: RuntimeBridgeUnitRefRole,
  metadata?: Record<string, unknown>,
): RuntimeBridgeUnitLink {
  return {
    bridgeUnitId: ref.bridgeUnitId,
    refRole,
    ...(ref.sourceUnitKey === undefined ? {} : { sourceUnitKey: ref.sourceUnitKey }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function uniqueBridgeUnitLinks(refs: RuntimeBridgeUnitLink[]): RuntimeBridgeUnitLink[] {
  const uniqueRefs = new Map<string, RuntimeBridgeUnitLink>();
  for (const ref of refs) {
    uniqueRefs.set(`${ref.bridgeUnitId}\0${ref.sourceUnitKey ?? ""}\0${ref.refRole}`, ref);
  }
  return Array.from(uniqueRefs.values());
}

function runtimeValidationFindingRecords(
  report: RuntimeReportInput,
): RuntimeValidationFindingRecord[] {
  if (!isRuntimeEvidenceReportV02(report)) {
    return [];
  }

  return report.validationFindings.map((finding) =>
    runtimeValidationFindingRecord(report, finding),
  );
}

function runtimeValidationFindingRecord(
  report: RuntimeEvidenceReportV02,
  finding: RuntimeValidationFindingV02,
): RuntimeValidationFindingRecord {
  const artifactRef =
    finding.artifactRef === undefined ? undefined : runtimeArtifactRefForDb(finding.artifactRef);
  if (finding.artifactRef !== undefined) {
    assertPortableRelativeArtifactUri(finding.artifactRef.uri);
  }
  const runtimeReportRef = {
    subjectKind: "runtime_report",
    subjectId: report.runtimeReportId,
  };
  const bridgeUnitRef =
    finding.bridgeUnitRef === undefined
      ? undefined
      : {
          subjectKind: "bridge_unit",
          subjectId: finding.bridgeUnitRef.bridgeUnitId,
          sourceUnitKey: finding.bridgeUnitRef.sourceUnitKey,
        };
  const affectedRefs =
    bridgeUnitRef === undefined ? [runtimeReportRef] : [runtimeReportRef, bridgeUnitRef];
  const evidence = [
    {
      evidenceKind: "runtime_validation",
      runtimeReportId: report.runtimeReportId,
      evidenceTier: finding.evidenceTier,
      artifactRef: artifactRef ?? null,
    },
  ];
  const provenance = [
    {
      provenanceKind: "runtime_evidence",
      runtimeReportId: report.runtimeReportId,
      adapterName: report.adapterName,
      adapterVersion: report.adapterVersion,
    },
  ];

  return {
    findingId: finding.findingId,
    findingKind: finding.findingKind,
    severity: finding.severity,
    message: finding.message,
    evidenceTier: finding.evidenceTier,
    bridgeUnitId: finding.bridgeUnitRef?.bridgeUnitId,
    artifactRef,
    title: `Runtime validation: ${finding.findingKind}`,
    impact: "Runtime evidence may be incomplete or invalid for this report.",
    affectedRefs,
    evidence,
    provenance,
    metadata: {
      schemaVersion: report.schemaVersion,
      runtimeReportId: report.runtimeReportId,
      finding: runtimeValidationFindingForDb(finding),
      bridgeUnitRef: finding.bridgeUnitRef ?? null,
      artifactRef: artifactRef ?? null,
    },
  };
}

function runtimeArtifactRefForDb(artifactRef: RuntimeArtifactRefV02): RuntimeArtifactRefV02 {
  assertPortableRelativeArtifactUri(artifactRef.uri);
  return {
    artifactId: artifactRef.artifactId,
    artifactKind: artifactRef.artifactKind,
    uri: artifactRef.uri,
    ...(artifactRef.hash === undefined ? {} : { hash: artifactRef.hash }),
    ...(artifactRef.mediaType === undefined ? {} : { mediaType: artifactRef.mediaType }),
    ...(artifactRef.byteSize === undefined ? {} : { byteSize: artifactRef.byteSize }),
  };
}

function runtimeTraceEventForDb(
  event: RuntimeEvidenceReportV02["traceEvents"][number],
): Record<string, unknown> {
  return {
    traceEventId: event.traceEventId,
    eventKind: event.eventKind,
    bridgeUnitRef: event.bridgeUnitRef,
    frame: event.frame,
    traceKey: event.traceKey ?? null,
    observedText: event.observedText ?? null,
    artifactRef:
      event.artifactRef === undefined ? null : runtimeArtifactRefForDb(event.artifactRef),
  };
}

function runtimeBranchEventForDb(
  event: RuntimeEvidenceReportV02["branchEvents"][number],
): Record<string, unknown> {
  return {
    branchEventId: event.branchEventId,
    bridgeUnitRef: event.bridgeUnitRef,
    frame: event.frame,
    branchPointKey: event.branchPointKey ?? null,
    promptText: event.promptText ?? null,
    selectedOptionId: event.selectedOptionId ?? null,
    options: event.options.map((option) => ({
      optionId: option.optionId,
      label: option.label ?? null,
      labelBridgeUnitRef: option.labelBridgeUnitRef ?? null,
      targetRouteKey: option.targetRouteKey ?? null,
      targetBridgeUnitRef: option.targetBridgeUnitRef ?? null,
    })),
  };
}

function runtimeCaptureForDb(
  capture: RuntimeEvidenceReportV02["captures"][number],
): Record<string, unknown> {
  return {
    captureId: capture.captureId,
    bridgeUnitRef: capture.bridgeUnitRef,
    evidenceTier: capture.evidenceTier,
    frame: capture.frame,
    width: capture.width,
    height: capture.height,
    nonZeroPixels: capture.nonZeroPixels ?? null,
    region: capture.region ?? null,
    artifactRef: runtimeArtifactRefForDb(capture.artifactRef),
  };
}

function runtimeRecordingForDb(
  recording: RuntimeEvidenceReportV02["recordings"][number],
): Record<string, unknown> {
  return {
    recordingId: recording.recordingId,
    bridgeUnitRef: recording.bridgeUnitRef,
    evidenceTier: recording.evidenceTier,
    startedAtFrame: recording.startedAtFrame,
    frameCount: recording.frameCount,
    width: recording.width,
    height: recording.height,
    encoding: recording.encoding,
    artifactRef: runtimeArtifactRefForDb(recording.artifactRef),
  };
}

function runtimeReferenceComparisonForDb(
  comparison: NonNullable<RuntimeEvidenceReportV02["referenceComparisons"]>[number],
): Record<string, unknown> {
  return {
    comparisonId: comparison.comparisonId,
    comparisonKind: comparison.comparisonKind,
    status: comparison.status,
    scope: comparison.scope,
    coveredBridgeUnitRefs: comparison.coveredBridgeUnitRefs,
    artifactRef: runtimeArtifactRefForDb(comparison.artifactRef),
  };
}

function runtimeValidationFindingForDb(
  finding: RuntimeValidationFindingV02,
): Record<string, unknown> {
  return {
    findingId: finding.findingId,
    findingKind: finding.findingKind,
    severity: finding.severity,
    bridgeUnitRef: finding.bridgeUnitRef ?? null,
    artifactRef:
      finding.artifactRef === undefined ? null : runtimeArtifactRefForDb(finding.artifactRef),
    message: finding.message,
    evidenceTier: finding.evidenceTier,
  };
}

function assertPortableRelativeArtifactUri(uri: string): void {
  assertPortableRuntimeArtifactUri(uri, { allowFixtureUri: false });
}

function assertPortableLegacyRuntimeArtifactUri(uri: string): void {
  assertPortableRuntimeArtifactUri(uri, { allowFixtureUri: true });
}

function assertPortableRuntimeArtifactUri(
  uri: string,
  options: { allowFixtureUri: boolean },
): void {
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri);
  const allowedFixtureUri = options.allowFixtureUri && uri.startsWith("fixture://");
  const hasTraversalSegment = uri.split("/").some((segment) => segment === "." || segment === "..");
  if (
    uri.startsWith("data:") ||
    uri.startsWith("blob:") ||
    uri.startsWith("file:") ||
    (hasScheme && !allowedFixtureUri) ||
    uri.startsWith("/") ||
    uri.includes("\\") ||
    hasTraversalSegment
  ) {
    throw new Error(`runtime artifact uri must be a portable relative artifact path: ${uri}`);
  }
  if (!options.allowFixtureUri && !uri.startsWith("artifacts/utsushi/runtime/")) {
    throw new Error(
      `runtime artifact uri must be under managed runtime artifact root artifacts/utsushi/runtime/: ${uri}`,
    );
  }
}

function isRuntimeEvidenceReportV02(
  report: RuntimeReportInput,
): report is RuntimeEvidenceReportV02 {
  return report.schemaVersion === "0.2.0";
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
