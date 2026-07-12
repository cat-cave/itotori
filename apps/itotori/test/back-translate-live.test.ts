// benchmark-back-translation-live-roundtrip — standalone paid-route guard.
//
// This formerly exercised a real OpenRouter round trip. Standalone calls now
// fail closed at the universal invocation boundary: they lack the durable run
// cost-admission sink required for a paid dispatch. Keep the real provider
// configuration and an injected fetch trap so the regression proves that
// refusal happens before any network byte or billable request.

import { describe, expect, it } from "vitest";
import {
  BACK_TRANSLATE_LIVE_FLAG,
  runBackTranslateLiveSmoke,
} from "../src/benchmark-stages/index.js";

describe("benchmark back-translation — standalone paid invocation boundary", () => {
  it("refuses the configured OpenRouter route before its injected transport can run", async () => {
    let fetchCalls = 0;
    await expect(
      runBackTranslateLiveSmoke({
        env: {
          [BACK_TRANSLATE_LIVE_FLAG]: "1",
          OPENROUTER_API_KEY: "test-root-boundary-key",
          OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
        },
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("the standalone paid invocation guard must run before fetch");
        },
      }),
    ).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: {
        kind: "budget_cap",
        detail: expect.stringContaining("durable cost-admission"),
      },
    });
    expect(fetchCalls).toBe(0);
  }, 120_000);
});
