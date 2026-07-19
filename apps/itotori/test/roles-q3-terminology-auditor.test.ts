// Terminology Auditor proofs — every clause fails if its guarantee is removed.
//
// Clause 1: the auditor runs ONLY AFTER the exact glossary/name gate. An exact
//           mismatch is a DETERMINISTIC defect owned by that gate, NEVER a Q3
//           verdict: the auditor refuses the unit before any model call.
// Clause 2: the rubric is TERMINOLOGY sense/register of APPROVED forms or a
//           genuinely new coinage — not exact matching. The tool grant excludes
//           every screen/egress surface, and a FAIL outside the terminology
//           categories is an invalid verdict that cannot finalize.
// Clause 3: the auditor may REFER a cited source candidate back to the ruling
//           lane, but a verdict CONTRADICTING an approved glossary form is
//           REJECTED — routed back, never approved, never overwritten.
// Clause 4: the verdict is strict PASS/FAIL/CANNOT_ASSESS with VISIBLE evidence;
//           a malformed verdict or an unresolvable citation cannot finalize; a
//           CANNOT_ASSESS can NEVER pass.
// Clause 5: the call routes through the ZDR boundary on the certified reviewer
//           profile with no provider pin, and the certified route is re-proven
//           at the public dispatch entry in EVERY mode — including test-dev.

import { describe, expect, it, vi } from "vitest";

import {
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
} from "../src/contracts/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  Q3PrematureAuditError,
  Q3RouteError,
  Q3_TERMINOLOGY_CATEGORIES,
  assertCertifiedReviewerRoute,
  assertExactGateCleared,
  assertTerminologyOnlyToolGrant,
  buildQ3CallSpec,
  canFinalize,
  interpretQ3Verdict,
  q3SystemPrompt,
  q3TerminologyToolGrant,
  runQ3Audit,
  type ContradictionResolver,
  type EvidenceResolver,
  type Q3DispatchRefs,
  type Q3ReviewInput,
} from "../src/roles/q3/index.js";

const SNAP = `sha256:${"a".repeat(64)}` as const;
const HASH = `sha256:${"b".repeat(64)}` as const;

const baseInput: Q3ReviewInput = {
  unitId: "unit:1",
  localizationSnapshotId: SNAP,
  candidateTarget: "The Demon Lord greeted the Hero.",
  exactGate: { gate: "glossary-exact", status: "cleared" },
  approvedTerms: [{ termId: "term:1", sourceForm: "魔王", approvedTargetForm: "Demon Lord" }],
  ambiguousCoinages: [],
  termRulingIds: ["ruling:1"],
  neighbors: [{ surface: "accepted-target", unitId: "unit:0", text: "Morning came." }],
};

const allVisible: EvidenceResolver = () => ({ resolved: true, visible: true });
const noContradiction: ContradictionResolver = () => ({
  contradictsApprovedForm: false,
  approvedTermId: null,
});

function passVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:1",
    localizationSnapshotId: SNAP,
    roleId: "Q3",
    rubric: "terminology",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["ruling:1"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["ruling:1"],
    repairConstraint: null,
    ...overrides,
  };
}

function failVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:2",
    localizationSnapshotId: SNAP,
    roleId: "Q3",
    rubric: "terminology",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["ruling:1"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "マナ" },
    category: "new-coinage",
    evidenceIds: ["ruling:1"],
    repairConstraint: "Refer this coinage to the ruling lane.",
    ...overrides,
  };
}

function cannotAssessVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:3",
    localizationSnapshotId: SNAP,
    roleId: "Q3",
    rubric: "terminology",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["ruling:1"] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["Need the ruling for マナ."],
    ...overrides,
  };
}

const refs: Q3DispatchRefs = {
  parentEventId: HASH,
  contextSnapshotId: HASH,
  localizationSnapshotId: SNAP,
  sealPayload: (plaintext): EncryptedPayloadRef => ({
    storageRef: `encrypted:q3:${plaintext.length}`,
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

// ── Clause 1: downstream of the exact gate; a mismatch is the gate's ─────────
describe("Clause 1 — runs only after the exact gate; a mismatch is deterministic, not Q3", () => {
  it("PROOF exact-mismatch-is-deterministic-not-Q3: a gate defect never becomes a verdict", async () => {
    const dispatch = vi.fn(recordedDispatch(passVerdict()));
    const outcome = await runQ3Audit(
      { ...baseInput, exactGate: { gate: "glossary-exact", status: "defect" } },
      refs,
      { dispatch, resolveEvidence: allVisible },
    );
    expect(outcome.outcome).toBe("gate-defect");
    expect(outcome.canFinalize).toBe(false);
    if (outcome.outcome === "gate-defect") expect(outcome.owningGate).toBe("glossary-exact");
    // The deterministic defect is the gate's: no model was ever called.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("an approved form absent from the candidate is an exact mismatch the gate owns", async () => {
    const dispatch = vi.fn(recordedDispatch(passVerdict()));
    const outcome = await runQ3Audit(
      { ...baseInput, candidateTarget: "The Dark King greeted the Hero." },
      refs,
      { dispatch, resolveEvidence: allVisible },
    );
    expect(outcome.outcome).toBe("gate-defect");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("no CallSpec can even be built for an uncleared exact gate", () => {
    expect(() =>
      buildQ3CallSpec(
        { ...baseInput, exactGate: { gate: "glossary-exact", status: "defect" } },
        refs,
      ),
    ).toThrow(Q3PrematureAuditError);
    expect(() => assertExactGateCleared(baseInput)).not.toThrow();
  });
});

// ── Clause 2: terminology sense/register, not exact matching ─────────────────
describe("Clause 2 — terminology sense/register of approved forms, not exact matching", () => {
  it("grants no screen or egress tool and keeps glossary lookup", () => {
    expect(() => assertTerminologyOnlyToolGrant()).not.toThrow();
    const grant = q3TerminologyToolGrant();
    expect(grant).not.toContain("render_and_ocr");
    expect(grant).not.toContain("web_search");
    expect(grant).not.toContain("back_translate");
    expect(grant).toContain("glossary_lookup");
  });

  it("states sense/register and rules out exact matching in the system contract", () => {
    const system = q3SystemPrompt().toLowerCase();
    expect(system).toContain("sense");
    expect(system).toContain("register");
    expect(system).toContain("exact");
  });

  it("rejects a FAIL whose category is outside terminology (a meaning finding)", () => {
    const meaning = failVerdict({ category: "mistranslation" });
    const interpretation = interpretQ3Verdict(meaning, baseInput, allVisible, noContradiction);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(Q3_TERMINOLOGY_CATEGORIES).toStrictEqual(["term-sense", "register", "new-coinage"]);
  });

  it("flags a cited register issue on an approved form and refers its input-derived source form", async () => {
    const outcome = await runQ3Audit(baseInput, refs, {
      dispatch: recordedDispatch(
        failVerdict({
          category: "register",
          span: { spanId: "s", surface: "target", text: "Demon Lord" },
        }),
      ),
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("reviewed");
    if (outcome.outcome !== "reviewed") return;
    expect(outcome.interpretation.disposition).toBe("refer");
    expect(outcome.interpretation.referral).toMatchObject({
      kind: "approved-form-context",
      termId: "term:1",
      sourceForm: "魔王",
      citedEvidenceIds: ["ruling:1"],
    });
  });

  it("refers an approved-form sense issue and a cited genuinely new source coinage", () => {
    const sense = interpretQ3Verdict(
      failVerdict({
        category: "term-sense",
        span: { spanId: "s", surface: "target", text: "Demon Lord" },
      }),
      baseInput,
      allVisible,
      noContradiction,
    );
    expect(sense.disposition).toBe("refer");
    expect(sense.referral?.sourceForm).toBe("魔王");
    const coinage = interpretQ3Verdict(
      failVerdict({ span: { spanId: "span:coinage", surface: "source", text: "マナ" } }),
      {
        ...baseInput,
        ambiguousCoinages: [
          { candidateId: "coinage:mana", sourceForm: "マナ", evidenceIds: ["ruling:1"] },
        ],
      },
      allVisible,
      noContradiction,
    );
    expect(coinage.disposition).toBe("refer");
    expect(coinage.referral).toMatchObject({
      kind: "ambiguous-source-coinage",
      candidateId: "coinage:mana",
      sourceForm: "マナ",
    });
    expect(coinage.referral?.citedEvidenceIds).toStrictEqual(["ruling:1"]);
    // The referral carries a source candidate only — never a target form.
    expect(coinage.referral).not.toHaveProperty("targetForm");
  });
});

// ── Clause 3: a contradictory target form is rejected ────────────────────────
describe("Clause 3 — a verdict contradicting an approved form is rejected, routed back", () => {
  it("PROOF contradictory-form-rejected: a new coinage over an approved form never approves", async () => {
    // The model flags "Demon Lord" — an already-approved glossary form — as a new
    // coinage. That contradicts the approved ruling; the default resolver catches
    // it against the input's approved terms and the verdict is rejected.
    const contradictory = failVerdict({
      span: { spanId: "span:c", surface: "target", text: "Demon Lord" },
    });
    const outcome = await runQ3Audit(baseInput, refs, {
      dispatch: recordedDispatch(contradictory),
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("reviewed");
    if (outcome.outcome !== "reviewed") return;
    expect(outcome.interpretation.disposition).toBe("reject-contradiction");
    expect(outcome.canFinalize).toBe(false); // never approved / overwritten
    expect(outcome.interpretation.referral).not.toBeNull(); // routed back to the ruling lane
    expect(
      outcome.interpretation.issues.some((issue) =>
        /contradicts an already-approved/u.test(issue.message),
      ),
    ).toBe(true);
  });

  it("an injected contradiction is rejected regardless of the verdict body", () => {
    const contradicts: ContradictionResolver = () => ({
      contradictsApprovedForm: true,
      approvedTermId: "term:1",
    });
    const interpretation = interpretQ3Verdict(failVerdict(), baseInput, allVisible, contradicts);
    expect(interpretation.disposition).toBe("reject-contradiction");
    expect(canFinalize(interpretation)).toBe(false);
  });

  it("a genuinely new coinage that collides with nothing approved is not a contradiction", () => {
    const interpretation = interpretQ3Verdict(
      failVerdict({ span: { spanId: "span:coinage", surface: "source", text: "マナ" } }),
      {
        ...baseInput,
        ambiguousCoinages: [
          { candidateId: "coinage:mana", sourceForm: "マナ", evidenceIds: ["ruling:1"] },
        ],
      },
      allVisible,
      noContradiction,
    );
    expect(interpretation.disposition).toBe("refer");
  });

  it("rejects a model-invented new coinage that was not a supplied source candidate", () => {
    const invented = interpretQ3Verdict(
      failVerdict({ span: { spanId: "span:invented", surface: "source", text: "幻晶" } }),
      baseInput,
      allVisible,
      noContradiction,
    );
    expect(invented.disposition).toBe("invalid");
    expect(canFinalize(invented)).toBe(false);
    expect(invented.referral).toBeNull();
  });
});

// ── Clause 4: strict verdict + visible evidence + CANNOT_ASSESS never passes ──
describe("Clause 4 — strict verdict, visible evidence, CANNOT_ASSESS never passes", () => {
  it("a FAIL missing its repair constraint is not a valid verdict", () => {
    expect(() =>
      interpretQ3Verdict(
        failVerdict({ repairConstraint: null }),
        baseInput,
        allVisible,
        noContradiction,
      ),
    ).toThrow();
  });

  it("an unresolvable citation invalidates the verdict", () => {
    const missing: EvidenceResolver = () => ({ resolved: false, visible: false });
    const interpretation = interpretQ3Verdict(passVerdict(), baseInput, missing, noContradiction);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(interpretation.issues.some((issue) => /does not resolve/u.test(issue.message))).toBe(
      true,
    );
  });

  it("a clean PASS with visible evidence finalizes", () => {
    const interpretation = interpretQ3Verdict(
      passVerdict(),
      baseInput,
      allVisible,
      noContradiction,
    );
    expect(interpretation.disposition).toBe("finalize");
    expect(canFinalize(interpretation)).toBe(true);
  });

  it("a valid CANNOT_ASSESS escalates and never finalizes", () => {
    const interpretation = interpretQ3Verdict(
      cannotAssessVerdict(),
      baseInput,
      allVisible,
      noContradiction,
    );
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
          category: "terminology",
          span: null,
          evidenceIds: [],
          repairConstraint: null,
          evidenceRequest: null,
        },
      ],
    };
    const issues = specialistFor("Q3").validate(silentPass);
    expect(issues.some((issue) => /never passes/u.test(issue.message))).toBe(true);
  });

  it("only a PASS disposition ever finalizes", () => {
    for (const raw of [passVerdict(), failVerdict(), cannotAssessVerdict()]) {
      const interpretation = interpretQ3Verdict(raw, baseInput, allVisible, noContradiction);
      if (canFinalize(interpretation)) expect(interpretation.verdict.verdict).toBe("PASS");
    }
  });
});

// ── Clause 5: ZDR + certified profile + route-bound in EVERY mode ────────────
describe("Clause 5 — ZDR dispatch on the certified reviewer profile, route-bound in every mode", () => {
  it("routes review to the certified deepseek-v4-flash reviewer profile with no provider pin", () => {
    const spec = buildQ3CallSpec(baseInput, refs);
    expect(spec.purpose).toBe("review");
    expect(spec.roleId).toBe("Q3");
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
    const spec = buildQ3CallSpec(baseInput, { ...refs, runMode: "test-dev" });
    expect(spec.runMode).toBe("test-dev");
    // A run mode is not an escape hatch: the assertion fires in test-dev too.
    expect(() => assertCertifiedReviewerRoute(spec)).not.toThrow();
    const drifted = { ...spec, requestedModel: "openai/gpt-uncertified" } as CallSpec;
    expect(() => assertCertifiedReviewerRoute(drifted)).toThrow(Q3RouteError);
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
    const outcome = await runQ3Audit(baseInput, refs, {
      dispatch: failure,
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("no-verdict");
    expect(outcome.canFinalize).toBe(false);
  });

  it("a recorded PASS dispatch finalizes deterministically", async () => {
    const outcome = await runQ3Audit(baseInput, refs, {
      dispatch: recordedDispatch(passVerdict()),
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("reviewed");
    expect(outcome.canFinalize).toBe(true);
  });
});
