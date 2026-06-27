import { describe, expect, it } from "vitest";
import {
  adapterBadge,
  capabilityLevelOrder,
  summarizeCapabilityEvidence,
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

  it("separates public fixture support from private-local aggregate evidence", () => {
    const row = toSummary(
      {
        adapterId: "kaifuu.rpg_maker_mv_mz",
        identify: { kind: "supported" },
        inventory: { kind: "unsupported", reason: "fixture is identify-only" },
        extract: { kind: "unsupported", reason: "fixture is identify-only" },
        patch: { kind: "unsupported", reason: "fixture is identify-only" },
      },
      [
        {
          adapterId: "kaifuu.rpg_maker_mv_mz",
          evidenceSource: "public_fixture",
          evidenceKind: "adapter_matrix",
          publicFixtureId: "rpg-maker-mv-mz-key-validation-success-v0.1",
          level: "identify",
          status: "present",
        },
        {
          adapterId: "kaifuu.rpg_maker_mv_mz",
          evidenceSource: "private_local_aggregate",
          evidenceKind: "local_corpus_sidecar",
          level: "identify",
          status: "present",
          evidenceLabels: [
            "rpgmaker_mv_metadata",
            "encrypted_asset_extension",
            "/home/private/game/System.json",
          ],
          aggregateCounts: {
            corpusCount: 1,
            entryCount: 12,
            markerCount: 3,
            pathHash: 1,
          },
          limitations: [
            "local scan marker evidence only; no adapter execution claimed",
            "SECRET_KEY=/home/private/key.txt",
          ],
        },
      ],
    );

    expect(row.badge).toBe("identify_only");
    expect(row.extract.kind).toBe("unsupported");
    expect(row.evidence.publicFixture.present).toBe(true);
    expect(row.evidence.privateLocalAggregate.present).toBe(true);
    expect(row.evidence.privateLocalAggregate.entryCount).toBe(12);
    expect(row.evidence.privateLocalAggregate.markerKinds).toEqual([
      "encrypted_asset_extension",
      "rpgmaker_mv_metadata",
    ]);

    const html = renderEngineCapabilityRows([row]);
    expect(html).toContain("Public fixture support");
    expect(html).toContain("Private-local aggregate evidence");
    expect(html).toContain("Public fixture evidence");
    expect(html).toContain("Private-local aggregate (12)");
    expect(html).not.toContain("/home/private");
    expect(html).not.toContain("System.json");
    expect(html).not.toContain("SECRET_KEY");
    expect(html).not.toContain("pathHash");
  });
});

describe("summarizeCapabilityEvidence", () => {
  it("defaults every evidence level to unknown", () => {
    const summary = summarizeCapabilityEvidence("kaifuu.empty", []);
    for (const level of capabilityLevelOrder) {
      expect(summary.publicFixture.levels[level]).toBe("unknown");
      expect(summary.privateLocalAggregate.levels[level]).toBe("unknown");
    }
  });

  it("keeps private-local evidence as a sidecar instead of upgrading strict support", () => {
    const row = toSummary(
      {
        adapterId: "kaifuu.rpg_maker_mv_mz",
        identify: { kind: "supported" },
        inventory: { kind: "unsupported", reason: "public fixture does not inventory" },
        extract: { kind: "unsupported", reason: "public fixture does not extract" },
        patch: { kind: "unsupported", reason: "public fixture does not patch" },
      },
      [
        {
          evidenceSource: "private_local_aggregate",
          level: "extract",
          status: "present",
          evidenceLabels: ["encrypted_asset_extension"],
          aggregateCounts: { corpusCount: 2, entryCount: 8 },
        },
      ],
    );

    expect(row.badge).toBe("identify_only");
    expect(row.extract.kind).toBe("unsupported");
    expect(row.evidence.privateLocalAggregate.levels.extract).toBe("present");
    expect(row.evidence.privateLocalAggregate.corpusCount).toBe(2);
  });
});
