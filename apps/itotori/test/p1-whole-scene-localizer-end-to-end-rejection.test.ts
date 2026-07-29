import { describe, expect, it } from "vitest";
import { DRAFT_BATCH_SCHEMA_VERSION, type DraftBatch } from "../src/contracts/index.js";
import {
  buildLocalizerCall,
  dispatchLocalizerCall,
  localizeScene,
  normalizeScene,
  planSceneLocalization,
  FinalizeError,
} from "../src/roles/p1/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  BASE,
  BIBLE,
  CTX,
  LOC,
  SCHEMA,
  draftBatchResponse,
  installedBibleForUnits,
  pad,
  recordedRuntime,
  unitFact,
  wholeSceneBatch,
  type Captured,
} from "./p1-whole-scene-localizer-test-support.js";

describe("P1 whole-scene localizer — end-to-end rejection", () => {
  it("(a) rejects a source skeleton whose placeholder manifest is malformed", async () => {
    // A manifest that omits a {{ph}} token actually present in the skeleton would
    // let a dropped variable slip through the byte-level patch — reject it loud.
    const manifestGap = unitFact(0, {
      skeleton: "HP {{ph:0}} left",
      placeholders: [{ placeholderId: "ph:0", kind: "variable", sourceText: "%d" }],
      overridePlaceholders: [],
    });
    const captured: Captured[] = [];
    await expect(
      localizeScene(
        {
          ...BASE,
          units: [manifestGap],
          bibleRenderingIds: BIBLE,
          unitBible: installedBibleForUnits([manifestGap]),
          budgetBytes: 10_000,
          overlapUnits: 1,
        },
        recordedRuntime([], captured),
      ),
    ).rejects.toThrow(/malformed-source-skeleton/u);
    // Nothing was dispatched — the malformed skeleton was refused up front.
    expect(captured).toHaveLength(0);
  });

  it("reports a protected-span gate rejection instead of a transport failure", async () => {
    const captured: Captured[] = [];
    const runtime = {
      ...recordedRuntime([], captured),
      contentAccess: {
        requireContentRead: async () => {
          throw new FinalizeError("protected-span", "synthetic protected placeholder rejection");
        },
      },
    };
    const protectedUnit = unitFact(0);
    await expect(
      localizeScene(
        {
          ...BASE,
          units: [protectedUnit],
          bibleRenderingIds: BIBLE,
          unitBible: installedBibleForUnits([protectedUnit]),
          budgetBytes: 10_000,
          overlapUnits: 1,
        },
        runtime,
      ),
    ).rejects.toThrow(
      "p1 localize gate-rejection: content gate rejected output: protected placeholder preservation failed",
    );
    expect(captured).toHaveLength(0);
  });

  it("(b) never dispatches an unvalidated (scope-forged) target into the author thread", async () => {
    const sceneUnits = [0, 1, 2, 3, 4, 5].map((index) =>
      unitFact(index, { skeleton: pad(`c${index}`, 10) }),
    );
    const scene = normalizeScene(sceneUnits);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    const chunk0 = plan.segments[0]!;
    if (chunk0.mode !== "overlapping-chunk") throw new Error("expected a chunked plan");
    // Forge a schema-valid first chunk that declares a PLAN-OVERLAP unit as its
    // own core, carrying a target that was never accepted under P1's scope.
    const forgedCore = [...chunk0.coreUnitIds, chunk0.overlapUnitIds[0]!];
    const forgedBatch = {
      schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
      localizationSnapshotId: LOC,
      batchId: "draft:6010:forged",
      scope: {
        kind: "overlapping-chunk" as const,
        sceneId: "6010",
        chunkIndex: 0,
        chunkCount: chunk0.chunkCount,
        coreUnitIds: forgedCore,
        overlapUnitIds: [],
      },
      drafts: forgedCore.map((id) => ({
        unitId: id,
        sourceHash: sceneUnits.find((u) => u.value.unitId === id)!.value.sourceHash,
        targetSkeleton: id === chunk0.overlapUnitIds[0] ? "FORGED-UNACCEPTED-TARGET" : `EN>${id}`,
        evidenceIds: [`fact:${id}`],
        basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
        uncertainty: ["none"],
      })),
    } as DraftBatch;

    const captured: Captured[] = [];
    await expect(
      localizeScene(
        {
          ...BASE,
          units: sceneUnits,
          bibleRenderingIds: BIBLE,
          unitBible: installedBibleForUnits(sceneUnits),
          budgetBytes: 40,
          overlapUnits: 1,
        },
        recordedRuntime([draftBatchResponse(forgedBatch)], captured),
      ),
    ).rejects.toThrow(FinalizeError);
    // Only the FIRST chunk was dispatched; validation refused the forged batch
    // BEFORE the thread could carry its target into a second request.
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain("FORGED-UNACCEPTED-TARGET");
  });

  it("(c) rejects a test-dev wrong-model call at the public dispatch boundary", async () => {
    const units = [unitFact(0)];
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 10_000, overlapUnits: 1 });
    const call = buildLocalizerCall({
      specialist: specialistFor("P1"),
      segment: plan.segments[0]!,
      unitsById: new Map(scene.units.map((u) => [u.unitId, u])),
      bibleRenderingIds: BIBLE,
      priorAcceptedTarget: new Map(),
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    // Forge only the model — exactly the test-dev escape the audit exercised.
    const forged = { ...call, spec: { ...call.spec, requestedModel: "openai/gpt-4.1" } };
    const captured: Captured[] = [];
    await expect(
      dispatchLocalizerCall(
        forged,
        recordedRuntime([draftBatchResponse(wholeSceneBatch("6010", units))], captured),
      ),
    ).rejects.toThrow(/certified deepseek-v4-flash/u);
    // The re-routed call never reached the wire.
    expect(captured).toHaveLength(0);
  });
});
