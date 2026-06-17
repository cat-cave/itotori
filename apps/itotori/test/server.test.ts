import type { AddressInfo } from "node:net";
import type { ProjectDashboardStatus, RuntimeDashboardStatus } from "@itotori/db";
import type { ItotoriApplicationServices } from "../src/services/database-services.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const getDashboardStatus = vi.fn(async () => dashboardStatusFixture);
const getRuntimeStatus = vi.fn(async () => runtimeStatusFixture);

const { createItotoriServer } = await import("../src/server.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("Itotori server API contracts", () => {
  it("serves project dashboard status from /api/projects/status", async () => {
    const response = await requestJson("/api/projects/status");

    expect(response).toMatchObject({
      projectId: "project-1",
      status: "runtime_ingested",
      localeBranches: [],
    });
    expect(getDashboardStatus).toHaveBeenCalledTimes(1);
    expect(getRuntimeStatus).not.toHaveBeenCalled();
  });

  it("serves the legacy runtime status shape from /api/hello/status", async () => {
    const response = await requestJson("/api/hello/status");

    expect(response).toEqual(runtimeStatusFixture);
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(getDashboardStatus).not.toHaveBeenCalled();
  });
});

const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-1",
  projectKey: "project-1",
  name: "project-1",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
  sourceBundleId: "bridge-1",
  sourceBundleHash: "hash-1",
  sourceBundleRevisionId: "revision-1",
  branchCount: 1,
  unitCount: 1,
  findingCount: 0,
  artifactCount: 3,
  latestEventKind: "patch_result_recorded",
  latestEventAt: "2026-06-17T00:00:00.000Z",
  localeBranches: [],
};

const runtimeStatusFixture: RuntimeDashboardStatus = {
  finalStatus: "hello_world_passed",
  runtimeReportId: "runtime-1",
  runtimeStatus: "passed",
  fidelityTier: "layout_probe",
  evidenceTier: null,
  textEventCount: 1,
  frameCaptureCount: 1,
  screenshotArtifactCount: 1,
  recordingArtifactCount: 0,
  validationFindingCount: 0,
};

async function requestJson(path: string): Promise<unknown> {
  const server = createItotoriServer({
    serviceFactory,
    webRoot: new URL("file:///tmp/itotori-empty-web/"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    expect(response.status).toBe(200);
    return await response.json();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function serviceFactory<T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  return await callback({
    projectWorkflow: {
      reset: vi.fn(async () => {}),
      getDashboardStatus,
      getRuntimeStatus,
      importBridge: vi.fn(async () => {
        throw new Error("not used");
      }),
      draftProject: vi.fn(async () => {
        throw new Error("not used");
      }),
      exportPatch: vi.fn(async () => {
        throw new Error("not used");
      }),
      ingestRuntimeReport: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    manualFeedback: {
      importManualFeedback: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  });
}
