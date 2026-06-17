import { eq, sql } from "drizzle-orm";
import type {
  BridgeAssetV02,
  BridgeBundle,
  BridgeBundleV02,
  FindingRecordV02,
  LocalizationUnitV02,
  PatchExport,
  PatchExportV02,
  RuntimeArtifactRefV02,
  RuntimeBridgeUnitRefV02,
  RuntimeEvidenceReportV02,
  RuntimeValidationFindingV02,
  RuntimeVerificationReport,
  SourceRevisionV02,
  TriageEventV02,
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
  patchExport?: PatchExport | PatchExportV02;
  runtimeReport?: RuntimeVerificationReport | RuntimeEvidenceReportV02;
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

export interface ItotoriProjectRepositoryPort {
  reset(actor: AuthorizationActor): Promise<void>;
  importSourceBundle(actor: AuthorizationActor, project: ItotoriProjectRecord): Promise<void>;
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
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.projectImport);
    const normalized = normalizeSourceBundle(project);

    await this.db.transaction(async (tx) => {
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
          sourceLocale: normalized.sourceLocale,
          status: projectStatusValues.imported,
          gameId: normalized.sourceGame.gameId,
          gameVersion: normalized.sourceGame.gameVersion,
          sourceProfileId: normalized.sourceGame.sourceProfileId,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: projects.projectId,
          set: {
            sourceLocale: normalized.sourceLocale,
            status: projectStatusValues.imported,
            gameId: normalized.sourceGame.gameId,
            gameVersion: normalized.sourceGame.gameVersion,
            sourceProfileId: normalized.sourceGame.sourceProfileId,
            updatedAt: sql`now()`,
          },
        });

      for (const revision of normalized.revisions) {
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
          sourceBundleId: normalized.sourceBundleId,
          projectId: project.projectId,
          sourceBundleRevisionId: normalized.sourceBundleRevision.revisionId,
          bridgeId: normalized.bridgeId,
          schemaVersion: normalized.schemaVersion,
          sourceBundleHash: normalized.sourceBundleHash,
          sourceLocale: normalized.sourceLocale,
          extractorName: normalized.extractor.name,
          extractorVersion: normalized.extractor.version,
          unitCount: normalized.units.length,
          assetCount: normalized.assets.length,
        })
        .onConflictDoUpdate({
          target: sourceBundles.sourceBundleId,
          set: {
            sourceBundleRevisionId: normalized.sourceBundleRevision.revisionId,
            sourceBundleHash: normalized.sourceBundleHash,
            sourceLocale: normalized.sourceLocale,
            extractorName: normalized.extractor.name,
            extractorVersion: normalized.extractor.version,
            unitCount: normalized.units.length,
            assetCount: normalized.assets.length,
          },
        });

      for (const asset of normalized.assets) {
        await tx
          .insert(assets)
          .values({
            assetId: asset.assetId,
            projectId: project.projectId,
            sourceBundleId: normalized.sourceBundleId,
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

      for (const unit of normalized.units) {
        await tx
          .insert(sourceUnits)
          .values({
            bridgeUnitId: unit.bridgeUnitId,
            projectId: project.projectId,
            sourceBundleId: normalized.sourceBundleId,
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
              sourceBundleId: normalized.sourceBundleId,
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

      await tx
        .insert(localeBranches)
        .values({
          localeBranchId: project.localeBranchId,
          projectId: project.projectId,
          sourceBundleId: normalized.sourceBundleId,
          targetLocale: project.targetLocale,
          branchName: project.targetLocale,
          status: localeBranchStatusValues.active,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: localeBranches.localeBranchId,
          set: {
            sourceBundleId: normalized.sourceBundleId,
            targetLocale: project.targetLocale,
            branchName: project.targetLocale,
            status: localeBranchStatusValues.active,
            updatedAt: sql`now()`,
          },
        });

      for (const unit of normalized.units) {
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
    const sourceBundleId = sourceBundleIdFor(project.bridge);
    await this.db.transaction(async (tx) => {
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
    const sourceBundleId = sourceBundleIdFor(project.bridge);
    const sourceBundleRevisionId = sourceBundleRevisionIdFor(project.bridge);
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
          set: { metadata: { status: runtimeStatus, finalStatus, runtimeReportId } },
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
              bridgeUnitId: eventArtifact.bridgeUnitId,
              metadata: eventArtifact.metadata,
            },
          });
      }

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
      latest_bundle as (
        select
          source_bundle_id,
          project_id,
          source_bundle_hash,
          source_bundle_revision_id
        from ${sourceBundles}
        where project_id in (select project_id from latest_project)
        order by imported_at desc
        limit 1
      )
      select
        p.project_id,
        p.project_key,
        p.name,
        p.status,
        p.source_locale,
        lb.source_bundle_id,
        lb.source_bundle_hash,
        lb.source_bundle_revision_id,
        b.locale_branch_id,
        b.target_locale,
        b.status as branch_status,
        count(distinct su.bridge_unit_id)::int as unit_count,
        count(distinct lbu.bridge_unit_id) filter (where lbu.target_text is not null)::int as translated_unit_count,
        totals.finding_count::int as finding_count,
        count(distinct f_branch.finding_id) filter (where f_branch.status = 'open')::int as open_finding_count,
        totals.artifact_count::int as artifact_count,
        count(distinct a_branch.artifact_id)::int as branch_artifact_count,
        latest_event.event_kind as latest_event_kind,
        latest_event.occurred_at as latest_event_at
      from ${projects} p
      join latest_project lp on lp.project_id = p.project_id
      join latest_bundle lb on lb.project_id = p.project_id
      left join ${localeBranches} b on b.project_id = p.project_id
      left join ${sourceUnits} su on su.source_bundle_id = lb.source_bundle_id
      left join ${localeBranchUnits} lbu
        on lbu.locale_branch_id = b.locale_branch_id
        and lbu.bridge_unit_id = su.bridge_unit_id
      left join itotori_findings f_branch
        on f_branch.project_id = p.project_id
        and f_branch.locale_branch_id = b.locale_branch_id
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
        lb.source_bundle_id,
        lb.source_bundle_hash,
        lb.source_bundle_revision_id,
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
      cost,
      localeBranches: branches,
    };
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

function sourceBundleRevisionIdFor(bundle: BridgeBundle | BridgeBundleV02): string {
  return isBridgeBundleV02(bundle)
    ? bundle.sourceBundleRevision.revisionId
    : `${bundle.bridgeId}:bundle-revision`;
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
  return {
    artifactId: artifactRef.artifactId,
    artifactKind: artifactRef.artifactKind,
    uri: artifactRef.uri,
    hash: artifactRef.hash,
    bridgeUnitId,
    metadata: {
      ...metadata,
      artifactRef,
      mediaType: artifactRef.mediaType ?? null,
      byteSize: artifactRef.byteSize ?? null,
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
        event,
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
        event,
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
          artifactRef: artifactRef ?? null,
          event,
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
        event,
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
          capture,
          width: capture.width,
          height: capture.height,
          nonZeroPixels: capture.nonZeroPixels,
          region: capture.region ?? null,
          artifactRef: capture.artifactRef,
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
          recording,
          frameCount: recording.frameCount,
          width: recording.width,
          height: recording.height,
          encoding: recording.encoding,
          artifactRef: recording.artifactRef,
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
        metadata: { comparison, artifactRef: comparison.artifactRef },
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
      artifactRef: finding.artifactRef ?? null,
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
    artifactRef: finding.artifactRef,
    title: `Runtime validation: ${finding.findingKind}`,
    impact: "Runtime evidence may be incomplete or invalid for this report.",
    affectedRefs,
    evidence,
    provenance,
    metadata: {
      schemaVersion: report.schemaVersion,
      runtimeReportId: report.runtimeReportId,
      finding,
      bridgeUnitRef: finding.bridgeUnitRef ?? null,
      artifactRef: finding.artifactRef ?? null,
    },
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
}

function isRuntimeEvidenceReportV02(
  report: RuntimeReportInput,
): report is RuntimeEvidenceReportV02 {
  return report.schemaVersion === "0.2.0";
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
