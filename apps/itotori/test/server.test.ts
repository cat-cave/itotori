import type { AddressInfo } from "node:net";
import type { Permission } from "@itotori/db";
import type { ItotoriApplicationServices } from "../src/services/database-services.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  benchmarkReportFixture,
  bridgeFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  decisionEventFixture,
  findingRecordFixture,
  projectFixture,
  runtimeIngestResultFixture,
  runtimeStatusFixture,
} from "./api-fixtures.js";

const requirePermission = vi.fn<[Permission], Promise<void>>(async () => {});
const getDashboardStatus = vi.fn(async () => dashboardStatusFixture);
const getRuntimeStatus = vi.fn(async () => runtimeStatusFixture);
const getCostReport = vi.fn(async () => costReportFixture);
const getDashboardDecisions = vi.fn(async () => dashboardDecisionsFixture);
const importBridge = vi.fn(async () => projectFixture);

const { createItotoriServer, startItotoriServer } = await import("../src/server.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("Itotori server API contracts", () => {
  it("serves project dashboard status from /api/projects/status", async () => {
    const response = await requestJson({ path: "/api/projects/status" });

    expect(response).toMatchObject({
      projectId: "project-1",
      status: "runtime_ingested",
      localeBranches: [{ targetLocale: "en-US" }],
    });
    expect(getDashboardStatus).toHaveBeenCalledTimes(1);
    expect(getRuntimeStatus).not.toHaveBeenCalled();
  });

  it("serves the legacy runtime status shape from /api/hello/status", async () => {
    const response = await requestJson({ path: "/api/hello/status" });

    expect(response).toEqual(runtimeStatusFixture);
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(getDashboardStatus).not.toHaveBeenCalled();
  });

  it("serves project cost status from /api/projects/cost", async () => {
    const response = await requestJson({ path: "/api/projects/cost" });

    expect(response).toMatchObject({
      projectId: "project-1",
      billedMicrosUsd: 1200,
      estimatedMicrosUsd: 980,
    });
    expect(getCostReport).toHaveBeenCalledTimes(1);
    expect(getDashboardStatus).not.toHaveBeenCalled();
  });

  it("routes typed bridge imports through JSON request parsing and permission checks", async () => {
    const response = await requestJson({
      path: "/api/imports/bridge",
      method: "POST",
      body: { bridge: bridgeFixture },
    });

    expect(response).toMatchObject({
      project: { projectId: "project-1" },
      status: { projectId: "project-1" },
    });
    expect(requirePermission).toHaveBeenCalledWith("project.import");
    expect(importBridge).toHaveBeenCalledWith(bridgeFixture);
  });

  it("binds the dashboard server to loopback by default", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const server = startItotoriServer({
      port: 0,
      serviceFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    try {
      await waitForListening(server);
      const address = server.address() as AddressInfo;

      expect(address.address).toBe("127.0.0.1");

      const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/status`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ projectId: "project-1" });
    } finally {
      consoleLog.mockRestore();
      await closeServer(server);
    }
  });

  it("returns a typed bad request response for malformed JSON", async () => {
    const server = createItotoriServer({
      serviceFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/imports/bridge`, {
        method: "POST",
        body: "{",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "bad_request" });
    } finally {
      await closeServer(server);
    }
  });
});

async function requestJson(options: {
  path: string;
  method?: string;
  body?: unknown;
}): Promise<unknown> {
  const server = createItotoriServer({
    serviceFactory,
    webRoot: new URL("file:///tmp/itotori-empty-web/"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${options.path}`, {
      method: options.method ?? "GET",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    return await response.json();
  } finally {
    await closeServer(server);
  }
}

async function waitForListening(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  if (server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function closeServer(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function serviceFactory<T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  return await callback({
    authorization: {
      requirePermission,
    },
    projectWorkflow: {
      reset: vi.fn(async () => {}),
      getDashboardStatus,
      getRuntimeStatus,
      getDashboardDecisions,
      getCostReport,
      importBridge,
      draftProject: vi.fn(async () => projectFixture),
      exportPatch: vi.fn(async () => {
        throw new Error("not used");
      }),
      ingestRuntimeReport: vi.fn(async () => ({
        project: projectFixture,
        result: runtimeIngestResultFixture,
      })),
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
    },
    manualFeedback: {
      importManualFeedback: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  });
}
