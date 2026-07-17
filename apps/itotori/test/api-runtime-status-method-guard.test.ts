import { describe, expect, it, vi } from "vitest";
import { handleItotoriApiRequest, type ItotoriApiServices } from "../src/api-handlers.js";
import { runtimeStatusFixture } from "./api-fixtures.js";

function runtimeStatusServices(): ItotoriApiServices {
  return {
    authorization: {
      requirePermission: vi.fn(async () => {}),
    },
    projectWorkflow: {
      getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
    },
  } as unknown as ItotoriApiServices;
}

describe("runtime v0.2 status API method guard", () => {
  it.each(["POST", "DELETE"])("returns method_not_allowed for %s", async (method) => {
    const response = await handleItotoriApiRequest(
      { method, pathname: "/api/runtime/v0.2/status" },
      runtimeStatusServices(),
    );

    expect(response).toEqual({
      statusCode: 405,
      body: { error: "method must be GET", code: "method_not_allowed" },
    });
  });

  it("preserves the GET runtime status response", async () => {
    const response = await handleItotoriApiRequest(
      { method: "GET", pathname: "/api/runtime/v0.2/status" },
      runtimeStatusServices(),
    );

    expect(response).toEqual({ statusCode: 200, body: runtimeStatusFixture });
  });

  it("returns not_found for an unknown runtime route", async () => {
    const response = await handleItotoriApiRequest(
      { method: "POST", pathname: "/api/runtime/v0.2/unknown" },
      runtimeStatusServices(),
    );

    expect(response).toEqual({
      statusCode: 404,
      body: {
        error: "unknown API route: /api/runtime/v0.2/unknown",
        code: "not_found",
      },
    });
  });
});
