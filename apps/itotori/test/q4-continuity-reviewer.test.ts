// Continuity Reviewer proofs — every clause fails if its guarantee is removed.
//
// Clause 1: the rubric is CONTINUITY only (callback / foreshadow / relationship
//           / route-arc); a FAIL outside that set is an invalid verdict, the tool
//           grant excludes every render/egress surface, and meaning/voice/engine
//           are named out of scope in the system contract.
// Clause 2: a contradiction cites BOTH real endpoints and the DETERMINISTIC play
//           order proves the origin plays BEFORE the use — an origin that does not
//           precede the use is invalid, derived from the ledger not the model.
// Clause 3: a claim NEVER crosses route scope — an endpoint off the route the
//           review is bound to is rejected.
// Clause 4: the verdict is strict PASS/FAIL/CANNOT_ASSESS; a phantom endpoint or a
//           malformed verdict cannot finalize.
// Clause 5: a CANNOT_ASSESS can NEVER pass — it escalates, and the ONLY
//           disposition that finalizes is a clean PASS.
// Clause 6: the call routes through the ZDR boundary on the certified reviewer
//           profile, route-bound in every run mode, proven offline via a recorded
//           dispatch over REAL decoded bytes.

import { describe, expect, it } from "vitest";

import {
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
  type RouteScope,
} from "../src/contracts/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  Q4_CONTINUITY_CATEGORIES,
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
  type ContinuityLedger,
  type Q4ContinuityFacts,
  type Q4DispatchRefs,
  type Q4ReviewInput,
} from "../src/roles/q4/index.js";
import { buildClaimFixture, unitFactIdAt } from "./support/claim-fixture.js";

const SNAP = `sha256:${"a".repeat(64)}` as const;
const HASH = `sha256:${"b".repeat(64)}` as const;

const ROUTE_A: RouteScope = { kind: "route", routeId: "route-a" };
const ROUTE_B: RouteScope = { kind: "route", routeId: "route-b" };
const GLOBAL: RouteScope = { kind: "global" };

// A synthetic ledger for the isolated shape proofs: an origin at play order 0 and
// a use at play order 5, both on route-a.
const synthLedger: ContinuityLedger = continuityLedgerFrom([
  { unitId: "u-origin", playOrderIndex: 0, routeScope: { kind: "route", routeId: "route-a" } },
  { unitId: "u-use", playOrderIndex: 5, routeScope: { kind: "route", routeId: "route-a" } },
]);

const baseInput: Q4ReviewInput = {
  unitId: "u-use",
  localizationSnapshotId: SNAP,
  reviewScope: ROUTE_A,
  currentTarget: "As you promised me back at the shrine, you finally came.",
  bibleRenderingIds: ["rendering:1"],
  originTranslations: [{ unitId: "u-origin", acceptedTarget: "I promise I'll come find you." }],
};

function facts(over: Partial<Q4ContinuityFacts> = {}): Q4ContinuityFacts {
  return { useUnitId: "u-use", reviewScope: ROUTE_A, ledger: synthLedger, ...over };
}

function passVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:1",
    localizationSnapshotId: SNAP,
    roleId: "Q4",
    rubric: "continuity",
    unitId: "u-use",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["u-origin"],
    repairConstraint: null,
    ...over,
  };
}

function failVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:2",
    localizationSnapshotId: SNAP,
    roleId: "Q4",
    rubric: "continuity",
    unitId: "u-use",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "at the shrine" },
    category: "callback",
    evidenceIds: ["u-origin"],
    repairConstraint: "Match the callback to the origin promise at the origin location.",
    ...over,
  };
}

function cannotAssessVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:3",
    localizationSnapshotId: SNAP,
    roleId: "Q4",
    rubric: "continuity",
    unitId: "u-use",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["Need the accepted origin translation for the shrine scene."],
    ...over,
  };
}

const refs: Q4DispatchRefs = {
  parentEventId: HASH,
  contextSnapshotId: HASH,
  localizationSnapshotId: SNAP,
  sealPayload: (plaintext): EncryptedPayloadRef => ({
    storageRef: `encrypted:q4:${plaintext.length}`,
    contentHash: HASH,
    encryption: "operator-managed",
  }),
};

function recordedDispatch(value: Record<string, unknown>): (spec: CallSpec) => Promise<CallResult> {
  return async () =>
    ({
      schemaVersion: "itotori.call-result.v2",
      memoKey: HASH,
      requested: { model: "deepseek/deepseek-v4-flash" },
      memoHit: true,
      status: "success",
      value,
      responseEventId: HASH,
      served: { status: "confirmed", model: "deepseek/deepseek-v4-flash", provider: "provider:x" },
      generationId: "generation:1",
      verification: "verified",
      usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 5, cachedTokens: 0 },
      billing: { status: "confirmed", costUsd: "0.001" },
      events: [{ kind: "run-started", iteration: 0 }],
    }) as unknown as CallResult;
}

// ── Clause 1: continuity-only rubric ─────────────────────────────────────────
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

// ── Clause 2: origin precedes use, deterministically ─────────────────────────
describe("Clause 2 — contradiction cites both endpoints; play order proves origin<use", () => {
  it("PROOF (origin-precedes-use): a FAIL whose origin plays before the use is valid; swapping the endpoints (origin after use) is INVALID — decided by the decode ledger, not the model", () => {
    // REAL decoded bytes: scene-1 units at play order 0 and 2 (global). The ledger
    // is materialized from the fact snapshot — no model asserts any ordering.
    const { snapshot } = buildClaimFixture({ scene2Routes: ["route-a"] });
    const ledger = buildContinuityLedger(snapshot);
    const early = unitFactIdAt(snapshot, 0);
    const later = unitFactIdAt(snapshot, 2);

    // origin (play order 0) precedes use (play order 2): a valid contradiction.
    const valid = interpretQ4Verdict(failVerdict({ unitId: later, evidenceIds: [early] }), {
      useUnitId: later,
      reviewScope: GLOBAL,
      ledger,
    });
    expect(valid.disposition).toBe("repair");
    expect(valid.issues).toHaveLength(0);

    // Swap the roles: cite the LATER unit as the origin of the EARLIER use. The
    // origin no longer plays first, so the finding is invalid — the verdict text
    // is identical; only the deterministic play order flips the outcome.
    const invalid = interpretQ4Verdict(failVerdict({ unitId: early, evidenceIds: [later] }), {
      useUnitId: early,
      reviewScope: GLOBAL,
      ledger,
    });
    expect(invalid.disposition).toBe("invalid");
    expect(canFinalize(invalid)).toBe(false);
    expect(invalid.issues.some((i) => /does not play before/u.test(i.message))).toBe(true);
  });

  it("a FAIL citing a phantom endpoint (no real unit) is invalid — both endpoints must be real", () => {
    const interpretation = interpretQ4Verdict(failVerdict({ evidenceIds: ["u-ghost"] }), facts());
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
});

// ── Clause 3: claims never cross route scope ─────────────────────────────────
describe("Clause 3 — a continuity claim never crosses route scope", () => {
  it("PROOF (claims-never-cross-route): the SAME finding over the SAME real endpoints is valid when the review is bound to their route and INVALID when bound to another route — only the route scope changes", () => {
    // REAL decoded bytes: scene-2 units at play order 3 and 5 live on route-a.
    const { snapshot } = buildClaimFixture({ scene2Routes: ["route-a"] });
    const ledger = buildContinuityLedger(snapshot);
    const origin = unitFactIdAt(snapshot, 3);
    const use = unitFactIdAt(snapshot, 5);
    const finding = failVerdict({ unitId: use, evidenceIds: [origin] });

    // Bound to route-a: both endpoints are on-route, origin precedes use — valid.
    const inRoute = interpretQ4Verdict(finding, { useUnitId: use, reviewScope: ROUTE_A, ledger });
    expect(inRoute.disposition).toBe("repair");
    expect(inRoute.issues).toHaveLength(0);

    // Bound to route-b: the identical endpoints now cross out of the review's
    // route, so the claim is rejected. Play order is unchanged — only the route
    // binding differs, and that alone flips the outcome.
    const crossRoute = interpretQ4Verdict(finding, {
      useUnitId: use,
      reviewScope: ROUTE_B,
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
    const interpretation = interpretQ4Verdict(failVerdict({ evidenceIds: ["g-origin"] }), {
      useUnitId: "u-use",
      reviewScope: ROUTE_A,
      ledger,
    });
    expect(interpretation.disposition).toBe("repair");
  });
});

// ── Clause 4: strict verdict shape + real endpoints ──────────────────────────
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

// ── Clause 5: CANNOT_ASSESS never passes ─────────────────────────────────────
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

// ── Clause 6: ZDR dispatch, certified profile, route-bound every mode ─────────
describe("Clause 6 — ZDR dispatch on the certified reviewer profile, route-bound", () => {
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
