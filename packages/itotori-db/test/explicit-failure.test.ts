import { describe, expect, it } from "vitest";
import {
  classifyExplicitFailure,
  hasExplicitFailureEvidence,
  InProfileDefectError,
  ItotoriProjectRunCostCapError,
  ItotoriProjectRunRepositoryError,
  MalformedOwnedInputError,
} from "../src/index.js";

describe("explicit failure taxonomy", () => {
  it("carries exact locked-account facts through a cap refusal", () => {
    const error = new ItotoriProjectRunCostCapError(100, 10, 60, 31);

    expect(error).toMatchObject({
      capMicrosUsd: 100,
      spentMicrosUsd: 10,
      reservedMicrosUsd: 60,
      requestedMicrosUsd: 31,
      remainingMicrosUsd: 30,
    });
    expect(classifyExplicitFailure(error)).toMatchObject({
      code: "exact_cap_exhausted",
      remainingAllowanceMicrosUsd: 30,
    });
  });

  it("rejects a broad repository code as exact allowance evidence", () => {
    const error = new ItotoriProjectRunRepositoryError("cost_cap_exceeded", "30 remains");

    expect(hasExplicitFailureEvidence(error)).toBe(false);
    expect(classifyExplicitFailure(error)).toMatchObject({
      code: "unexpected_service_fault",
      remainingAllowanceMicrosUsd: null,
    });
  });

  it("keeps a typed class stable when its message names unrelated classes", () => {
    const error = new InProfileDefectError(
      "repair-in-profile-operation",
      "permission denial after timeout and missing input",
    );

    expect(classifyExplicitFailure(error)).toMatchObject({
      code: "in_profile_defect",
      failureClass: "in-profile defect",
      nextAction: "repair-in-profile-operation",
    });
  });

  it("trusts only the owned-input boundary type as malformed-input evidence", () => {
    expect(classifyExplicitFailure(new MalformedOwnedInputError())).toMatchObject({
      code: "malformed_owned_input",
      httpStatus: 400,
    });
    const unrelated = new SyntaxError("parser implementation defect");
    expect(hasExplicitFailureEvidence(unrelated)).toBe(false);
    expect(classifyExplicitFailure(unrelated)).toMatchObject({
      code: "unexpected_service_fault",
      httpStatus: 500,
    });
  });
});
