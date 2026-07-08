// itotori-bmk-cockpit-read-model — DB-backed benchmark cockpit run repository.
//
// Persists one APPEND-ONLY row per benchmark run on a project (table
// `itotori_benchmark_runs`, migration 0064). The benchmark facility scores a
// run → records the contestants (official / self / self_nocontext / fan / mtl)
// + the §8 panel↔human anchor + the §10 actionable backlog in
// `report_body`. The repository exposes two operations:
//   - `recordRun`  — persist a freshly scored benchmark run body.
//   - `loadRun`    — load the SPECIFIC run by id (single-row read for the
//                    /api/projects/{projectId}/bmk-cockpit/{runId} surface).
//   - `loadLatestRunForProject` — load the most recent run for the cockpit
//                    read-model (the dashboard default; no caller-supplied
//                    branch means "latest project-wide").
//   - `loadRunsForProject`      — paged run history so a reviewer sees
//                    whether the backlog is shrinking over time.
//
// Deliberately game-agnostic + generic: the repository stores the whole run
// body verbatim as an opaque jsonb blob and promotes only the keyed columns
// the queries index on. It knows nothing about the app's
// `BmkCockpitReadModel` shape — the app adapter maps between the two — so this
// package stays free of any dependency on the read-model's types.
//
// Authorization: every method is gated on `catalog.read` (the SAME read
// permission the sibling `listBenchmarkReports` enforces), so a caller without
// read access cannot observe benchmark runs at the persistence boundary. The
// `runtime.ingest` gate protects `recordRun` (a run is recorded by the
// scoring pipeline, same authority as recording a benchmark report's provider
// ledger). The HTTP redaction layer is layered on top in the read-model.

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import {
  type AuthorizationActor,
  permissionValues,
  requirePermission,
} from "../authorization.js";
import { benchmarkRuns } from "../schema.js";

export type BenchmarkRunKind = "real_run" | "fixture" | "replay";

export const benchmarkRunKindValues: readonly BenchmarkRunKind[] = [
  "real_run",
  "fixture",
  "replay",
] as const;

export type BenchmarkRunStatus = "succeeded" | "failed" | "partial";

export const benchmarkRunStatusValues: readonly BenchmarkRunStatus[] = [
  "succeeded",
  "failed",
  "partial",
] as const;

/**
 * A persisted benchmark cockpit run row, as the repository returns it. The
 * `reportBody` carries the verbatim generic run body the app's read-model
 * re-parses — keeping the package free of any dependency on the read-model
 * shape.
 */
export type BenchmarkRunRecord = {
  runId: string;
  projectId: string;
  localeBranchId: string | null;
  targetLocale: string;
  schemaVersion: string;
  kind: BenchmarkRunKind;
  status: BenchmarkRunStatus;
  unitsScored: number;
  reportBody: Record<string, unknown>;
  recordedAt: Date;
};

/** Input to `recordRun`. */
export type RecordBenchmarkRunInput = {
  projectId: string;
  localeBranchId: string | null;
  targetLocale: string;
  schemaVersion: string;
  kind: BenchmarkRunKind;
  status: BenchmarkRunStatus;
  unitsScored: number;
  /** The verbatim generic run body (contestants + anchor + backlog). */
  reportBody: Record<string, unknown>;
  recordedAt: Date;
};

/** Options for `loadRunsForProject`. */
export type LoadBenchmarkRunsForProjectOptions = {
  /** Restrict to a single locale branch (omit = project-wide). */
  localeBranchId?: string | null;
  /** Max rows to return (clamped inside the repository). */
  limit?: number;
  /** Row offset for paging. */
  offset?: number;
};

export interface ItotoriBenchmarkRunRepositoryPort {
  recordRun(
    actor: AuthorizationActor,
    input: RecordBenchmarkRunInput,
  ): Promise<BenchmarkRunRecord>;
  loadRun(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<BenchmarkRunRecord | undefined>;
  loadLatestRunForProject(
    actor: AuthorizationActor,
    projectId: string,
    options?: { localeBranchId?: string | null },
  ): Promise<BenchmarkRunRecord | undefined>;
  loadRunsForProject(
    actor: AuthorizationActor,
    projectId: string,
    options?: LoadBenchmarkRunsForProjectOptions,
  ): Promise<BenchmarkRunRecord[]>;
}

export class BenchmarkRunRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkRunRepositoryError";
  }
}

export const BENCHMARK_RUN_DEFAULT_LIMIT = 25;
export const BENCHMARK_RUN_MAX_LIMIT = 200;

export class ItotoriBenchmarkRunRepository
  implements ItotoriBenchmarkRunRepositoryPort
{
  constructor(private readonly db: ItotoriDatabase) {}

  async recordRun(
    actor: AuthorizationActor,
    input: RecordBenchmarkRunInput,
  ): Promise<BenchmarkRunRecord> {
    // A benchmark run is recorded by the scoring pipeline (the same authority as
    // recording a benchmark report's provider ledger): `runtime.ingest`.
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    if (input.targetLocale.length === 0) {
      throw new BenchmarkRunRepositoryError(
        "refusing to record a benchmark run with an empty targetLocale (locale-less runs have no meaning for the cockpit)",
      );
    }
    if (input.schemaVersion.length === 0) {
      throw new BenchmarkRunRepositoryError(
        "refusing to record a benchmark run with an empty schemaVersion (the read-model needs to assert compatibility)",
      );
    }
    if (input.unitsScored < 1) {
      throw new BenchmarkRunRepositoryError(
        `refusing to record a benchmark run scoring zero units (a zero-unit run is a refusal, not a result); got unitsScored=${input.unitsScored}`,
      );
    }
    if (!benchmarkRunStatusValues.includes(input.status)) {
      throw new BenchmarkRunRepositoryError(
        `unknown benchmark run status '${input.status}'; expected one of ${benchmarkRunStatusValues.join(", ")}`,
      );
    }
    if (!benchmarkRunKindValues.includes(input.kind)) {
      throw new BenchmarkRunRepositoryError(
        `unknown benchmark run kind '${input.kind}'; expected one of ${benchmarkRunKindValues.join(", ")}`,
      );
    }

    const runId = `bmk-run-${randomUUID()}`;
    const inserted = await this.db
      .insert(benchmarkRuns)
      .values({
        runId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        targetLocale: input.targetLocale,
        schemaVersion: input.schemaVersion,
        kind: input.kind,
        status: input.status,
        unitsScored: input.unitsScored,
        reportBody: input.reportBody,
        recordedAt: input.recordedAt,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new BenchmarkRunRepositoryError(
        `benchmark run row for runId ${runId} disappeared immediately after insert`,
      );
    }
    return rowToRecord(row);
  }

  async loadRun(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<BenchmarkRunRecord | undefined> {
    // Read-side: `catalog.read` (mirrors `listBenchmarkReports`).
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select()
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.runId, runId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : rowToRecord(row);
  }

  async loadLatestRunForProject(
    actor: AuthorizationActor,
    projectId: string,
    options: { localeBranchId?: string | null } = {},
  ): Promise<BenchmarkRunRecord | undefined> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const where =
      options.localeBranchId === undefined
        ? eq(benchmarkRuns.projectId, projectId)
        : and(
            eq(benchmarkRuns.projectId, projectId),
            options.localeBranchId === null
              ? isNull(benchmarkRuns.localeBranchId)
              : eq(benchmarkRuns.localeBranchId, options.localeBranchId),
          );
    const rows = await this.db
      .select()
      .from(benchmarkRuns)
      .where(where)
      .orderBy(desc(benchmarkRuns.recordedAt), desc(benchmarkRuns.runId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : rowToRecord(row);
  }

  async loadRunsForProject(
    actor: AuthorizationActor,
    projectId: string,
    options: LoadBenchmarkRunsForProjectOptions = {},
  ): Promise<BenchmarkRunRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const limit = clampBenchmarkRunsLimit(options.limit ?? BENCHMARK_RUN_DEFAULT_LIMIT);
    const offset = options.offset ?? 0;
    if (offset < 0) {
      throw new BenchmarkRunRepositoryError(
        `offset must be a non-negative integer; got ${offset}`,
      );
    }
    const where =
      options.localeBranchId === undefined
        ? eq(benchmarkRuns.projectId, projectId)
        : and(
            eq(benchmarkRuns.projectId, projectId),
            options.localeBranchId === null
              ? isNull(benchmarkRuns.localeBranchId)
              : eq(benchmarkRuns.localeBranchId, options.localeBranchId),
          );
    const rows = await this.db
      .select()
      .from(benchmarkRuns)
      .where(where)
      .orderBy(desc(benchmarkRuns.recordedAt), desc(benchmarkRuns.runId))
      .limit(limit)
      .offset(offset);
    return rows.map(rowToRecord);
  }
}

function clampBenchmarkRunsLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BenchmarkRunRepositoryError(
      `limit must be a positive integer; got ${limit}`,
    );
  }
  return Math.min(limit, BENCHMARK_RUN_MAX_LIMIT);
}

function rowToRecord(
  row: typeof benchmarkRuns.$inferSelect,
): BenchmarkRunRecord {
  return {
    runId: row.runId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    targetLocale: row.targetLocale,
    schemaVersion: row.schemaVersion,
    kind: row.kind as BenchmarkRunKind,
    status: row.status as BenchmarkRunStatus,
    unitsScored: row.unitsScored,
    reportBody: row.reportBody,
    recordedAt: row.recordedAt,
  };
}
