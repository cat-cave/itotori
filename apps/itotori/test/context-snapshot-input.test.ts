import { createHash } from "node:crypto";

import { ItotoriLlmSnapshotRepository, contextSnapshot, type LlmRevisionRef } from "@itotori/db";
import { describe, expect, it } from "vitest";

import { buildContextSnapshotInput } from "../src/prepass/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { buildRb024Snapshot, loadBridgeBundle } from "./support/gate-fixtures.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

const REVISIONS = {
  decodeRef: revision("decode"),
  glossaryRef: revision("glossary"),
  styleRef: revision("style"),
};

function assembledInput() {
  return buildContextSnapshotInput({
    factSnapshot: buildRb024Snapshot(),
    sourceLanguage: loadBridgeBundle().sourceLocale,
    ...REVISIONS,
  });
}

describe("context snapshot input assembly", () => {
  it("derives one context id for wiki build and localize from shared artifacts", () => {
    const factSnapshot = buildRb024Snapshot();
    const bridge = loadBridgeBundle();
    const wikiBuildInput = buildContextSnapshotInput({
      factSnapshot,
      sourceLanguage: bridge.sourceLocale,
      ...REVISIONS,
    });
    const localizeInput = buildContextSnapshotInput({
      factSnapshot,
      sourceLanguage: bridge.sourceLocale,
      ...REVISIONS,
    });

    expect(contextSnapshot(wikiBuildInput).snapshotId).toBe(
      contextSnapshot(localizeInput).snapshotId,
    );
    expect(wikiBuildInput.sourceUnits).toEqual(
      factSnapshot.orderedUnits.map((unit) => ({
        unitId: unit.factId,
        sourceHash: unit.sourceHash,
      })),
    );
    expect(wikiBuildInput.revealHorizon).toEqual({ kind: "through-play-order", playOrderIndex: 5 });
    expect(wikiBuildInput.structure.revisionId).toBe("sentinel:structure");
    expect(wikiBuildInput.routeGraph.revisionId).toBe("sentinel:route-graph");
    expect(wikiBuildInput.humanCorrections.revisionId).toBe("sentinel:human-corrections");
    expect(wikiBuildInput.externalSources).toBeNull();
  });
});

postgresDescribe("context snapshot input persistence", () => {
  it("round-trips the derived context snapshot through the repository", async () => {
    const database = await isolatedMigratedContext();
    try {
      const repository = new ItotoriLlmSnapshotRepository(database.pool);
      const input = assembledInput();
      const stored = await repository.putContext(input);

      expect(stored.snapshotId).toBe(contextSnapshot(input).snapshotId);
      await expect(repository.readContext(stored.snapshotId)).resolves.toEqual(stored);
    } finally {
      await database.close();
    }
  });
});

function revision(revisionId: string): LlmRevisionRef {
  const contentHash =
    `sha256:${createHash("sha256").update(revisionId).digest("hex")}` as `sha256:${string}`;
  return { revisionId, contentHash };
}
