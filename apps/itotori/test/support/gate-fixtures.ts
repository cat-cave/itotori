// Shared fixtures for the deterministic-gate proofs.
//
// Two roots: (1) `buildRb024Snapshot()` materializes the REAL RB-024 fact
// snapshot from the committed v0.2 bridge bundle + a referencing narrative
// structure (the same fixture the pre-pass proofs use), so the gates are proven
// over genuine decoded units; (2) the synthetic `makeSnapshot` / `makeUnit`
// builders give per-gate control to trigger a specific pass/defect condition.

import { readFileSync } from "node:fs";

import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import type { AcceptedOutput } from "../../src/contracts/index.js";
import { buildFactSnapshot } from "../../src/prepass/index.js";
import type {
  FactSnapshot,
  OrderedUnitFact,
  TerminologyOccurrenceFact,
} from "../../src/prepass/index.js";
import type {
  NarrativeScene,
  NarrativeStructure,
  NarrativeUnit,
} from "../../src/structure/types.js";
import type { AcceptedUnitOutput } from "../../src/gates/index.js";

const BUNDLE_HASH = "sha256:3065996aa103c1c827f13998f8d44046d5df0b9d5f30a1f0027544de71be6927";

export function loadBridgeBundle(): BridgeBundleV02 {
  const raw = readFileSync(new URL("../fixtures/whole-seen-bridge.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeBundleV02;
}

type UnitSpec = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  assetId: string;
  startByte: number;
  endByte: number;
  isChoice: boolean;
};

const SPECS: readonly UnitSpec[] = [
  {
    bridgeUnitId: "a06a6efc-b1f0-7483-b225-40f197a3bc83",
    sourceUnitKey: "reallive:scene-0001#0000",
    assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
    startByte: 17,
    endByte: 21,
    isChoice: false,
  },
  {
    bridgeUnitId: "9706a898-f08a-7ba9-99e6-c304e0235874",
    sourceUnitKey: "reallive:scene-0001#0001",
    assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
    startByte: 29,
    endByte: 31,
    isChoice: true,
  },
  {
    bridgeUnitId: "b43c7e66-a03e-713b-89cc-797c5ff9216f",
    sourceUnitKey: "reallive:scene-0001#0002",
    assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
    startByte: 29,
    endByte: 31,
    isChoice: true,
  },
  {
    bridgeUnitId: "d04f6e35-621e-78cf-80d0-1a3b0416db78",
    sourceUnitKey: "reallive:scene-0002#0000",
    assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
    startByte: 17,
    endByte: 21,
    isChoice: false,
  },
  {
    bridgeUnitId: "402c8867-cf61-7afa-a110-843c4f9fab53",
    sourceUnitKey: "reallive:scene-0002#0001",
    assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
    startByte: 29,
    endByte: 31,
    isChoice: true,
  },
  {
    bridgeUnitId: "84106326-5a71-737e-b369-b6a0ed46bf2a",
    sourceUnitKey: "reallive:scene-0002#0002",
    assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
    startByte: 29,
    endByte: 31,
    isChoice: true,
  },
];

function makeNarrativeUnit(spec: UnitSpec, index: number): NarrativeUnit {
  return {
    unitId: `unit-${spec.sourceUnitKey}`,
    bridgeRef: { bridgeUnitId: spec.bridgeUnitId, sourceUnitKey: spec.sourceUnitKey },
    surfaceKind: spec.isChoice ? "choice_label" : "dialogue",
    sourceText: "",
    characterId: null,
    evidenceTier: "E2",
    color: null,
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    byteOffsetInScene: spec.startByte,
    byteLength: spec.endByte - spec.startByte,
    rawByteHandle: `handle-${index}`,
    choiceId: spec.isChoice ? `choice-${spec.sourceUnitKey}` : null,
    playOrder: index,
    revealOrder: null,
    observedLineIds: [],
    routeMembership: [],
  };
}

function scene(sceneId: number, specs: UnitSpec[], nextScene: number | null): NarrativeScene {
  return {
    sceneId,
    selectionControl: "none",
    nextScene,
    messages: [],
    choices: [],
    units: specs.map((spec, index) => makeNarrativeUnit(spec, index)),
  };
}

function wholeGameStructure(): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v2",
    entryScene: 1,
    sceneDispatchOrder: [1, 2],
    sourceBundleHash: BUNDLE_HASH,
    scenes: [
      scene(1, [SPECS[0]!, SPECS[1]!, SPECS[2]!], 2),
      scene(2, [SPECS[3]!, SPECS[4]!, SPECS[5]!], null),
      { sceneId: 3, selectionControl: "none", nextScene: null, messages: [], choices: [] },
    ],
  };
}

/** The genuine RB-024 fact snapshot over the committed bridge bytes. */
export function buildRb024Snapshot(): FactSnapshot {
  return buildFactSnapshot(wholeGameStructure(), loadBridgeBundle());
}

// --- synthetic builders -----------------------------------------------------

const SHA_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function sha(seed: string): `sha256:${string}` {
  const hex = [...seed]
    .reduce((acc, ch) => acc + ch.charCodeAt(0).toString(16), "")
    .padEnd(64, "0")
    .slice(0, 64);
  return `sha256:${hex}`;
}

export function makeUnit(
  overrides: Partial<OrderedUnitFact> & { factId: string },
): OrderedUnitFact {
  const sourceHash = overrides.sourceHash ?? SHA_A;
  return {
    factId: overrides.factId,
    bridgeUnitId: overrides.bridgeUnitId ?? `${overrides.factId}-bridge`,
    sourceUnitKey: overrides.sourceUnitKey ?? `reallive:${overrides.factId}`,
    sceneId: overrides.sceneId ?? 1,
    linkKind: overrides.linkKind ?? "line",
    surfaceKind: overrides.surfaceKind ?? "dialogue",
    sourceHash,
    byteRange: overrides.byteRange ?? null,
    routeScope: overrides.routeScope ?? { kind: "global" },
    playReveal: overrides.playReveal ?? {
      playOrderIndex: 0,
      revealSceneOrder: null,
      revealItemOrder: null,
    },
    speaker: overrides.speaker ?? null,
    protectedSkeleton: overrides.protectedSkeleton ?? { sourceHash, spans: [] },
    patchRef: overrides.patchRef ?? {
      assetId: "01920000-0000-7000-8000-0000000000aa",
      writeMode: "replace",
      sourceUnitKey: overrides.sourceUnitKey ?? `reallive:${overrides.factId}`,
      sourceRevision: {
        revisionId: "01920000-0000-7000-8000-0000000000bb",
        revisionKind: "content_hash",
        value: sourceHash,
      },
    },
    runtimeExpectation: overrides.runtimeExpectation ?? { expectationKind: "metadata_only" },
  };
}

export function makeSnapshot(options: {
  units: readonly OrderedUnitFact[];
  reachableUnitKeys?: readonly string[];
  entryScene?: number;
  terminology?: readonly TerminologyOccurrenceFact[];
}): FactSnapshot {
  const units = [...options.units];
  const reachable = options.reachableUnitKeys ?? units.map((unit) => unit.sourceUnitKey);
  return {
    schemaVersion: "itotori.fact-snapshot.v1",
    source: {
      bridgeId: "bridge-test",
      sourceBundleHash: SHA_A,
      entryScene: options.entryScene ?? 1,
      structureSchemaVersion: "utsushi.narrative-structure.v2",
    },
    orderedUnits: units,
    scenes: [],
    routeTopology: {
      entryScene: options.entryScene ?? 1,
      sceneDispatchOrder: [1],
      edges: [],
      reachableSceneIds: [1],
      unreachableSceneIds: [],
      reachableUnitKeys: [...reachable],
    },
    characters: [],
    terminology: options.terminology ?? [],
    choiceLabels: { totalCount: 0, unitKeys: [] },
    glossaryConflicts: [],
    contentHash: SHA_A,
    snapshotId: SHA_A,
  };
}

/** A full, schema-valid unit AcceptedOutput bound to `fact` with `target`. */
export function makeAccepted(
  fact: OrderedUnitFact,
  target: string,
  overrides?: { evidenceIds?: readonly string[]; sourceHash?: string; outputId?: string },
): AcceptedUnitOutput {
  const output: Extract<AcceptedOutput, { subjectType: "unit" }> = {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: overrides?.outputId ?? `output:${fact.factId}`,
    version: 1,
    parentOutputIds: [],
    memoKeys: [],
    evidenceIds: [...(overrides?.evidenceIds ?? [fact.factId])],
    acceptedAt: "2026-07-15T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "narrowed:gate-proof",
      reason: "test-dev",
    },
    subjectType: "unit",
    subjectId: fact.factId,
    localizationSnapshotId: SHA_A,
    stage: "final",
    sourceHash: overrides?.sourceHash ?? fact.sourceHash,
    value: {
      targetSkeleton: target,
      targetHash: sha(target),
      translationObjectId: `translation:${fact.factId}`,
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:test",
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:test"] },
      gateReceipts: [{ gate: "protected-spans", evidenceHash: SHA_A, status: "PASS" }],
      reviewVerdictIds: [],
    },
  };
  return output;
}
