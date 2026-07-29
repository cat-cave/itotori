import { describe, expect, it } from "vitest";
import { UnitFactSchema, type Defect, type ReviewVerdict } from "../src/contracts/index.js";
import { buildDefect, evaluateDeterministicGates, realliveSjisPolicy } from "../src/gates/index.js";
import {
  MissingBibleEntryError,
  resolveUnitBibleGroundTruth,
  type InstalledBible,
} from "../src/localized-wiki/ground-truth/index.js";
import type { FactSnapshot, OrderedUnitFact } from "../src/prepass/index.js";
import { deriveEditScope } from "../src/roles/p2/index.js";
import { normalizeRepairRequest } from "../src/roles/p3/index.js";
import { Q1ReviewInputSchema } from "../src/roles/q1/index.js";
import { Q2ReviewInputSchema } from "../src/roles/q2/index.js";
import { Q3ReviewInputSchema } from "../src/roles/q3/index.js";
import { Q4ReviewInputSchema } from "../src/roles/q4/index.js";
import { contestEligible } from "../src/roles/q6/index.js";
import { createWorkflowPorts } from "../src/composition/index.js";
import type {
  DraftedScene,
  DraftedUnit,
  LaneVerdict,
  WorkflowScene,
} from "../src/workflow/index.js";
import {
  AssemblerError,
  buildDeterministicGateInput,
  buildEditLineInput,
  buildLocalizeSceneInput,
  buildQ1ReviewInput,
  buildQ2ReviewInput,
  buildQ3ReviewInput,
  buildQ4ReviewInput,
  buildQ6ReviewInput,
  buildRepairRequest,
  createReadinessDeps,
  decodeFactSourceFrom,
  interpretLaneVerdict,
  type RunScopeConfig,
} from "../src/composition/live/assemblers/index.js";
import type { LocalizationUnitV02 } from "@itotori/localization-bridge-schema";

export const SNAP = `sha256:${"a".repeat(64)}` as const;

export const CTX = `sha256:${"e".repeat(64)}` as const;

export const SCHEMA = `sha256:${"f".repeat(64)}` as const;

export const HASH1 = `sha256:${"1".repeat(64)}` as const;

export const HASH2 = `sha256:${"2".repeat(64)}` as const;

export const ROUTE = "route.r1";

export const config: RunScopeConfig = {
  contextSnapshotId: CTX,
  localizationSnapshotId: SNAP,
  schemaHash: SCHEMA,
  runMode: "production",
  contextScope: "whole-game",
};

export function orderedUnit(
  factId: string,
  sourceUnitKey: string,
  playOrder: number,
  sourceHash: string,
  spans: readonly { spanKind: string; raw: string; startByte: number; endByte: number }[],
): OrderedUnitFact {
  return {
    factId,
    bridgeUnitId: `bridge:${factId}`,
    sourceUnitKey,
    sceneId: 1,
    linkKind: "line",
    surfaceKind: "dialogue",
    sourceHash,
    byteRange: { startByte: 0, endByte: 64 },
    routeScope: { kind: "route", routeId: ROUTE },
    playReveal: { playOrderIndex: playOrder, revealSceneOrder: null, revealItemOrder: null },
    speaker: {
      knowledgeState: "known",
      revealState: "revealed",
      displayName: "Rin",
      speakerId: "char.rin",
      canonicalNameRef: "char.rin",
      textColor: [10, 20, 30],
    },
    protectedSkeleton: {
      sourceHash,
      spans: spans.map((span) => ({ ...span, preserveMode: "verbatim" })),
    },
    patchRef: {},
    runtimeExpectation: {},
  } as unknown as OrderedUnitFact;
}

export const U1 = orderedUnit("unit:u1", "key.u1", 0, HASH1, [
  { spanKind: "control_markup", raw: "<b>", startByte: 3, endByte: 6 },
]);

export const U2 = orderedUnit("unit:u2", "key.u2", 1, HASH2, []);

export const bridgeUnits = new Map<string, LocalizationUnitV02>([
  [
    "unit:u1",
    {
      sourceText: "Hi <b> there",
      sourceAssetRef: { assetId: "asset.1" },
    } as unknown as LocalizationUnitV02,
  ],
  [
    "unit:u2",
    {
      sourceText: "Bye now",
      sourceAssetRef: { assetId: "asset.1" },
    } as unknown as LocalizationUnitV02,
  ],
]);

export const snapshot: FactSnapshot = {
  schemaVersion: "itotori.fact-snapshot.v1",
  source: {} as FactSnapshot["source"],
  orderedUnits: [U1, U2],
  scenes: [],
  routeTopology: {
    entryScene: 1,
    sceneDispatchOrder: [1],
    edges: [],
    reachableSceneIds: [1],
    unreachableSceneIds: [],
    reachableUnitKeys: ["key.u1", "key.u2"],
  },
  characters: [],
  terminology: [],
  choiceLabels: { totalCount: 0, unitKeys: [] },
  glossaryConflicts: [],
  contentHash: SNAP,
  snapshotId: SNAP,
};

export const facts = decodeFactSourceFrom(snapshot, bridgeUnits);

export function draftedUnit(
  unitId: string,
  sourceHash: string,
  targetSkeleton: string,
  renderingIds: readonly string[],
): DraftedUnit {
  return {
    unitId,
    bibleRenderingIds: renderingIds,
    draft: {
      unitId,
      sourceHash,
      targetSkeleton,
      evidenceIds: ["ev.1"],
      basis: { kind: "wiki-first", bibleRenderingIds: renderingIds },
      uncertainty: ["none"],
    },
  };
}

export const D1 = draftedUnit("unit:u1", HASH1, "Hello <b> world", [
  "rendering:name",
  "rendering:voice",
]);

export const D2 = draftedUnit("unit:u2", HASH2, "Goodbye", ["rendering:name"]);

export const draftedScene: DraftedScene = {
  sceneId: "1",
  mode: "whole-scene",
  batches: [
    {
      schemaVersion: "itotori.draft-batch.v1",
      localizationSnapshotId: SNAP,
      batchId: "1.batch",
      scope: { kind: "whole-scene", sceneId: "1", expectedUnitIds: ["unit:u1", "unit:u2"] },
      drafts: [D1.draft, D2.draft],
    },
  ],
  units: [D1, D2],
};

export const workflowScene: WorkflowScene = {
  sceneId: "1",
  units: [
    {
      unitId: "unit:u1",
      sourceHash: HASH1,
      speakerId: "char.rin",
      routeId: ROUTE,
      firstAppearance: true,
    },
    {
      unitId: "unit:u2",
      sourceHash: HASH2,
      speakerId: "char.rin",
      routeId: ROUTE,
      firstAppearance: false,
    },
  ],
};

export function installedBible(missing: ReadonlySet<string> = new Set()): InstalledBible {
  return {
    canonicalForms: [],
    renderings: () => [],
    lookup: (required) => {
      if (missing.has(required.category)) return undefined;
      return { renderingId: `rendering:${required.category}`, version: 1 } as ReturnType<
        InstalledBible["lookup"]
      >;
    },
  };
}

export function verdict(
  lane: "Q1" | "Q3",
  unitId: string,
  outcome: "PASS" | "FAIL",
): ReviewVerdict {
  const base = {
    schemaVersion: "itotori.review-verdict.v1" as const,
    reviewId: `review.${lane}.${unitId}`,
    localizationSnapshotId: SNAP,
    roleId: lane,
    rubric: lane === "Q1" ? ("meaning" as const) : ("terminology" as const),
    unitId,
    basis: { kind: "wiki-first" as const, bibleRenderingIds: ["rendering:name"] },
    evidenceIds: ["ev.1"],
  };
  if (outcome === "PASS") {
    return {
      ...base,
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      repairConstraint: null,
    };
  }
  return {
    ...base,
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span.1", surface: "target", text: "off" },
    category: lane === "Q1" ? "mistranslation" : "term-sense",
    repairConstraint: "use the approved sense",
  };
}
