import { describe, expect, it } from "vitest";
import { UnitFactSchema, type Defect } from "../src/contracts/index.js";
import { buildDefect, evaluateDeterministicGates, realliveSjisPolicy } from "../src/gates/index.js";
import {
  MissingBibleEntryError,
  resolveUnitBibleGroundTruth,
} from "../src/localized-wiki/ground-truth/index.js";

import { deriveEditScope } from "../src/roles/p2/index.js";
import { normalizeRepairRequest } from "../src/roles/p3/index.js";
import { Q1ReviewInputSchema } from "../src/roles/q1/index.js";
import { Q2ReviewInputSchema } from "../src/roles/q2/index.js";
import { Q3ReviewInputSchema } from "../src/roles/q3/index.js";
import { Q4ReviewInputSchema } from "../src/roles/q4/index.js";
import { contestEligible } from "../src/roles/q6/index.js";
import { createWorkflowPorts } from "../src/composition/index.js";
import type { LaneVerdict } from "../src/workflow/index.js";
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
} from "../src/composition/live/assemblers/index.js";

import {
  SNAP,
  CTX,
  HASH1,
  ROUTE,
  config,
  orderedUnit,
  U1,
  bridgeUnits,
  snapshot,
  facts,
  D1,
  draftedScene,
  workflowScene,
  installedBible,
  verdict,
} from "./composition-assemblers.support.js";

describe("readiness assembler", () => {
  it("resolves ready with the installed rendering ids", async () => {
    const deps = { readiness: createReadinessDeps({ facts, bible: installedBible() }), draft: {} };
    const ports = createWorkflowPorts(deps as unknown as Parameters<typeof createWorkflowPorts>[0]);
    const readiness = await ports.readiness.resolve("unit:u1");
    expect(readiness.ready).toBe(true);
    if (readiness.ready) expect(readiness.bibleRenderingIds.length).toBeGreaterThan(0);
  });

  it("reports not-ready naming the missing required entry", async () => {
    const deps = {
      readiness: createReadinessDeps({ facts, bible: installedBible(new Set(["voice"])) }),
      draft: {},
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
    const input = buildDeterministicGateInput({
      scene: draftedScene,
      facts,
      side: { policy: realliveSjisPolicy },
    });
    const report = evaluateDeterministicGates(input);
    expect(input.workScope?.inScopeUnitFactIds).toEqual(
      draftedScene.units.map((unit) => unit.unitId),
    );
    // The always-run gates all ran, bound by subjectId === factId.
    expect(report.evaluatedGates).toEqual(
      expect.arrayContaining([
        "cardinality-order-hash",
        "protected-spans",
        "encoding-policy",
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
    const input = buildQ1ReviewInput({
      unit: D1,
      fact: u1Fact,
      localizationSnapshotId: SNAP,
      targetLanguage: "en-US",
      localizedBible: [
        { renderingId: "rendering:name", text: "Use Rin for 凛." },
        { renderingId: "rendering:voice", text: "Keep Rin direct." },
      ],
    });
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
    // "snapshot has no ordered fact for unit <id>" on real primary_corpus bytes).
    const base = orderedUnit("bare-x", "reallive:scene-0001#0000", 0, HASH1, []);
    const fact = { ...base, factId: "unit:bare-x", bridgeUnitId: "bare-x" } as typeof base;
    const snap = { ...snapshot, orderedUnits: [fact] } as typeof snapshot;
    const bridgeUnit = bridgeUnits.values().next().value;
    const fs = decodeFactSourceFrom(snap, new Map([["bare-x", bridgeUnit]]));
    expect(fs.orderedFact("bare-x").factId).toBe("unit:bare-x");
    expect(fs.orderedFact("unit:bare-x").factId).toBe("unit:bare-x");
  });
});
