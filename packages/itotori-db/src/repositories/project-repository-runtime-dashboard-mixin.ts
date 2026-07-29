import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";
import { ProjectRepositoryBase } from "./project-repository-base.js";

export class ProjectRuntimeDashboardRepository extends ProjectRepositoryBase {
  constructor(
    db: deps.ItotoriDatabase,
    engineFamilyRegistry: api.ProjectEngineFamilyRegistry,
    private readonly requireProjectScopeForRuntimeStatus: (projectId: string) => Promise<string>,
  ) {
    super(db, engineFamilyRegistry);
  }

  async getRuntimeStatus(
    actor: deps.AuthorizationActor,
    runtimeRunId?: string,
    projectId?: string,
  ): Promise<api.RuntimeDashboardStatus> {
    await deps.requirePermission(this.db, actor, deps.permissionValues.catalogRead);
    const requestedRuntimeRunId = runtimeRunId ?? null;
    // An explicit project scope constrains BOTH selection paths: a requested
    // run must belong to the scope, deps.and the unscoped-run fallback may only
    // choose the requested project. A run outside the scope therefore reads as
    // "deps.not found" rather than silently returning another project's evidence.
    const requestedProjectId =
      projectId === undefined ? null : await this.requireProjectScopeForRuntimeStatus(projectId);
    const result = await this.db.execute(deps.sql`
      with requested_runtime_run as (
        select
          runtime_run_id,
          project_id,
          created_at
        from ${deps.runtimeEvidenceRuns}
        where ${requestedRuntimeRunId}::text is deps.not null
          deps.and runtime_run_id = ${requestedRuntimeRunId}
          deps.and (${requestedProjectId}::text is null or project_id = ${requestedProjectId})
        limit 1
      ),
      latest_project as (
        select project_id
        from (
          select project_id, 0 as priority, created_at as selected_at
          from requested_runtime_run
          union all
          select project_id, 1 as priority, updated_at as selected_at
          from ${deps.projects}
          where ${requestedRuntimeRunId}::text is null
            deps.and (${requestedProjectId}::text is null or project_id = ${requestedProjectId})
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
        from ${deps.runtimeEvidenceRuns}
        where (
          ${requestedRuntimeRunId}::text is deps.not null
          deps.and runtime_run_id in (select runtime_run_id from requested_runtime_run)
        ) or (
          ${requestedRuntimeRunId}::text is null
          deps.and project_id in (select project_id from latest_project)
        )
        order by report_created_at desc, created_at desc
        limit 1
      ),
      selected_runtime_report as (
        select
          artifact_id,
          metadata,
          created_at
        from ${deps.artifacts}
        where project_id in (select project_id from latest_project)
          deps.and artifact_kind = 'runtime_report'
          deps.and (
            artifact_id in (select runtime_report_artifact_id from selected_runtime_run)
            or deps.not exists (select 1 from selected_runtime_run)
          )
        order by created_at desc
        limit 1
      ),
      selected_patch_result as (
        select
          artifact_id,
          metadata,
          created_at
        from ${deps.artifacts}
        where project_id in (select project_id from latest_project)
          deps.and artifact_kind = 'patch_result'
          deps.and (
            artifact_id in (select patch_result_artifact_id from selected_runtime_run)
            or deps.not exists (select 1 from selected_runtime_run)
          )
        order by created_at desc
        limit 1
      ),
      runtime_capture_kind_counts as (
        -- DAG-node-runtime-status-double-counted-capture-scalars-on-wire:
        -- The frame-capture vs screenshot API scalars are the REAL distinct
        -- per-artifactKind counts of the persisted runtime deps.artifacts (each
        -- capture produces exactly one row, keyed either as the
        -- frame_capture artifact_kind for legacy deps.RuntimeVerificationReport
        -- frame captures or as the screenshot artifact_kind for
        -- deps.RuntimeEvidenceReportV02 captures). Counting from the deps.artifacts
        -- table avoids double-counting that arose when the single
        -- capture_count column on itotori_runtime_evidence_runs was reused
        -- for both scalars.
        select
          a.metadata->>'runtimeReportId' as runtime_report_id,
          count(*) filter (where a.artifact_kind = 'frame_capture')::int
            as frame_capture_kind_count,
          count(*) filter (where a.artifact_kind = 'screenshot')::int
            as screenshot_kind_count
        from ${deps.artifacts} a
        where a.artifact_kind in ('frame_capture', 'screenshot')
          deps.and a.metadata->>'runtimeReportId' is deps.not null
        group by a.metadata->>'runtimeReportId'
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
        coalesce(
          rckc.frame_capture_kind_count::text,
          selected_runtime_report.metadata->>'frameCaptureCount',
          '0'
        ) as frame_capture_count,
        coalesce(
          rckc.screenshot_kind_count::text,
          selected_runtime_report.metadata->>'screenshotArtifactCount',
          '0'
        ) as screenshot_artifact_count,
        coalesce(selected_runtime_run.recording_count::text, selected_runtime_report.metadata->>'recordingArtifactCount')
          as recording_artifact_count,
        coalesce(selected_runtime_run.validation_finding_count::text, selected_runtime_report.metadata->>'validationFindingCount')
          as validation_finding_count
      from latest_project
      left join selected_runtime_run on true
      left join selected_runtime_report on true
      left join selected_patch_result on true
      left join runtime_capture_kind_counts rckc
        on rckc.runtime_report_id = coalesce(
          selected_runtime_run.runtime_report_artifact_id,
          selected_runtime_report.artifact_id
        )
    `);

    const first = result.rows[0] as Record<string, unknown> | undefined;
    if (!first) {
      if (requestedRuntimeRunId !== null) {
        throw new api.RuntimeRunNotFoundError(requestedRuntimeRunId);
      }
      throw new Error("no Itotori runtime status found");
    }

    const loadedRuntimeRunId = helpers.nullableString(first.runtime_run_id);
    const runtimeReportId = helpers.nullableString(first.runtime_report_id);
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
      runtimeStatus: helpers.nullableString(first.runtime_status),
      fidelityTier: helpers.nullableString(first.fidelity_tier),
      evidenceTier: helpers.nullableString(first.evidence_tier),
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
  ): Promise<api.RuntimeDashboardTraceEvent[]> {
    const result = await this.db.execute(deps.sql`
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
      from ${deps.runtimeEvidenceItems} rei
      left join lateral (
        select ref.source_unit_key
        from ${deps.runtimeEvidenceBridgeUnitRefs} ref
        where ref.runtime_evidence_id = rei.runtime_evidence_id
        order by case when ref.ref_role = 'primary' then 0 else 1 end, ref.created_at
        limit 1
      ) refs on true
      left join ${deps.sourceUnits} su on su.bridge_unit_id = rei.bridge_unit_id
      where rei.runtime_run_id = ${runtimeRunId}
        deps.and rei.evidence_kind in ('trace_event', 'branch_event')
      order by rei.frame nulls last, rei.runtime_evidence_id
    `);

    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      const bridgeUnitId = helpers.nullableString(record.bridge_unit_id);
      return {
        runtimeEventId: String(record.runtime_evidence_id),
        eventKind: String(record.event_kind ?? record.evidence_kind ?? "unknown"),
        bridgeUnitId,
        sourceUnitKey: helpers.nullableString(record.source_unit_key),
        draftId:
          bridgeUnitId === null
            ? null
            : `${String(record.locale_branch_id ?? "runtime")}:${bridgeUnitId}`,
        runtimeTargetId: helpers.nullableString(record.runtime_target_id),
        evidenceTier: helpers.nullableString(record.evidence_tier),
        frame: helpers.nullableNumber(record.frame),
        textPreview: helpers.nullableString(record.text_preview),
        artifactIds:
          record.artifact_id === null || record.artifact_id === undefined
            ? []
            : [String(record.artifact_id)],
      };
    });
  }

  private async runtimeDashboardFindings(
    runtimeRunId: string,
  ): Promise<api.RuntimeDashboardFinding[]> {
    const result = await this.db.execute(deps.sql`
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
      from ${deps.runtimeValidationFindings} rvf
      left join ${deps.sourceUnits} su on su.bridge_unit_id = rvf.bridge_unit_id
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
        bridgeUnitId: helpers.nullableString(record.bridge_unit_id),
        sourceUnitKey: helpers.nullableString(record.source_unit_key),
        artifactId: helpers.nullableString(record.artifact_id),
      };
    });
  }

  private async runtimeDashboardArtifacts(
    runtimeRunId: string,
  ): Promise<api.RuntimeDashboardArtifact[]> {
    const result = await this.db.execute(deps.sql`
      select
        a.artifact_id,
        a.artifact_kind,
        a.uri,
        a.hash,
        a.bridge_unit_id,
        su.source_unit_key,
        coalesce(a.metadata->>'mediaType', a.metadata->'artifactRef'->>'mediaType') as media_type,
        coalesce(a.metadata->>'byteSize', a.metadata->'artifactRef'->>'byteSize') as byte_size,
        a.metadata->>'hashProvenance' as hash_provenance,
        a.metadata
      from ${deps.artifacts} a
      left join ${deps.sourceUnits} su on su.bridge_unit_id = a.bridge_unit_id
      where a.metadata->>'runtimeReportId' = ${runtimeRunId}
        deps.and a.artifact_kind in (
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
      const uri = helpers.nullableString(record.uri);
      const hash = helpers.nullableString(record.hash);
      return {
        artifactId: String(record.artifact_id),
        artifactKind: String(record.artifact_kind),
        uri,
        hash,
        hashProvenance: helpers.runtimeArtifactHashProvenanceFromRow(record.hash_provenance),
        mediaType: helpers.nullableString(record.media_type),
        byteSize: helpers.nullableNumber(record.byte_size),
        bridgeUnitId: helpers.nullableString(record.bridge_unit_id),
        sourceUnitKey: helpers.nullableString(record.source_unit_key),
        diagnostic: helpers.runtimeArtifactDiagnostic(uri, hash, record.metadata),
      };
    });
  }

  private async runtimeDashboardApproximations(
    runtimeRunId: string,
  ): Promise<api.RuntimeDashboardApproximation[]> {
    const result = await this.db.execute(deps.sql`
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
          jsonb_agg(distinct ref.bridge_unit_id) filter (where ref.bridge_unit_id is deps.not null),
          '[]'::jsonb
        ) as bridge_unit_ids
      from ${deps.runtimeEvidenceItems} rei
      left join ${deps.runtimeEvidenceBridgeUnitRefs} ref
        on ref.runtime_evidence_id = rei.runtime_evidence_id
      where rei.runtime_run_id = ${runtimeRunId}
        deps.and rei.evidence_kind = 'approximation'
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
        bridgeUnitIds: helpers.stringArray(record.bridge_unit_ids),
      };
    });
  }

  private async runtimeDashboardUnsupportedCapabilities(
    runtimeRunId: string,
  ): Promise<api.RuntimeDashboardUnsupportedCapability[]> {
    const result = await this.db.execute(deps.sql`
      select metadata->'runtimeCapabilities'->'features' as features
      from ${deps.runtimeEvidenceRuns}
      where runtime_run_id = ${runtimeRunId}
      limit 1
    `);
    const features = (result.rows[0] as Record<string, unknown> | undefined)?.features;
    if (!Array.isArray(features)) {
      return [];
    }

    return features.flatMap((feature) => {
      if (!helpers.isRecord(feature) || feature.status !== "unsupported") {
        return [];
      }
      return [
        {
          feature: String(feature.feature ?? "unknown"),
          status: String(feature.status),
          fidelityTierCeiling: helpers.nullableString(feature.fidelityTierCeiling),
          evidenceTierCeiling: helpers.nullableString(feature.evidenceTierCeiling),
          limitations: helpers.stringArray(feature.limitations),
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
    const result = await this.db.execute(deps.sql`
      select coalesce(run.metadata->'limitations', report.metadata->'limitations') as limitations
      from (select ${id}::text as id) ids
      left join ${deps.runtimeEvidenceRuns} run on run.runtime_run_id = ids.id
      left join ${deps.artifacts} report on report.artifact_id = ids.id
      limit 1
    `);
    return helpers.stringArray(
      (result.rows[0] as Record<string, unknown> | undefined)?.limitations,
    );
  }
}
