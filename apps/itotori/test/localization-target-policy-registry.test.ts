import { describe, expect, it } from "vitest";

import { resolveTargetPolicyForAdapter, SOFTPAL_SJIS_POLICY_ID } from "../src/gates/index.js";

describe("localization target policy registry", () => {
  it("resolves the Softpal bridge to its Shift-JIS TEXT.DAT policy", () => {
    const policy = resolveTargetPolicyForAdapter("kaifuu-softpal");

    expect(policy).toMatchObject({
      policyId: SOFTPAL_SJIS_POLICY_ID,
      adapterId: "kaifuu-softpal",
      codec: "shift-jis",
      runtimeEvidenceChannels: ["decoded-textline", "render-ocr"],
    });
    expect(policy.firstDisallowedCodePoint("safe 😀")?.reason).toBe("not Shift-JIS-representable");
  });
});
