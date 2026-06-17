// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { renderRuntimeDashboard } from "../src/dashboard.js";

const server = setupServer(
  http.get("http://localhost:3000/api/hello/status", () =>
    HttpResponse.json({
      finalStatus: "hello_world_passed",
      runtimeReportId: "runtime-1",
      runtimeStatus: "passed",
      fidelityTier: "layout_probe",
      textEventCount: 1,
      frameCaptureCount: 1,
    }),
  ),
  http.get("http://itotori.test/api/hello/status", () =>
    HttpResponse.json({
      finalStatus: "hello_world_passed",
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

describe("Utsushi runtime dashboard", () => {
  it("keeps the default hello status endpoint compatible", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root);

    expect(root.textContent).toContain("runtime-1");
    expect(root.textContent).toContain("layout_probe");
    expect(root.textContent).toContain("1 text event");
    expect(root.textContent).toContain("1 frame capture");
  });

  it("renders DB-backed runtime evidence from the shared API", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/hello/status");

    expect(root.textContent).toContain("runtime-1");
    expect(root.textContent).toContain("layout_probe");
    expect(root.textContent).toContain("1 text event");
    expect(root.textContent).toContain("1 frame capture");
  });
});
