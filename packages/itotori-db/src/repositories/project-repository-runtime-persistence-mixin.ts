import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";
import { ProjectRepositoryBase } from "./project-repository-base.js";

export class ProjectRuntimePersistenceRepository extends ProjectRepositoryBase {
  constructor(
    db: deps.ItotoriDatabase,
    engineFamilyRegistry: api.ProjectEngineFamilyRegistry,
    private readonly getDashboardStatusForProject: (
      projectId: string,
    ) => Promise<api.ProjectDashboardStatus>,
  ) {
    super(db, engineFamilyRegistry);
  }

  async saveRuntimeReport(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
    runtimeReport: unknown,
    patchResultId: string,
  ): Promise<api.ProjectDashboardStatus> {
    deps.assertRuntimeEvidenceReportV02(runtimeReport);
    await deps.requirePermission(this.db, actor, deps.permissionValues.runtimeIngest);
    const runtimeReportId = helpers.runtimeReportIdFor(runtimeReport);
    const adapterName = helpers.runtimeAdapterName(runtimeReport);
    const adapterVersion = helpers.runtimeAdapterVersion(runtimeReport);
    const runtimeStatus = helpers.runtimeReportStatus(runtimeReport);
    const finalStatus = helpers.runtimeFinalStatus(runtimeStatus);
    const fidelityTier = helpers.runtimeFidelityTier(runtimeReport);
    const evidenceTier = helpers.runtimeEvidenceTier(runtimeReport);
    const textEventCount = helpers.runtimeTextEventCount(runtimeReport);
    const branchEventCount = helpers.runtimeBranchEventCount(runtimeReport);
    const frameCaptureCount = helpers.runtimeFrameCaptureCount(runtimeReport);
    const screenshotArtifactCount = helpers.runtimeScreenshotArtifactCount(runtimeReport);
    const recordingArtifactCount = helpers.runtimeRecordingArtifactCount(runtimeReport);
    const validationFindingCount = helpers.runtimeValidationFindingCount(runtimeReport);
    const referenceComparisonCount = helpers.runtimeReferenceComparisonCount(runtimeReport);
    const reportCreatedAt = helpers.runtimeReportCreatedAt(runtimeReport);
    const runtimeReportMetadata = helpers.runtimeReportMetadataFor(runtimeReport, {
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
    const artifactLinks = helpers.runtimeArtifactLinks(runtimeReport);
    const evidenceItems = helpers.runtimeEvidenceItemsFor(runtimeReport);
    const validationRecords = helpers.runtimeValidationFindingRecords(runtimeReport);
    const recordedEventId = `${runtimeReportId}:recorded`;

    await this.db.transaction(async (tx) => {
      const { sourceBundleId, sourceBundleRevisionId } =
        await helpers.resolveSourceBundlePersistenceTarget(tx, project);
      const retainedRuntimeArtifactIds = helpers.runtimeProjectionArtifactIds(
        runtimeReportId,
        patchResultId,
        artifactLinks,
        validationRecords,
      );

      await tx
        .insert(deps.artifacts)
        .values({
          artifactId: runtimeReportId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceBundleId,
          artifactKind: "runtime_report",
          metadata: runtimeReportMetadata,
        })
        .onConflictDoUpdate({
          target: deps.artifacts.artifactId,
          set: {
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            metadata: runtimeReportMetadata,
          },
        });

      await tx
        .insert(deps.artifacts)
        .values({
          artifactId: patchResultId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceBundleId,
          artifactKind: "patch_result",
          metadata: { status: runtimeStatus, finalStatus, runtimeReportId },
        })
        .onConflictDoUpdate({
          target: deps.artifacts.artifactId,
          set: {
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            metadata: { status: runtimeStatus, finalStatus, runtimeReportId },
          },
        });

      for (const artifactLink of artifactLinks) {
        await tx
          .insert(deps.artifacts)
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
            target: deps.artifacts.artifactId,
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

      await helpers.cleanupRuntimeReportProjection(
        tx,
        runtimeReportId,
        project.projectId,
        retainedRuntimeArtifactIds,
      );

      await tx
        .insert(deps.runtimeEvidenceRuns)
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
          target: deps.runtimeEvidenceRuns.runtimeRunId,
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
            updatedAt: deps.sql`now()`,
          },
        });

      for (const item of evidenceItems) {
        await tx
          .insert(deps.runtimeEvidenceItems)
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
            target: deps.runtimeEvidenceItems.runtimeEvidenceId,
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
              updatedAt: deps.sql`now()`,
            },
          });

        await tx
          .delete(deps.runtimeEvidenceBridgeUnitRefs)
          .where(
            deps.eq(deps.runtimeEvidenceBridgeUnitRefs.runtimeEvidenceId, item.runtimeEvidenceId),
          );

        for (const ref of item.bridgeUnitRefs) {
          await tx.insert(deps.runtimeEvidenceBridgeUnitRefs).values({
            runtimeEvidenceId: item.runtimeEvidenceId,
            bridgeUnitId: ref.bridgeUnitId,
            refRole: ref.refRole,
            sourceUnitKey: ref.sourceUnitKey ?? "",
            metadata: ref.metadata ?? {},
          });
        }
      }

      await tx
        .insert(deps.events)
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
          .insert(deps.findings)
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
            target: deps.findings.findingId,
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
              updatedAt: deps.sql`now()`,
            },
          });

        if (validation.artifactRef !== undefined) {
          await tx
            .insert(deps.artifacts)
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
              target: deps.artifacts.artifactId,
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
          .insert(deps.runtimeValidationFindings)
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
            target: deps.runtimeValidationFindings.findingId,
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
              updatedAt: deps.sql`now()`,
            },
          });
      }

      await tx
        .update(deps.projects)
        .set({ status: deps.projectStatusValues.runtimeIngested, updatedAt: deps.sql`now()` })
        .where(deps.eq(deps.projects.projectId, project.projectId));
    });

    return this.getDashboardStatusForProject(project.projectId);
  }
}
