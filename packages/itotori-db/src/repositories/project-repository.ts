import { eq, sql } from "drizzle-orm";
import type {
  BridgeAssetV02,
  BridgeBundle,
  BridgeBundleV02,
  FindingRecordV02,
  LocalizationUnitV02,
  PatchExport,
  PatchExportV02,
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
import {
  artifacts,
  assets,
  events,
  findings,
  localeBranches,
  localeBranchStatusValues,
  localeBranchUnits,
  projectStatusValues,
  projects,
  sourceBundles,
  sourceRevisions,
  sourceUnits,
  workspaces,
} from "../schema.js";

export const defaultWorkspaceId = "local-workspace";
export const defaultWorkspaceName = "Local workspace";

export type ItotoriProjectRecord = {
  projectId: string;
  bridge: BridgeBundle | BridgeBundleV02;
  localeBranchId: string;
  targetLocale: string;
  drafts: Record<string, string>;
  patchExport?: PatchExport | PatchExportV02;
  runtimeReport?: RuntimeVerificationReport;
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
  localeBranches: LocaleBranchStatus[];
};

export type RuntimeDashboardStatus = {
  finalStatus: string;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  textEventCount: number;
  frameCaptureCount: number;
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
    runtimeReport: RuntimeVerificationReport,
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
    runtimeReport: RuntimeVerificationReport,
    patchResultId: string,
  ): Promise<ProjectDashboardStatus> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    const sourceBundleId = sourceBundleIdFor(project.bridge);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(artifacts)
        .values({
          artifactId: runtimeReport.runtimeReportId,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          sourceBundleId,
          artifactKind: "runtime_report",
          metadata: {
            schemaVersion: runtimeReport.schemaVersion,
            adapterName: runtimeReport.adapterName,
            fidelityTier: runtimeReport.fidelityTier,
            status: runtimeReport.status,
            textEventCount: runtimeReport.textEvents.length,
            frameCaptureCount: runtimeReport.frameCaptures.length,
            approximations: runtimeReport.approximations,
          },
        })
        .onConflictDoUpdate({
          target: artifacts.artifactId,
          set: {
            metadata: {
              schemaVersion: runtimeReport.schemaVersion,
              adapterName: runtimeReport.adapterName,
              fidelityTier: runtimeReport.fidelityTier,
              status: runtimeReport.status,
              textEventCount: runtimeReport.textEvents.length,
              frameCaptureCount: runtimeReport.frameCaptures.length,
              approximations: runtimeReport.approximations,
            },
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
          metadata: { status: "passed", runtimeReportId: runtimeReport.runtimeReportId },
        })
        .onConflictDoUpdate({
          target: artifacts.artifactId,
          set: { metadata: { status: "passed", runtimeReportId: runtimeReport.runtimeReportId } },
        });

      for (const frame of runtimeReport.frameCaptures) {
        await tx
          .insert(artifacts)
          .values({
            artifactId: frame.frameCaptureId,
            projectId: project.projectId,
            localeBranchId: project.localeBranchId,
            sourceBundleId,
            bridgeUnitId: frame.bridgeUnitId,
            artifactKind: "frame_capture",
            uri: frame.artifactPath,
            metadata: {
              width: frame.width,
              height: frame.height,
              nonZeroPixels: frame.nonZeroPixels,
            },
          })
          .onConflictDoUpdate({
            target: artifacts.artifactId,
            set: {
              uri: frame.artifactPath,
              metadata: {
                width: frame.width,
                height: frame.height,
                nonZeroPixels: frame.nonZeroPixels,
              },
            },
          });
      }

      await tx
        .insert(events)
        .values({
          eventId: `${runtimeReport.runtimeReportId}:recorded`,
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          eventKind: "patch_result_recorded",
          occurredAt: new Date(),
          actor: { actorKind: "tool", displayName: runtimeReport.adapterName },
          subjectRefs: [
            {
              subjectKind: "runtime_report",
              subjectId: runtimeReport.runtimeReportId,
              label: runtimeReport.status,
            },
          ],
          provenance: [],
          causalLinks: [],
          payload: { patchResultId, status: runtimeReport.status },
        })
        .onConflictDoNothing();

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

    return {
      projectId: String(first.project_id),
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
          latest_patch_result.metadata->>'finalStatus',
          case
            when latest_patch_result.metadata->>'status' in (
              'hello_world_passed',
              'hello_world_failed'
            )
              then latest_patch_result.metadata->>'status'
            when latest_runtime_report.metadata->>'status' = 'passed'
              then 'hello_world_passed'
            when latest_runtime_report.metadata->>'status' = 'failed'
              then 'hello_world_failed'
            else latest_patch_result.metadata->>'status'
          end
        ) as final_status,
        latest_runtime_report.artifact_id as runtime_report_id,
        latest_runtime_report.metadata->>'status' as runtime_status,
        latest_runtime_report.metadata->>'fidelityTier' as fidelity_tier,
        latest_runtime_report.metadata->>'textEventCount' as text_event_count,
        latest_runtime_report.metadata->>'frameCaptureCount' as frame_capture_count
      from latest_project
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
      textEventCount: Number(first.text_event_count ?? 0),
      frameCaptureCount: Number(first.frame_capture_count ?? 0),
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

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
