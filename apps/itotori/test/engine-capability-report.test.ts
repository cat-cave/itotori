import { describe, expect, it } from "vitest";
import {
  adapterBadge,
  capabilityLevelOrder,
  EngineCapabilityReportService,
  summarizeCapabilityEvidence,
  toSummary,
} from "../src/services/engine-capability-report.js";

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

describe("EngineCapabilityReportService", () => {
  it("flattens repository evidenceByLevel buckets without upgrading matrix-derived support", async () => {
    const repository = {
      listMatricesWithEvidence: async () => [
        {
          adapterId: "kaifuu.rpg_maker_mv_mz",
          matrix: {
            adapterId: "kaifuu.rpg_maker_mv_mz",
            identify: { kind: "supported" },
            inventory: { kind: "unsupported", reason: "public fixture does not inventory" },
            extract: { kind: "unsupported", reason: "public fixture does not extract" },
            patch: { kind: "unsupported", reason: "public fixture does not patch" },
          },
          evidenceByLevel: {
            identify: {
              publicFixture: [
                {
                  engineCapabilityEvidenceId: "evidence-public-1",
                  adapterId: "kaifuu.rpg_maker_mv_mz",
                  level: "identify",
                  evidenceSource: "public_fixture",
                  evidenceKind: "adapter_matrix",
                  schemaVersion: "catalog.capability_evidence.v0.1",
                  status: "present",
                  aggregateCounts: { fixture_rows: 4 },
                  evidenceLabels: ["adapter_capability_matrix", "public_fixture_matrix"],
                  limitations: ["fixture support matrix only"],
                  publicFixtureId: "rpg-maker-mv-mz-key-validation-success-v0.1",
                  reportedAt: new Date("2026-06-01T00:00:00.000Z"),
                },
              ],
              privateLocalAggregate: [],
            },
            inventory: {
              publicFixture: [],
              privateLocalAggregate: [],
            },
            extract: {
              publicFixture: [],
              privateLocalAggregate: [
                {
                  engineCapabilityEvidenceId: "evidence-private-1",
                  adapterId: "kaifuu.rpg_maker_mv_mz",
                  level: "extract",
                  evidenceSource: "private_local_aggregate",
                  evidenceKind: "local_corpus_sidecar",
                  schemaVersion: "catalog.local_corpus_engine_evidence.v0.1",
                  status: "present",
                  aggregateCounts: {
                    corpus_count: 1,
                    entry_count: 12,
                    "marker.kinds": 3,
                    encryptedAssetCount: 2,
                    "path.hash": 1,
                  },
                  evidenceLabels: ["local_corpus_marker_evidence", "encrypted_asset_extension"],
                  limitations: ["local scan aggregate evidence only; no adapter execution claimed"],
                  publicFixtureId: null,
                  reportedAt: new Date("2026-06-01T00:00:00.000Z"),
                },
              ],
            },
            patch: {
              publicFixture: [],
              privateLocalAggregate: [],
            },
          },
        },
      ],
      listMatrices: async () => [],
      isAdapterUsable: async () => false,
      adaptersSupporting: async () => [],
      writeMatrix: async () => {},
    } as unknown as ConstructorParameters<typeof EngineCapabilityReportService>[0];
    const service = new EngineCapabilityReportService(repository, { userId: "local-user" });

    const [row] = await service.listAdapterSummaries();

    expect(row?.badge).toBe("identify_only");
    expect(row?.extract.kind).toBe("unsupported");
    expect(row?.evidence.publicFixture.present).toBe(true);
    expect(row?.evidence.publicFixture.levels.identify).toBe("present");
    expect(row?.evidence.publicFixture.fixtureIds).toEqual([
      "rpg-maker-mv-mz-key-validation-success-v0.1",
    ]);
    expect(row?.evidence.privateLocalAggregate.present).toBe(true);
    expect(row?.evidence.privateLocalAggregate.levels.extract).toBe("present");
    expect(row?.evidence.privateLocalAggregate.corpusCount).toBe(1);
    expect(row?.evidence.privateLocalAggregate.entryCount).toBe(12);
    expect(row?.evidence.privateLocalAggregate.aggregateCounts["marker.kinds"]).toBe(3);
    expect(row?.evidence.privateLocalAggregate.aggregateCounts.encryptedAssetCount).toBe(2);
    expect(row?.evidence.privateLocalAggregate.aggregateCounts["path.hash"]).toBeUndefined();
  });
});
