import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import {
  assertPatchExport,
  assertPatchExportV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  BRIDGE_SCHEMA_VERSION_V02,
  evaluatePatchExportCompatibilityV02,
  type BridgeAssetV02,
  type BridgeBundle,
  type BridgeBundleV02,
  type FindingRecordV02,
  type LocalizationUnitV02,
  type PatchExport,
  type PatchExportV02,
  type PatchResultV02,
  type RuntimeArtifactRefV02,
  type RuntimeArtifactKindV02,
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
import {
  ItotoriModelLedgerRepository,
  insertProviderRunLedgerRows,
  type ProjectCostReport,
  type ProviderRunLedgerInput,
} from "./model-ledger-repository.js";
import { ensureBranchPolicyGlossaryReferenceInTx } from "./branch-reference-repository.js";
import {
  artifacts,
  assets,
  bridgeImports,
  contextArtifacts,
  contextArtifactStatusValues,
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
  styleGuides,
  styleGuideVersions,
  translationMemoryReuseEvents,
  translationMemorySegments,
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
  patchResult?: PatchResultV02;
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

export type BenchmarkArtifactLedgerInput = {
  artifact: ArtifactInput;
  providerRuns: ProviderRunLedgerInput[];
};

export type LocaleBranchStatus = {
  localeBranchId: string;
  targetLocale: string;
  status: string;
  currentStyleGuidePolicyVersionId: string | null;
  unitCount: number;
  translatedUnitCount: number;
  openFindingCount: number;
  artifactCount: number;
};

export type LocaleBranchIdentity = {
  localeBranchId: string;
  projectId: string;
  sourceBundleId: string;
  sourceBundleRevisionId: string;
  sourceLocale: string;
  targetLocale: string;
  branchName: string;
  status: string;
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
  selectedLocaleBranchId: string | null;
  currentStyleGuidePolicyVersionId: string | null;
  importStatus: BridgeImportStatus;
  cost: ProjectCostReport;
  localeBranches: LocaleBranchStatus[];
};

export type RuntimeDashboardStatus = {
  finalStatus: string;
  runtimeRunId: string | null;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  textEventCount: number;
  frameCaptureCount: number;
  evidenceTier: string | null;
  screenshotArtifactCount: number;
  recordingArtifactCount: number;
  validationFindingCount: number;
  traceEvents: RuntimeDashboardTraceEvent[];
  findings: RuntimeDashboardFinding[];
  artifacts: RuntimeDashboardArtifact[];
  approximations: RuntimeDashboardApproximation[];
  unsupportedCapabilities: RuntimeDashboardUnsupportedCapability[];
  limitations: string[];
};

export type RuntimeDashboardTraceEvent = {
  runtimeEventId: string;
  eventKind: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  draftId: string | null;
  runtimeTargetId: string | null;
  evidenceTier: string | null;
  frame: number | null;
  textPreview: string | null;
  artifactIds: string[];
};

export type RuntimeDashboardFinding = {
  findingId: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceTier: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  artifactId: string | null;
};

export type RuntimeDashboardArtifact = {
  artifactId: string;
  artifactKind: string;
  uri: string | null;
  hash: string | null;
  mediaType: string | null;
  byteSize: number | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  diagnostic: string | null;
};

export type RuntimeDashboardApproximation = {
  approximationId: string;
  approximationTier: string;
  scope: string;
  description: string;
  evidenceTierCeiling: string;
  bridgeUnitIds: string[];
};

export type RuntimeDashboardUnsupportedCapability = {
  feature: string;
  status: string;
  fidelityTierCeiling: string | null;
  evidenceTierCeiling: string | null;
  limitations: string[];
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

/**
 * ITOTORI-027 — per-(qa agent, evaluated system) calibration recorded
 * with a benchmark report. `truePositives` / `falsePositives` /
 * `falseNegatives` are the QA FP/FN representation the cost & quality
 * dashboard surfaces; they are computed at record time from the report's
 * seeded-defect oracle (never re-estimated) and persisted in the
 * benchmark_report artifact metadata.
 */
export type BenchmarkQaAgentSummary = {
  qaAgentId: string;
  qaAgentVersion: string;
  evaluatedSystemId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  seededPrecision: number;
  seededRecall: number;
  f1: number;
  findingsEmitted: number;
  scorableFindings: number;
};

/**
 * ITOTORI-027 — a recorded benchmark report as read back for the cost &
 * quality dashboard's benchmark views + report drilldown. Sourced from
 * the persisted benchmark_report artifact; the cost side is tracked
 * separately through the ledger (`ProjectCostReport`).
 */
export type BenchmarkReportSummary = {
  benchmarkRunId: string;
  projectId: string;
  localeBranchId: string | null;
  benchmarkName: string;
  status: string;
  createdAt: string;
  sourceLocale: string;
  targetLocale: string;
  systemCount: number;
  findingCount: number;
  penaltyTotal: number;
  qaAgents: BenchmarkQaAgentSummary[];
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
  recordBenchmarkArtifactWithProviderLedger(
    actor: AuthorizationActor,
    input: BenchmarkArtifactLedgerInput,
  ): Promise<void>;
  listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]>;
  listBenchmarkReports(projectId: string): Promise<BenchmarkReportSummary[]>;
  getDashboardStatus(): Promise<ProjectDashboardStatus>;
  /**
   * gate-runtime-status-reads-and-redact-evidence-previews — the runtime
   * status read requires the actor to hold the project/ledger read
   * permission (`catalog.read`, the same gate the sibling
   * `getProjectCostReport` cost read uses). The detailed report exposes
   * evidence text previews (`traceEvents[].textPreview`, sourced from
   * observedText/promptText), finding free text (`findings[].message`), and
   * managed artifact URIs + hashes, so it is actor-checked where the data
   * is read. Unprivileged HTTP callers receive a redacted summary at the
   * API boundary.
   */
  getRuntimeStatus(
    actor: AuthorizationActor,
    runtimeRunId?: string,
  ): Promise<RuntimeDashboardStatus>;
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
        ${translationMemoryReuseEvents},
        ${translationMemorySegments},
        ${styleGuideVersions},
        ${styleGuides},
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
              // ITOTORI-060: revive a previously-tombstoned asset on re-add.
              removedAt: null,
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
              // ITOTORI-060: revive a previously-tombstoned unit that this
              // reimport re-adds, rather than leaving it archived or
              // duplicating the row.
              removedAt: null,
            },
          });
      }

      // ITOTORI-060: units/assets omitted by this reimport are TOMBSTONED
      // (removed_at = now()), not hard-deleted. Deleting them would CASCADE
      // away locale-branch unit rows + runtime evidence refs + TM reuse events
      // and sever every historical back-pointer; tombstoning keeps that history
      // intact while removing the row from the active/current set. Guard on
      // removed_at IS NULL so already-tombstoned rows are left untouched.
      if (diff.units.removedIds.length > 0) {
        await tx
          .update(sourceUnits)
          .set({ removedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              inArray(sourceUnits.bridgeUnitId, diff.units.removedIds),
              isNull(sourceUnits.removedAt),
            ),
          );
      }

      if (diff.assets.removedIds.length > 0) {
        await tx
          .update(assets)
          .set({ removedAt: sql`now()` })
          .where(and(inArray(assets.assetId, diff.assets.removedIds), isNull(assets.removedAt)));
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

      await staleContextArtifactsAfterSourceImport(tx, {
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        currentSourceBundleRevisionId: importTarget.sourceBundleRevision.revisionId,
      });

      const draftStyleGuideVersionId = await getApprovedStyleGuideVersionIdInTx(
        tx,
        project.localeBranchId,
      );
      const hasDrafts = Object.keys(project.drafts).length > 0;
      const draftBranchReference = hasDrafts
        ? await ensureBranchPolicyGlossaryReferenceInTx(tx, actor, {
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
          .insert(localeBranchUnits)
          .values({
            localeBranchId: project.localeBranchId,
            bridgeUnitId: unit.bridgeUnitId,
            targetText: project.drafts[unit.bridgeUnitId] ?? null,
            styleGuideVersionId: hasDraft ? draftStyleGuideVersionId : null,
            glossaryReferenceId: hasDraft ? (draftBranchReference?.referenceId ?? null) : null,
          })
          .onConflictDoUpdate({
            target: [localeBranchUnits.localeBranchId, localeBranchUnits.bridgeUnitId],
            set: {
              targetText: project.drafts[unit.bridgeUnitId] ?? null,
              styleGuideVersionId: hasDraft ? draftStyleGuideVersionId : null,
              glossaryReferenceId: hasDraft ? (draftBranchReference?.referenceId ?? null) : null,
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

      const draftStyleGuideVersionId = await getApprovedStyleGuideVersionIdInTx(
        tx,
        project.localeBranchId,
      );
      const draftEntries = Object.entries(project.drafts);
      const draftBranchReference =
        draftEntries.length === 0
          ? null
          : await ensureBranchPolicyGlossaryReferenceInTx(tx, actor, {
              projectId: project.projectId,
              localeBranchId: project.localeBranchId,
              styleGuideVersionId: draftStyleGuideVersionId,
              updateReason: "draft_save_reference",
              metadata: { source: "saveDrafts" },
            });
      for (const [bridgeUnitId, targetText] of draftEntries) {
        await tx
          .insert(localeBranchUnits)
          .values({
            localeBranchId: project.localeBranchId,
            bridgeUnitId,
            targetText,
            styleGuideVersionId: draftStyleGuideVersionId,
            glossaryReferenceId: draftBranchReference?.referenceId ?? null,
          })
          .onConflictDoUpdate({
            target: [localeBranchUnits.localeBranchId, localeBranchUnits.bridgeUnitId],
            set: {
              targetText,
              styleGuideVersionId: draftStyleGuideVersionId,
              glossaryReferenceId: draftBranchReference?.referenceId ?? null,
              updatedAt: sql`now()`,
            },
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
    validatePatchExportContract(patchExport, project.bridge);
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
                adapterLocalFindingId: validation.adapterLocalFindingId,
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
                  adapterLocalFindingId: validation.adapterLocalFindingId,
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

  async recordBenchmarkArtifactWithProviderLedger(
    actor: AuthorizationActor,
    input: BenchmarkArtifactLedgerInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(artifacts)
        .values({
          artifactId: input.artifact.artifactId,
          projectId: input.artifact.projectId,
          localeBranchId: input.artifact.localeBranchId ?? null,
          sourceBundleId: input.artifact.sourceBundleId ?? null,
          bridgeUnitId: input.artifact.bridgeUnitId ?? null,
          findingId: input.artifact.findingId ?? null,
          artifactKind: input.artifact.artifactKind,
          uri: input.artifact.uri ?? null,
          hash: input.artifact.hash ?? null,
          metadata: input.artifact.metadata ?? {},
        })
        .onConflictDoUpdate({
          target: artifacts.artifactId,
          set: {
            localeBranchId: input.artifact.localeBranchId ?? null,
            sourceBundleId: input.artifact.sourceBundleId ?? null,
            bridgeUnitId: input.artifact.bridgeUnitId ?? null,
            findingId: input.artifact.findingId ?? null,
            artifactKind: input.artifact.artifactKind,
            uri: input.artifact.uri ?? null,
            hash: input.artifact.hash ?? null,
            metadata: input.artifact.metadata ?? {},
          },
        });

      for (const providerRun of input.providerRuns) {
        await insertProviderRunLedgerRows(tx, providerRun);
      }
    });
  }

  async listBenchmarkReports(projectId: string): Promise<BenchmarkReportSummary[]> {
    const result = await this.db.execute(sql`
      select
        a.artifact_id,
        a.project_id,
        a.locale_branch_id,
        a.metadata,
        a.created_at
      from ${artifacts} a
      where a.project_id = ${projectId}
        and a.artifact_kind = 'benchmark_report'
      order by a.created_at desc, a.artifact_id desc
    `);
    return (result.rows as Array<Record<string, unknown>>).map(benchmarkReportSummaryFromRow);
  }

  async listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]> {
    const result = await this.db.execute(sql`
      select
        b.locale_branch_id,
        b.project_id,
        b.source_bundle_id,
        sb.source_bundle_revision_id,
        sb.source_locale,
        b.target_locale,
        b.branch_name,
        b.status
      from ${localeBranches} b
      join ${sourceBundles} sb on sb.source_bundle_id = b.source_bundle_id
      where b.project_id = ${projectId}
      order by b.created_at asc, b.locale_branch_id asc
    `);

    return result.rows.map(
      (row): LocaleBranchIdentity => ({
        localeBranchId: String(row.locale_branch_id),
        projectId: String(row.project_id),
        sourceBundleId: String(row.source_bundle_id),
        sourceBundleRevisionId: String(row.source_bundle_revision_id),
        sourceLocale: String(row.source_locale),
        targetLocale: String(row.target_locale),
        branchName: String(row.branch_name),
        status: String(row.status),
      }),
    );
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
        sg.latest_version_id as current_style_guide_policy_version_id,
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
      left join ${styleGuides} sg
        on sg.locale_branch_id = b.locale_branch_id
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
        sg.latest_version_id,
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
          currentStyleGuidePolicyVersionId: nullableString(
            row.current_style_guide_policy_version_id,
          ),
          unitCount: Number(row.unit_count),
          translatedUnitCount: Number(row.translated_unit_count),
          openFindingCount: Number(row.open_finding_count),
          artifactCount: Number(row.branch_artifact_count),
        }),
      );

    const projectId = String(first.project_id);
    // gate-project-status-and-cost-reads — the dashboard status embeds the
    // full cost report via the unchecked same-package assembler. The
    // dashboard summary is available to unprivileged callers, so its cost
    // sub-object is NOT gated here; the privileged internals (recentRuns +
    // translation-memory targetText) are redacted at the API boundary for
    // unprivileged callers, while the standalone cost report read is
    // actor-checked in `getProjectCostReport`.
    const cost = await new ItotoriModelLedgerRepository(this.db).assembleProjectCostReport(
      projectId,
    );
    const selectedStyleGuideBranch =
      branches.find((branch) => branch.currentStyleGuidePolicyVersionId !== null) ??
      branches[0] ??
      null;

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
      selectedLocaleBranchId: selectedStyleGuideBranch?.localeBranchId ?? null,
      currentStyleGuidePolicyVersionId:
        selectedStyleGuideBranch?.currentStyleGuidePolicyVersionId ?? null,
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

  /**
   * gate-runtime-status-reads-and-redact-evidence-previews — actor-checked
   * HERE (repository layer, where the data is read) so an internal caller
   * running as an unprivileged actor cannot bypass the gate and read the
   * evidence-text previews, finding free text, or artifact URIs/hashes.
   * The API boundary additionally redacts the report for unprivileged HTTP
   * callers; this check is the defense-in-depth backstop.
   */
  async getRuntimeStatus(
    actor: AuthorizationActor,
    runtimeRunId?: string,
  ): Promise<RuntimeDashboardStatus> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const requestedRuntimeRunId = runtimeRunId ?? null;
    const result = await this.db.execute(sql`
      with requested_runtime_run as (
        select
          runtime_run_id,
          project_id,
          created_at
        from ${runtimeEvidenceRuns}
        where ${requestedRuntimeRunId}::text is not null
          and runtime_run_id = ${requestedRuntimeRunId}
        limit 1
      ),
      latest_project as (
        select project_id
        from (
          select project_id, 0 as priority, created_at as selected_at
          from requested_runtime_run
          union all
          select project_id, 1 as priority, updated_at as selected_at
          from ${projects}
          where ${requestedRuntimeRunId}::text is null
        ) project_candidates
        order by priority, selected_at desc
        limit 1
      ),
      selected_runtime_run as (
        select
          runtime_run_id,
          project_id,
          runtime_report_artifact_id,
          patch_result_artifact_id,
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
        where (
          ${requestedRuntimeRunId}::text is not null
          and runtime_run_id = ${requestedRuntimeRunId}
        ) or (
          ${requestedRuntimeRunId}::text is null
          and project_id in (select project_id from latest_project)
        )
        order by report_created_at desc, created_at desc
        limit 1
      ),
      selected_runtime_report as (
        select
          artifact_id,
          metadata,
          created_at
        from ${artifacts}
        where project_id in (select project_id from latest_project)
          and artifact_kind = 'runtime_report'
          and (
            artifact_id in (select runtime_report_artifact_id from selected_runtime_run)
            or not exists (select 1 from selected_runtime_run)
          )
        order by created_at desc
        limit 1
      ),
      selected_patch_result as (
        select
          artifact_id,
          metadata,
          created_at
        from ${artifacts}
        where project_id in (select project_id from latest_project)
          and artifact_kind = 'patch_result'
          and (
            artifact_id in (select patch_result_artifact_id from selected_runtime_run)
            or not exists (select 1 from selected_runtime_run)
          )
        order by created_at desc
        limit 1
      )
      select
        coalesce(
          selected_runtime_run.metadata->>'finalStatus',
          selected_patch_result.metadata->>'finalStatus',
          case
            when selected_patch_result.metadata->>'status' in (
              'hello_world_passed',
              'hello_world_failed'
            )
              then selected_patch_result.metadata->>'status'
            when selected_runtime_run.status = 'passed'
              then 'hello_world_passed'
            when selected_runtime_run.status = 'failed'
              then 'hello_world_failed'
            when selected_runtime_report.metadata->>'status' = 'passed'
              then 'hello_world_passed'
            when selected_runtime_report.metadata->>'status' = 'failed'
              then 'hello_world_failed'
            else selected_patch_result.metadata->>'status'
          end
        ) as final_status,
        selected_runtime_run.runtime_run_id as runtime_run_id,
        coalesce(selected_runtime_run.runtime_report_artifact_id, selected_runtime_report.artifact_id)
          as runtime_report_id,
        coalesce(selected_runtime_run.status, selected_runtime_report.metadata->>'status')
          as runtime_status,
        coalesce(selected_runtime_run.fidelity_tier, selected_runtime_report.metadata->>'fidelityTier')
          as fidelity_tier,
        coalesce(selected_runtime_run.evidence_tier, selected_runtime_report.metadata->>'evidenceTier')
          as evidence_tier,
        coalesce(selected_runtime_run.text_event_count::text, selected_runtime_report.metadata->>'textEventCount')
          as text_event_count,
        coalesce(selected_runtime_run.capture_count::text, selected_runtime_report.metadata->>'frameCaptureCount')
          as frame_capture_count,
        coalesce(selected_runtime_run.capture_count::text, selected_runtime_report.metadata->>'screenshotArtifactCount')
          as screenshot_artifact_count,
        coalesce(selected_runtime_run.recording_count::text, selected_runtime_report.metadata->>'recordingArtifactCount')
          as recording_artifact_count,
        coalesce(selected_runtime_run.validation_finding_count::text, selected_runtime_report.metadata->>'validationFindingCount')
          as validation_finding_count
      from latest_project
      left join selected_runtime_run on true
      left join selected_runtime_report on true
      left join selected_patch_result on true
    `);

    const first = result.rows[0] as Record<string, unknown> | undefined;
    if (!first) {
      throw new Error("no Itotori runtime status found");
    }

    const loadedRuntimeRunId = nullableString(first.runtime_run_id);
    const runtimeReportId = nullableString(first.runtime_report_id);
    const [traceEvents, findings, dashboardArtifacts, approximations, unsupportedCapabilities] =
      loadedRuntimeRunId === null
        ? [[], [], [], [], []]
        : await Promise.all([
            this.runtimeDashboardTraceEvents(loadedRuntimeRunId),
            this.runtimeDashboardFindings(loadedRuntimeRunId),
            this.runtimeDashboardArtifacts(loadedRuntimeRunId),
            this.runtimeDashboardApproximations(loadedRuntimeRunId),
            this.runtimeDashboardUnsupportedCapabilities(loadedRuntimeRunId),
          ]);

    return {
      finalStatus: String(first.final_status ?? "missing"),
      runtimeRunId: loadedRuntimeRunId,
      runtimeReportId,
      runtimeStatus: nullableString(first.runtime_status),
      fidelityTier: nullableString(first.fidelity_tier),
      evidenceTier: nullableString(first.evidence_tier),
      textEventCount: Number(first.text_event_count ?? 0),
      frameCaptureCount: Number(first.frame_capture_count ?? 0),
      screenshotArtifactCount: Number(first.screenshot_artifact_count ?? 0),
      recordingArtifactCount: Number(first.recording_artifact_count ?? 0),
      validationFindingCount: Number(first.validation_finding_count ?? 0),
      traceEvents,
      findings,
      artifacts: dashboardArtifacts,
      approximations,
      unsupportedCapabilities,
      limitations: await this.runtimeDashboardLimitations(loadedRuntimeRunId, runtimeReportId),
    };
  }

  private async runtimeDashboardTraceEvents(
    runtimeRunId: string,
  ): Promise<RuntimeDashboardTraceEvent[]> {
    const result = await this.db.execute(sql`
      select
        rei.runtime_evidence_id,
        rei.evidence_kind,
        rei.locale_branch_id,
        rei.bridge_unit_id,
        coalesce(nullif(refs.source_unit_key, ''), su.source_unit_key) as source_unit_key,
        coalesce(rei.metadata->>'eventKind', rei.evidence_kind) as event_kind,
        coalesce(
          rei.metadata->>'runtimeTargetId',
          rei.metadata->'event'->>'runtimeTargetId',
          rei.metadata->>'traceKey',
          rei.metadata->>'branchPointKey'
        ) as runtime_target_id,
        rei.evidence_tier,
        rei.frame,
        coalesce(
          rei.metadata->>'observedText',
          rei.metadata->'event'->>'observedText',
          rei.metadata->>'promptText'
        ) as text_preview,
        rei.artifact_id
      from ${runtimeEvidenceItems} rei
      left join lateral (
        select ref.source_unit_key
        from ${runtimeEvidenceBridgeUnitRefs} ref
        where ref.runtime_evidence_id = rei.runtime_evidence_id
        order by case when ref.ref_role = 'primary' then 0 else 1 end, ref.created_at
        limit 1
      ) refs on true
      left join ${sourceUnits} su on su.bridge_unit_id = rei.bridge_unit_id
      where rei.runtime_run_id = ${runtimeRunId}
        and rei.evidence_kind in ('trace_event', 'branch_event')
      order by rei.frame nulls last, rei.runtime_evidence_id
    `);

    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      const bridgeUnitId = nullableString(record.bridge_unit_id);
      return {
        runtimeEventId: String(record.runtime_evidence_id),
        eventKind: String(record.event_kind ?? record.evidence_kind ?? "unknown"),
        bridgeUnitId,
        sourceUnitKey: nullableString(record.source_unit_key),
        draftId:
          bridgeUnitId === null
            ? null
            : `${String(record.locale_branch_id ?? "runtime")}:${bridgeUnitId}`,
        runtimeTargetId: nullableString(record.runtime_target_id),
        evidenceTier: nullableString(record.evidence_tier),
        frame: nullableNumber(record.frame),
        textPreview: nullableString(record.text_preview),
        artifactIds:
          record.artifact_id === null || record.artifact_id === undefined
            ? []
            : [String(record.artifact_id)],
      };
    });
  }

  private async runtimeDashboardFindings(runtimeRunId: string): Promise<RuntimeDashboardFinding[]> {
    const result = await this.db.execute(sql`
      select
        rvf.finding_id,
        rvf.finding_kind,
        rvf.severity,
        rvf.message,
        rvf.evidence_tier,
        rvf.bridge_unit_id,
        coalesce(
          nullif(rvf.metadata->'bridgeUnitRef'->>'sourceUnitKey', ''),
          su.source_unit_key
        ) as source_unit_key,
        rvf.artifact_id
      from ${runtimeValidationFindings} rvf
      left join ${sourceUnits} su on su.bridge_unit_id = rvf.bridge_unit_id
      where rvf.runtime_run_id = ${runtimeRunId}
      order by rvf.created_at, rvf.finding_id
    `);

    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        findingId: String(record.finding_id),
        findingKind: String(record.finding_kind),
        severity: String(record.severity),
        message: String(record.message),
        evidenceTier: String(record.evidence_tier),
        bridgeUnitId: nullableString(record.bridge_unit_id),
        sourceUnitKey: nullableString(record.source_unit_key),
        artifactId: nullableString(record.artifact_id),
      };
    });
  }

  private async runtimeDashboardArtifacts(
    runtimeRunId: string,
  ): Promise<RuntimeDashboardArtifact[]> {
    const result = await this.db.execute(sql`
      select
        a.artifact_id,
        a.artifact_kind,
        a.uri,
        a.hash,
        a.bridge_unit_id,
        su.source_unit_key,
        coalesce(a.metadata->>'mediaType', a.metadata->'artifactRef'->>'mediaType') as media_type,
        coalesce(a.metadata->>'byteSize', a.metadata->'artifactRef'->>'byteSize') as byte_size,
        a.metadata
      from ${artifacts} a
      left join ${sourceUnits} su on su.bridge_unit_id = a.bridge_unit_id
      where a.metadata->>'runtimeReportId' = ${runtimeRunId}
        and a.artifact_kind in (
          'screenshot',
          'recording',
          'trace_log',
          'frame_capture',
          'reference_comparison'
        )
      order by a.created_at, a.artifact_id
    `);

    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      const uri = nullableString(record.uri);
      const hash = nullableString(record.hash);
      return {
        artifactId: String(record.artifact_id),
        artifactKind: String(record.artifact_kind),
        uri,
        hash,
        mediaType: nullableString(record.media_type),
        byteSize: nullableNumber(record.byte_size),
        bridgeUnitId: nullableString(record.bridge_unit_id),
        sourceUnitKey: nullableString(record.source_unit_key),
        diagnostic: runtimeArtifactDiagnostic(uri, hash, record.metadata),
      };
    });
  }

  private async runtimeDashboardApproximations(
    runtimeRunId: string,
  ): Promise<RuntimeDashboardApproximation[]> {
    const result = await this.db.execute(sql`
      select
        rei.runtime_evidence_id,
        rei.metadata->'approximation'->>'approximationId' as approximation_id,
        rei.metadata->'approximation'->>'approximationTier' as approximation_tier,
        rei.metadata->'approximation'->>'scope' as scope,
        rei.metadata->'approximation'->>'description' as description,
        coalesce(
          rei.metadata->'approximation'->>'evidenceTierCeiling',
          rei.evidence_tier
        ) as evidence_tier_ceiling,
        coalesce(
          jsonb_agg(distinct ref.bridge_unit_id) filter (where ref.bridge_unit_id is not null),
          '[]'::jsonb
        ) as bridge_unit_ids
      from ${runtimeEvidenceItems} rei
      left join ${runtimeEvidenceBridgeUnitRefs} ref
        on ref.runtime_evidence_id = rei.runtime_evidence_id
      where rei.runtime_run_id = ${runtimeRunId}
        and rei.evidence_kind = 'approximation'
      group by rei.runtime_evidence_id, rei.metadata, rei.evidence_tier
      order by rei.runtime_evidence_id
    `);

    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        approximationId: String(record.approximation_id ?? record.runtime_evidence_id),
        approximationTier: String(record.approximation_tier ?? "unknown"),
        scope: String(record.scope ?? "runtime"),
        description: String(record.description ?? "Runtime approximation"),
        evidenceTierCeiling: String(record.evidence_tier_ceiling ?? "unknown"),
        bridgeUnitIds: stringArray(record.bridge_unit_ids),
      };
    });
  }

  private async runtimeDashboardUnsupportedCapabilities(
    runtimeRunId: string,
  ): Promise<RuntimeDashboardUnsupportedCapability[]> {
    const result = await this.db.execute(sql`
      select metadata->'runtimeCapabilities'->'features' as features
      from ${runtimeEvidenceRuns}
      where runtime_run_id = ${runtimeRunId}
      limit 1
    `);
    const features = (result.rows[0] as Record<string, unknown> | undefined)?.features;
    if (!Array.isArray(features)) {
      return [];
    }

    return features.flatMap((feature) => {
      if (!isRecord(feature) || feature.status !== "unsupported") {
        return [];
      }
      return [
        {
          feature: String(feature.feature ?? "unknown"),
          status: String(feature.status),
          fidelityTierCeiling: nullableString(feature.fidelityTierCeiling),
          evidenceTierCeiling: nullableString(feature.evidenceTierCeiling),
          limitations: stringArray(feature.limitations),
        },
      ];
    });
  }

  private async runtimeDashboardLimitations(
    runtimeRunId: string | null,
    runtimeReportId: string | null,
  ): Promise<string[]> {
    const id = runtimeRunId ?? runtimeReportId;
    if (id === null) {
      return [];
    }
    const result = await this.db.execute(sql`
      select coalesce(run.metadata->'limitations', report.metadata->'limitations') as limitations
      from (select ${id}::text as id) ids
      left join ${runtimeEvidenceRuns} run on run.runtime_run_id = ids.id
      left join ${artifacts} report on report.artifact_id = ids.id
      limit 1
    `);
    return stringArray((result.rows[0] as Record<string, unknown> | undefined)?.limitations);
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

  // ITOTORI-060: only currently-active (non-tombstoned) rows can be newly
  // removed by this reimport. Already-tombstoned rows that stay omitted are not
  // re-counted or re-touched.
  const removedIds = existingAssets
    .filter((asset) => asset.removedAt === null && !incomingIds.has(asset.assetId))
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

  // ITOTORI-060: only currently-active (non-tombstoned) rows can be newly
  // removed by this reimport. Already-tombstoned rows that stay omitted are not
  // re-counted or re-touched.
  const removedIds = existingUnits
    .filter((unit) => unit.removedAt === null && !incomingIds.has(unit.bridgeUnitId))
    .map((unit) => unit.bridgeUnitId);
  return { added, updated, removed: removedIds.length, unchanged, removedIds };
}

function assetMatchesExisting(asset: BridgeAssetV02, existingAsset: ExistingAsset): boolean {
  return (
    // ITOTORI-060: a tombstoned row being re-added is a state change (revive),
    // never "unchanged".
    existingAsset.removedAt === null &&
    existingAsset.sourceRevisionId === asset.sourceRevision.revisionId &&
    existingAsset.assetKey === asset.assetKey &&
    existingAsset.assetKind === asset.assetKind &&
    existingAsset.sourceHash === asset.sourceHash &&
    existingAsset.path === (asset.path ?? null)
  );
}

function unitMatchesExisting(unit: LocalizationUnitV02, existingUnit: ExistingSourceUnit): boolean {
  return (
    // ITOTORI-060: a tombstoned row being re-added is a state change (revive),
    // never "unchanged".
    existingUnit.removedAt === null &&
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

async function staleContextArtifactsAfterSourceImport(
  db: ItotoriDatabase,
  input: {
    projectId: string;
    localeBranchId: string;
    currentSourceBundleRevisionId: string;
  },
): Promise<void> {
  await db
    .update(contextArtifacts)
    .set({
      status: contextArtifactStatusValues.stale,
      invalidatedReason: "source_import",
      invalidatedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(contextArtifacts.projectId, input.projectId),
        eq(contextArtifacts.localeBranchId, input.localeBranchId),
        eq(contextArtifacts.status, contextArtifactStatusValues.active),
        sql`(
          ${contextArtifacts.sourceRevisionId} <> ${input.currentSourceBundleRevisionId}
          or exists (
            select 1
            from itotori_context_artifact_source_units casu
            left join itotori_source_units su on su.bridge_unit_id = casu.bridge_unit_id
            where casu.context_artifact_id = ${contextArtifacts.contextArtifactId}
              and (
                su.bridge_unit_id is null
                or su.source_revision_id <> casu.source_revision_id
                or su.source_hash <> casu.source_hash
              )
          )
        )`,
      ),
    );
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
  adapterLocalFindingId: string;
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
  validationRecords: RuntimeValidationFindingRecord[],
): string[] {
  return Array.from(
    new Set([
      runtimeReportId,
      patchResultId,
      ...artifactLinks.map((artifact) => artifact.artifactId),
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
      const artifactId = runtimeChildIdFor(report.runtimeReportId, frame.frameCaptureId);
      return {
        artifactId,
        artifactKind: "frame_capture",
        uri: frame.artifactPath,
        hash: undefined,
        bridgeUnitId: frame.bridgeUnitId,
        metadata: {
          adapterLocalArtifactId: frame.frameCaptureId,
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
            artifactLinkFromRef(
              report.runtimeReportId,
              event.artifactRef,
              event.bridgeUnitRef.bridgeUnitId,
              {
                evidenceKind: runtimeEvidenceKindValues.traceEvent,
                traceEventId: event.traceEventId,
                frame: event.frame,
                traceKey: event.traceKey,
              },
            ),
          ],
    ),
    ...report.captures.map((capture) => ({
      ...artifactLinkFromRef(
        report.runtimeReportId,
        capture.artifactRef,
        capture.bridgeUnitRef.bridgeUnitId,
        {
          evidenceKind: runtimeEvidenceKindValues.capture,
          captureId: capture.captureId,
          evidenceTier: capture.evidenceTier,
          frame: capture.frame,
          width: capture.width,
          height: capture.height,
          nonZeroPixels: capture.nonZeroPixels,
          region: capture.region ?? null,
        },
      ),
    })),
    ...report.recordings.map((recording) => ({
      ...artifactLinkFromRef(
        report.runtimeReportId,
        recording.artifactRef,
        recording.bridgeUnitRef.bridgeUnitId,
        {
          evidenceKind: runtimeEvidenceKindValues.recording,
          recordingId: recording.recordingId,
          evidenceTier: recording.evidenceTier,
          startedAtFrame: recording.startedAtFrame,
          frameCount: recording.frameCount,
          width: recording.width,
          height: recording.height,
          encoding: recording.encoding,
        },
      ),
    })),
    ...(report.referenceComparisons ?? []).map((comparison) =>
      artifactLinkFromRef(
        report.runtimeReportId,
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
  runtimeReportId: string,
  artifactRef: RuntimeArtifactRefV02,
  bridgeUnitId: string | undefined,
  metadata: Record<string, unknown>,
): RuntimeArtifactLink {
  assertPortableRuntimeSchemaArtifactUri(artifactRef.uri);
  const storedArtifactRef = runtimeArtifactRefForDb(artifactRef, runtimeReportId);
  const adapterLocalArtifactRef = runtimeArtifactRefForDb(artifactRef);
  return {
    artifactId: storedArtifactRef.artifactId,
    artifactKind: storedArtifactRef.artifactKind,
    uri: storedArtifactRef.uri,
    hash: storedArtifactRef.hash,
    bridgeUnitId,
    metadata: {
      ...metadata,
      artifactRef: storedArtifactRef,
      adapterLocalArtifactId: adapterLocalArtifactRef.artifactId,
      adapterLocalArtifactRef,
      mediaType: storedArtifactRef.mediaType ?? null,
      byteSize: storedArtifactRef.byteSize ?? null,
    },
  };
}

function runtimeEvidenceItemsFor(report: RuntimeReportInput): RuntimeEvidenceItemInput[] {
  if (!isRuntimeEvidenceReportV02(report)) {
    return [
      ...report.textEvents.map((event) => ({
        runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, event.runtimeTextEventId),
        evidenceKind: runtimeEvidenceKindValues.traceEvent,
        bridgeUnitId: event.bridgeUnitId,
        artifactId: undefined,
        artifactKind: undefined,
        portableArtifactUri: undefined,
        evidenceTier: null,
        frame: event.frame,
        metadata: { adapterLocalEvidenceId: event.runtimeTextEventId, event },
        bridgeUnitRefs: [
          {
            bridgeUnitId: event.bridgeUnitId,
            refRole: runtimeBridgeUnitRefRoleValues.primary,
          },
        ],
      })),
      ...report.frameCaptures.map((frame) => ({
        runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, frame.frameCaptureId),
        evidenceKind: runtimeEvidenceKindValues.capture,
        bridgeUnitId: frame.bridgeUnitId,
        artifactId: runtimeChildIdFor(report.runtimeReportId, frame.frameCaptureId),
        artifactKind: "frame_capture",
        portableArtifactUri: undefined,
        evidenceTier: null,
        frame: undefined,
        metadata: {
          adapterLocalEvidenceId: frame.frameCaptureId,
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
        assertPortableRuntimeSchemaArtifactUri(artifactRef.uri);
      }
      const storedArtifactRef =
        artifactRef === undefined
          ? undefined
          : runtimeArtifactRefForDb(artifactRef, report.runtimeReportId);
      return {
        runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, event.traceEventId),
        evidenceKind: runtimeEvidenceKindValues.traceEvent,
        bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
        artifactId: storedArtifactRef?.artifactId,
        artifactKind: artifactRef?.artifactKind ?? "runtime_trace_event",
        portableArtifactUri: storedArtifactRef?.uri,
        evidenceTier: null,
        frame: event.frame,
        metadata: {
          adapterLocalEvidenceId: event.traceEventId,
          eventKind: event.eventKind,
          traceKey: event.traceKey,
          observedText: event.observedText,
          artifactRef: storedArtifactRef ?? null,
          adapterLocalArtifactRef:
            artifactRef === undefined ? null : runtimeArtifactRefForDb(artifactRef),
          event: runtimeTraceEventForDb(event),
        },
        bridgeUnitRefs: [
          bridgeUnitLink(event.bridgeUnitRef, runtimeBridgeUnitRefRoleValues.primary),
        ],
      };
    }),
    ...report.branchEvents.map((event) => ({
      runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, event.branchEventId),
      evidenceKind: runtimeEvidenceKindValues.branchEvent,
      bridgeUnitId: event.bridgeUnitRef.bridgeUnitId,
      artifactId: undefined,
      artifactKind: "runtime_branch_event",
      portableArtifactUri: undefined,
      evidenceTier: null,
      frame: event.frame,
      metadata: {
        adapterLocalEvidenceId: event.branchEventId,
        branchPointKey: event.branchPointKey,
        selectedOptionId: event.selectedOptionId,
        event: runtimeBranchEventForDb(event),
      },
      bridgeUnitRefs: runtimeBranchEventBridgeUnitLinks(event),
    })),
    ...report.captures.map((capture) => {
      assertPortableRuntimeSchemaArtifactUri(capture.artifactRef.uri);
      const storedArtifactRef = runtimeArtifactRefForDb(
        capture.artifactRef,
        report.runtimeReportId,
      );
      return {
        runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, capture.captureId),
        evidenceKind: runtimeEvidenceKindValues.capture,
        bridgeUnitId: capture.bridgeUnitRef.bridgeUnitId,
        artifactId: storedArtifactRef.artifactId,
        artifactKind: capture.artifactRef.artifactKind,
        portableArtifactUri: storedArtifactRef.uri,
        evidenceTier: capture.evidenceTier,
        frame: capture.frame,
        metadata: {
          adapterLocalEvidenceId: capture.captureId,
          width: capture.width,
          height: capture.height,
          nonZeroPixels: capture.nonZeroPixels,
          region: capture.region ?? null,
          artifactRef: storedArtifactRef,
          adapterLocalArtifactRef: runtimeArtifactRefForDb(capture.artifactRef),
          capture: runtimeCaptureForDb(capture),
        },
        bridgeUnitRefs: [
          bridgeUnitLink(capture.bridgeUnitRef, runtimeBridgeUnitRefRoleValues.primary),
        ],
      };
    }),
    ...report.recordings.map((recording) => {
      assertPortableRuntimeSchemaArtifactUri(recording.artifactRef.uri);
      const storedArtifactRef = runtimeArtifactRefForDb(
        recording.artifactRef,
        report.runtimeReportId,
      );
      return {
        runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, recording.recordingId),
        evidenceKind: runtimeEvidenceKindValues.recording,
        bridgeUnitId: recording.bridgeUnitRef.bridgeUnitId,
        artifactId: storedArtifactRef.artifactId,
        artifactKind: recording.artifactRef.artifactKind,
        portableArtifactUri: storedArtifactRef.uri,
        evidenceTier: recording.evidenceTier,
        frame: recording.startedAtFrame,
        metadata: {
          adapterLocalEvidenceId: recording.recordingId,
          recording: runtimeRecordingForDb(recording),
          frameCount: recording.frameCount,
          width: recording.width,
          height: recording.height,
          encoding: recording.encoding,
          artifactRef: storedArtifactRef,
          adapterLocalArtifactRef: runtimeArtifactRefForDb(recording.artifactRef),
        },
        bridgeUnitRefs: [
          bridgeUnitLink(recording.bridgeUnitRef, runtimeBridgeUnitRefRoleValues.primary),
        ],
      };
    }),
    ...report.approximations.map((approximation) => ({
      runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, approximation.approximationId),
      evidenceKind: runtimeEvidenceKindValues.approximation,
      bridgeUnitId: approximation.affectedBridgeUnitRefs[0]?.bridgeUnitId,
      artifactId: undefined,
      artifactKind: undefined,
      portableArtifactUri: undefined,
      evidenceTier: approximation.evidenceTierCeiling,
      frame: undefined,
      metadata: { adapterLocalEvidenceId: approximation.approximationId, approximation },
      bridgeUnitRefs: approximation.affectedBridgeUnitRefs.map((ref) =>
        bridgeUnitLink(ref, runtimeBridgeUnitRefRoleValues.affected),
      ),
    })),
    ...(report.referenceComparisons ?? []).map((comparison) => {
      assertPortableRuntimeSchemaArtifactUri(comparison.artifactRef.uri);
      const storedArtifactRef = runtimeArtifactRefForDb(
        comparison.artifactRef,
        report.runtimeReportId,
      );
      return {
        runtimeEvidenceId: runtimeChildIdFor(report.runtimeReportId, comparison.comparisonId),
        evidenceKind: runtimeEvidenceKindValues.referenceComparison,
        bridgeUnitId: comparison.coveredBridgeUnitRefs[0]?.bridgeUnitId,
        artifactId: storedArtifactRef.artifactId,
        artifactKind: comparison.artifactRef.artifactKind,
        portableArtifactUri: storedArtifactRef.uri,
        evidenceTier: "E4",
        frame: undefined,
        metadata: {
          adapterLocalEvidenceId: comparison.comparisonId,
          comparison: runtimeReferenceComparisonForDb(comparison),
          artifactRef: storedArtifactRef,
          adapterLocalArtifactRef: runtimeArtifactRefForDb(comparison.artifactRef),
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
  const findingId = runtimeChildIdFor(report.runtimeReportId, finding.findingId);
  const artifactRef =
    finding.artifactRef === undefined
      ? undefined
      : runtimeArtifactRefForDb(finding.artifactRef, report.runtimeReportId);
  if (finding.artifactRef !== undefined) {
    assertPortableRuntimeSchemaArtifactUri(finding.artifactRef.uri);
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
    findingId,
    adapterLocalFindingId: finding.findingId,
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
      adapterLocalFindingId: finding.findingId,
      finding: runtimeValidationFindingForDb(finding),
      bridgeUnitRef: finding.bridgeUnitRef ?? null,
      artifactRef: artifactRef ?? null,
      adapterLocalArtifactRef:
        finding.artifactRef === undefined ? null : runtimeArtifactRefForDb(finding.artifactRef),
    },
  };
}

function runtimeArtifactRefForDb(
  artifactRef: RuntimeArtifactRefV02,
  runtimeReportId?: string,
): RuntimeArtifactRefV02 {
  assertPortableRuntimeSchemaArtifactUri(artifactRef.uri);
  const artifactId =
    runtimeReportId === undefined
      ? artifactRef.artifactId
      : runtimeChildIdFor(runtimeReportId, artifactRef.artifactId);
  const artifactKind = artifactRef.artifactKind;
  const uri =
    runtimeReportId === undefined
      ? artifactRef.uri
      : runtimeManagedArtifactUriForDb(artifactRef, runtimeReportId);
  const mediaType = artifactRef.mediaType;
  const byteSize = artifactRef.byteSize;
  return {
    artifactId,
    artifactKind,
    uri,
    hash:
      artifactRef.hash ??
      runtimeManagedArtifactHash({
        artifactId,
        artifactKind,
        uri,
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(byteSize === undefined ? {} : { byteSize }),
      }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(byteSize === undefined ? {} : { byteSize }),
  };
}

function runtimeChildIdFor(runtimeReportId: string, adapterLocalId: string): string {
  // Runtime adapter child ids are only unique within a report. Repository-owned child
  // evidence rows and derived child artifacts use run-qualified ids to prevent cross-run moves.
  return `${runtimeReportId}:${adapterLocalId}`;
}

function runtimeManagedArtifactHash(ref: {
  artifactId: string;
  artifactKind: string;
  uri: string;
  mediaType?: string;
  byteSize?: number;
}): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(ref)).digest("hex")}`;
}

const RUNTIME_MANAGED_ARTIFACT_URI_ROOT = "artifacts/utsushi/runtime";

const RUNTIME_ARTIFACT_KIND_DIRECTORIES: Record<RuntimeArtifactKindV02, string> = {
  trace_log: "traces",
  screenshot: "screenshots",
  recording: "recordings",
  capture_metadata: "frame-captures",
  reference_comparison: "conformance-reports",
  runtime_report: "reports",
};

const RUNTIME_ARTIFACT_KIND_EXTENSIONS: Record<RuntimeArtifactKindV02, string> = {
  trace_log: ".json",
  screenshot: ".png",
  recording: ".webm",
  capture_metadata: ".json",
  reference_comparison: ".json",
  runtime_report: ".json",
};

function runtimeManagedArtifactUriForDb(
  artifactRef: RuntimeArtifactRefV02,
  runtimeReportId: string,
): string {
  if (artifactRef.uri.startsWith(`${RUNTIME_MANAGED_ARTIFACT_URI_ROOT}/`)) {
    return artifactRef.uri;
  }
  const directory = RUNTIME_ARTIFACT_KIND_DIRECTORIES[artifactRef.artifactKind];
  const extension =
    runtimeArtifactUriExtension(artifactRef.uri) ??
    RUNTIME_ARTIFACT_KIND_EXTENSIONS[artifactRef.artifactKind];
  return [
    RUNTIME_MANAGED_ARTIFACT_URI_ROOT,
    runtimeReportId,
    directory,
    `${artifactRef.artifactId}${extension}`,
  ].join("/");
}

function runtimeArtifactUriExtension(uri: string): string | undefined {
  const filename = uri.split("/").at(-1) ?? "";
  const match = filename.match(/\.[A-Za-z0-9]+$/);
  return match?.[0];
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
  assertPortableRuntimeArtifactUri(uri, { allowFixtureUri: false, requireManagedRoot: true });
}

function assertPortableRuntimeSchemaArtifactUri(uri: string): void {
  assertPortableRuntimeArtifactUri(uri, { allowFixtureUri: false, requireManagedRoot: false });
}

function assertPortableLegacyRuntimeArtifactUri(uri: string): void {
  assertPortableRuntimeArtifactUri(uri, { allowFixtureUri: true, requireManagedRoot: false });
}

function assertPortableRuntimeArtifactUri(
  uri: string,
  options: { allowFixtureUri: boolean; requireManagedRoot: boolean },
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
  if (options.requireManagedRoot && !uri.startsWith(`${RUNTIME_MANAGED_ARTIFACT_URI_ROOT}/`)) {
    throw new Error(
      `runtime artifact uri must be under managed runtime artifact root ${RUNTIME_MANAGED_ARTIFACT_URI_ROOT}/: ${uri}`,
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

function benchmarkReportSummaryFromRow(row: Record<string, unknown>): BenchmarkReportSummary {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at ?? metadata.createdAt ?? "");
  const qaAgentsRaw = Array.isArray(metadata.qaAgents) ? metadata.qaAgents : [];
  return {
    benchmarkRunId: String(row.artifact_id),
    projectId: String(row.project_id),
    localeBranchId: nullableString(row.locale_branch_id),
    benchmarkName: String(metadata.benchmarkName ?? ""),
    status: String(metadata.status ?? "unknown"),
    createdAt,
    sourceLocale: String(metadata.sourceLocale ?? ""),
    targetLocale: String(metadata.targetLocale ?? ""),
    systemCount: Number(metadata.systemCount ?? 0),
    findingCount: Number(metadata.findingCount ?? 0),
    penaltyTotal: Number(metadata.penaltyTotal ?? 0),
    qaAgents: qaAgentsRaw.map(benchmarkQaAgentSummaryFromMetadata),
  };
}

function benchmarkQaAgentSummaryFromMetadata(value: unknown): BenchmarkQaAgentSummary {
  const record = isRecord(value) ? value : {};
  return {
    qaAgentId: String(record.qaAgentId ?? ""),
    qaAgentVersion: String(record.qaAgentVersion ?? ""),
    evaluatedSystemId: String(record.evaluatedSystemId ?? ""),
    truePositives: Number(record.truePositives ?? 0),
    falsePositives: Number(record.falsePositives ?? 0),
    falseNegatives: Number(record.falseNegatives ?? 0),
    seededPrecision: Number(record.seededPrecision ?? 0),
    seededRecall: Number(record.seededRecall ?? 0),
    f1: Number(record.f1 ?? 0),
    findingsEmitted: Number(record.findingsEmitted ?? 0),
    scorableFindings: Number(record.scorableFindings ?? 0),
  };
}

async function getApprovedStyleGuideVersionIdInTx(
  db: Pick<ItotoriDatabase, "select">,
  localeBranchId: string,
): Promise<string | null> {
  const rows = await db
    .select({ approvedVersionId: styleGuides.approvedVersionId })
    .from(styleGuides)
    .where(eq(styleGuides.localeBranchId, localeBranchId))
    .limit(1);
  return rows[0]?.approvedVersionId ?? null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => (typeof entry === "string" && entry.length > 0 ? [entry] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePatchExportContract(
  patchExport: PatchExport | PatchExportV02,
  bridge: BridgeBundle | BridgeBundleV02,
): void {
  if (patchExport.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertPatchExportV02(patchExport);
    if (bridge.schemaVersion !== BRIDGE_SCHEMA_VERSION_V02) {
      throw new Error("PatchExportV02 requires a v0.2 source bridge");
    }
    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);
    if (report.status !== "compatible") {
      const reasons = report.incompatibleUnits.map((unit) => unit.reason ?? "unknown").join(", ");
      throw new Error(`PatchExportV02 source compatibility failed: ${reasons}`);
    }
    return;
  }
  assertPatchExport(patchExport);
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function runtimeArtifactDiagnostic(
  uri: string | null,
  hash: string | null,
  metadata: unknown,
): string | null {
  const redactedFields =
    isRecord(metadata) && Array.isArray(metadata.redactedFields)
      ? stringArray(metadata.redactedFields)
      : [];
  if (redactedFields.length > 0) {
    return `redacted fields: ${redactedFields.join(", ")}`;
  }
  if (uri === null) {
    return "artifact record has no managed artifact-store URI";
  }
  try {
    assertPortableRelativeArtifactUri(uri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `blocked unmanaged artifact link: ${message}`;
  }
  if (hash === null) {
    return "managed artifact link missing content hash";
  }
  return null;
}
