import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriAssetLocalizationDecisionRepository,
  assetLocalizationDecisionAssetKindValues,
  assetLocalizationDecisionPolicyValues,
  type RecordAssetDecisionInput,
} from "../src/repositories/asset-localization-decision-repository.js";
import {
  assetDecisionFixtureLocaleBranchId,
  assetDecisionFixtureProjectId,
  provisionAssetDecisionFixtureProject,
} from "./asset-localization-decision-fixtures.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

function baseInput(overrides: Partial<RecordAssetDecisionInput> = {}): RecordAssetDecisionInput {
  return {
    projectId: assetDecisionFixtureProjectId,
    localeBranchId: assetDecisionFixtureLocaleBranchId,
    assetRef: { kind: "bridgeAssetRef", ref: "asset.json#sprite-1" },
    assetKind: assetLocalizationDecisionAssetKindValues.imageWithText,
    decisionPolicy: assetLocalizationDecisionPolicyValues.translateText,
    decisionRationale: "Has translatable signage text.",
    ...overrides,
  };
}

describe.skipIf(!process.env.DATABASE_URL)("ItotoriAssetLocalizationDecisionRepository", () => {
  it("recordDecision persists a new decision and loadActiveDecisions returns it", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);

      const recorded = await repo.recordDecision(localActor, baseInput());
      expect(recorded.decisionId).toMatch(/^asset-decision-/);
      expect(recorded.projectId).toBe(assetDecisionFixtureProjectId);
      expect(recorded.localeBranchId).toBe(assetDecisionFixtureLocaleBranchId);
      expect(recorded.assetKind).toBe(assetLocalizationDecisionAssetKindValues.imageWithText);
      expect(recorded.decisionPolicy).toBe(assetLocalizationDecisionPolicyValues.translateText);
      expect(recorded.decisionRationale).toBe("Has translatable signage text.");
      expect(recorded.decidedByUserId).toBe(localUserId);
      expect(recorded.supersededAt).toBeNull();
      expect(recorded.supersededByDecisionId).toBeNull();

      const active = await repo.loadActiveDecisions(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
      );
      expect(active).toHaveLength(1);
      expect(active[0]!.decisionId).toBe(recorded.decisionId);
    } finally {
      await context.close();
    }
  });

  it("recordDecision supersedes any prior active decision for the same asset+locale_branch", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);

      const first = await repo.recordDecision(localActor, baseInput());
      const second = await repo.recordDecision(
        localActor,
        baseInput({
          decisionPolicy: assetLocalizationDecisionPolicyValues.keepOriginal,
          decisionRationale: "Reverted after style guide update.",
        }),
      );

      expect(second.decisionId).not.toBe(first.decisionId);

      const active = await repo.loadActiveDecisions(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
      );
      expect(active).toHaveLength(1);
      expect(active[0]!.decisionId).toBe(second.decisionId);

      const history = await repo.loadDecisionHistory(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
        baseInput().assetRef,
      );
      expect(history).toHaveLength(2);
      const superseded = history.find((entry) => entry.decisionId === first.decisionId);
      expect(superseded).toBeDefined();
      expect(superseded!.supersededAt).not.toBeNull();
      expect(superseded!.supersededByDecisionId).toBe(second.decisionId);
    } finally {
      await context.close();
    }
  });

  it("loadActiveDecisions filters by asset kind when requested", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);

      await repo.recordDecision(
        localActor,
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#sprite-a" },
          assetKind: assetLocalizationDecisionAssetKindValues.imageWithText,
        }),
      );
      await repo.recordDecision(
        localActor,
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#font-a" },
          assetKind: assetLocalizationDecisionAssetKindValues.font,
          decisionPolicy: assetLocalizationDecisionPolicyValues.swapWithReplacement,
        }),
      );

      const imagesOnly = await repo.loadActiveDecisions(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
        { kindFilter: assetLocalizationDecisionAssetKindValues.imageWithText },
      );
      expect(imagesOnly).toHaveLength(1);
      expect(imagesOnly[0]!.assetKind).toBe(assetLocalizationDecisionAssetKindValues.imageWithText);
    } finally {
      await context.close();
    }
  });

  it("loadDecisionsByPolicy returns only active decisions with the given policy", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);

      await repo.recordDecision(
        localActor,
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#a" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.translateText,
        }),
      );
      await repo.recordDecision(
        localActor,
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#b" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
        }),
      );
      await repo.recordDecision(
        localActor,
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#c" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
        }),
      );

      const skips = await repo.loadDecisionsByPolicy(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
        assetLocalizationDecisionPolicyValues.skip,
      );
      expect(skips).toHaveLength(2);
      for (const skip of skips) {
        expect(skip.decisionPolicy).toBe(assetLocalizationDecisionPolicyValues.skip);
      }
    } finally {
      await context.close();
    }
  });

  it("recordDecisionsBulk atomically inserts every input on the happy path", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);

      const inputs: RecordAssetDecisionInput[] = [
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#bulk-1" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
        }),
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#bulk-2" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
        }),
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#bulk-3" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
        }),
      ];
      const recorded = await repo.recordDecisionsBulk(localActor, inputs);
      expect(recorded).toHaveLength(3);

      const active = await repo.loadActiveDecisions(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
      );
      expect(active).toHaveLength(3);
    } finally {
      await context.close();
    }
  });

  it("recordDecisionsBulk rolls back every insertion when one input is invalid", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);

      const inputs: RecordAssetDecisionInput[] = [
        baseInput({
          assetRef: { kind: "bridgeAssetRef", ref: "asset.json#bulk-ok" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
        }),
        baseInput({
          // Empty ref triggers assertRecordInput failure for this entry.
          assetRef: { kind: "bridgeAssetRef", ref: "" },
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
        }),
      ];
      await expect(repo.recordDecisionsBulk(localActor, inputs)).rejects.toThrow(
        /assetRef\.ref must be a non-empty string/,
      );

      const active = await repo.loadActiveDecisions(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
      );
      expect(active).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("recordDecisionsBulk rejects an empty input list", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);
      await expect(repo.recordDecisionsBulk(localActor, [])).rejects.toThrow(
        /recordDecisionsBulk requires at least one decision input/,
      );
    } finally {
      await context.close();
    }
  });

  it("loadDecisionHistory returns superseded rows ordered by decided_at desc", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionAssetDecisionFixtureProject(context.db, localActor);
      const repo = new ItotoriAssetLocalizationDecisionRepository(context.db);

      const first = await repo.recordDecision(
        localActor,
        baseInput({
          decidedAt: new Date("2026-06-20T00:00:00Z"),
        }),
      );
      const second = await repo.recordDecision(
        localActor,
        baseInput({
          decisionPolicy: assetLocalizationDecisionPolicyValues.keepOriginal,
          decidedAt: new Date("2026-06-22T00:00:00Z"),
        }),
      );
      const third = await repo.recordDecision(
        localActor,
        baseInput({
          decisionPolicy: assetLocalizationDecisionPolicyValues.skip,
          decidedAt: new Date("2026-06-24T00:00:00Z"),
        }),
      );

      const history = await repo.loadDecisionHistory(
        localActor,
        assetDecisionFixtureProjectId,
        assetDecisionFixtureLocaleBranchId,
        baseInput().assetRef,
      );
      expect(history.map((entry) => entry.decisionId)).toEqual([
        third.decisionId,
        second.decisionId,
        first.decisionId,
      ]);
    } finally {
      await context.close();
    }
  });
});
