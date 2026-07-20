// Voice Reviewer proofs — every clause fails if its guarantee is removed.
//
// Clause 1: the rubric is VOICE and REGISTER CONTINUITY only, against the
//           localized voice bible and the accepted target history. The tool
//           grant excludes every screen/egress surface, and a FAIL outside the
//           voice categories is an invalid verdict that cannot finalize.
// Clause 2: every FAILURE cites the APPLICABLE bible rule at the position AND the
//           accepted target history it violated. A FAIL citing neither, only one,
//           or a rule/history that is not applicable at the decode-derived
//           position is INVALID and can never finalize.
// Clause 3: the position (counterpart/route/play) is DECODE-DERIVED; applicable
//           rules and history are computed from it, not the model. First
//           appearances, register shifts, and stratified samples are all
//           reviewable; a non-decode position is refused.
// Clause 4: the verdict is strict PASS/FAIL/CANNOT_ASSESS with VISIBLE evidence;
//           a malformed verdict or an unresolvable citation cannot finalize; a
//           CANNOT_ASSESS can NEVER pass.
// Clause 5: the call routes through the ZDR boundary on the certified reviewer
//           profile with no provider pin, and the certified route is re-proven at
//           the public dispatch entry in EVERY mode — including test-dev.

import { describe, expect, it, vi } from "vitest";

import {
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
} from "../src/contracts/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  Q2PositionError,
  Q2RouteError,
  Q2_VOICE_CATEGORIES,
  applicableBibleRules,
  assertCertifiedReviewerRoute,
  assertPositionDecodeDerived,
  assertVoiceOnlyToolGrant,
  buildQ2CallSpec,
  canFinalize,
  historyAtPosition,
  interpretQ2Verdict,
  parseQ2ReviewInput,
  positionGroundedCitationResolver,
  q2SystemPrompt,
  q2VoiceToolGrant,
  runQ2Review,
  type EvidenceResolver,
  type Q2DispatchRefs,
  type Q2ReviewInput,
} from "../src/roles/q2/index.js";

const SNAP = `sha256:${"a".repeat(64)}` as const;
const HASH = `sha256:${"b".repeat(64)}` as const;

const baseInput: Q2ReviewInput = {
  unitId: "unit:1",
  localizationSnapshotId: SNAP,
  speakerId: "char:hero",
  candidateTarget: "Yo, mentor, what's up?",
  position: {
    derivation: "decode",
    counterpartId: "char:mentor",
    routeId: "route:main",
    playOrder: 100,
  },
  sampleKind: "stratified-sample",
  bibleRules: [
    {
      ruleId: "rule:base",
      scope: "character",
      counterpartId: null,
      routeId: null,
      fromPlayOrder: null,
      toPlayOrder: null,
      register: "Formal, deferential base register.",
    },
    {
      ruleId: "rule:cp",
      scope: "counterpart",
      counterpartId: "char:mentor",
      routeId: null,
      fromPlayOrder: null,
      toPlayOrder: null,
      register: "Especially respectful toward the mentor.",
    },
    {
      ruleId: "rule:rival",
      scope: "counterpart",
      counterpartId: "char:rival",
      routeId: null,
      fromPlayOrder: null,
      toPlayOrder: null,
      register: "Curt toward the rival.",
    },
  ],
  acceptedHistory: [
    {
      historyId: "hist:base",
      unitId: "unit:0",
      counterpartId: null,
      routeId: "route:main",
      playOrder: 5,
      text: "I shall do my utmost.",
    },
    {
      historyId: "hist:cp",
      unitId: "unit:50",
      counterpartId: "char:mentor",
      routeId: "route:main",
      playOrder: 50,
      text: "Thank you for your guidance, master.",
    },
    {
      historyId: "hist:future",
      unitId: "unit:200",
      counterpartId: "char:mentor",
      routeId: "route:main",
      playOrder: 200,
      text: "A later accepted line.",
    },
  ],
};

const allVisible: EvidenceResolver = () => ({ resolved: true, visible: true });

function passVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:1",
    localizationSnapshotId: SNAP,
    roleId: "Q2",
    rubric: "voice",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rule:cp"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["hist:cp"],
    repairConstraint: null,
    ...overrides,
  };
}

function failVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:2",
    localizationSnapshotId: SNAP,
    roleId: "Q2",
    rubric: "voice",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rule:cp"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "Yo, mentor" },
    category: "character-voice",
    evidenceIds: ["hist:cp"],
    repairConstraint: "Restore the deferential register the mentor address established.",
    ...overrides,
  };
}

function cannotAssessVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:3",
    localizationSnapshotId: SNAP,
    roleId: "Q2",
    rubric: "voice",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rule:cp"] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["Need the accepted mentor-address history for this route."],
    ...overrides,
  };
}

const refs: Q2DispatchRefs = {
  parentEventId: HASH,
  contextSnapshotId: HASH,
  localizationSnapshotId: SNAP,
  sealPayload: (plaintext): EncryptedPayloadRef => ({
    storageRef: `encrypted:q2:${plaintext.length}`,
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

// ── Clause 1: voice/register continuity only, not meaning or engine ──────────
describe("Clause 1 — voice/register continuity only, not meaning or engine faults", () => {
  it("grants no screen or egress tool and keeps the decode/accepted read surface", () => {
    expect(() => assertVoiceOnlyToolGrant()).not.toThrow();
    const grant = q2VoiceToolGrant();
    expect(grant).not.toContain("render_and_ocr");
    expect(grant).not.toContain("web_search");
    expect(grant).not.toContain("back_translate");
    expect(grant).toContain("decode_get_character_occurrences");
    expect(grant).toContain("outputs_get_accepted");
  });

  it("PROOF voice-only-rubric: states voice/register continuity and rules out meaning/engine", () => {
    const system = q2SystemPrompt().toLowerCase();
    expect(system).toContain("voice");
    expect(system).toContain("register");
    expect(system).toContain("continuity");
    expect(system).toContain("meaning");
    expect(system).toContain("render");
    expect(Q2_VOICE_CATEGORIES).toStrictEqual(["register", "character-voice"]);
  });

  it("PROOF voice-only-rubric: a FAIL outside the voice categories is invalid", () => {
    const meaning = failVerdict({ category: "mistranslation" });
    const interpretation = interpretQ2Verdict(
      meaning,
      allVisible,
      positionGroundedCitationResolver(baseInput),
    );
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(
      interpretation.issues.some((issue) => /outside the voice rubric/u.test(issue.message)),
    ).toBe(true);
  });
});

// ── Clause 2: a FAIL must cite the applicable bible rule + violated history ───
describe("Clause 2 — every FAIL cites the applicable bible rule + the target history it violated", () => {
  const resolveCitation = positionGroundedCitationResolver(baseInput);

  it("PROOF failure-cites-bible-rule-and-history: a grounded FAIL cites both and routes to repair", () => {
    const interpretation = interpretQ2Verdict(failVerdict(), allVisible, resolveCitation);
    expect(interpretation.disposition).toBe("repair");
    expect(interpretation.issues).toStrictEqual([]);
    expect(interpretation.citation).toStrictEqual({
      citedBibleRuleId: "rule:cp",
      citedHistoryId: "hist:cp",
    });
  });

  it("PROOF failure-cites-bible-rule-and-history: a FAIL citing NO applicable bible rule is invalid", () => {
    const ungrounded = failVerdict({
      basis: { kind: "wiki-first", bibleRenderingIds: ["rule:rival"] },
    });
    const interpretation = interpretQ2Verdict(ungrounded, allVisible, resolveCitation);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(interpretation.citation?.citedBibleRuleId).toBeNull();
    expect(
      interpretation.issues.some((issue) =>
        /must cite the applicable bible rule at the position/u.test(issue.message),
      ),
    ).toBe(true);
  });

  it("PROOF failure-cites-bible-rule-and-history: a FAIL citing NO violated history is invalid", () => {
    const ungrounded = failVerdict({ evidenceIds: ["hist:future"] });
    const interpretation = interpretQ2Verdict(ungrounded, allVisible, resolveCitation);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(interpretation.citation?.citedHistoryId).toBeNull();
    expect(
      interpretation.issues.some((issue) =>
        /must cite the target history it violated at the position/u.test(issue.message),
      ),
    ).toBe(true);
  });

  it("a FAIL grounded in neither is invalid on both counts", () => {
    const ungrounded = failVerdict({
      basis: { kind: "wiki-first", bibleRenderingIds: ["rule:rival"] },
      evidenceIds: ["hist:future"],
    });
    const interpretation = interpretQ2Verdict(ungrounded, allVisible, resolveCitation);
    expect(interpretation.disposition).toBe("invalid");
    expect(interpretation.citation).toStrictEqual({
      citedBibleRuleId: null,
      citedHistoryId: null,
    });
  });
});

// ── Clause 3: decode-derived position; reviewable slices ─────────────────────
describe("Clause 3 — position is decode-derived; first appearances, shifts, and samples are reviewable", () => {
  it("PROOF position-decode-derived: applicable rules and history are computed FROM the position", () => {
    // The rival counterpart rule and the future line are excluded purely by the
    // decode-derived counterpart/route/play — not by anything the model said.
    expect(applicableBibleRules(baseInput).map((rule) => rule.ruleId)).toStrictEqual([
      "rule:base",
      "rule:cp",
    ]);
    expect(historyAtPosition(baseInput).map((line) => line.historyId)).toStrictEqual([
      "hist:base",
      "hist:cp",
    ]);
  });

  it("excludes sibling-route bible rules and accepted history", () => {
    const offRoute = {
      ...baseInput,
      bibleRules: [
        ...baseInput.bibleRules,
        { ...baseInput.bibleRules[1]!, ruleId: "rule:alt", routeId: "route:alt" },
      ],
      acceptedHistory: [
        ...baseInput.acceptedHistory,
        { ...baseInput.acceptedHistory[0]!, historyId: "hist:alt", routeId: "route:alt" },
      ],
    };
    expect(applicableBibleRules(offRoute).some((rule) => rule.ruleId === "rule:alt")).toBe(false);
    expect(historyAtPosition(offRoute).some((line) => line.historyId === "hist:alt")).toBe(false);
    expect(
      interpretQ2Verdict(
        failVerdict({
          basis: { kind: "wiki-first", bibleRenderingIds: ["rule:alt"] },
          evidenceIds: ["hist:alt"],
        }),
        allVisible,
        positionGroundedCitationResolver(offRoute),
      ).disposition,
    ).toBe("invalid");
  });

  it("PROOF position-decode-derived: a non-decode position is refused structurally and at the gate", () => {
    expect(() =>
      parseQ2ReviewInput({
        ...baseInput,
        position: { ...baseInput.position, derivation: "model" },
      }),
    ).toThrow();
    const forged = {
      ...baseInput,
      position: { ...baseInput.position, derivation: "model" as unknown as "decode" },
    } as Q2ReviewInput;
    expect(() => assertPositionDecodeDerived(forged)).toThrow(Q2PositionError);
  });

  it("a first appearance, a register shift, and a stratified sample all build a spec and review", async () => {
    for (const sampleKind of ["first-appearance", "register-shift", "stratified-sample"] as const) {
      const input: Q2ReviewInput = { ...baseInput, sampleKind };
      const spec = buildQ2CallSpec(input, refs);
      expect(spec.roleId).toBe("Q2");
      const outcome = await runQ2Review(input, refs, {
        dispatch: recordedDispatch(passVerdict()),
        resolveEvidence: allVisible,
      });
      expect(outcome.outcome).toBe("reviewed");
      expect(outcome.canFinalize).toBe(true);
    }
  });
});

// ── Clause 4: strict verdict + visible evidence + CANNOT_ASSESS never passes ──
describe("Clause 4 — strict verdict, visible evidence, CANNOT_ASSESS never passes", () => {
  const resolveCitation = positionGroundedCitationResolver(baseInput);

  it("a FAIL missing its repair constraint is not a valid verdict", () => {
    expect(() =>
      interpretQ2Verdict(failVerdict({ repairConstraint: null }), allVisible, resolveCitation),
    ).toThrow();
  });

  it("an unresolvable citation invalidates the verdict", () => {
    const missing: EvidenceResolver = () => ({ resolved: false, visible: false });
    const interpretation = interpretQ2Verdict(passVerdict(), missing, resolveCitation);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(interpretation.issues.some((issue) => /does not resolve/u.test(issue.message))).toBe(
      true,
    );
  });

  it("a clean PASS with visible evidence finalizes", () => {
    const interpretation = interpretQ2Verdict(passVerdict(), allVisible, resolveCitation);
    expect(interpretation.disposition).toBe("finalize");
    expect(canFinalize(interpretation)).toBe(true);
  });

  it("a valid CANNOT_ASSESS escalates and never finalizes", () => {
    const interpretation = interpretQ2Verdict(cannotAssessVerdict(), allVisible, resolveCitation);
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
          category: "voice",
          span: null,
          evidenceIds: [],
          repairConstraint: null,
          evidenceRequest: null,
        },
      ],
    };
    const issues = specialistFor("Q2").validate(silentPass);
    expect(issues.some((issue) => /never passes/u.test(issue.message))).toBe(true);
  });

  it("only a PASS disposition ever finalizes", () => {
    for (const raw of [passVerdict(), failVerdict(), cannotAssessVerdict()]) {
      const interpretation = interpretQ2Verdict(raw, allVisible, resolveCitation);
      if (canFinalize(interpretation)) expect(interpretation.verdict.verdict).toBe("PASS");
    }
  });
});

// ── Clause 5: ZDR + certified profile + route-bound in EVERY mode ────────────
describe("Clause 5 — ZDR dispatch on the certified reviewer profile, route-bound in every mode", () => {
  it("routes review to the certified deepseek-v4-flash reviewer profile with no provider pin", () => {
    const spec = buildQ2CallSpec(baseInput, refs);
    expect(spec.purpose).toBe("review");
    expect(spec.roleId).toBe("Q2");
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

  it("re-proves the certified route at the public entry even in test-dev", () => {
    const spec = buildQ2CallSpec(baseInput, { ...refs, runMode: "test-dev" });
    expect(spec.runMode).toBe("test-dev");
    // A run mode is not an escape hatch: the assertion fires in test-dev too.
    expect(() => assertCertifiedReviewerRoute(spec)).not.toThrow();
    const drifted = { ...spec, requestedModel: "openai/gpt-uncertified" } as CallSpec;
    expect(() => assertCertifiedReviewerRoute(drifted)).toThrow(Q2RouteError);
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
    const outcome = await runQ2Review(baseInput, refs, {
      dispatch: failure,
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("no-verdict");
    expect(outcome.canFinalize).toBe(false);
  });

  it("a recorded PASS dispatch finalizes deterministically", async () => {
    const dispatch = vi.fn(recordedDispatch(passVerdict()));
    const outcome = await runQ2Review(baseInput, refs, { dispatch, resolveEvidence: allVisible });
    expect(outcome.outcome).toBe("reviewed");
    expect(outcome.canFinalize).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
