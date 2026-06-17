// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { assertItotoriApiResponse } from "../src/api-schema.js";
import { renderDashboard } from "../src/dashboard.js";
import { itotoriApiMswHandlers } from "./msw-handlers.js";

const server = setupServer(...itotoriApiMswHandlers);

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
    expect(root.textContent).toContain("provider_estimate");
    expect(root.textContent).toContain("itotori-draft-default-v1@1.0.0");
  });

  it("checks MSW project fixtures against the real API response schema", () => {
    expect(() =>
      assertItotoriApiResponse("projects.status", {
        projectId: "project-1",
        status: "runtime_ingested",
      }),
    ).toThrow("projectKey");
  });
});
