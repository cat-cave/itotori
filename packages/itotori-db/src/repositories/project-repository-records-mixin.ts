import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";
import { ProjectRepositoryBase } from "./project-repository-base.js";

export class ProjectRecordsRepository extends ProjectRepositoryBase {
  async appendEvent(actor: deps.AuthorizationActor, input: api.EventInput): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.runtimeIngest);
    await this.db.insert(deps.events).values({
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

  async recordFinding(actor: deps.AuthorizationActor, input: api.FindingInput): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.runtimeIngest);
    const finding = input.finding;
    await this.db
      .insert(deps.findings)
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
        target: deps.findings.findingId,
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
          updatedAt: deps.sql`now()`,
        },
      });
  }

  async linkArtifact(actor: deps.AuthorizationActor, input: api.ArtifactInput): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.runtimeIngest);
    if (input.uri !== undefined && helpers.RUNTIME_MANAGED_ARTIFACT_KINDS.has(input.artifactKind)) {
      helpers.assertPortableRelativeArtifactUri(input.uri);
    }
    await this.db
      .insert(deps.artifacts)
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
        target: deps.artifacts.artifactId,
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
    actor: deps.AuthorizationActor,
    input: api.BenchmarkArtifactLedgerInput,
  ): Promise<void> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.runtimeIngest);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(deps.artifacts)
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
          target: deps.artifacts.artifactId,
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
        await deps.insertProviderRunLedgerRows(tx, providerRun);
      }
    });
  }

  async listBenchmarkReports(projectId: string): Promise<api.BenchmarkReportSummary[]> {
    const result = await this.db.execute(deps.sql`
      select
        a.artifact_id,
        a.project_id,
        a.locale_branch_id,
        a.metadata,
        a.created_at
      from ${deps.artifacts} a
      where a.project_id = ${projectId}
        and a.artifact_kind = 'benchmark_report'
      order by a.created_at desc, a.artifact_id desc
    `);
    return (result.rows as Array<Record<string, unknown>>).map(
      helpers.benchmarkReportSummaryFromRow,
    );
  }

  async listLocaleBranchIdentities(projectId: string): Promise<api.LocaleBranchIdentity[]> {
    const result = await this.db.execute(deps.sql`
      select
        b.locale_branch_id,
        b.project_id,
        b.source_bundle_id,
        sb.source_bundle_revision_id,
        sb.source_locale,
        b.target_locale,
        b.branch_name,
        b.status
      from ${deps.localeBranches} b
      join ${deps.sourceBundles} sb on sb.source_bundle_id = b.source_bundle_id
      where b.project_id = ${projectId}
      order by b.created_at asc, b.locale_branch_id asc
    `);

    return result.rows.map(
      (row): api.LocaleBranchIdentity => ({
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
}
