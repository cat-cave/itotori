import type { AssetDecisionRecord } from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import type { AssetDecisionsCliPort } from "../src/asset-decisions/cli.js";
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
  loadActiveDecisions: ReturnType<typeof vi.fn>;
} {
  const loadActiveDecisions = vi.fn<[string, string], Promise<AssetDecisionRecord[]>>(
    async () => records,
  );
  return {
    port: {
      loadActiveDecisions,
    },
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
        resetDatabase: vi.fn(async () => {}),
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

  it("itotori:asset-decisions-list errors when the assetDecisions port is not configured", async () => {
    await expect(
      runItotoriCliCommand(
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
          io: jsonStoreFixture(new Map(), new Map()),
          migrateDatabase: vi.fn(async () => {}),
          resetDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(servicesFixture(undefined)),
        },
      ),
    ).rejects.toThrow(/asset-decisions service is not configured/);
  });
});
