import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthorizationActor } from "../authorization.js";
import { permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { costLedgerEntries, jobQueue, modelProviders, projects, providerRuns } from "../schema.js";
import { ProjectScopeNotFoundError } from "./project-repository.js";

export const JOBS_RUN_TABLE_SCHEMA_VERSION = "jobs.run_table.v0.3";
export const JOBS_RUN_TABLE_DEFAULT_LIMIT = 20;
export const JOBS_RUN_TABLE_MAX_LIMIT = 100;

export type JobsRunTableTokens = { in: number | null; out: number | null; total: number | null };
export type JobsRunTableCost = {
  availability: "captured" | "not_captured";
  unit: "usd";
  amount: string | null;
};
export type JobsRunTableFallback = { used: boolean; plan: string[]; chain: null };
export type JobsRunTableZdr = {
  availability: "captured" | "not_captured";
  enforced: boolean | null;
};
export type JobsRunTableRow = {
  runId: string;
  jobId: string | null;
  projectId: string;
  localeBranchId: string | null;
  task: string;
  status: string;
  servedModel: string;
  servedProvider: string;
  zdr: JobsRunTableZdr;
  cost: JobsRunTableCost;
  tokens: JobsRunTableTokens;
  fallback: JobsRunTableFallback;
  createdAt: string;
};
export type JobsRunTableReadModel = {
  schemaVersion: typeof JOBS_RUN_TABLE_SCHEMA_VERSION;
  generatedAt: string;
  filter: { projectId: string };
  pagination: {
    total: number;
    limit: number;
    offset: number;
    page: number;
    pageCount: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  rows: JobsRunTableRow[];
};
export type LoadJobsRunTableOptions = {
  projectId?: string;
  limit?: number;
  offset?: number;
  generatedAt?: Date;
};

/**
 * The current jobs projection is rooted in physical provider runs. The former
 * journal run / attempt / bridge-unit tables were removed by migration 0111;
 * this service deliberately does not recreate identifiers from adjacent data.
 */
export class ItotoriJobsRunTableRepository {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadRunTable(
    actor: AuthorizationActor,
    options: LoadJobsRunTableOptions = {},
  ): Promise<JobsRunTableReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const projectId = requiredProjectId(options.projectId);
    await this.requireProjectScope(projectId);
    const limit = normalizeLimit(options.limit);
    const offset = normalizeOffset(options.offset);

    const totalRows = await this.db
      .select({ total: sql<string>`count(*)::text` })
      .from(providerRuns)
      .where(eq(providerRuns.projectId, projectId));
    const total = Number.parseInt(totalRows[0]?.total ?? "0", 10);

    // The job join is project-scoped as well. `provider_runs.job_id` has a
    // foreign key, but it does not prove the linked job belongs to this run's
    // project, so a mismatched job is rendered as absent rather than leaked.
    const rows = await this.db
      .select({
        providerRunId: providerRuns.providerRunId,
        jobId: jobQueue.jobId,
        projectId: providerRuns.projectId,
        localeBranchId: providerRuns.localeBranchId,
        task: sql<string>`coalesce(${jobQueue.jobName}, ${providerRuns.taskKind})`,
        status: providerRuns.status,
        servedModel: providerRuns.actualModelId,
        servedProvider: sql<string>`coalesce(${providerRuns.upstreamProvider}, ${modelProviders.providerName})`,
        routingPosture: providerRuns.routingPosture,
        costLedgerEntryId: costLedgerEntries.costLedgerEntryId,
        amountMicrosUsd: costLedgerEntries.amountMicrosUsd,
        promptTokens: providerRuns.promptTokens,
        completionTokens: providerRuns.completionTokens,
        totalTokens: providerRuns.totalTokens,
        fallbackUsed: providerRuns.fallbackUsed,
        fallbackPlan: providerRuns.fallbackPlan,
        createdAt: providerRuns.startedAt,
      })
      .from(providerRuns)
      .innerJoin(modelProviders, eq(modelProviders.providerId, providerRuns.providerId))
      .leftJoin(
        jobQueue,
        and(eq(jobQueue.jobId, providerRuns.jobId), eq(jobQueue.projectId, providerRuns.projectId)),
      )
      .leftJoin(costLedgerEntries, eq(costLedgerEntries.providerRunId, providerRuns.providerRunId))
      .where(eq(providerRuns.projectId, projectId))
      .orderBy(desc(providerRuns.startedAt), desc(providerRuns.providerRunId))
      .limit(limit)
      .offset(offset);

    const hasMore = offset + rows.length < total;
    return {
      schemaVersion: JOBS_RUN_TABLE_SCHEMA_VERSION,
      generatedAt: (options.generatedAt ?? new Date()).toISOString(),
      filter: { projectId },
      pagination: {
        total,
        limit,
        offset,
        page: Math.floor(offset / limit) + 1,
        pageCount: total === 0 ? 0 : Math.ceil(total / limit),
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      rows: rows.map(jobsRunTableRow),
    };
  }

  private async requireProjectScope(projectId: string): Promise<void> {
    const rows = await this.db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (rows[0] === undefined) throw new ProjectScopeNotFoundError(projectId);
  }
}

type JobsRunTableSqlRow = {
  providerRunId: string;
  jobId: string | null;
  projectId: string;
  localeBranchId: string | null;
  task: string;
  status: string;
  servedModel: string;
  servedProvider: string;
  routingPosture: Record<string, unknown>;
  costLedgerEntryId: string | null;
  amountMicrosUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  fallbackUsed: boolean;
  fallbackPlan: string[];
  createdAt: Date;
};

function jobsRunTableRow(row: JobsRunTableSqlRow): JobsRunTableRow {
  const zdr = capturedZdr(row.routingPosture);
  const costCaptured = row.costLedgerEntryId !== null && row.amountMicrosUsd !== null;
  return {
    runId: row.providerRunId,
    jobId: row.jobId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    task: row.task,
    status: row.status,
    servedModel: row.servedModel,
    servedProvider: row.servedProvider,
    zdr: { availability: zdr === null ? "not_captured" : "captured", enforced: zdr },
    cost: {
      availability: costCaptured ? "captured" : "not_captured",
      unit: "usd",
      amount: costCaptured ? microsToUsd(row.amountMicrosUsd!) : null,
    },
    tokens: { in: row.promptTokens, out: row.completionTokens, total: row.totalTokens },
    // The current provider-run record has no fallback-attempt-chain column.
    // Null states that absence honestly; [] would assert no attempts occurred.
    fallback: { used: row.fallbackUsed, plan: row.fallbackPlan, chain: null },
    createdAt: row.createdAt.toISOString(),
  };
}

function capturedZdr(posture: Record<string, unknown>): boolean | null {
  if (posture._pre_itotori_230 === true) return null;
  return typeof posture.zdr === "boolean" ? posture.zdr : null;
}

function microsToUsd(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const absolute = Math.abs(micros);
  const whole = Math.floor(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return `${sign}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

function requiredProjectId(projectId: string | undefined): string {
  if (projectId === undefined || projectId.trim() === "") {
    throw new Error("loadRunTable requires a non-empty projectId scope");
  }
  return projectId;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return JOBS_RUN_TABLE_DEFAULT_LIMIT;
  }
  return Math.min(limit, JOBS_RUN_TABLE_MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  return offset === undefined || !Number.isInteger(offset) || offset < 0 ? 0 : offset;
}
