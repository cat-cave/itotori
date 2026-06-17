import type { ProjectDashboardStatus, RuntimeDashboardStatus } from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { handleItotoriApiRequest, isItotoriApiPath } from "../src/api-handlers.js";

describe("Itotori API handlers", () => {
  it("routes project status requests through the status service", async () => {
    const service = serviceFixture();

    const response = await handleItotoriApiRequest("/api/projects/status", service);

    expect(response).toEqual({ statusCode: 200, body: dashboardStatusFixture });
    expect(service.getDashboardStatus).toHaveBeenCalledTimes(1);
    expect(service.getRuntimeStatus).not.toHaveBeenCalled();
  });

  it("routes legacy runtime status requests through the shared status service", async () => {
    const service = serviceFixture();

    const response = await handleItotoriApiRequest("/api/hello/status", service);

    expect(response).toEqual({ statusCode: 200, body: runtimeStatusFixture });
    expect(service.getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(service.getDashboardStatus).not.toHaveBeenCalled();
  });

  it("identifies known API paths without claiming static assets", () => {
    expect(isItotoriApiPath("/api/projects/status")).toBe(true);
    expect(isItotoriApiPath("/api/hello/status")).toBe(true);
    expect(isItotoriApiPath("/assets/main.js")).toBe(false);
  });
});

function serviceFixture() {
  return {
    getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
    getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
  };
}

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
