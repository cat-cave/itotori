// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { renderDashboard } from "../src/dashboard.js";

const server = setupServer(
  http.get("http://itotori.test/api/hello/status", () =>
    HttpResponse.json({
      projectId: "project-1",
      bridgeId: "bridge-1",
      localeBranchId: "locale-1",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      finalStatus: "hello_world_passed",
      unitCount: 1,
      translatedUnitCount: 1,
      patchExportId: "patch-1",
      runtimeReportId: "runtime-1",
      runtimeStatus: "passed",
      fidelityTier: "layout_probe",
      textEventCount: 1,
      frameCaptureCount: 1,
    }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Itotori dashboard", () => {
  it("renders DB-backed hello-world status from the API", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    await renderDashboard(root, "http://itotori.test/api/hello/status");

    expect(root.textContent).toContain("hello_world_passed");
    expect(root.textContent).toContain("ja-JP -> en-US");
    expect(root.textContent).toContain("1/1 translated");
    expect(root.textContent).toContain("runtime-1");
  });
});
