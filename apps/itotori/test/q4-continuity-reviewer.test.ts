import { describe, expect, it } from "vitest";
import { type CallResult, type CallSpec } from "../src/contracts/index.js";
import { ROSTER_SPECIALISTS, specialistFor, validateRosterManifest } from "../src/roster/index.js";
import {
  Q4_CONTINUITY_CATEGORIES,
  assertCertifiedContinuityRoute,
  assertContinuityOnlyToolGrant,
  buildContinuityLedger,
  buildQ4CallSpec,
  canFinalize,
  continuityLedgerFrom,
  interpretQ4Verdict,
  parseQ4ReviewInput,
  q4ContinuityToolGrant,
  q4SystemPrompt,
  q4UserPrompt,
  runQ4Review,
  type Q4ReviewInput,
} from "../src/roles/q4/index.js";
import { buildClaimFixture, unitFactIdAt } from "./support/claim-fixture.js";

import {
  SNAP,
  HASH,
  ROUTE_A,
  ROUTE_B,
  GLOBAL,
  synthLedger,
  baseInput,
  facts,
  passVerdict,
  failVerdict,
  cannotAssessVerdict,
  refs,
  recordedDispatch,
} from "./q4-continuity-reviewer.support.js";

describe("Clause 1 — continuity rubric only", () => {
  it("the continuity categories are exactly callback/foreshadow/relationship/route-arc", () => {
    expect(Q4_CONTINUITY_CATEGORIES).toStrictEqual([
      "callback",
      "foreshadow",
      "relationship",
      "route-arc",
    ]);
  });

  it("rejects a FAIL whose category is outside the continuity rubric (a meaning finding)", () => {
    const offlane = failVerdict({ category: "mistranslation" });
    const interpretation = interpretQ4Verdict(offlane, facts());
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(
      interpretation.issues.some((i) => /outside the continuity rubric/u.test(i.message)),
    ).toBe(true);
  });

  it("accepts every continuity category as a valid FAIL", () => {
    for (const category of Q4_CONTINUITY_CATEGORIES) {
      const interpretation = interpretQ4Verdict(failVerdict({ category }), facts());
      expect(interpretation.disposition).toBe("repair");
    }
  });

  it("grants no render or egress tool and reads only decode/glossary/accepted surfaces", () => {
    expect(() => assertContinuityOnlyToolGrant()).not.toThrow();
    const grant = q4ContinuityToolGrant();
    expect(grant).not.toContain("render_and_ocr");
    expect(grant).not.toContain("web_search");
    expect(grant).not.toContain("back_translate");
    expect(grant).toContain("glossary_lookup");
    expect(grant).toContain("decode_get_units");
    expect(grant).toContain("outputs_get_accepted");
  });

  it("names continuity-only and rules out meaning/voice/engine in the system contract", () => {
    const system = q4SystemPrompt().toLowerCase();
    expect(system).toContain("continuity");
    expect(system).toContain("callback");
    expect(system).toContain("foreshadow");
    expect(system).toContain("meaning");
    expect(system).toContain("voice");
    expect(system).toContain("render");
  });
});

describe("Clause 2 — contradiction cites both endpoints; play order proves origin<use", () => {
  it("PROOF (origin-precedes-use): a FAIL whose origin plays before the use is valid; swapping the endpoints (origin after use) is INVALID — decided by the decode ledger, not the model", () => {
    // REAL decoded bytes: scene-1 units at play order 0 and 2 (global). The ledger
    // is materialized from the fact snapshot — no model asserts any ordering.
    const { snapshot } = buildClaimFixture({ scene2Routes: ["route-a"] });
    const ledger = buildContinuityLedger(snapshot);
    const early = unitFactIdAt(snapshot, 0);
    const later = unitFactIdAt(snapshot, 2);

    // origin (play order 0) precedes use (play order 2): every continuity
    // category is a valid, endpoint-cited contradiction over the real fixture.
    for (const category of ["callback", "foreshadow", "relationship"] as const) {
      const valid = interpretQ4Verdict(
        failVerdict({ unitId: later, category, evidenceIds: [early, later] }),
        {
          useUnitId: later,
          reviewScope: GLOBAL,
          acceptedOriginUnitIds: [early],
          ledger,
        },
      );
      expect(valid.disposition, category).toBe("repair");
      expect(valid.issues, category).toHaveLength(0);
    }

    // Swap the roles: cite the LATER unit as the origin of the EARLIER use. The
    // origin no longer plays first, so the finding is invalid — the verdict text
    // is identical; only the deterministic play order flips the outcome.
    const invalid = interpretQ4Verdict(
      failVerdict({ unitId: early, evidenceIds: [later, early] }),
      {
        useUnitId: early,
        reviewScope: GLOBAL,
        acceptedOriginUnitIds: [later],
        ledger,
      },
    );
    expect(invalid.disposition).toBe("invalid");
    expect(canFinalize(invalid)).toBe(false);
    expect(invalid.issues.some((i) => /does not play before/u.test(i.message))).toBe(true);
  });

  it("a FAIL citing a phantom endpoint (no real unit) is invalid — both endpoints must be real", () => {
    const interpretation = interpretQ4Verdict(
      failVerdict({ evidenceIds: ["u-ghost", "u-use"] }),
      facts(),
    );
    expect(interpretation.disposition).toBe("invalid");
    expect(
      interpretation.issues.some((i) => /does not resolve to a real unit/u.test(i.message)),
    ).toBe(true);
  });

  it("a verdict for a different unit than the one under review is invalid", () => {
    const interpretation = interpretQ4Verdict(failVerdict({ unitId: "u-origin" }), facts());
    expect(interpretation.disposition).toBe("invalid");
    expect(
      interpretation.issues.some((i) => /not for the unit under review/u.test(i.message)),
    ).toBe(true);
  });

  it("rejects a contradiction that omits the use endpoint even when its origin is real", () => {
    const interpretation = interpretQ4Verdict(failVerdict({ evidenceIds: ["u-origin"] }), facts());
    expect(interpretation.disposition).toBe("invalid");
    expect(interpretation.issues.some((i) => /must cite the use endpoint/u.test(i.message))).toBe(
      true,
    );
  });

  it("flags callback, foreshadow, and relationship contradictions only when each cites the accepted origin and current use", () => {
    for (const category of ["callback", "foreshadow", "relationship"] as const) {
      const interpretation = interpretQ4Verdict(
        failVerdict({ category, evidenceIds: ["u-origin", "u-use"] }),
        facts(),
      );
      expect(interpretation.disposition, category).toBe("repair");
      expect(interpretation.issues, category).toHaveLength(0);
    }
  });
});

describe("Clause 3 — a continuity claim never crosses route scope", () => {
  it("PROOF (claims-never-cross-route): the SAME finding over the SAME real endpoints is valid when the review is bound to their route and INVALID when bound to another route — only the route scope changes", () => {
    // REAL decoded bytes: scene-2 units at play order 3 and 5 live on route-a.
    const { snapshot } = buildClaimFixture({ scene2Routes: ["route-a"] });
    const ledger = buildContinuityLedger(snapshot);
    const origin = unitFactIdAt(snapshot, 3);
    const use = unitFactIdAt(snapshot, 5);
    const finding = failVerdict({ unitId: use, evidenceIds: [origin, use] });

    // Bound to route-a: both endpoints are on-route, origin precedes use — valid.
    const inRoute = interpretQ4Verdict(finding, {
      useUnitId: use,
      reviewScope: ROUTE_A,
      acceptedOriginUnitIds: [origin],
      ledger,
    });
    expect(inRoute.disposition).toBe("repair");
    expect(inRoute.issues).toHaveLength(0);

    // Bound to route-b: the identical endpoints now cross out of the review's
    // route, so the claim is rejected. Play order is unchanged — only the route
    // binding differs, and that alone flips the outcome.
    const crossRoute = interpretQ4Verdict(finding, {
      useUnitId: use,
      reviewScope: ROUTE_B,
      acceptedOriginUnitIds: [origin],
      ledger,
    });
    expect(crossRoute.disposition).toBe("invalid");
    expect(canFinalize(crossRoute)).toBe(false);
    expect(
      crossRoute.issues.some((i) => /crosses out of the review route scope/u.test(i.message)),
    ).toBe(true);
  });

  it("a global origin is visible on any route (a whole-game fact plays everywhere)", () => {
    const ledger = continuityLedgerFrom([
      { unitId: "u-use", playOrderIndex: 5, routeScope: { kind: "route", routeId: "route-a" } },
      { unitId: "g-origin", playOrderIndex: 0, routeScope: { kind: "global" } },
    ]);
    const interpretation = interpretQ4Verdict(failVerdict({ evidenceIds: ["g-origin", "u-use"] }), {
      useUnitId: "u-use",
      reviewScope: ROUTE_A,
      acceptedOriginUnitIds: ["g-origin"],
      ledger,
    });
    expect(interpretation.disposition).toBe("repair");
  });
});

describe("Clause 4 — strict verdict shape", () => {
  it("a schema-invalid model blob throws (not a silent pass)", () => {
    expect(() => interpretQ4Verdict({}, facts())).toThrow();
  });

  it("a non-Q4 / non-continuity verdict is rejected", () => {
    expect(() => interpretQ4Verdict(failVerdict({ roleId: "Q1" }), facts())).toThrow();
    expect(() => interpretQ4Verdict(failVerdict({ rubric: "meaning" }), facts())).toThrow();
  });

  it("a FAIL missing its repair constraint is not a valid verdict", () => {
    expect(() => interpretQ4Verdict(failVerdict({ repairConstraint: null }), facts())).toThrow();
  });

  it("a clean PASS whose endpoints are real and on-route finalizes", () => {
    const interpretation = interpretQ4Verdict(passVerdict(), facts());
    expect(interpretation.disposition).toBe("finalize");
    expect(canFinalize(interpretation)).toBe(true);
  });
});

describe("Clause 5 — CANNOT_ASSESS never passes", () => {
  it("a valid CANNOT_ASSESS escalates and never finalizes", () => {
    const interpretation = interpretQ4Verdict(cannotAssessVerdict(), facts());
    expect(interpretation.disposition).toBe("escalate");
    expect(canFinalize(interpretation)).toBe(false);
  });

  it("the shared reviewer validator rejects a CANNOT_ASSESS that requests no evidence", () => {
    const silentPass = {
      snapshotId: SNAP,
      verdicts: [
        {
          unitId: "u-use",
          verdict: "CANNOT_ASSESS",
          severity: "none",
          category: "continuity",
          span: null,
          evidenceIds: [],
          repairConstraint: null,
          evidenceRequest: null,
        },
      ],
    };
    const issues = specialistFor("Q4").validate(silentPass);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => /never passes/u.test(i.message))).toBe(true);
  });

  it("only a PASS disposition ever finalizes", () => {
    for (const raw of [passVerdict(), failVerdict(), cannotAssessVerdict()]) {
      const interpretation = interpretQ4Verdict(raw, facts());
      if (canFinalize(interpretation)) {
        expect(interpretation.verdict.verdict).toBe("PASS");
      }
    }
  });
});

describe("Clause 6 — ZDR dispatch on the certified reviewer profile, route-bound", () => {
  it("is immutable reviewer-profile data in the validated 19-role manifest", () => {
    const manifest = validateRosterManifest(ROSTER_SPECIALISTS);
    const q4 = manifest.Q4;
    expect(q4.shape).toBe("reviewer");
    expect(q4.modelProfile).toBe("reviewer");
    expect(Object.isFrozen(q4)).toBe(true);
    expect(Object.isFrozen(q4.tools)).toBe(true);
    expect(q4.validate(undefined)).not.toHaveLength(0);
  });

  it("routes review to the certified deepseek-v4-flash reviewer profile with no provider pin", () => {
    const spec = buildQ4CallSpec(baseInput, refs);
    expect(spec.purpose).toBe("review");
    expect(spec.roleId).toBe("Q4");
    expect(spec.modelProfile).toBe("reviewer");
    expect(spec.requestedModel).toBe("deepseek/deepseek-v4-flash");
    expect(spec.providerPolicy).toMatchObject({
      allowFallbacks: true,
      zdr: true,
      dataCollection: "deny",
      requireParameters: true,
    });
    expect(spec.output.name).toBe("review-verdict");
    expect(spec.tools).toHaveLength(0);
  });

  it("is route-bound in EVERY run mode — the route rides the prompt and the ZDR profile is unchanged", () => {
    for (const runMode of ["production", "pilot", "test-dev"] as const) {
      const spec = buildQ4CallSpec(baseInput, { ...refs, runMode });
      expect(spec.runMode).toBe(runMode);
      expect(spec.requestedModel).toBe("deepseek/deepseek-v4-flash");
      expect(spec.providerPolicy).toMatchObject({ zdr: true });
    }
    // The review is bound to its route on the wire.
    expect(q4UserPrompt(baseInput)).toContain("route route-a");
    expect(q4UserPrompt({ ...baseInput, reviewScope: GLOBAL })).toContain("global (whole-game)");
    // A route-less input cannot even be constructed.
    expect(() => parseQ4ReviewInput({ ...baseInput, reviewScope: undefined })).toThrow();
  });

  it("rejects a CallSpec whose model route is drifted before dispatch", () => {
    const spec = buildQ4CallSpec(baseInput, refs);
    expect(() =>
      assertCertifiedContinuityRoute({
        ...spec,
        requestedModel: "other/model",
      }),
    ).toThrow(/not the certified/u);
  });

  it("a recorded PASS dispatch finalizes deterministically over real bytes", async () => {
    const { snapshot } = buildClaimFixture({ scene2Routes: ["route-a"] });
    const ledger = buildContinuityLedger(snapshot);
    const origin = unitFactIdAt(snapshot, 0);
    const use = unitFactIdAt(snapshot, 2);
    const input: Q4ReviewInput = {
      ...baseInput,
      unitId: use,
      reviewScope: GLOBAL,
      originTranslations: [{ unitId: origin, acceptedTarget: "I promise I'll come find you." }],
    };
    const outcome = await runQ4Review(input, refs, {
      dispatch: recordedDispatch(passVerdict({ unitId: use, evidenceIds: [origin] })),
      ledger,
    });
    expect(outcome.outcome).toBe("reviewed");
    expect(outcome.canFinalize).toBe(true);
  });

  it("a recorded callback contradiction over real decoded endpoints routes to repair only with both citations", async () => {
    const { snapshot } = buildClaimFixture({ scene2Routes: ["route-a"] });
    const ledger = buildContinuityLedger(snapshot);
    const origin = unitFactIdAt(snapshot, 0);
    const use = unitFactIdAt(snapshot, 2);
    const input: Q4ReviewInput = {
      ...baseInput,
      unitId: use,
      reviewScope: GLOBAL,
      originTranslations: [{ unitId: origin, acceptedTarget: "I promise I'll come find you." }],
    };
    const outcome = await runQ4Review(input, refs, {
      dispatch: recordedDispatch(
        failVerdict({ unitId: use, category: "callback", evidenceIds: [origin, use] }),
      ),
      ledger,
    });
    expect(outcome.outcome).toBe("reviewed");
    if (outcome.outcome !== "reviewed") throw new Error("expected a reviewed Q4 outcome");
    expect(outcome.interpretation.disposition).toBe("repair");
    expect(outcome.interpretation.verdict.evidenceIds).toEqual([origin, use]);
    expect(outcome.canFinalize).toBe(false);
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
    const outcome = await runQ4Review(baseInput, refs, { dispatch: failure, ledger: synthLedger });
    expect(outcome.outcome).toBe("no-verdict");
    expect(outcome.canFinalize).toBe(false);
  });
});
