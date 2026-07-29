import { describe, expect, it } from "vitest";
import {
  RENDER_AND_OCR_RESULT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type RenderAndOcrResult,
} from "../src/contracts/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  Q5DecodedObservationError,
  Q5_ONSCREEN_CATEGORIES,
  Q5RouteError,
  assertCertifiedBuildLqaRoute,
  assertBuildLqaOnlyToolGrant,
  buildQ5CallSpec,
  canFinalize,
  deterministicFaults,
  frameHasBlockingFault,
  gateForFaultKind,
  interpretQ5Verdict,
  parseQ5ReviewInput,
  q5BuildLqaToolGrant,
  q5FrameFromRenderResult,
  q5SystemPrompt,
  q5UserPrompt,
  Q5_PROMPT_VERSION,
  runQ5Review,
  type EvidenceResolver,
  type Q5ReviewInput,
} from "../src/roles/q5/index.js";

import {
  SNAP,
  HASH,
  BYTES,
  cleanFrame,
  baseInput,
  allVisible,
  countingDispatch,
  faultedFrame,
  passVerdict,
  failVerdict,
  cannotAssessVerdict,
  refs,
  recordedDispatch,
} from "./q5-build-lqa-reviewer.support.js";

describe("Clause 1 — English target observed through render/OCR only", () => {
  it("rejects a decoded-TextLine channel key at any depth", () => {
    const leaky = {
      ...baseInput,
      frame: { ...cleanFrame, decodedTextLines: ["He was waiting at the station."] },
    };
    expect(() => parseQ5ReviewInput(leaky)).toThrow(Q5DecodedObservationError);
  });

  it("rejects a top-level decoded English observation", () => {
    expect(() => parseQ5ReviewInput({ ...baseInput, decodedTarget: "phantom" })).toThrow(
      Q5DecodedObservationError,
    );
  });

  it("puts the real frame, expected accepted target, OCR text, and localized bible on the prompt", () => {
    const user = q5UserPrompt(baseInput);
    expect(user).toContain("https://frames.example/frame-1.png");
    expect(user).toContain("640x480");
    expect(user).toContain("EXPECTED ACCEPTED TARGET (accepted:1)");
    expect(user).toContain("ON-SCREEN ENGLISH (render/OCR of the real patched bytes)");
    expect(user).toContain("He was waiting at the station.");
    expect(user).toContain("Use clear, neutral past-tense narration.");
    expect(user.toLowerCase()).not.toMatch(/\bdecoded\b/u);
  });

  it("projects the frame from a REAL render/OCR result (the patched-byte channel)", () => {
    const renderResult: RenderAndOcrResult = {
      schemaVersion: RENDER_AND_OCR_RESULT_SCHEMA_VERSION,
      tool: "render_and_ocr",
      snapshotId: SNAP,
      requestHash: HASH,
      resultHash: HASH,
      page: {
        kind: "complete",
        requestCursor: null,
        returnedRows: 1,
        returnedBytes: 64,
        maxRows: 100,
        maxBytes: 1_000,
        nextCursor: null,
      },
      patchedBytesHash: BYTES,
      frames: [
        {
          frameId: "frame:1",
          artifactUri: "https://frames.example/frame-1.png",
          contentHash: HASH,
          expectedAcceptedOutputId: "accepted:1",
          observedUnitIds: ["unit:1"],
          width: 640,
          height: 480,
          ocrText: "He was waiting at the station.",
          observations: [
            {
              observationId: "obs:1",
              kind: "layout",
              status: "PASS",
              unitId: "unit:1",
              detail: "ok",
            },
          ],
        },
      ],
    } as unknown as RenderAndOcrResult;
    const frame = q5FrameFromRenderResult(renderResult, "frame:1");
    expect(frame.patchedBytesHash).toBe(BYTES);
    expect(frame.artifactUri).toBe("https://frames.example/frame-1.png");
    expect(frame).toMatchObject({ width: 640, height: 480 });
    expect(frame.ocrText).toBe("He was waiting at the station.");
    // The projected frame is a valid Q5 observation channel end to end.
    const input = parseQ5ReviewInput({ ...baseInput, frame });
    expect(input.frame.frameId).toBe("frame:1");
  });

  it("requires exact localized-bible renderings and a frame that observed the reviewed unit", () => {
    expect(() =>
      parseQ5ReviewInput({
        ...baseInput,
        localizedBible: [{ renderingId: "rendering:other", text: "Wrong binding." }],
      }),
    ).toThrow(/exactly match/u);
    expect(() =>
      parseQ5ReviewInput({
        ...baseInput,
        frame: { ...cleanFrame, observedUnitIds: ["unit:other"] },
      }),
    ).toThrow(/must observe the unit/u);
  });
});

describe("Clause 2 — render/build faults route to deterministic gates", () => {
  it("maps every render fault kind to a real deterministic build gate", () => {
    expect(gateForFaultKind("overflow")).toBe("byte-box");
    expect(gateForFaultKind("charset")).toBe("encoding-policy");
    expect(gateForFaultKind("missing-glyph")).toBe("render-ocr");
    expect(gateForFaultKind("layout")).toBe("render-ocr");
    expect(gateForFaultKind("ocr-mismatch")).toBe("render-ocr");
    expect(gateForFaultKind("replay-coverage")).toBe("render-ocr");
  });

  it("a faulted frame routes to the gate and is NEVER charged as a translation defect", () => {
    // The model even returns a translation-quality FAIL — the deterministic
    // fault must still pre-empt it: the disposition is the deterministic gate,
    // NOT a Q5 repair/translation defect, and it cannot finalize.
    for (const kind of [
      "missing-glyph",
      "overflow",
      "charset",
      "layout",
      "replay-coverage",
    ] as const) {
      const frame = faultedFrame(kind);
      expect(frameHasBlockingFault(frame)).toBe(true);
      const interpretation = interpretQ5Verdict(failVerdict(), frame, allVisible);
      expect(interpretation.disposition).toBe("deterministic-gate");
      expect(interpretation.disposition).not.toBe("repair");
      expect(canFinalize(interpretation)).toBe(false);
      expect(interpretation.routedFaults).toHaveLength(1);
      expect(interpretation.routedFaults[0]).toMatchObject({
        faultKind: kind,
        gate: gateForFaultKind(kind),
      });
    }
  });

  it("a faulted frame is never silently passed either (a model PASS cannot finalize)", () => {
    const interpretation = interpretQ5Verdict(
      passVerdict(),
      faultedFrame("missing-glyph"),
      allVisible,
    );
    expect(interpretation.disposition).toBe("deterministic-gate");
    expect(canFinalize(interpretation)).toBe(false);
  });

  it("deterministicFaults is derived from the frame alone (no model consulted)", () => {
    expect(deterministicFaults(cleanFrame)).toHaveLength(0);
    expect(deterministicFaults(faultedFrame("charset"))).toHaveLength(1);
  });

  it("a faulted frame + a GARBAGE model output routes to its gate WITHOUT parsing the model", () => {
    // A schema-invalid model blob would throw if parsed — but the fault is
    // decided off the frame ALONE, before any model parse, so it routes cleanly.
    const interpretation = interpretQ5Verdict({}, faultedFrame("missing-glyph"), allVisible);
    expect(interpretation.disposition).toBe("deterministic-gate");
    expect(interpretation.verdict).toBeNull();
    expect(canFinalize(interpretation)).toBe(false);
    expect(interpretation.routedFaults[0]?.gate).toBe("render-ocr");
  });

  it("end to end: a faulted frame + a garbage model output routes to its gate, no throw", async () => {
    // Through the PUBLIC route: the dispatch returns a garbage success blob `{}`,
    // yet a missing-glyph fault routes to render-ocr without throwing, and the
    // fault is never charged to translation quality (verdict is null).
    const faulted = faultedFrame("missing-glyph");
    const outcome = await runQ5Review({ ...baseInput, frame: faulted }, refs, {
      dispatch: recordedDispatch({}),
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("reviewed");
    expect(outcome.canFinalize).toBe(false);
    if (outcome.outcome === "reviewed") {
      expect(outcome.interpretation.disposition).toBe("deterministic-gate");
      expect(outcome.interpretation.verdict).toBeNull();
      expect(outcome.interpretation.routedFaults[0]?.gate).toBe("render-ocr");
    }
  });

  it("a clean frame + a garbage model output still surfaces the model-parse failure", () => {
    // The reorder must NOT swallow a real model-parse failure on a clean frame.
    expect(() => interpretQ5Verdict({}, cleanFrame, allVisible)).toThrow();
  });
});

describe("Clause 3 — on-screen translation quality only", () => {
  it("grants no render or egress tool", () => {
    expect(() => assertBuildLqaOnlyToolGrant()).not.toThrow();
    const grant = q5BuildLqaToolGrant();
    expect(grant).not.toContain("render_and_ocr");
    expect(grant).not.toContain("web_search");
    expect(grant).not.toContain("back_translate");
    expect(grant).toContain("glossary_lookup");
  });

  it("states on-screen-only and render-is-elsewhere in the system contract", () => {
    const system = q5SystemPrompt().toLowerCase();
    expect(system).toContain("on screen");
    expect(system).toContain("render");
  });

  it("rejects a FAIL whose category is outside the on-screen rubric (a build fault)", () => {
    const offlane = failVerdict({
      category: "mistranslation",
      span: { spanId: "span:1", surface: "target", text: "x" },
    });
    const interpretation = interpretQ5Verdict(offlane, cleanFrame, allVisible);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(Q5_ONSCREEN_CATEGORIES).toStrictEqual(["onscreen-language"]);
  });
});

describe("Clause 4 — strict verdict shape and visible evidence", () => {
  it("a FAIL missing its repair constraint is not a valid verdict", () => {
    expect(() =>
      interpretQ5Verdict(failVerdict({ repairConstraint: null }), cleanFrame, allVisible),
    ).toThrow();
  });

  it("a FAIL missing its span is not a valid verdict", () => {
    expect(() => interpretQ5Verdict(failVerdict({ span: null }), cleanFrame, allVisible)).toThrow();
  });

  it("an unresolvable citation invalidates the verdict", () => {
    const missing: EvidenceResolver = () => ({ resolved: false, visible: false });
    const interpretation = interpretQ5Verdict(passVerdict(), cleanFrame, missing);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(interpretation.issues.some((issue) => /does not resolve/u.test(issue.message))).toBe(
      true,
    );
  });

  it("an invisible citation invalidates the verdict", () => {
    const hidden: EvidenceResolver = () => ({ resolved: true, visible: false });
    const interpretation = interpretQ5Verdict(passVerdict(), cleanFrame, hidden);
    expect(interpretation.disposition).toBe("invalid");
    expect(interpretation.issues.some((issue) => /not visible/u.test(issue.message))).toBe(true);
  });

  it("requires every outcome to cite the on-screen frame and expected accepted target", () => {
    const noFrame = interpretQ5Verdict(
      passVerdict({ evidenceIds: ["accepted:1"] }),
      cleanFrame,
      allVisible,
    );
    expect(noFrame.disposition).toBe("invalid");
    expect(noFrame.issues.some((issue) => /on-screen frame evidence/u.test(issue.message))).toBe(
      true,
    );

    const noAcceptedTarget = interpretQ5Verdict(
      cannotAssessVerdict({ evidenceIds: ["frame:1"] }),
      cleanFrame,
      allVisible,
    );
    expect(noAcceptedTarget.disposition).toBe("invalid");
    expect(
      noAcceptedTarget.issues.some((issue) => /expected accepted target/u.test(issue.message)),
    ).toBe(true);
    expect(canFinalize(noAcceptedTarget)).toBe(false);
  });

  it("a clean PASS on a clean frame with visible evidence finalizes", () => {
    const interpretation = interpretQ5Verdict(passVerdict(), cleanFrame, allVisible);
    expect(interpretation.disposition).toBe("finalize");
    expect(canFinalize(interpretation)).toBe(true);
  });
});

describe("Clause 5 — CANNOT_ASSESS never passes", () => {
  it("a valid CANNOT_ASSESS escalates and never finalizes", () => {
    const interpretation = interpretQ5Verdict(cannotAssessVerdict(), cleanFrame, allVisible);
    expect(interpretation.disposition).toBe("escalate");
    expect(canFinalize(interpretation)).toBe(false);
  });

  it("the shared reviewer validator rejects a CANNOT_ASSESS that requests no evidence", () => {
    const silentPass = {
      snapshotId: SNAP,
      verdicts: [
        {
          unitId: "unit:1",
          verdict: "CANNOT_ASSESS",
          severity: "none",
          category: "visual",
          span: null,
          evidenceIds: [],
          repairConstraint: null,
          evidenceRequest: null,
        },
      ],
    };
    const issues = specialistFor("Q5").validate(silentPass);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => /never passes/u.test(issue.message))).toBe(true);
  });

  it("only a PASS disposition ever finalizes", () => {
    const verdicts = [passVerdict(), failVerdict(), cannotAssessVerdict()];
    for (const raw of verdicts) {
      const interpretation = interpretQ5Verdict(raw, cleanFrame, allVisible);
      if (canFinalize(interpretation)) {
        expect(interpretation.verdict?.verdict).toBe("PASS");
      }
    }
  });
});

describe("Clause 6 — ZDR dispatch on the certified reviewer profile", () => {
  it("routes review to the certified deepseek-v4-flash reviewer profile with no provider pin", () => {
    const spec = buildQ5CallSpec(baseInput, refs);
    expect(spec.purpose).toBe("review");
    expect(spec.roleId).toBe("Q5");
    expect(spec.modelProfile).toBe("reviewer");
    expect(spec.requestedModel).toBe("deepseek/deepseek-v4-flash");
    expect(spec.providerPolicy).toMatchObject({
      allowFallbacks: true,
      zdr: true,
      dataCollection: "deny",
      requireParameters: true,
    });
    expect(spec.output.name).toBe("review-verdict");
    expect(spec.promptVersion).toBe(Q5_PROMPT_VERSION);
    expect(spec.tools).toHaveLength(0);
  });

  it("re-proves the certified account-wide ZDR route in every run mode", () => {
    for (const runMode of ["production", "pilot", "test-dev"] as const) {
      const spec = buildQ5CallSpec(baseInput, { ...refs, runMode });
      expect(() => assertCertifiedBuildLqaRoute(spec)).not.toThrow();
      expect(() =>
        assertCertifiedBuildLqaRoute({ ...spec, requestedModel: "other/model" }),
      ).toThrow(Q5RouteError);
    }
  });

  it("a dispatch failure can never finalize (recorded offline path)", async () => {
    const failure: (spec: CallSpec) => Promise<CallResult> = async () =>
      ({
        schemaVersion: "itotori.call-result.v2",
        memoKey: HASH,
        requested: { model: "deepseek/deepseek-v4-flash" },
        memoHit: false,
        status: "failure",
        failureKind: "refusal",
        responseEventId: null,
        responseEncrypted: null,
        served: { status: "unknown" },
        generationId: null,
        verification: "unverified",
        usage: null,
        billing: { status: "billing-unknown" },
        defects: [],
        events: [],
      }) as unknown as CallResult;
    const outcome = await runQ5Review(baseInput, refs, {
      dispatch: failure,
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("no-verdict");
    expect(outcome.canFinalize).toBe(false);
  });

  it("a recorded PASS dispatch on a clean frame finalizes deterministically", async () => {
    const outcome = await runQ5Review(baseInput, refs, {
      dispatch: recordedDispatch(passVerdict()),
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("reviewed");
    expect(outcome.canFinalize).toBe(true);
  });

  it("a recorded run over a faulted frame routes to the deterministic gate", async () => {
    const faulted = faultedFrame("overflow");
    const outcome = await runQ5Review({ ...baseInput, frame: faulted }, refs, {
      dispatch: recordedDispatch(passVerdict()),
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("reviewed");
    expect(outcome.canFinalize).toBe(false);
    if (outcome.outcome === "reviewed") {
      expect(outcome.interpretation.disposition).toBe("deterministic-gate");
      expect(outcome.interpretation.routedFaults[0]?.gate).toBe("byte-box");
    }
  });
});

describe("Clause 7 — immutable reviewer-profile registration", () => {
  it("is the v2 reviewer-profile specialist with the shared semantic validator", () => {
    const q5 = specialistFor("Q5");
    expect(q5).toMatchObject({
      roleId: "Q5",
      shape: "reviewer",
      version: "itotori.role.Q5.v2",
      granularity: "per-unit",
      wikiObjectKind: "translation",
      modelProfileKey: "deepseek-v4-flash",
      modelProfile: "reviewer",
    });
    expect(Object.isFrozen(q5)).toBe(true);
    expect(q5.validate({ snapshotId: SNAP, verdicts: [] }).length).toBeGreaterThan(0);
  });
});

describe("Clause 8 — observation channel purity", () => {
  it("rejects a frame carrying a decoded-text field, before any wire request", async () => {
    // The English target is observed ONLY through the render/OCR channel. A
    // decoded-text field on the frame — the channel that cannot carry an ASCII
    // -leading English line — is rejected by the strict frame schema, and it never
    // reaches the wire.
    const wire = countingDispatch(passVerdict());
    const leaked = {
      ...baseInput,
      frame: { ...cleanFrame, decodedText: "He was waiting at the station." },
    } as unknown as Q5ReviewInput;
    await expect(
      runQ5Review(leaked, refs, { dispatch: wire.dispatch, resolveEvidence: allVisible }),
    ).rejects.toThrow();
    expect(wire.calls()).toBe(0);
  });
});
