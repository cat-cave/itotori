import { beforeAll, describe, expect, it } from "vitest";
import { AuthorizationError, permissionValues } from "@itotori/db";
import type { BenchmarkReportV02 } from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { handleReadOnlyItotoriApiRequest, readOnlyApiServices } from "../src/api-handlers.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import { benchmarkReportFixture, findingRecordFixture } from "./api-fixtures.js";

/**
 * The product runs SEVERAL localizations at once, so every project-scoped read
 * must answer for the project the caller names — not for "the workspace's one
 * active project". These tests populate TWO projects and assert over HTTP that
 * each project's request returns that project's rows and none of the other's.
 *
 * Every assertion here fails if the `?projectId=` scope is dropped anywhere on
 * the path (route parser, read-only façade forwarder, service, repository),
 * because the unscoped read deliberately resolves to the OTHER project: `beta`
 * is stamped as the most recently updated project during seeding.
 */

import { requireLivePostgres } from "../../../packages/itotori-db/test/live-postgres-suite.js";

const postgresDescribe = requireLivePostgres(describe);

type SeedProject = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  /** Two hex digits woven into the seeded UUID-shaped ids. */
  marker: string;
  /** Multiplier applied to the benchmark fixture's provider costs. */
  costScale: number;
};

const alpha: SeedProject = {
  projectId: "scoped-read-alpha",
  localeBranchId: "scoped-read-alpha-branch",
  sourceRevisionId: "scoped-read-alpha-revision",
  marker: "a1",
  costScale: 1,
};

const beta: SeedProject = {
  projectId: "scoped-read-beta",
  localeBranchId: "scoped-read-beta-branch",
  sourceRevisionId: "scoped-read-beta-revision",
  marker: "b2",
  costScale: 3,
};

/** Billed totals the ledger must report per project (the zero-cost run is excluded). */
const billedMicrosUsd = (project: SeedProject): number =>
  benchmarkReportFixture.providerModelCostRecords.reduce(
    (total, record) => total + (record.cost.amountMicrosUsd ?? 0) * project.costScale,
    0,
  );

const unknownProjectId = "scoped-read-project-that-does-not-exist";

postgresDescribe("project-scoped read APIs", () => {
  beforeAll(() => {
    // The full service graph builds a field-memo cipher; supply a deterministic
    // test key when the harness has not set one (mirrors the other live-DB tests).
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("answers every project-scoped read from the named project, never the other one", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        await seedProject(services, alpha);
        await seedProject(services, beta);
        await seedRuntimeEvidenceRun(context, alpha);
        // Make "the workspace's latest project" deterministic AND != alpha, so
        // an ignored scope answers with beta and every alpha assertion fails.
        await markLatestProject(context, beta);

        const api = privilegedReadApi(services);

        // projects.status
        for (const project of [alpha, beta]) {
          const status = await readJson(api, "/api/projects/status", project.projectId);
          expect(status.body).toMatchObject({ projectId: project.projectId });
        }

        // projects.decisions — finding rows, not just a rollup.
        for (const project of [alpha, beta]) {
          const decisions = await readJson(api, "/api/projects/decisions", project.projectId);
          expect(decisions.body).toMatchObject({
            projectId: project.projectId,
            counts: { pendingDecisionCount: 1 },
          });
          expect(decisionTitles(decisions.body)).toEqual([findingTitle(project)]);
          expect(decisionTitles(decisions.body)).not.toContain(findingTitle(other(project)));
        }

        // projects.cost — the ledger totals differ per project by construction.
        for (const project of [alpha, beta]) {
          const cost = await readJson(api, "/api/projects/cost", project.projectId);
          expect(cost.body).toMatchObject({
            projectId: project.projectId,
            billedMicrosUsd: billedMicrosUsd(project),
            runCount: benchmarkReportFixture.providerModelCostRecords.length,
          });
        }

        // projects.benchmarks
        for (const project of [alpha, beta]) {
          const benchmarks = await readJson(api, "/api/projects/benchmarks", project.projectId);
          expect(benchmarkRunIds(benchmarks.body)).toEqual([benchmarkRunId(project)]);
        }

        // projects.overview — the composed drill-down payload the portfolio needs.
        for (const project of [alpha, beta]) {
          const overview = await readJson(api, "/api/projects/overview", project.projectId);
          const body = overview.body as Record<string, any>;
          expect(body.projectId).toBe(project.projectId);
          expect(body.progress.projectId).toBe(project.projectId);
          expect(body.decisions.projectId).toBe(project.projectId);
          expect(body.cost).toMatchObject({
            projectId: project.projectId,
            billedMicrosUsd: billedMicrosUsd(project),
          });
          expect(body.telemetry.projectId).toBe(project.projectId);
          expect(body.costDrilldown.filter.projectId).toBe(project.projectId);
          expect(body.costDrilldown.rows.length).toBe(
            benchmarkReportFixture.providerModelCostRecords.length,
          );
          expect(
            (body.costDrilldown.rows as Array<{ providerRunId: string }>).map(
              (row) => row.providerRunId,
            ),
          ).toEqual(expect.arrayContaining(providerRunIds(project)));
          expect(
            (body.costDrilldown.rows as Array<{ providerRunId: string }>).map(
              (row) => row.providerRunId,
            ),
          ).not.toEqual(expect.arrayContaining(providerRunIds(other(project))));
          expect(body.benchmarkHeadline.reportCount).toBe(1);
          expect(body.benchmarkHeadline.latestReport.benchmarkRunId).toBe(benchmarkRunId(project));
        }

        // runtime.status — alpha owns the only runtime evidence run.
        const alphaRuntime = await readJson(api, "/api/runtime/v0.2/status", alpha.projectId);
        expect(alphaRuntime.body).toMatchObject({
          runtimeRunId: runtimeRunId(alpha),
          finalStatus: "hello_world_passed",
        });
        const betaRuntime = await readJson(api, "/api/runtime/v0.2/status", beta.projectId);
        expect(betaRuntime.body).toMatchObject({ runtimeRunId: null });

        // A run id belonging to another project is NOT reachable through a scope.
        const crossScoped = await api({
          method: "GET",
          pathname: "/api/runtime/v0.2/status",
          search: `?projectId=${beta.projectId}&runtimeRunId=${runtimeRunId(alpha)}`,
        });
        expect(crossScoped.statusCode).toBe(404);
      });
    } finally {
      await context.close();
    }
  });

  it("keeps the unscoped reads meaning what they mean today", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        await seedProject(services, alpha);
        await seedProject(services, beta);
        await markLatestProject(context, beta);

        const api = privilegedReadApi(services);
        for (const pathname of [
          "/api/projects/status",
          "/api/projects/decisions",
          "/api/projects/cost",
        ]) {
          const response = await api({ method: "GET", pathname });
          expect(response.statusCode).toBe(200);
          expect(response.body).toMatchObject({ projectId: beta.projectId });
        }
        const benchmarks = await api({ method: "GET", pathname: "/api/projects/benchmarks" });
        expect(benchmarkRunIds(benchmarks.body)).toEqual([benchmarkRunId(beta)]);
      });
    } finally {
      await context.close();
    }
  });

  it("fails closed with 404 when the scope names a project that does not exist", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        await seedProject(services, alpha);

        const api = privilegedReadApi(services);
        for (const pathname of [
          "/api/projects/status",
          "/api/projects/decisions",
          "/api/projects/cost",
          "/api/projects/benchmarks",
          "/api/projects/overview",
          "/api/runtime/v0.2/status",
        ]) {
          const response = await api({
            method: "GET",
            pathname,
            search: `?projectId=${unknownProjectId}`,
          });
          expect({ pathname, statusCode: response.statusCode }).toEqual({
            pathname,
            statusCode: 404,
          });
          expect(response.body).toMatchObject({ code: "not_found" });
        }
      });
    } finally {
      await context.close();
    }
  });

  it("refuses an empty scope and an unknown scope parameter", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        await seedProject(services, alpha);
        const api = privilegedReadApi(services);

        const empty = await api({
          method: "GET",
          pathname: "/api/projects/decisions",
          search: "?projectId=",
        });
        expect(empty.statusCode).toBe(400);

        const unknownParam = await api({
          method: "GET",
          pathname: "/api/projects/cost",
          search: "?projectIdentifier=x",
        });
        expect(unknownParam.statusCode).toBe(400);
      });
    } finally {
      await context.close();
    }
  });

  it("does not let a project scope widen what an unprivileged caller may read", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        await seedProject(services, alpha);
        await seedProject(services, beta);
        await markLatestProject(context, beta);

        // The catalog.read gate is resolved from the caller's permissions, not
        // from the requested scope: naming a project must narrow the answer,
        // never unlock the privileged detail.
        const denied = readOnlyApiServices({
          ...services,
          authorization: {
            requirePermission: async (permission) => {
              throw new AuthorizationError({ userId: "no-permissions" }, permission);
            },
          },
        } as never);

        const cost = await handleReadOnlyItotoriApiRequest(
          {
            method: "GET",
            pathname: "/api/projects/cost",
            search: `?projectId=${alpha.projectId}`,
          },
          denied,
        );
        expect(cost.statusCode).toBe(200);
        expect(cost.body).toMatchObject({ projectId: alpha.projectId, recentRuns: [] });

        const privileged = await readJson(
          privilegedReadApi(services),
          "/api/projects/cost",
          alpha.projectId,
        );
        expect((privileged.body as { recentRuns: unknown[] }).recentRuns.length).toBe(
          benchmarkReportFixture.providerModelCostRecords.length,
        );
        expect(permissionValues.catalogRead).toBe("catalog.read");
      });
    } finally {
      await context.close();
    }
  });
});

type ReadApi = (request: {
  method: string;
  pathname: string;
  search?: string;
}) => Promise<{ statusCode: number; body: unknown }>;

function privilegedReadApi(services: unknown): ReadApi {
  const readOnly = readOnlyApiServices({
    ...(services as Record<string, unknown>),
    // withDatabaseItotoriServices leaves the authorization surface as an
    // unbound stub; the read-only route gate only needs requirePermission.
    authorization: { requirePermission: async () => undefined },
  } as never);
  return async (request) => await handleReadOnlyItotoriApiRequest(request, readOnly);
}

async function readJson(
  api: ReadApi,
  pathname: string,
  projectId: string,
): Promise<{ statusCode: number; body: unknown }> {
  const response = await api({ method: "GET", pathname, search: `?projectId=${projectId}` });
  expect({ pathname, statusCode: response.statusCode, body: response.body }).toMatchObject({
    pathname,
    statusCode: 200,
  });
  return response;
}

function other(project: SeedProject): SeedProject {
  return project === alpha ? beta : alpha;
}

function findingId(project: SeedProject): string {
  return `019ed002-0000-7000-8000-0000000009${project.marker}`;
}

function findingTitle(project: SeedProject): string {
  return `${project.projectId} pending decision`;
}

function benchmarkRunId(project: SeedProject): string {
  return `019ed006-0000-7000-8000-0000000000${project.marker}`;
}

function providerRunIds(project: SeedProject): string[] {
  return benchmarkReportFixture.providerModelCostRecords.map(
    (_record, index) => `019ed006-0000-7000-8000-00000000${index}1${project.marker}`,
  );
}

function runtimeRunId(project: SeedProject): string {
  return `${project.projectId}-runtime-run`;
}

function decisionTitles(body: unknown): string[] {
  return ((body as { pendingDecisions: Array<{ title: string }> }).pendingDecisions ?? []).map(
    (decision) => decision.title,
  );
}

function benchmarkRunIds(body: unknown): string[] {
  return ((body as { reports: Array<{ benchmarkRunId: string }> }).reports ?? []).map(
    (report) => report.benchmarkRunId,
  );
}

/**
 * Seed one project through the REAL workflow ports: run-scope provisioning, an
 * open finding, and a recorded benchmark report (which also writes the provider
 * runs + cost ledger rows the cost report, telemetry and drill-down read).
 */
async function seedProject(services: any, project: SeedProject): Promise<void> {
  const workflow = services.projectWorkflow;
  await workflow.ensureRunProjectScope({
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    sourceRevisionId: project.sourceRevisionId,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    engineFamily: "synthetic_fixture",
    sourceRoot: `/fixture/${project.projectId}/source`,
    buildRoot: `/fixture/${project.projectId}/build`,
    extractProfile: { surface: "project-scoped-reads" },
  });
  await workflow.recordFinding(project.projectId, {
    localeBranchId: project.localeBranchId,
    finding: {
      ...findingRecordFixture,
      findingId: findingId(project),
      title: findingTitle(project),
    },
  });
  await workflow.recordBenchmarkReport(project.projectId, {
    benchmarkReport: scopedBenchmarkReport(project),
  });
}

function scopedBenchmarkReport(project: SeedProject): BenchmarkReportV02 {
  return {
    ...benchmarkReportFixture,
    benchmarkRunId: benchmarkRunId(project),
    localeBranchId: project.localeBranchId,
    providerModelCostRecords: benchmarkReportFixture.providerModelCostRecords.map(
      (record, index) => ({
        ...record,
        providerRunId: providerRunIds(project)[index]!,
        // Prompt presets are immutable per (id, version) and the recorded config
        // snapshot embeds the benchmark run id, so each project needs its own.
        prompt: {
          ...record.prompt,
          promptPresetId: `${record.prompt.promptPresetId}-${project.marker}`,
        },
        cost: {
          ...record.cost,
          amountMicrosUsd: (record.cost.amountMicrosUsd ?? 0) * project.costScale,
        },
      }),
    ),
  };
}

/**
 * Seed one persisted runtime evidence run for `project`. The runtime status read
 * has no ingest port on the read-only surface, so the two durable rows it selects
 * from are inserted directly; every assertion still runs over HTTP.
 */
async function seedRuntimeEvidenceRun(
  context: { pool: { query(text: string, values: unknown[]): Promise<unknown> } },
  project: SeedProject,
): Promise<void> {
  const artifactId = `${project.projectId}-runtime-report`;
  const sourceBundleId = `${project.projectId}:${project.sourceRevisionId}:run-scope`;
  await context.pool.query(
    `insert into itotori_artifacts
       (artifact_id, project_id, locale_branch_id, source_bundle_id, artifact_kind, metadata)
     values ($1, $2, $3, $4, 'runtime_report', '{"status":"passed"}'::jsonb)`,
    [artifactId, project.projectId, project.localeBranchId, sourceBundleId],
  );
  await context.pool.query(
    `insert into itotori_runtime_evidence_runs
       (runtime_run_id, project_id, locale_branch_id, source_bundle_id,
        source_bundle_revision_id, runtime_report_artifact_id, adapter_name,
        status, fidelity_tier, report_created_at, metadata)
     values ($1, $2, $3, $4, $5, $6, 'fixture-runtime-adapter', 'passed',
             'observed', now(), '{}'::jsonb)`,
    [
      runtimeRunId(project),
      project.projectId,
      project.localeBranchId,
      sourceBundleId,
      project.sourceRevisionId,
      artifactId,
    ],
  );
}

/** Make "the workspace's most recently updated project" deterministic. */
async function markLatestProject(
  context: { pool: { query(text: string, values: unknown[]): Promise<unknown> } },
  project: SeedProject,
): Promise<void> {
  await context.pool.query(
    `update itotori_projects set updated_at = now() + interval '1 hour' where project_id = $1`,
    [project.projectId],
  );
}
