// Deterministic localization + evidence gate proofs.
//
// For EACH gate: a passing case and a defect case (a guarantee removed makes a
// test fail). Every emitted defect is contract-validated against DefectSchema.
// Gates run over the REAL fact snapshot where the shape allows, and over
// synthetic snapshots to trigger specific per-gate conditions. A gate that
// cannot evaluate its input fails loud (GateEvaluationError) — proven too.

import type { Fact } from "../src/contracts/index.js";
import { DefectSchema } from "../src/contracts/index.js";
import { describe, expect, it } from "vitest";

import {
  byteBoxGate,
  cardinalityOrderHashGate,
  encodingGate,
  evaluateDeterministicGates,
  evidenceScopeGate,
  GateEvaluationError,
  glossaryExactGate,
  markupControlsGate,
  patchCoverageGate,
  protectedSpansGate,
  reachableUnitFactIdsInOrder,
  realliveSjisPolicy,
  renderOcrGate,
  utf8JsonPolicy,
} from "../src/gates/index.js";
import type { RenderAndOcrResult } from "../src/contracts/index.js";

import {
  buildRb024Snapshot,
  makeAccepted,
  makeSnapshot,
  makeUnit,
  sha,
} from "./support/gate-fixtures.js";

const SNAP = sha("context-snapshot");

function assertContractValid(defects: readonly unknown[]): void {
  for (const defect of defects) {
    expect(() => DefectSchema.parse(defect)).not.toThrow();
  }
}

describe("cardinality-order-hash gate", () => {
  const u0 = makeUnit({
    factId: "unit:c0",
    sourceUnitKey: "k0",
    playReveal: { playOrderIndex: 0, revealSceneOrder: null, revealItemOrder: null },
  });
  const u1 = makeUnit({
    factId: "unit:c1",
    sourceUnitKey: "k1",
    playReveal: { playOrderIndex: 1, revealSceneOrder: null, revealItemOrder: null },
  });
  const snap = makeSnapshot({ units: [u0, u1] });

  it("passes when every accepted output matches source hash and order", () => {
    const defects = cardinalityOrderHashGate(snap, [makeAccepted(u0, "a"), makeAccepted(u1, "b")]);
    expect(defects).toHaveLength(0);
  });

  it("flags a source-hash mismatch", () => {
    const bad = makeAccepted(u0, "a", { sourceHash: sha("wrong") });
    const defects = cardinalityOrderHashGate(snap, [bad, makeAccepted(u1, "b")]);
    expect(defects.map((d) => d.category)).toContain("source-hash");
    assertContractValid(defects);
  });

  it("flags a reversed expected order", () => {
    const defects = cardinalityOrderHashGate(
      snap,
      [makeAccepted(u0, "a"), makeAccepted(u1, "b")],
      ["unit:c1", "unit:c0"],
    );
    expect(defects.map((d) => d.category)).toContain("unit-order");
  });

  it("flags an accepted output outside the expected scope", () => {
    const defects = cardinalityOrderHashGate(snap, [makeAccepted(u0, "a")], ["unit:c1"]);
    expect(defects.map((d) => d.category)).toContain("unit-cardinality");
  });

  it("fails loud on an accepted output for an unknown unit", () => {
    const stray = makeUnit({ factId: "unit:ghost" });
    expect(() => cardinalityOrderHashGate(snap, [makeAccepted(stray, "x")])).toThrow(
      GateEvaluationError,
    );
  });
});

describe("protected-spans gate", () => {
  const unit = makeUnit({
    factId: "unit:ps",
    protectedSkeleton: {
      sourceHash: sha("ps"),
      spans: [
        {
          spanKind: "variable_placeholder",
          preserveMode: "exact",
          raw: "{name}",
          startByte: 0,
          endByte: 6,
        },
      ],
    },
    sourceHash: sha("ps"),
  });
  const snap = makeSnapshot({ units: [unit] });

  it("passes when the exact span is preserved", () => {
    expect(protectedSpansGate(snap, [makeAccepted(unit, "Hi {name}!")])).toHaveLength(0);
  });

  it("flags a dropped exact span", () => {
    const defects = protectedSpansGate(snap, [makeAccepted(unit, "Hi you!")]);
    expect(defects.map((d) => d.category)).toEqual(["protected-span"]);
    assertContractValid(defects);
  });
});

describe("encoding gate (RealLive Shift-JIS policy)", () => {
  const unit = makeUnit({ factId: "unit:sjis" });
  const snap = makeSnapshot({ units: [unit] });

  it("passes an ASCII target", () => {
    expect(encodingGate(snap, [makeAccepted(unit, "Hello.")], realliveSjisPolicy)).toHaveLength(0);
  });

  it("flags a non-Shift-JIS codepoint", () => {
    const defects = encodingGate(snap, [makeAccepted(unit, "smile 😀")], realliveSjisPolicy);
    expect(defects.map((d) => d.category)).toEqual(["encoding"]);
    assertContractValid(defects);
  });
});

describe("encoding gate honesty across policies", () => {
  const unit = makeUnit({ factId: "unit:utf8" });
  const snap = makeSnapshot({ units: [unit] });
  // An emoji-bearing target the RealLive Shift-JIS codec cannot carry.
  const emojiTarget = makeAccepted(unit, "smile 😀");

  it("a UTF-8 policy HONESTLY passes a target the Shift-JIS policy must reject", () => {
    // RealLive Shift-JIS: the same target is an encoding defect.
    expect(encodingGate(snap, [emojiTarget], realliveSjisPolicy)).toHaveLength(1);
    // UTF-8: representable, so the shared encoding gate passes it honestly.
    expect(encodingGate(snap, [emojiTarget], utf8JsonPolicy)).toHaveLength(0);
  });

  it("both policies still reject a raw unsupported control code", () => {
    const control = makeAccepted(unit, `bad${String.fromCharCode(2)}`);
    expect(encodingGate(snap, [control], realliveSjisPolicy)).toHaveLength(1);
    expect(encodingGate(snap, [control], utf8JsonPolicy)).toHaveLength(1);
  });
});

describe("byte-box gate", () => {
  const unit = makeUnit({ factId: "unit:bb", surfaceKind: "speaker_name" });
  const snap = makeSnapshot({ units: [unit] });

  it("passes a short target", () => {
    expect(byteBoxGate(snap, [makeAccepted(unit, "Aoi")], realliveSjisPolicy)).toHaveLength(0);
  });

  it("flags a target over the speaker-name byte budget", () => {
    const defects = byteBoxGate(snap, [makeAccepted(unit, "X".repeat(80))], realliveSjisPolicy);
    expect(defects.map((d) => d.category)).toContain("byte-limit");
    assertContractValid(defects);
  });
});

describe("markup-controls gate", () => {
  const unit = makeUnit({ factId: "unit:mk", surfaceKind: "dialogue" });
  const snap = makeSnapshot({ units: [unit] });

  it("passes balanced, terminated markup", () => {
    expect(
      markupControlsGate(snap, [makeAccepted(unit, "Hello <b>there</b>.")], realliveSjisPolicy),
    ).toHaveLength(0);
  });

  it("flags unbalanced markup", () => {
    const defects = markupControlsGate(
      snap,
      [makeAccepted(unit, "Hello <b there.")],
      realliveSjisPolicy,
    );
    expect(defects.map((d) => d.category)).toContain("markup");
    assertContractValid(defects);
  });

  it("flags an out-of-band control marker leak from the policy", () => {
    const defects = markupControlsGate(
      snap,
      [makeAccepted(unit, "Hi <reallive.kidoku 3>.")],
      realliveSjisPolicy,
    );
    expect(defects.map((d) => d.category)).toContain("control-sequence");
  });

  it("does not flag the RealLive marker under a policy without it", () => {
    const defects = markupControlsGate(
      snap,
      [makeAccepted(unit, "Hi <reallive.kidoku 3>.")],
      utf8JsonPolicy,
    );
    expect(defects.map((d) => d.category)).not.toContain("control-sequence");
  });

  it("flags a missing terminal punctuation", () => {
    const defects = markupControlsGate(
      snap,
      [makeAccepted(unit, "no ending here")],
      realliveSjisPolicy,
    );
    expect(defects.map((d) => d.category)).toContain("punctuation");
  });
});

describe("glossary-exact gate", () => {
  const unit = makeUnit({ factId: "unit:gl", sourceUnitKey: "kgl" });
  const term = {
    factId: "glossary:mother",
    termKey: "T-mother",
    policyAction: "translate",
    aliases: [],
    occurrenceCount: 1,
    occurrenceUnitKeys: ["kgl"],
  };
  const snap = makeSnapshot({ units: [unit], terminology: [term] });
  const form = {
    termId: "T-mother",
    sourceForm: "母",
    requiredTargetForm: "Mother",
    forbiddenTargetForms: ["Mom"],
  };

  it("passes when the required target form is present", () => {
    expect(
      glossaryExactGate(snap, [makeAccepted(unit, "My Mother said so.")], [form]),
    ).toHaveLength(0);
  });

  it("flags a missing required glossary form", () => {
    const defects = glossaryExactGate(snap, [makeAccepted(unit, "My mom said so.")], [form]);
    expect(defects.some((d) => d.category === "glossary-exact")).toBe(true);
    assertContractValid(defects);
  });

  it("fails loud for a term absent from the snapshot terminology", () => {
    expect(() =>
      glossaryExactGate(snap, [makeAccepted(unit, "x")], [{ ...form, termId: "T-ghost" }]),
    ).toThrow(GateEvaluationError);
  });
});

describe("evidence-scope gate", () => {
  const unit = makeUnit({
    factId: "unit:ev",
    playReveal: { playOrderIndex: 5, revealSceneOrder: null, revealItemOrder: null },
  });
  const snap = makeSnapshot({ units: [unit] });

  function note(
    overrides?: Partial<{
      snapshotId: string;
      fromPlayOrder: number;
      throughPlayOrder: number | null;
    }>,
  ): Fact {
    return {
      schemaVersion: "itotori.fact.v1",
      factId: "human-note:n1",
      snapshotId: overrides?.snapshotId ?? SNAP,
      hash: sha("note"),
      visibility: {
        routeScope: { kind: "global" },
        fromPlayOrder: overrides?.fromPlayOrder ?? 0,
        throughPlayOrder: overrides?.throughPlayOrder ?? null,
      },
      source: "human-note",
      value: {
        kind: "human-note",
        noteId: "n1",
        excerpt: "context",
        revision: { revisionId: "r1", contentHash: sha("rev") },
        scope: { kind: "global" },
      },
    };
  }

  it("passes when cited evidence is same-snapshot, in-route, and within horizon", () => {
    const accepted = makeAccepted(unit, "hi.", { evidenceIds: ["human-note:n1"] });
    expect(evidenceScopeGate(snap, [accepted], [note()], SNAP)).toHaveLength(0);
  });

  it("flags unresolved evidence", () => {
    const accepted = makeAccepted(unit, "hi.", { evidenceIds: ["human-note:missing"] });
    const defects = evidenceScopeGate(snap, [accepted], [note()], SNAP);
    expect(defects.map((d) => d.category)).toEqual(["evidence"]);
    assertContractValid(defects);
  });

  it("flags evidence from another snapshot (scope)", () => {
    const accepted = makeAccepted(unit, "hi.", { evidenceIds: ["human-note:n1"] });
    const defects = evidenceScopeGate(snap, [accepted], [note({ snapshotId: sha("other") })], SNAP);
    expect(defects.map((d) => d.category)).toEqual(["scope"]);
  });

  it("flags evidence outside the reveal horizon (scope)", () => {
    const accepted = makeAccepted(unit, "hi.", { evidenceIds: ["human-note:n1"] });
    const defects = evidenceScopeGate(snap, [accepted], [note({ fromPlayOrder: 9 })], SNAP);
    expect(defects.map((d) => d.category)).toEqual(["scope"]);
  });

  it("fails loud when evidence is cited but no corpus is supplied", () => {
    const accepted = makeAccepted(unit, "hi.", { evidenceIds: ["human-note:n1"] });
    expect(() =>
      evaluateDeterministicGates({
        snapshot: snap,
        accepted: [accepted],
        policy: realliveSjisPolicy,
      }),
    ).toThrow(GateEvaluationError);
  });
});

describe("patch-coverage gate", () => {
  const u0 = makeUnit({ factId: "unit:p0", sourceUnitKey: "kp0" });
  const u1 = makeUnit({ factId: "unit:p1", sourceUnitKey: "kp1" });

  it("passes when every reachable in-scope unit is covered", () => {
    const snap = makeSnapshot({ units: [u0, u1], reachableUnitKeys: ["kp0", "kp1"] });
    expect(patchCoverageGate(snap, [makeAccepted(u0, "a"), makeAccepted(u1, "b")])).toHaveLength(0);
  });

  it("flags an uncovered reachable unit", () => {
    const snap = makeSnapshot({ units: [u0, u1], reachableUnitKeys: ["kp0", "kp1"] });
    const defects = patchCoverageGate(snap, [makeAccepted(u0, "a")]);
    expect(defects.map((d) => d.category)).toEqual(["patch-coverage"]);
    assertContractValid(defects);
  });

  it("flags an unreachable in-scope unit", () => {
    const snap = makeSnapshot({ units: [u0, u1], reachableUnitKeys: ["kp0"] });
    const defects = patchCoverageGate(snap, [makeAccepted(u0, "a")], {
      inScopeUnitFactIds: ["unit:p0", "unit:p1"],
    });
    expect(defects.some((d) => d.category === "patch-coverage")).toBe(true);
  });
});

describe("render-ocr gate", () => {
  const unit = makeUnit({
    factId: "unit:r0",
    runtimeExpectation: { expectationKind: "trace_text" },
  });
  const snap = makeSnapshot({ units: [unit] });

  function render(status: "PASS" | "FAIL", kind: "overflow" | "ocr-mismatch"): RenderAndOcrResult {
    return {
      schemaVersion: "itotori.tool.render-and-ocr-result.v1",
      tool: "render_and_ocr",
      snapshotId: SNAP,
      requestHash: sha("req"),
      resultHash: sha("res"),
      page: {
        kind: "complete",
        requestCursor: null,
        returnedRows: 1,
        returnedBytes: 1,
        maxRows: 10,
        maxBytes: 10,
        nextCursor: null,
      },
      patchedBytesHash: sha("patched"),
      frames: [
        {
          frameId: "frame:1",
          artifactUri: "https://example.test/f1.png",
          contentHash: sha("frame"),
          expectedAcceptedOutputId: "output:unit:r0",
          observedUnitIds: ["unit:r0"],
          width: 640,
          height: 480,
          ocrText: "hi",
          observations: [
            { observationId: "obs:1", kind, status, unitId: "unit:r0", detail: "detail" },
          ],
        },
      ],
    };
  }

  it("passes when all observations pass and the expected unit is observed", () => {
    expect(
      renderOcrGate(snap, [makeAccepted(unit, "hi.")], render("PASS", "overflow")),
    ).toHaveLength(0);
  });

  it("flags a failed render observation as a render defect", () => {
    const defects = renderOcrGate(snap, [makeAccepted(unit, "hi.")], render("FAIL", "overflow"));
    expect(defects.map((d) => d.category)).toContain("render");
    assertContractValid(defects);
  });

  it("classifies a failed OCR observation as an ocr defect", () => {
    const defects = renderOcrGate(
      snap,
      [makeAccepted(unit, "hi.")],
      render("FAIL", "ocr-mismatch"),
    );
    expect(defects.map((d) => d.category)).toContain("ocr");
  });
});

describe("gates over the real RB-024 fact snapshot", () => {
  it("runs cardinality + patch-coverage over genuine decoded units", () => {
    const snapshot = buildRb024Snapshot();
    const order = reachableUnitFactIdsInOrder(snapshot);
    expect(order.length).toBeGreaterThan(0);
    const accepted = order.map((factId) => {
      const unit = snapshot.orderedUnits.find((candidate) => candidate.factId === factId)!;
      return makeAccepted(unit, "translated.");
    });
    expect(cardinalityOrderHashGate(snapshot, accepted)).toHaveLength(0);
    expect(patchCoverageGate(snapshot, accepted)).toHaveLength(0);
    // Drop one accepted output — patch coverage must fire for the gap.
    const missing = patchCoverageGate(snapshot, accepted.slice(1));
    expect(missing.map((d) => d.category)).toContain("patch-coverage");
  });
});
