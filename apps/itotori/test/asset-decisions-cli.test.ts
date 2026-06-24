import {
  assetLocalizationDecisionAssetKindValues,
  assetLocalizationDecisionPolicyValues,
} from "@itotori/db";
import type { AssetDecisionRecord, RecordAssetDecisionInput } from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import type { AssetDecisionsCliPort } from "../src/asset-decisions/cli.js";
import {
  parseAssetDecisionPolicy,
  parseAssetKind,
  parseAssetRef,
} from "../src/asset-decisions/cli.js";
import {
  keepOriginalFixture,
  translateTextFixture,
} from "../src/asset-decisions/decision-fixtures.js";

function jsonStoreFixture(reads: Map<string, unknown>, writes: Map<string, unknown>) {
  return {
    readJson: vi.fn((path: string) => reads.get(path)),
    writeJson: vi.fn((path: string, value: unknown) => {
      writes.set(path, value);
    }),
  };
}

function assetDecisionsPortFixture(records: AssetDecisionRecord[] = []): {
  port: AssetDecisionsCliPort;
  recordDecision: ReturnType<typeof vi.fn>;
  loadActiveDecisions: ReturnType<typeof vi.fn>;
} {
  const recordDecision = vi.fn<[RecordAssetDecisionInput], Promise<AssetDecisionRecord>>(
    async (input) =>
      translateTextFixture({
        decisionId: "asset-decision-cli",
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        assetKind: input.assetKind,
        decisionPolicy: input.decisionPolicy,
        decisionRationale: input.decisionRationale ?? null,
        assetRef: input.assetRef,
      }),
  );
  const loadActiveDecisions = vi.fn<[string, string], Promise<AssetDecisionRecord[]>>(
    async () => records,
  );
  return {
    port: {
      recordDecision,
      loadActiveDecisions,
    },
    recordDecision,
    loadActiveDecisions,
  };
}

function servicesFixture(port: AssetDecisionsCliPort | undefined = undefined): ItotoriCliServices {
  // Use a partial-but-typed stub: we only invoke asset-decisions
  // commands in this file, so the other surfaces are placeholder.
  const stub: Partial<ItotoriCliServices> = {
    assetDecisions: port,
  };
  return stub as ItotoriCliServices;
}

describe("asset-decisions CLI handlers", () => {
  it("itotori:asset-decisions-list writes the active decisions to the output path", async () => {
    const fixture = assetDecisionsPortFixture([
      translateTextFixture({ decisionId: "decision-1" }),
      keepOriginalFixture({ decisionId: "decision-2" }),
    ]);
    const writes = new Map<string, unknown>();
    await runItotoriCliCommand(
      [
        "asset-decisions-list",
        "--project",
        "project-test",
        "--locale",
        "locale-test",
        "--output",
        "decisions.json",
      ],
      {
        io: jsonStoreFixture(new Map(), writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(servicesFixture(fixture.port)),
      },
    );
    expect(fixture.loadActiveDecisions).toHaveBeenCalledWith("project-test", "locale-test");
    expect(writes.get("decisions.json")).toMatchObject({
      projectId: "project-test",
      localeBranchId: "locale-test",
      decisions: expect.any(Array),
    });
    const written = writes.get("decisions.json") as { decisions: AssetDecisionRecord[] };
    expect(written.decisions).toHaveLength(2);
  });

  it("itotori:asset-decisions-record passes a validated decision input to the port", async () => {
    const fixture = assetDecisionsPortFixture();
    const writes = new Map<string, unknown>();
    await runItotoriCliCommand(
      [
        "asset-decisions-record",
        "--project",
        "project-test",
        "--locale",
        "locale-test",
        "--asset-ref",
        JSON.stringify({ kind: "bridgeAssetRef", ref: "asset.json#sign" }),
        "--asset-kind",
        assetLocalizationDecisionAssetKindValues.imageWithText,
        "--policy",
        assetLocalizationDecisionPolicyValues.translateText,
        "--rationale",
        "Reviewed by lead translator.",
        "--output",
        "recorded.json",
      ],
      {
        io: jsonStoreFixture(new Map(), writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(servicesFixture(fixture.port)),
      },
    );
    expect(fixture.recordDecision).toHaveBeenCalledWith({
      projectId: "project-test",
      localeBranchId: "locale-test",
      assetRef: { kind: "bridgeAssetRef", ref: "asset.json#sign" },
      assetKind: assetLocalizationDecisionAssetKindValues.imageWithText,
      decisionPolicy: assetLocalizationDecisionPolicyValues.translateText,
      decisionRationale: "Reviewed by lead translator.",
    });
    expect(writes.get("recorded.json")).toMatchObject({
      decisionId: "asset-decision-cli",
      decisionPolicy: assetLocalizationDecisionPolicyValues.translateText,
    });
  });

  it("itotori:asset-decisions-record errors when the assetDecisions port is not configured", async () => {
    await expect(
      runItotoriCliCommand(
        [
          "asset-decisions-record",
          "--project",
          "project-test",
          "--locale",
          "locale-test",
          "--asset-ref",
          JSON.stringify({ kind: "bridgeAssetRef", ref: "asset.json#sign" }),
          "--asset-kind",
          assetLocalizationDecisionAssetKindValues.imageWithText,
          "--policy",
          assetLocalizationDecisionPolicyValues.translateText,
        ],
        {
          io: jsonStoreFixture(new Map(), new Map()),
          migrateDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(servicesFixture(undefined)),
        },
      ),
    ).rejects.toThrow(/asset-decisions service is not configured/);
  });

  it("itotori:asset-decisions-record rejects unknown policy and kind enum values", async () => {
    expect(() => parseAssetDecisionPolicy("hand_wave")).toThrow(/unknown asset decision policy/);
    expect(() => parseAssetKind("hand_wave")).toThrow(/unknown asset kind/);
  });

  it("parseAssetRef rejects malformed JSON and missing fields", () => {
    expect(() => parseAssetRef("not-json")).toThrow(/must be JSON/);
    expect(() => parseAssetRef(JSON.stringify({ kind: "bridgeAssetRef" }))).toThrow(
      /--asset-ref\.ref must be a non-empty string/,
    );
    expect(() => parseAssetRef(JSON.stringify({ ref: "asset.json#a" }))).toThrow(
      /--asset-ref\.kind must be a non-empty string/,
    );
  });
});
