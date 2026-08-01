import { ItotoriProjectRunCostCapError, ItotoriProjectRunRepositoryError } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { errorResponse } from "../src/api-handler-responses.js";
import { classifyApplicationFailure } from "../src/explicit-failure/index.js";
import {
  LocalizationTargetPolicyError,
  resolveTargetPolicyForAdapter,
} from "../src/gates/policy/registry.js";
import { PatchRuntimeLaunchError } from "../src/play/runtime-launcher-registry.js";

describe("explicit failure API responses", () => {
  it("returns the exact remaining allowance from a real cap refusal", () => {
    const response = errorResponse(new ItotoriProjectRunCostCapError(100, 10, 60, 31));

    expect(response).toEqual({
      statusCode: 429,
      body: {
        code: "workflow_failed",
        error:
          "budget refusal: exact remaining allowance; remaining allowance 30 micros; next action increase-cap-or-reduce-scope",
        remainingAllowanceMicrosUsd: 30,
      },
    });
  });

  it("does not infer an exact allowance from the repository's broad error code", () => {
    const response = errorResponse(
      new ItotoriProjectRunRepositoryError("cost_cap_exceeded", "remaining allowance 30"),
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error" });
    expect(response.body).not.toHaveProperty("remainingAllowanceMicrosUsd");
    expect(response.body).toHaveProperty(
      "incidentReference",
      expect.stringMatching(
        /^incident:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    );
  });

  it("uses an opaque incident reference without exposing unexpected error prose", () => {
    const response = errorResponse(
      new Error("private path /protected/input.bin and credential do-not-display"),
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      code: "internal_error",
      incidentReference: expect.stringMatching(/^incident:[0-9a-f-]{36}$/u),
    });
    expect(JSON.stringify(response.body)).not.toMatch(/protected|credential|do-not-display/u);
  });

  it("classifies by a typed discriminant when prose names other failure classes", () => {
    const error = new PatchRuntimeLaunchError(
      "runtime_failed",
      "permission denied after provider timeout and missing input",
    );

    expect(classifyApplicationFailure(error)).toMatchObject({
      code: "in_profile_defect",
      failureClass: "in-profile defect",
      diagnosticOutcome: "evidence-derived class and exact next action",
      nextAction: "repair-in-profile-operation",
    });
    expect(errorResponse(error)).toMatchObject({
      statusCode: 422,
      body: { code: "workflow_failed" },
    });
  });

  it("keeps an unrelated syntax defect internal", () => {
    const response = errorResponse(new SyntaxError("private parser implementation detail"));
    expect(response).toMatchObject({
      statusCode: 500,
      body: { code: "internal_error" },
    });
    expect(JSON.stringify(response.body)).not.toContain("private parser implementation detail");
  });

  it("distinguishes an unknown profile from duplicate registry wiring", () => {
    const unknown = captureError(() => resolveTargetPolicyForAdapter("unregistered-test-adapter"));
    expect(classifyApplicationFailure(unknown)).toMatchObject({
      code: "unsupported_source_profile",
      httpStatus: 422,
    });

    const duplicate = new LocalizationTargetPolicyError(
      "duplicate-adapter",
      "duplicate adapter names a missing input and provider timeout",
    );
    expect(classifyApplicationFailure(duplicate)).toMatchObject({
      code: "unexpected_service_fault",
      httpStatus: 500,
    });
    expect(errorResponse(duplicate)).toMatchObject({
      statusCode: 500,
      body: { code: "internal_error" },
    });
  });
});

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}
