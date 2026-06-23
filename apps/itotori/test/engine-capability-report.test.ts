import { describe, expect, it } from "vitest";
import {
  adapterBadge,
  type AdapterCapabilitySummary,
  toSummary,
} from "../src/services/engine-capability-report.js";
import { renderEngineCapabilityRows } from "../src/dashboard.js";

// KAIFUU-053: itotori-side consumer round-trips. Mirrors the strict-gate
// tests in `crates/kaifuu-core/src/registry/` and
// `packages/localization-bridge-schema/test/schema.test.ts`.

describe("adapterBadge", () => {
  it("returns 'supported' when extract is supported", () => {
    expect(
      adapterBadge({
        adapterId: "kaifuu.full",
        identify: { kind: "supported" },
        inventory: { kind: "supported" },
        extract: { kind: "supported" },
        patch: { kind: "supported" },
      }),
    ).toBe("supported");
  });

  it("returns 'partial' when extract is partial", () => {
    expect(
      adapterBadge({
        adapterId: "kaifuu.reallive",
        identify: { kind: "supported" },
        inventory: { kind: "supported" },
        extract: { kind: "partial", limitations: ["only text"] },
        patch: { kind: "unsupported", reason: "no patch path" },
      }),
    ).toBe("partial");
  });

  it("returns 'identify_only' when identify is supported but extract is unsupported", () => {
    expect(
      adapterBadge({
        adapterId: "kaifuu.siglus",
        identify: { kind: "supported" },
        inventory: { kind: "unsupported", reason: "no" },
        extract: { kind: "unsupported", reason: "no" },
        patch: { kind: "unsupported", reason: "no" },
      }),
    ).toBe("identify_only");
  });

  it("returns 'unsupported' when identify itself is not supported", () => {
    expect(
      adapterBadge({
        adapterId: "kaifuu.broken",
        identify: { kind: "unsupported", reason: "no detection" },
        inventory: { kind: "unsupported", reason: "no" },
        extract: { kind: "unsupported", reason: "no" },
        patch: { kind: "unsupported", reason: "no" },
      }),
    ).toBe("unsupported");
  });
});

describe("renderEngineCapabilityRows", () => {
  function summaryFor(adapterId: string, override: Partial<AdapterCapabilitySummary> = {}) {
    return toSummary({
      adapterId,
      identify: { kind: "supported" },
      inventory: { kind: "supported" },
      extract: { kind: "supported" },
      patch: { kind: "supported" },
      ...override,
    } as Parameters<typeof toSummary>[0]);
  }

  it("renders an Identified only badge for engines with no Extract path", () => {
    const html = renderEngineCapabilityRows([
      summaryFor("kaifuu.siglus", {
        identify: { kind: "supported" },
        inventory: { kind: "unsupported", reason: "detector-only fixture" },
        extract: { kind: "unsupported", reason: "detector-only fixture" },
        patch: { kind: "unsupported", reason: "detector-only fixture" },
      }),
    ]);
    expect(html).toContain("Identified only");
    expect(html).toContain("kaifuu.siglus");
    // The reason is surfaced as a tooltip title (defense in depth — users
    // hovering over the unsupported chip see the cause).
    expect(html).toContain("detector-only fixture");
  });

  it("renders a Partial extract badge when extract is partial", () => {
    const html = renderEngineCapabilityRows([
      summaryFor("kaifuu.reallive", {
        extract: { kind: "partial", limitations: ["only text"] },
        patch: { kind: "unsupported", reason: "no patch path" },
      }),
    ]);
    expect(html).toContain("Partial extract");
    expect(html).toContain("only text");
  });

  it("renders an empty-copy panel when no matrices are recorded", () => {
    const html = renderEngineCapabilityRows([]);
    expect(html).toContain("No engine capability reports recorded yet.");
  });
});
