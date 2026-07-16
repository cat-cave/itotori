// Adjudicator proofs — every clause fails if its guarantee is removed.
//
// 1. Sees both contested verdicts + real cited evidence (blinded).
// 2. Typed binding verdict OR typed human-escalation artifact.
// 3. Citations resolve; uncertain paths escalate (provisional).
// 4. Bounded trigger: non-subjective / low-impact never fire.
// 5. A/B + B/A run; (dis)agreement + winning side recorded (self-bias).
// 6. ZDR sole boundary; certified deepseek-v4-flash judge; every mode.

import { describe, expect, it, vi } from "vitest";

import {
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
} from "../src/contracts/index.js";
import {
  Q6BlindingError,
  Q6HumanEscalationSchema,
  Q6IneligibleContestError,
  Q6RouteError,
  assertAdjudicationOnlyToolGrant,
  assertCertifiedJudgeRoute,
  assertContestEligible,
  buildQ6CallSpec,
  buildQ6OrderCallSpecs,
  canFinalize,
  contestEligible,
  foldQ6OrderJudgements,
  interpretQ6OrderVerdict,
  parseQ6ReviewInput,
  q6AdjudicationToolGrant,
  q6SystemPrompt,
  q6UserPrompt,
  runQ6Adjudication,
  type EvidenceResolver,
  type Q6DispatchRefs,
  type Q6ReviewInput,
} from "../src/roles/q6/index.js";

const SNAP = `sha256:${"a".repeat(64)}` as const;
const HASH = `sha256:${"b".repeat(64)}` as const;

const baseInput: Q6ReviewInput = {
  unitId: "unit:1",
  localizationSnapshotId: SNAP,
  bibleRenderingIds: ["rendering:1"],
  trigger: { subjectiveConflict: true, impact: "high", factsSettled: true },
  positions: [
    {
      label: "A",
      claimSummary: "Keep the warmer register; it matches the route tone.",
      verdict: "PASS",
      severity: "none",
      category: null,
      span: null,
      evidence: [{ evidenceId: "ev:a1", text: "Prior accepted line uses the same warmth." }],
      repairConstraint: null,
    },
    {
      label: "B",
      claimSummary: "Cool the register; the speaker is restrained here.",
      verdict: "FAIL",
      severity: "major",
      category: "character-voice",
      span: { spanId: "span:1", surface: "target", text: "hey there" },
      evidence: [{ evidenceId: "ev:b1", text: "Voice bible marks speaker as reserved." }],
      repairConstraint: "Prefer a restrained greeting on this beat.",
    },
  ],
};

const allVisible: EvidenceResolver = (id) =>
  id === "ev:a1" || id === "ev:b1"
    ? { resolved: true, visible: true }
    : { resolved: false, visible: false };

function sideVerdict(
  side: "A" | "B",
  kind: "PASS" | "FAIL",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const evidenceId = side === "A" ? "ev:a1" : "ev:b1";
  const base = {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: `review:${kind}-${side}`,
    localizationSnapshotId: SNAP,
    roleId: "Q6",
    rubric: "adjudication",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    evidenceIds: [evidenceId],
  };
  if (kind === "PASS") {
    return {
      ...base,
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      repairConstraint: null,
      ...overrides,
    };
  }
  return {
    ...base,
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "hey there" },
    category: "subjective-conflict",
    repairConstraint: "Bind the restrained register on this beat.",
    ...overrides,
  };
}

function cannotAssess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:cannot",
    localizationSnapshotId: SNAP,
    roleId: "Q6",
    rubric: "adjudication",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["Need a third accepted line for this speaker."],
    ...overrides,
  };
}

const refs: Q6DispatchRefs = {
  parentEventId: HASH,
  contextSnapshotId: HASH,
  localizationSnapshotId: SNAP,
  sealPayload: (plaintext): EncryptedPayloadRef => ({
    storageRef: `encrypted:q6:${plaintext.length}`,
    contentHash: HASH,
    encryption: "operator-managed",
  }),
};

/** Synthetic in-memory transport: queue values for A-then-B then B-then-A. */
function sequentialDispatch(values: readonly Record<string, unknown>[]) {
  let index = 0;
  const specs: CallSpec[] = [];
  return {
    dispatch: async (spec: CallSpec): Promise<CallResult> => {
      specs.push(spec);
      const value = values[index] ?? values[values.length - 1]!;
      index += 1;
      return {
        schemaVersion: "itotori.call-result.v2",
        memoKey: HASH,
        requested: { model: "deepseek/deepseek-v4-flash" },
        memoHit: true,
        status: "success",
        value,
        responseEventId: HASH,
        served: {
          status: "confirmed",
          model: "deepseek/deepseek-v4-flash",
          provider: "provider:recorded",
        },
        generationId: "generation:1",
        verification: "verified",
        usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 5, cachedTokens: 0 },
        billing: { status: "confirmed", costUsd: "0.001" },
        events: [{ kind: "run-started", iteration: 0 }],
      } as unknown as CallResult;
    },
    specs: () => specs,
    calls: () => specs.length,
  };
}

function failureDispatch(): (spec: CallSpec) => Promise<CallResult> {
  return async () =>
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
}

async function run(values: readonly Record<string, unknown>[], input: Q6ReviewInput = baseInput) {
  const transport = sequentialDispatch(values);
  const outcome = await runQ6Adjudication(input, refs, {
    dispatch: transport.dispatch,
    resolveEvidence: allVisible,
  });
  return { outcome, transport };
}

// ── Clause 1: both verdicts + real evidence; blinded ─────────────────────────
describe("Clause 1 — sees both contested verdicts + real evidence; blinded", () => {
  it("prompt carries both claims and their real evidence texts", () => {
    const user = q6UserPrompt(baseInput, "A-then-B");
    expect(user).toContain("Keep the warmer register");
    expect(user).toContain("Cool the register");
    expect(user).toContain("ev:a1");
    expect(user).toContain("Prior accepted line uses the same warmth.");
    expect(user).toContain("ev:b1");
    expect(user).toContain("Voice bible marks speaker as reserved.");
    expect(user).toContain("asserted-verdict: PASS");
    expect(user).toContain("asserted-verdict: FAIL");
  });

  it("rejects identity keys and labels positions by A/B order only", () => {
    expect(() =>
      parseQ6ReviewInput({
        ...baseInput,
        positions: [{ ...baseInput.positions[0]!, model: "x" }, baseInput.positions[1]!],
      }),
    ).toThrow(Q6BlindingError);
    expect(() => parseQ6ReviewInput({ ...baseInput, provider: "fireworks" })).toThrow(
      Q6BlindingError,
    );
    const ab = q6UserPrompt(baseInput, "A-then-B").toLowerCase();
    const ba = q6UserPrompt(baseInput, "B-then-A").toLowerCase();
    expect(ab).toContain("first=a");
    expect(ba).toContain("first=b");
    for (const key of ["author", "translator", "openai", "fireworks"]) {
      expect(ab).not.toMatch(new RegExp(`\\b${key}\\b`, "u"));
    }
  });
});

// ── Clause 2: typed binding or typed human-escalation ────────────────────────
describe("Clause 2 — typed binding verdict or typed human-escalation", () => {
  it("happy path: dual-order agreement emits schema-valid binding PASS", async () => {
    const { outcome } = await run([sideVerdict("A", "PASS"), sideVerdict("A", "PASS")]);
    expect(outcome.outcome).toBe("adjudicated");
    if (outcome.outcome !== "adjudicated") return;
    expect(outcome.interpretation.disposition).toBe("finalize");
    expect(outcome.interpretation.verdict?.verdict).toBe("PASS");
    expect(outcome.interpretation.verdict?.roleId).toBe("Q6");
    expect(outcome.interpretation.verdict?.rubric).toBe("adjudication");
    expect(outcome.interpretation.escalation).toBeNull();
    expect(canFinalize(outcome.interpretation)).toBe(true);
  });

  it("order-flip and CANNOT_ASSESS emit typed escalation, never finalize", async () => {
    const flip = await run([sideVerdict("A", "PASS"), sideVerdict("B", "PASS")]);
    expect(flip.outcome.outcome).toBe("adjudicated");
    if (flip.outcome.outcome === "adjudicated") {
      expect(flip.outcome.interpretation.disposition).toBe("escalate");
      expect(flip.outcome.interpretation.verdict).toBeNull();
      const parsed = Q6HumanEscalationSchema.safeParse(flip.outcome.interpretation.escalation);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.reason).toBe("order-flip");
      expect(canFinalize(flip.outcome.interpretation)).toBe(false);
    }

    const cannot = await run([cannotAssess(), cannotAssess()]);
    expect(cannot.outcome.outcome).toBe("adjudicated");
    if (cannot.outcome.outcome === "adjudicated") {
      expect(cannot.outcome.interpretation.escalation?.reason).toBe("cannot-assess");
      expect(canFinalize(cannot.outcome.interpretation)).toBe(false);
    }
  });
});

// ── Clause 3: traceable citations; uncertain paths escalate ──────────────────
describe("Clause 3 — citations resolve; uncertain paths escalate", () => {
  it("unresolvable citation invalidates; exclusive side evidence can bind", async () => {
    const forged = interpretQ6OrderVerdict(
      sideVerdict("A", "PASS", { evidenceIds: ["ev:forged"] }),
      "A-then-B",
      baseInput,
      allVisible,
    );
    expect(forged.valid).toBe(false);
    expect(forged.issues.some((i) => /does not resolve/u.test(i.message))).toBe(true);

    const { outcome } = await run([sideVerdict("B", "FAIL"), sideVerdict("B", "FAIL")]);
    expect(outcome.outcome).toBe("adjudicated");
    if (outcome.outcome !== "adjudicated") return;
    expect(outcome.interpretation.disposition).toBe("repair");
    expect(outcome.interpretation.verdict?.evidenceIds).toEqual(["ev:b1"]);
    expect(outcome.interpretation.orderDebias.bindingSide).toBe("B");
    expect(canFinalize(outcome.interpretation)).toBe(false);
  });

  it("mixed-side citations cannot measure a winner and escalate", () => {
    const mixed = sideVerdict("A", "PASS", { evidenceIds: ["ev:a1", "ev:b1"] });
    const folded = foldQ6OrderJudgements(baseInput, [
      interpretQ6OrderVerdict(mixed, "A-then-B", baseInput, allVisible),
      interpretQ6OrderVerdict(mixed, "B-then-A", baseInput, allVisible),
    ]);
    expect(folded.disposition).toBe("invalid");
    expect(folded.escalation?.reason).toBe("mixed-side-citations");
    expect(canFinalize(folded)).toBe(false);
  });
});

// ── Clause 4: bounded trigger ────────────────────────────────────────────────
describe("Clause 4 — bounded trigger; non-subjective / low-impact never fire", () => {
  it("non-subjective and low-impact: zero model calls", async () => {
    for (const trigger of [
      { subjectiveConflict: false, impact: "high" as const, factsSettled: true },
      { subjectiveConflict: true, impact: "low" as const, factsSettled: true },
    ]) {
      const { outcome, transport } = await run(
        [sideVerdict("A", "PASS"), sideVerdict("A", "PASS")],
        { ...baseInput, trigger },
      );
      expect(outcome.outcome).toBe("ineligible");
      expect(outcome.canFinalize).toBe(false);
      expect(transport.calls()).toBe(0);
      expect(contestEligible({ ...baseInput, trigger })).toBe(false);
    }
  });

  it("facts-not-settled refuses CallSpec assembly", () => {
    const premature = {
      ...baseInput,
      trigger: { subjectiveConflict: true, impact: "high" as const, factsSettled: false },
    };
    expect(() => assertContestEligible(premature)).toThrow(Q6IneligibleContestError);
    expect(() => buildQ6CallSpec(premature, refs, "A-then-B")).toThrow(Q6IneligibleContestError);
  });
});

// ── Clause 5: order-debias runs; agreement + side recorded ───────────────────
describe("Clause 5 — order-debiasing runs; agreement and winning side recorded", () => {
  it("happy path: both orders dispatch; agreement + binding side recorded", async () => {
    const { outcome, transport } = await run([sideVerdict("A", "PASS"), sideVerdict("A", "PASS")]);
    expect(transport.calls()).toBe(2);
    const userEventIds = transport.specs().map((spec) => {
      const user = spec.messages.find((m) => m.kind === "text" && m.role === "user");
      return user && user.kind === "text" ? user.eventId : null;
    });
    expect(userEventIds[0]).not.toEqual(userEventIds[1]);
    expect(q6UserPrompt(baseInput, "A-then-B")).not.toEqual(q6UserPrompt(baseInput, "B-then-A"));
    if (outcome.outcome !== "adjudicated") throw new Error("expected adjudicated");
    const debias = outcome.interpretation.orderDebias;
    expect(debias).toMatchObject({
      abWinner: "A",
      baWinner: "A",
      ordersAgree: true,
      bindingSide: "A",
      abVerdict: "PASS",
      baVerdict: "PASS",
    });
  });

  it("PROOF order-flip-detection: disagreement recorded as a self-bias signal", async () => {
    const { outcome, transport } = await run([sideVerdict("A", "FAIL"), sideVerdict("B", "FAIL")]);
    expect(transport.calls()).toBe(2);
    if (outcome.outcome !== "adjudicated") throw new Error("expected adjudicated");
    const debias = outcome.interpretation.orderDebias;
    expect(debias.abWinner).toBe("A");
    expect(debias.baWinner).toBe("B");
    expect(debias.ordersAgree).toBe(false);
    expect(debias.bindingSide).toBeNull();
    expect(outcome.interpretation.escalation?.reason).toBe("order-flip");
    expect(outcome.interpretation.escalation?.orderDebias.abWinner).toBe("A");
    expect(outcome.interpretation.escalation?.orderDebias.baWinner).toBe("B");
  });

  it("order budget is exactly two presentations", () => {
    const ordered = buildQ6OrderCallSpecs(baseInput, refs);
    expect(ordered.map((item) => item.order)).toEqual(["A-then-B", "B-then-A"]);
    expect(ordered).toHaveLength(2);
  });
});

// ── Clause 6: ZDR + certified judge route in every mode ──────────────────────
describe("Clause 6 — ZDR dispatch; certified deepseek-v4-flash judge; no provider pin", () => {
  it("routes to certified judge profile with no provider pin, every mode", () => {
    const production = buildQ6CallSpec(baseInput, refs, "A-then-B");
    expect(production).toMatchObject({
      purpose: "judge",
      roleId: "Q6",
      modelProfile: "judge",
      requestedModel: "deepseek/deepseek-v4-flash",
      providerPolicy: {
        allowFallbacks: true,
        zdr: true,
        dataCollection: "deny",
        requireParameters: true,
      },
    });
    expect(production.providerPolicy).not.toHaveProperty("only");
    expect(production.providerPolicy).not.toHaveProperty("order");
    expect(production.output.name).toBe("review-verdict");
    expect(production.tools).toHaveLength(0);
    expect(() => assertCertifiedJudgeRoute(production)).not.toThrow();

    const testDev = buildQ6CallSpec(baseInput, { ...refs, runMode: "test-dev" }, "B-then-A");
    expect(testDev.runMode).toBe("test-dev");
    expect(testDev.requestedModel).toBe("deepseek/deepseek-v4-flash");
    expect(testDev.modelProfileVersion).toBe(production.modelProfileVersion);
    expect(() => assertCertifiedJudgeRoute(testDev)).not.toThrow();
    expect(() =>
      assertCertifiedJudgeRoute({ ...testDev, requestedModel: "some-other/model" } as CallSpec),
    ).toThrow(Q6RouteError);

    expect(() => assertAdjudicationOnlyToolGrant()).not.toThrow();
    const grant = q6AdjudicationToolGrant();
    expect(grant).not.toContain("render_and_ocr");
    expect(grant).not.toContain("web_search");
    expect(grant).not.toContain("back_translate");
    expect(q6SystemPrompt().toLowerCase()).toContain("subjective");
  });

  it("records served pair as output; dispatch failure never finalizes", async () => {
    const { outcome, transport } = await run([sideVerdict("A", "PASS"), sideVerdict("A", "PASS")]);
    if (outcome.outcome !== "adjudicated") throw new Error("expected adjudicated");
    expect(outcome.servedPairs).toHaveLength(2);
    for (const served of outcome.servedPairs) {
      expect(served).toMatchObject({
        status: "confirmed",
        model: "deepseek/deepseek-v4-flash",
        provider: "provider:recorded",
      });
    }
    for (const spec of transport.specs()) {
      expect(spec.providerPolicy).not.toHaveProperty("only");
    }

    const failed = await runQ6Adjudication(baseInput, refs, {
      dispatch: failureDispatch(),
      resolveEvidence: allVisible,
    });
    expect(failed.outcome).toBe("no-verdict");
    expect(failed.canFinalize).toBe(false);
    if (failed.outcome === "no-verdict") {
      expect(failed.escalation.reason).toBe("dispatch-failure");
    }

    const spy = vi.fn(
      sequentialDispatch([sideVerdict("B", "PASS"), sideVerdict("B", "PASS")]).dispatch,
    );
    await runQ6Adjudication(baseInput, refs, { dispatch: spy, resolveEvidence: allVisible });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
