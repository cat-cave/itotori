import { describe, expect, it } from "vitest";
import { usageCostToDecimalString, usageCostToMicros } from "../src/providers/cost.js";

describe("provider cost normalization", () => {
  it("preserves a positive numeric charge below the former 12-decimal rounding floor", () => {
    // This is a numeric OpenRouter-shaped usage.cost value rather than a
    // fabricated ProviderCost literal. A fixed `toFixed(12)` conversion
    // previously erased it before the durable ledger could record the bill.
    const positiveSubPicodollarCharge = 1e-13;

    expect(usageCostToDecimalString(positiveSubPicodollarCharge)).toBe("0.0000000000001");
    // Micros remain an informational rounded mirror; `amountUsd` above is
    // the authoritative exact value persisted and reconciled end-to-end.
    expect(usageCostToMicros(positiveSubPicodollarCharge)).toBe(0);
  });
});
