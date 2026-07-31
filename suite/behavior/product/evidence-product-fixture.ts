import { createHash } from "node:crypto";

import { createSyntheticLargeBridgeBundle } from "../../../packages/localization-bridge-schema/src/synthetic-large-project.js";
import type { AcceptedOutput } from "../../../apps/itotori/src/contracts/index.js";
import type { FactSnapshot, OrderedUnitFact } from "../../../apps/itotori/src/prepass/index.js";
import type {
  AcceptedUnitOutput,
  NativePatchbackInput,
} from "../../../apps/itotori/src/patchback/types.js";

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fact(
  unit: ReturnType<typeof createSyntheticLargeBridgeBundle>["units"][number],
): OrderedUnitFact {
  const sceneId = unit.context.route?.sceneId;
  if (sceneId === undefined) throw new Error("scenario-product-route-missing");
  return {
    factId: `fact:${unit.bridgeUnitId}`,
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sceneId,
    linkKind: unit.surfaceKind === "choice_label" ? "choice" : "line",
    surfaceKind: unit.surfaceKind,
    sourceHash: unit.sourceHash,
    byteRange: null,
    routeScope: { kind: "global" },
    playReveal: { playOrderIndex: 0, revealSceneOrder: null, revealItemOrder: null },
    speaker: unit.speaker ?? null,
    protectedSkeleton: {
      sourceHash: unit.sourceHash,
      spans: unit.spans.map(({ spanKind, preserveMode, raw, startByte, endByte }) => ({
        spanKind,
        preserveMode,
        raw,
        startByte,
        endByte,
      })),
    },
    patchRef: unit.patchRef,
    runtimeExpectation: unit.runtimeExpectation,
  };
}

function snapshot(
  sourceRevision: string,
  bridgeId: string,
  bundleHash: string,
  unit: OrderedUnitFact,
): FactSnapshot {
  const identity = sha256(`${sourceRevision}\0${bridgeId}\0${bundleHash}`);
  return {
    schemaVersion: "itotori.fact-snapshot.v1",
    source: {
      bridgeId,
      sourceBundleHash: bundleHash,
      entryScene: unit.sceneId,
      structureSchemaVersion: "utsushi.narrative-structure.v2",
    },
    orderedUnits: [unit],
    scenes: [],
    routeTopology: {
      entryScene: unit.sceneId,
      sceneDispatchOrder: [unit.sceneId],
      edges: [],
      reachableSceneIds: [unit.sceneId],
      unreachableSceneIds: [],
      reachableUnitKeys: [unit.sourceUnitKey],
    },
    characters: [],
    terminology: [],
    choiceLabels: {
      totalCount: unit.linkKind === "choice" ? 1 : 0,
      unitKeys: unit.linkKind === "choice" ? [unit.sourceUnitKey] : [],
    },
    glossaryConflicts: [],
    contentHash: identity,
    snapshotId: identity,
  };
}

function accepted(unit: OrderedUnitFact, snapshotId: string, target: string): AcceptedUnitOutput {
  const output: Extract<AcceptedOutput, { subjectType: "unit" }> = {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: `output:${unit.factId}`,
    version: 1,
    parentOutputIds: [],
    memoKeys: [],
    evidenceIds: [unit.factId],
    acceptedAt: "2026-07-15T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "narrowed:portable-evidence",
      reason: "test-dev",
    },
    subjectType: "unit",
    subjectId: unit.factId,
    localizationSnapshotId: snapshotId,
    stage: "final",
    sourceHash: unit.sourceHash,
    value: {
      targetSkeleton: target,
      targetHash: sha256(target),
      translationObjectId: `translation:${unit.factId}`,
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:portable-evidence",
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:portable-evidence"] },
      gateReceipts: [{ gate: "protected-spans", evidenceHash: sha256(target), status: "PASS" }],
      reviewVerdictIds: [],
    },
  };
  return output;
}

export function buildPatchScenarioInput(revision: string) {
  const bridge = createSyntheticLargeBridgeBundle({
    seed: `portable-evidence:${revision}`,
    targetJapaneseCharacters: 1,
    assetCount: 1,
  });
  const bridgeUnit = bridge.units[0];
  if (bridgeUnit === undefined) throw new Error("scenario-product-bridge-empty");
  const targetLocale = bridgeUnit.policy?.targetLocale;
  if (targetLocale === undefined) throw new Error("scenario-product-target-locale-missing");
  const unit = fact(bridgeUnit);
  const facts = snapshot(revision, bridge.bridgeId, bridge.sourceBundleHash, unit);
  const input: NativePatchbackInput = {
    snapshot: facts,
    accepted: [accepted(unit, facts.snapshotId, bridgeUnit.sourceText)],
    rawBridge: bridge,
    workScope: { inScopeUnitFactIds: [unit.factId] },
    sourceLocale: bridge.sourceLocale,
    targetLocale,
  };
  return { bridge, input };
}
