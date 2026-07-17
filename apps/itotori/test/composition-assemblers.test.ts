// Proving tests for the deterministic live workflow-port assemblers. Each test
// runs the projected input through the ROLE'S OWN front-door validator (the
// oracle): a UnitFact through the strict schema, an edit input through
// `deriveEditScope`, a repair request through `normalizeRepairRequest`, a Q6
// input through `parseQ6ReviewInput`, review inputs through their strict schemas,
// and the gate input through `evaluateDeterministicGates`. If the assembler
// produced anything but the role's EXACT input shape, the oracle rejects it.

import { describe, expect, it } from "vitest";

import { UnitFactSchema, type Defect, type ReviewVerdict } from "../src/contracts/index.js";
import { buildDefect, evaluateDeterministicGates } from "../src/gates/index.js";
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

// ---------------------------------------------------------------------------
// Fixtures — a two-unit route scene with one protected span.
// ---------------------------------------------------------------------------

const SNAP = `sha256:${"a".repeat(64)}` as const;
const CTX = `sha256:${"e".repeat(64)}` as const;
const SCHEMA = `sha256:${"f".repeat(64)}` as const;
const HASH1 = `sha256:${"1".repeat(64)}` as const;
const HASH2 = `sha256:${"2".repeat(64)}` as const;
const ROUTE = "route.r1";

const config: RunScopeConfig = {
  contextSnapshotId: CTX,
  localizationSnapshotId: SNAP,
  schemaHash: SCHEMA,
  runMode: "production",
  contextScope: "whole-game",
};

function orderedUnit(
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

const U1 = orderedUnit("unit:u1", "key.u1", 0, HASH1, [
  { spanKind: "control_markup", raw: "<b>", startByte: 3, endByte: 6 },
]);
const U2 = orderedUnit("unit:u2", "key.u2", 1, HASH2, []);

const bridgeUnits = new Map<string, LocalizationUnitV02>([
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

const snapshot: FactSnapshot = {
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

const facts = decodeFactSourceFrom(snapshot, bridgeUnits);

function draftedUnit(
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

const D1 = draftedUnit("unit:u1", HASH1, "Hello <b> world", ["rendering:name", "rendering:voice"]);
const D2 = draftedUnit("unit:u2", HASH2, "Goodbye", ["rendering:name"]);

const draftedScene: DraftedScene = {
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

const workflowScene: WorkflowScene = {
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

function installedBible(missing: ReadonlySet<string> = new Set()): InstalledBible {
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

// ---------------------------------------------------------------------------

describe("readiness assembler", () => {
  it("resolves ready with the installed rendering ids", async () => {
    const deps = { readiness: createReadinessDeps({ facts, bible: installedBible() }) };
    const ports = createWorkflowPorts(deps as unknown as Parameters<typeof createWorkflowPorts>[0]);
    const readiness = await ports.readiness.resolve("unit:u1");
    expect(readiness.ready).toBe(true);
    if (readiness.ready) expect(readiness.bibleRenderingIds.length).toBeGreaterThan(0);
  });

  it("reports not-ready naming the missing required entry", async () => {
    const deps = {
      readiness: createReadinessDeps({ facts, bible: installedBible(new Set(["voice"])) }),
    };
    const ports = createWorkflowPorts(deps as unknown as Parameters<typeof createWorkflowPorts>[0]);
    const readiness = await ports.readiness.resolve("unit:u1");
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) expect(readiness.missing).toHaveLength(1);
  });

  it("resolveUnitBibleGroundTruth throws MissingBibleEntryError for a missing entry", () => {
    expect(() =>
      resolveUnitBibleGroundTruth(U1, snapshot, installedBible(new Set(["name"]))),
    ).toThrow(MissingBibleEntryError);
  });
});

describe("draft assembler → P1 LocalizeSceneInput", () => {
  it("projects schema-valid UnitFacts that preserve placeholders + SJIS, with the flat wiki basis", () => {
    const input = buildLocalizeSceneInput({
      scene: workflowScene,
      mode: "whole-scene",
      bibleRenderingIdsByUnit: new Map([
        ["unit:u1", ["rendering:name", "rendering:voice"]],
        ["unit:u2", ["rendering:name"]],
      ]),
      facts,
      config,
      budget: { budgetBytes: 8_000, overlapUnits: 1 },
    });
    // Every projected unit is a strict, schema-valid UnitFact.
    for (const unit of input.units) expect(() => UnitFactSchema.parse(unit)).not.toThrow();
    // The protected span is preserved as a masked placeholder, verbatim raw.
    const u1 = input.units.find((unit) => unit.value.unitId === "unit:u1")!;
    expect(u1.value.sourceSkeleton).toContain("{{ph:0}}");
    expect(u1.value.protectedPlaceholders[0]?.sourceText).toBe("<b>");
    // The flat wiki-first basis is the de-duplicated union, sorted.
    expect(input.bibleRenderingIds).toEqual(["rendering:name", "rendering:voice"]);
    expect(input.localizationSnapshotId).toBe(SNAP);
    expect(input.contextSnapshotId).toBe(CTX);
  });
});

describe("gate assembler → DeterministicGateInput", () => {
  it("synthesizes candidate accepted outputs the gates bind + evaluate cleanly", () => {
    const input = buildDeterministicGateInput({ scene: draftedScene, facts, side: {} });
    const report = evaluateDeterministicGates(input);
    // The always-run gates all ran, bound by subjectId === factId.
    expect(report.evaluatedGates).toEqual(
      expect.arrayContaining([
        "cardinality-order-hash",
        "protected-spans",
        "shift-jis",
        "byte-box",
        "markup-controls",
        "patch-coverage",
      ]),
    );
    // The synthesized accepted outputs carry matching source hashes + preserved
    // spans → no cardinality/source-hash/protected-span defect.
    const badCategories = new Set([
      "unit-cardinality",
      "unit-order",
      "source-hash",
      "protected-span",
    ]);
    expect(report.defects.filter((defect) => badCategories.has(defect.category))).toEqual([]);
  });
});

describe("repair assembler → P2 edit scope + P3 repair request", () => {
  const minorDefect: Defect = buildDefect({
    unitId: "unit:u1",
    category: "punctuation",
    detail: "minor punctuation",
    basisFactIds: ["fact.1"],
  });
  const majorDefect: Defect = buildDefect({
    unitId: "unit:u1",
    category: "protected-span",
    detail: "protected span dropped",
    basisFactIds: ["fact.1"],
  });

  it("buildEditLineInput yields an input deriveEditScope accepts (implicated-only)", () => {
    const input = buildEditLineInput({
      scene: draftedScene,
      unitIds: ["unit:u1"],
      defects: [minorDefect],
      facts,
      config,
    });
    const scope = deriveEditScope(input.currentDraft, input.defectBundle, input.units);
    expect(scope.implicatedUnitIds).toEqual(["unit:u1"]);
    expect(input.bibleRenderingIds).toEqual(["rendering:name", "rendering:voice"]);
  });

  it("buildRepairRequest yields a request normalizeRepairRequest accepts (failed-only)", () => {
    const request = buildRepairRequest({
      scene: draftedScene,
      unitIds: ["unit:u1"],
      defects: [majorDefect],
      facts,
    });
    const normalized = normalizeRepairRequest(request);
    expect(normalized.failedUnitIds).toEqual(["unit:u1"]);
    expect(normalized.candidatesById.get("unit:u1")?.currentTargetSkeleton).toBe("Hello <b> world");
    // The candidate carries the verbatim protected placeholder from the source.
    expect(request.candidates[0]?.protectedPlaceholders[0]?.sourceText).toBe("<b>");
  });
});

// ---------------------------------------------------------------------------

function verdict(lane: "Q1" | "Q3", unitId: string, outcome: "PASS" | "FAIL"): ReviewVerdict {
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

describe("adjudicate assembler → Q6ReviewInput", () => {
  const contested: readonly LaneVerdict[] = [
    { lane: "Q1", verdict: verdict("Q1", "unit:u1", "PASS") },
    { lane: "Q3", verdict: verdict("Q3", "unit:u1", "FAIL") },
  ];
  const resolveEvidence = (id: string): string => `evidence text for ${id}`;
  const resolveBibleRenderingIds = (): readonly string[] => ["rendering:name"];

  it("projects the two blinded A/B positions + high-impact trigger, schema-valid + eligible", () => {
    const q6 = buildQ6ReviewInput({
      unitId: "unit:u1",
      contested,
      resolveEvidence,
      resolveBibleRenderingIds,
      config,
    });
    expect(q6.positions.map((position) => position.label).sort()).toEqual(["A", "B"]);
    expect(q6.positions.find((position) => position.label === "A")?.verdict).toBe("FAIL");
    expect(q6.positions.find((position) => position.label === "B")?.verdict).toBe("PASS");
    expect(contestEligible(q6)).toBe(true);
  });

  it("fails loud on a one-sided contest (no genuine dissent/affirmation split)", () => {
    const oneSided: readonly LaneVerdict[] = [
      { lane: "Q1", verdict: verdict("Q1", "unit:u1", "FAIL") },
      { lane: "Q3", verdict: verdict("Q3", "unit:u1", "FAIL") },
    ];
    expect(() =>
      buildQ6ReviewInput({
        unitId: "unit:u1",
        contested: oneSided,
        resolveEvidence,
        resolveBibleRenderingIds,
        config,
      }),
    ).toThrow(AssemblerError);
  });

  it("fails loud when cited evidence does not resolve to text", () => {
    expect(() =>
      buildQ6ReviewInput({
        unitId: "unit:u1",
        contested,
        resolveEvidence: () => null,
        resolveBibleRenderingIds,
        config,
      }),
    ).toThrow(AssemblerError);
  });
});

describe("review-lane input assemblers → Q1..Q4 schema-valid inputs", () => {
  const u1Fact = UnitFactSchema.parse(
    buildLocalizeSceneInput({
      scene: workflowScene,
      mode: "whole-scene",
      bibleRenderingIdsByUnit: new Map([["unit:u1", ["rendering:name"]]]),
      facts,
      config,
      budget: { budgetBytes: 8_000, overlapUnits: 1 },
    }).units.find((unit) => unit.value.unitId === "unit:u1")!,
  );

  it("Q1 meaning input is schema-valid from the drafted unit + source fact", () => {
    const input = buildQ1ReviewInput({ unit: D1, fact: u1Fact, localizationSnapshotId: SNAP });
    expect(() => Q1ReviewInputSchema.parse(input)).not.toThrow();
    expect(input.candidateTarget).toBe("Hello <b> world");
    expect(input.sourceFacts[0]?.text).toBe("Hi <b> there");
  });

  it("Q2 voice input carries the decode position + known speaker", () => {
    const input = buildQ2ReviewInput({
      unit: D1,
      fact: u1Fact,
      ordered: U1,
      localizationSnapshotId: SNAP,
      sampleKind: "first-appearance",
    });
    expect(() => Q2ReviewInputSchema.parse(input)).not.toThrow();
    expect(input.speakerId).toBe("char.rin");
    expect(input.position.routeId).toBe(ROUTE);
    expect(input.position.playOrder).toBe(0);
  });

  it("Q3 terminology input carries the exact-gate outcome", () => {
    const input = buildQ3ReviewInput({
      unit: D1,
      localizationSnapshotId: SNAP,
      exactGateStatus: "cleared",
      approvedTerms: [{ termId: "t1", sourceForm: "世界", approvedTargetForm: "world" }],
    });
    expect(() => Q3ReviewInputSchema.parse(input)).not.toThrow();
    expect(input.exactGate.status).toBe("cleared");
  });

  it("Q4 continuity input is route-bound to the unit's decode scope", () => {
    const input = buildQ4ReviewInput({ unit: D1, ordered: U1, localizationSnapshotId: SNAP });
    expect(() => Q4ReviewInputSchema.parse(input)).not.toThrow();
    expect(input.reviewScope).toEqual({ kind: "route", routeId: ROUTE });
  });
});

describe("review-lane verdict interpreter → LaneVerdict", () => {
  it("tags a schema-valid verdict with its lane", () => {
    const laneVerdict = interpretLaneVerdict("Q1", "unit:u1", verdict("Q1", "unit:u1", "PASS"));
    expect(laneVerdict.lane).toBe("Q1");
    expect(laneVerdict.verdict.unitId).toBe("unit:u1");
  });

  it("fails loud on a verdict routed to the wrong lane", () => {
    expect(() => interpretLaneVerdict("Q3", "unit:u1", verdict("Q1", "unit:u1", "PASS"))).toThrow(
      AssemblerError,
    );
  });
});

describe("decodeFactSourceFrom key resolution (real bridge id shape)", () => {
  it("resolves an ordered fact by the BARE bridge unit id when factId is `unit:`-prefixed", () => {
    // Real bridge data: factId = `unit:<id>` (provenance-prefixed) while the draft
    // sequence (projectDecodeStructure scene.units) queries by the BARE unit id.
    // Keying the fact map by factId alone misses every bare-id lookup (regression:
    // "snapshot has no ordered fact for unit <id>" on real Sweetie bytes).
    const base = orderedUnit("bare-x", "reallive:scene-0001#0000", 0, HASH1, []);
    const fact = { ...base, factId: "unit:bare-x", bridgeUnitId: "bare-x" } as typeof base;
    const snap = { ...snapshot, orderedUnits: [fact] } as typeof snapshot;
    const bridgeUnit = bridgeUnits.values().next().value;
    const fs = decodeFactSourceFrom(snap, new Map([["bare-x", bridgeUnit]]));
    expect(fs.orderedFact("bare-x").factId).toBe("unit:bare-x");
    expect(fs.orderedFact("unit:bare-x").factId).toBe("unit:bare-x");
  });
});
