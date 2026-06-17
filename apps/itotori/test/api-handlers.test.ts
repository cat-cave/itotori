import { AuthorizationError, permissionValues, type Permission } from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import {
  handleItotoriApiRequest,
  isItotoriApiPath,
  type ItotoriApiRequest,
  type ItotoriApiServices,
} from "../src/api-handlers.js";
import {
  benchmarkReportFixture,
  bridgeFixture,
  costReportFixture,
  dashboardStatusFixture,
  decisionEventFixture,
  findingRecordFixture,
  projectFixture,
  runtimeIngestResultFixture,
  runtimeReportFixture,
  runtimeStatusFixture,
} from "./api-fixtures.js";

describe("Itotori API handlers", () => {
  it("routes project and runtime status reads without permission checks", async () => {
    const services = serviceFixture();

    const projects = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects" },
      services,
    );
    const projectStatus = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/status" },
      services,
    );
    const runtimeStatus = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/hello/status" },
      services,
    );
    const costStatus = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/projects/cost" },
      services,
    );

    expect(projects).toEqual({ statusCode: 200, body: { projects: [dashboardStatusFixture] } });
    expect(projectStatus).toEqual({ statusCode: 200, body: dashboardStatusFixture });
    expect(runtimeStatus).toEqual({ statusCode: 200, body: runtimeStatusFixture });
    expect(costStatus).toEqual({ statusCode: 200, body: costReportFixture });
    expect(services.projectWorkflow.getDashboardStatus).toHaveBeenCalledTimes(2);
    expect(services.projectWorkflow.getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(services.projectWorkflow.getCostReport).toHaveBeenCalledTimes(1);
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "bridge import",
      request: post("/api/imports/bridge", { bridge: bridgeFixture }),
      permission: permissionValues.projectImport,
      service: "importBridge",
    },
    {
      name: "branch draft",
      request: post("/api/projects/project-1/branches", {
        project: projectFixture,
        targetLocale: "fr-FR",
      }),
      permission: permissionValues.draftWrite,
      service: "draftProject",
    },
    {
      name: "finding record",
      request: post("/api/projects/project-1/findings", {
        localeBranchId: "locale-1",
        finding: findingRecordFixture,
      }),
      permission: permissionValues.runtimeIngest,
      service: "recordFinding",
    },
    {
      name: "decision record",
      request: post("/api/projects/project-1/decisions", {
        localeBranchId: "locale-1",
        event: decisionEventFixture,
      }),
      permission: permissionValues.runtimeIngest,
      service: "recordDecision",
    },
    {
      name: "benchmark record",
      request: post("/api/projects/project-1/benchmarks", {
        localeBranchId: "locale-1",
        benchmarkReport: benchmarkReportFixture,
      }),
      permission: permissionValues.runtimeIngest,
      service: "recordBenchmarkReport",
    },
    {
      name: "runtime evidence ingest",
      request: post("/api/projects/project-1/runtime-evidence", {
        project: projectFixture,
        runtimeReport: runtimeReportFixture,
      }),
      permission: permissionValues.runtimeIngest,
      service: "ingestRuntimeReport",
    },
  ] as const)(
    "checks permissions before the $name mutation",
    async ({ request, permission, service }) => {
      const services = serviceFixture();

      const response = await handleItotoriApiRequest(request, services);

      expect(response.statusCode).toBe(200);
      expect(services.authorization.requirePermission).toHaveBeenCalledWith(permission);
      expect(services.projectWorkflow[service]).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed request bodies before checking permissions", async () => {
    const services = serviceFixture();

    const response = await handleItotoriApiRequest(
      post("/api/imports/bridge", { bridge: { schemaVersion: "bad" } }),
      services,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "bad_request" });
    expect(services.authorization.requirePermission).not.toHaveBeenCalled();
    expect(services.projectWorkflow.importBridge).not.toHaveBeenCalled();
  });

  it("returns forbidden when permission middleware rejects a mutation", async () => {
    const services = serviceFixture();
    services.authorization.requirePermission.mockRejectedValueOnce(
      new AuthorizationError({ userId: "missing-grant" }, permissionValues.projectImport),
    );

    const response = await handleItotoriApiRequest(
      post("/api/imports/bridge", { bridge: bridgeFixture }),
      services,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "forbidden" });
    expect(services.projectWorkflow.importBridge).not.toHaveBeenCalled();
  });

  it("allows failed runtime evidence ingest results with validation findings", async () => {
    const services = serviceFixture();
    services.projectWorkflow.ingestRuntimeReport.mockResolvedValueOnce({
      project: projectFixture,
      result: {
        ...runtimeIngestResultFixture,
        status: "hello_world_failed",
      },
    });

    const response = await handleItotoriApiRequest(
      post("/api/projects/project-1/runtime-evidence", {
        project: projectFixture,
        runtimeReport: { ...runtimeReportFixture, status: "failed" },
      }),
      services,
    );

    expect(response).toMatchObject({
      statusCode: 200,
      body: { status: "hello_world_failed", runtimeReportId: "runtime-1" },
    });
  });

  it("identifies API paths without claiming static assets", () => {
    expect(isItotoriApiPath("/api/projects/status")).toBe(true);
    expect(isItotoriApiPath("/api/projects/project-1/findings")).toBe(true);
    expect(isItotoriApiPath("/assets/main.js")).toBe(false);
  });
});

function post(pathname: string, body: unknown): ItotoriApiRequest {
  return { method: "POST", pathname, body };
}

function serviceFixture(): ItotoriApiServices {
  return {
    authorization: {
      requirePermission: vi.fn<[Permission], Promise<void>>(async () => {}),
    },
    projectWorkflow: {
      getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
      getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
      getCostReport: vi.fn(async () => costReportFixture),
      importBridge: vi.fn(async () => projectFixture),
      draftProject: vi.fn(async () => projectFixture),
      recordFinding: vi.fn(async () => ({
        findingId: findingRecordFixture.findingId,
        status: "open" as const,
      })),
      recordDecision: vi.fn(async () => ({
        decisionId: decisionEventFixture.eventId,
        eventKind: decisionEventFixture.eventKind,
        recorded: true,
      })),
      recordBenchmarkReport: vi.fn(async () => ({
        benchmarkRunId: benchmarkReportFixture.benchmarkRunId,
        artifactId: benchmarkReportFixture.benchmarkRunId,
        status: benchmarkReportFixture.status,
        systemCount: benchmarkReportFixture.systemsCompared.length,
        findingCount: benchmarkReportFixture.findingRecords.length,
      })),
      ingestRuntimeReport: vi.fn(async () => ({
        project: projectFixture,
        result: runtimeIngestResultFixture,
      })),
    },
  };
}
