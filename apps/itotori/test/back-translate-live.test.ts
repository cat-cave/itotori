// benchmark-back-translation-live-roundtrip — REAL ZDR round-trip proof (gated).
//
// The live counterpart to the CI-safe wiring test. It makes REAL OpenRouter ZDR
// calls (the DEV_PAIR pair) to back-translate a bounded synthetic-public smoke
// system's target text to Japanese, then runs the §3 deterministic tripwire over
// the live-produced back-translations and asserts:
//   - the serve was ZDR-routed and the real (model, provider) pair was recorded;
//   - every call carries a REAL billed `usage.cost` (never approximated); and
//   - the tripwire FIRES on the meaning-loss unit on the live path.
//
// Gated on ITOTORI_BACK_TRANSLATE_LIVE=1 + OPENROUTER_API_KEY +
// OPENROUTER_ZDR_ACCOUNT_ASSERTED=1. Unset → visible skip (no silent pass), so
// `pnpm test` in CI skips it. Budget: two small calls, each capped at $0.05.

import { describe, expect, it } from "vitest";
import {
  BACK_TRANSLATE_LIVE_FLAG,
  runBackTranslateLiveSmoke,
} from "../src/benchmark-stages/index.js";

const LIVE_ENABLED =
  process.env[BACK_TRANSLATE_LIVE_FLAG] === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

describe("benchmark back-translation — REAL ZDR round-trip populates the §3 tripwire", () => {
  it("back-translates over ZDR, records real usage.cost, and trips on meaning-loss", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        `[back-translate-live] skipping real run — set ${BACK_TRANSLATE_LIVE_FLAG}=1, ` +
          "OPENROUTER_API_KEY, and OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 to run it",
      );
      return;
    }

    // runBackTranslateLiveSmoke asserts the account-wide ZDR posture BEFORE any
    // live byte (it throws if OPENROUTER_ZDR_ACCOUNT_ASSERTED !== "1").
    const result = await runBackTranslateLiveSmoke();
    expect(result.status).toBe("passed");
    if (result.status !== "passed") {
      return;
    }

    // (1) the served (model, provider) pair was recorded off the real runs.
    expect(result.servedPair.model.length).toBeGreaterThan(0);

    // (2) every call carries a REAL billed usage.cost + a ZDR-routed serve.
    expect(result.runs.length).toBeGreaterThanOrEqual(2);
    for (const run of result.runs) {
      expect(run.status).toBe("succeeded");
      expect(run.cost.costKind).toBe("billed");
      expect(run.cost.amountUsd.length).toBeGreaterThan(0);
      expect(run.routingPosture.zdr).toBe(true);
    }

    // (3) THE CRUX — the tripwire FIRES on meaning-loss on the live path.
    expect(result.tripped).toBe(true);
    const byLabel = new Map(result.tripwires.map((t) => [t.label, t.tripped]));
    expect(byLabel.get("smoke#meaning-loss")).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[back-translate-live] ${JSON.stringify({
        servedPair: result.servedPair,
        costs: result.runs.map((r) => r.cost.amountUsd),
        tripwires: result.tripwires.map((t) => ({
          label: t.label,
          sim: t.similarity,
          tripped: t.tripped,
        })),
      })}`,
    );
  }, 120_000);
});
