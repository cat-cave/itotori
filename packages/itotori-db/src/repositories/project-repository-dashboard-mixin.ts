import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";
import { ProjectRepositoryBase } from "./project-repository-base.js";

export class ProjectDashboardRepository extends ProjectRepositoryBase {
  async getDashboardStatus(targetProjectId?: string): Promise<api.ProjectDashboardStatus> {
    // Scope the "which project" CTE to the requested project when supplied.
    // Composed read models pass an explicit projectId so the status they embed
    // (progress + locale-branch set) belongs to the SAME project as the rest of
    // the composition; a bad/foreign projectId selects no project and the read
    // fails closed ("no Itotori project state found") rather than falling back
    // to another project's data.
    const projectScope =
      targetProjectId === undefined ? deps.sql`` : deps.sql`where project_id = ${targetProjectId}`;
    const result = await this.db.execute(deps.sql`
      with latest_project as (
        select project_id
        from ${deps.projects}
        ${projectScope}
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
        from ${deps.bridgeImports} li
        join ${deps.sourceBundles} sb
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
        from ${deps.sourceBundles}
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
        p.engine_family,
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
      from ${deps.projects} p
      join latest_project lp on lp.project_id = p.project_id
      join selected_bundle sb on sb.project_id = p.project_id
      left join ${deps.localeBranches} b on b.project_id = p.project_id
      left join ${deps.sourceUnits} su on su.source_bundle_id = sb.source_bundle_id
      left join ${deps.localeBranchUnits} lbu
        on lbu.locale_branch_id = b.locale_branch_id
        and lbu.bridge_unit_id = su.bridge_unit_id
      left join ${deps.styleGuides} sg
        on sg.locale_branch_id = b.locale_branch_id
      left join itotori_findings f_branch
        on f_branch.project_id = p.project_id
        and f_branch.locale_branch_id = b.locale_branch_id
      left join ${deps.runtimeValidationFindings} rvf_branch
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
        from ${deps.events} e
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
        p.engine_family,
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
      // An EXPLICIT scope that selected nothing is a not-found scope, not an
      // empty workspace: report it as such so the HTTP boundary answers 404
      // instead of a 500, and never so it can be mistaken for a fallback.
      if (targetProjectId !== undefined) {
        throw new api.ProjectScopeNotFoundError(targetProjectId);
      }
      throw new Error("no Itotori project state found");
    }

    const branches = rows
      .filter((row) => row.locale_branch_id !== null)
      .map(
        (row): api.LocaleBranchStatus => ({
          localeBranchId: String(row.locale_branch_id),
          targetLocale: String(row.target_locale),
          status: String(row.branch_status),
          currentStyleGuidePolicyVersionId: helpers.nullableString(
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
    const cost = await new deps.ItotoriModelLedgerRepository(this.db).assembleProjectCostReport(
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
      engineFamily: helpers.nullableString(first.engine_family),
      sourceBundleId: String(first.source_bundle_id),
      sourceBundleHash: String(first.source_bundle_hash),
      sourceBundleRevisionId: String(first.source_bundle_revision_id),
      branchCount: branches.length,
      unitCount: Number(first.unit_count),
      findingCount: Number(first.finding_count),
      artifactCount: Number(first.artifact_count),
      latestEventKind: helpers.nullableString(first.latest_event_kind),
      latestEventAt:
        first.latest_event_at instanceof Date ? first.latest_event_at.toISOString() : null,
      selectedLocaleBranchId: selectedStyleGuideBranch?.localeBranchId ?? null,
      currentStyleGuidePolicyVersionId:
        selectedStyleGuideBranch?.currentStyleGuidePolicyVersionId ?? null,
      importStatus: helpers.bridgeImportStatusFromRow(first),
      cost,
      localeBranches: branches,
    };
  }

  async getDashboardDecisions(projectId?: string): Promise<api.DashboardDecisionReadModel> {
    const selectedProjectId = await this.resolveDashboardProjectId(projectId);
    const result = await this.db.execute(deps.sql`
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
      from ${deps.findings} f
      left join ${deps.localeBranches} b on b.locale_branch_id = f.locale_branch_id
      left join ${deps.runtimeValidationFindings} rvf on rvf.finding_id = f.finding_id
      left join ${deps.runtimeEvidenceRuns} rr on rr.runtime_run_id = rvf.runtime_run_id
      where f.project_id = ${selectedProjectId}
        and f.status = 'open'
      order by f.created_at asc, f.finding_id asc
    `);

    const pendingDecisions = (result.rows as Array<Record<string, unknown>>).map(
      helpers.dashboardPendingDecisionFromRow,
    );

    return {
      projectId: selectedProjectId,
      counts: helpers.dashboardDecisionCounts(pendingDecisions),
      pendingDecisions,
    };
  }

  async requireProjectScope(projectId: string): Promise<string> {
    const rows = await this.db
      .select({ projectId: deps.projects.projectId })
      .from(deps.projects)
      .where(deps.eq(deps.projects.projectId, projectId))
      .limit(1);
    const project = rows[0];
    if (project === undefined) {
      throw new api.ProjectScopeNotFoundError(projectId);
    }
    return project.projectId;
  }

  private async resolveDashboardProjectId(projectId?: string): Promise<string> {
    if (projectId !== undefined) {
      return await this.requireProjectScope(projectId);
    }
    const rows = await this.db
      .select({ projectId: deps.projects.projectId })
      .from(deps.projects)
      .orderBy(deps.sql`${deps.projects.updatedAt} desc`)
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
}
