// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { renderDashboard } from "../src/dashboard.js";

const server = setupServer(
  http.get("http://itotori.test/api/projects/status", () =>
    HttpResponse.json({
      projectId: "project-1",
      projectKey: "project-1",
      name: "project-1",
      status: "runtime_ingested",
      sourceBundleId: "bridge-1",
      sourceBundleHash: "hash-1",
      sourceBundleRevisionId: "revision-1",
      sourceLocale: "ja-JP",
      branchCount: 1,
      unitCount: 1,
      findingCount: 0,
      artifactCount: 3,
      latestEventKind: "patch_result_recorded",
      latestEventAt: "2026-06-17T00:00:00.000Z",
      localeBranches: [
        {
          localeBranchId: "locale-1",
          targetLocale: "en-US",
          status: "active",
          unitCount: 1,
          translatedUnitCount: 1,
          openFindingCount: 0,
          artifactCount: 3,
        },
      ],
    }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Itotori dashboard", () => {
  it("renders DB-backed project status from the API", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    await renderDashboard(root, "http://itotori.test/api/projects/status");

    expect(root.textContent).toContain("runtime_ingested");
    expect(root.textContent).toContain("en-US");
    expect(root.textContent).toContain("1/1");
    expect(root.textContent).toContain("patch_result_recorded");
  });
});
