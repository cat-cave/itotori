import { eq, sql } from "drizzle-orm";
import type {
  BridgeBundle,
  PatchExport,
  RuntimeVerificationReport,
} from "@itotori/localization-bridge-schema";
import type { ItotoriDatabase } from "../connection.js";
import {
  bridgeUnits,
  helloWorldFinalStatusValues,
  helloWorldRuns,
  patchExports,
  projectStatusValues,
  projects,
  runtimeReports,
} from "../schema.js";

export type ProjectRecord = {
  projectId: string;
  bridge: BridgeBundle;
  localeBranchId: string;
  targetLocale: string;
  drafts: Record<string, string>;
  patchExport?: PatchExport;
  runtimeReport?: RuntimeVerificationReport;
};

export type HelloDashboardStatus = {
  projectId: string;
  bridgeId: string;
  localeBranchId: string;
  sourceLocale: string;
  targetLocale: string;
  finalStatus: string;
  unitCount: number;
  translatedUnitCount: number;
  patchExportId: string | null;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  textEventCount: number;
  frameCaptureCount: number;
};

export class HelloWorldRepository {
  constructor(private readonly db: ItotoriDatabase) {}

  async reset(): Promise<void> {
    await this.db.execute(
      sql`truncate ${helloWorldRuns}, ${runtimeReports}, ${patchExports}, ${bridgeUnits}, ${projects} restart identity cascade`,
    );
  }

  async saveImportedProject(project: ProjectRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(projects)
        .values({
          projectId: project.projectId,
          bridgeId: project.bridge.bridgeId,
          sourceLocale: project.bridge.sourceLocale,
          targetLocale: project.targetLocale,
          localeBranchId: project.localeBranchId,
          status: projectStatusValues.imported,
        })
        .onConflictDoUpdate({
          target: projects.projectId,
          set: {
            bridgeId: project.bridge.bridgeId,
            sourceLocale: project.bridge.sourceLocale,
            targetLocale: project.targetLocale,
            localeBranchId: project.localeBranchId,
            status: projectStatusValues.imported,
            updatedAt: sql`now()`,
          },
        });

      for (const unit of project.bridge.units) {
        await tx
          .insert(bridgeUnits)
          .values({
            bridgeUnitId: unit.bridgeUnitId,
            projectId: project.projectId,
            sourceUnitKey: unit.sourceUnitKey,
            sourceText: unit.sourceText,
            targetText: project.drafts[unit.bridgeUnitId] ?? null,
            textSurface: unit.textSurface,
            protectedSpanCount: unit.protectedSpans.length,
          })
          .onConflictDoUpdate({
            target: bridgeUnits.bridgeUnitId,
            set: {
              sourceText: unit.sourceText,
              targetText: project.drafts[unit.bridgeUnitId] ?? null,
              textSurface: unit.textSurface,
              protectedSpanCount: unit.protectedSpans.length,
              updatedAt: sql`now()`,
            },
          });
      }
    });
  }

  async saveDrafts(project: ProjectRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({
          targetLocale: project.targetLocale,
          status: projectStatusValues.drafted,
          updatedAt: sql`now()`,
        })
        .where(eq(projects.projectId, project.projectId));

      for (const [bridgeUnitId, targetText] of Object.entries(project.drafts)) {
        await tx
          .update(bridgeUnits)
          .set({
            targetText,
            updatedAt: sql`now()`,
          })
          .where(eq(bridgeUnits.bridgeUnitId, bridgeUnitId));
      }
    });
  }

  async savePatchExport(project: ProjectRecord, patchExport: PatchExport): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(patchExports)
        .values({
          patchExportId: patchExport.patchExportId,
          projectId: project.projectId,
          targetLocale: patchExport.targetLocale,
          entryCount: patchExport.entries.length,
        })
        .onConflictDoUpdate({
          target: patchExports.patchExportId,
          set: {
            targetLocale: patchExport.targetLocale,
            entryCount: patchExport.entries.length,
          },
        });
      await tx
        .update(projects)
        .set({ status: projectStatusValues.patchExported, updatedAt: sql`now()` })
        .where(eq(projects.projectId, project.projectId));
    });
  }

  async saveRuntimeReport(
    project: ProjectRecord,
    runtimeReport: RuntimeVerificationReport,
    patchResultId: string,
  ): Promise<HelloDashboardStatus> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(runtimeReports)
        .values({
          runtimeReportId: runtimeReport.runtimeReportId,
          projectId: project.projectId,
          status: runtimeReport.status,
          fidelityTier: runtimeReport.fidelityTier,
          textEventCount: runtimeReport.textEvents.length,
          frameCaptureCount: runtimeReport.frameCaptures.length,
        })
        .onConflictDoUpdate({
          target: runtimeReports.runtimeReportId,
          set: {
            status: runtimeReport.status,
            fidelityTier: runtimeReport.fidelityTier,
            textEventCount: runtimeReport.textEvents.length,
            frameCaptureCount: runtimeReport.frameCaptures.length,
          },
        });
      await tx
        .insert(helloWorldRuns)
        .values({
          runId: "hello-world",
          projectId: project.projectId,
          patchResultId,
          finalStatus: helloWorldFinalStatusValues.passed,
        })
        .onConflictDoUpdate({
          target: helloWorldRuns.runId,
          set: {
            patchResultId,
            finalStatus: helloWorldFinalStatusValues.passed,
            updatedAt: sql`now()`,
          },
        });
      await tx
        .update(projects)
        .set({ status: projectStatusValues.runtimeIngested, updatedAt: sql`now()` })
        .where(eq(projects.projectId, project.projectId));
    });
    return this.getStatus();
  }

  async getStatus(): Promise<HelloDashboardStatus> {
    const result = await this.db.execute(sql`
      select
        p.project_id,
        p.bridge_id,
        p.locale_branch_id,
        p.source_locale,
        p.target_locale,
        coalesce(h.final_status, p.status) as final_status,
        count(distinct u.bridge_unit_id)::int as unit_count,
        count(distinct u.bridge_unit_id) filter (where u.target_text is not null)::int as translated_unit_count,
        max(pe.patch_export_id) as patch_export_id,
        max(rr.runtime_report_id) as runtime_report_id,
        max(rr.status) as runtime_status,
        max(rr.fidelity_tier) as fidelity_tier,
        coalesce(max(rr.text_event_count), 0)::int as text_event_count,
        coalesce(max(rr.frame_capture_count), 0)::int as frame_capture_count
      from ${projects} p
      left join ${bridgeUnits} u on u.project_id = p.project_id
      left join ${patchExports} pe on pe.project_id = p.project_id
      left join ${runtimeReports} rr on rr.project_id = p.project_id
      left join ${helloWorldRuns} h on h.project_id = p.project_id
      group by p.project_id, p.bridge_id, p.locale_branch_id, p.source_locale, p.target_locale, h.final_status, p.status
      order by max(p.updated_at) desc
      limit 1
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("no Itotori hello-world state found");
    }
    return {
      projectId: String(row.project_id),
      bridgeId: String(row.bridge_id),
      localeBranchId: String(row.locale_branch_id),
      sourceLocale: String(row.source_locale),
      targetLocale: String(row.target_locale),
      finalStatus: String(row.final_status),
      unitCount: Number(row.unit_count),
      translatedUnitCount: Number(row.translated_unit_count),
      patchExportId: nullableString(row.patch_export_id),
      runtimeReportId: nullableString(row.runtime_report_id),
      runtimeStatus: nullableString(row.runtime_status),
      fidelityTier: nullableString(row.fidelity_tier),
      textEventCount: Number(row.text_event_count),
      frameCaptureCount: Number(row.frame_capture_count),
    };
  }
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
