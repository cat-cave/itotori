import { ProviderUnavailableError } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { localizeFailureBlocker } from "../src/cli/localize-failure-blocker.js";
import { PatchRuntimeLaunchError } from "../src/play/runtime-launcher-registry.js";

describe("localize failure blockers", () => {
  it("preserves the legacy stage blocker for an untyped fault", () => {
    expect(localizeFailureBlocker("draft", new Error("provider timeout"))).toBe("draft-failed");
  });

  it("records stable evidence code and next action for typed faults", () => {
    expect(localizeFailureBlocker("draft", new ProviderUnavailableError(503))).toBe(
      "draft:provider_unavailable:retry-provider-request",
    );
    expect(
      localizeFailureBlocker(
        "play",
        new PatchRuntimeLaunchError("unsupported_runtime_operation", "missing permission"),
      ),
    ).toBe("play:unknown_in_profile_operation:repair-in-profile-operation");
  });
});
