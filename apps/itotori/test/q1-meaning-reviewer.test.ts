// Meaning Reviewer proofs — every clause fails if its guarantee is removed.
//
// Clause 1: the reviewer is BLINDED to author identity — an author key at any
//           depth is rejected, and none reaches the assembled prompt.
// Clause 2: the rubric is MEANING ONLY — the tool grant excludes every
//           screen/egress surface, and a FAIL outside the meaning categories is
//           an invalid verdict that cannot finalize.
// Clause 3: the verdict is strict PASS/FAIL/CANNOT_ASSESS carrying severity,
//           exact span, category, VISIBLE evidence, and a repair constraint; a
//           malformed verdict or an unresolvable citation cannot finalize.
// Clause 4: a CANNOT_ASSESS can NEVER pass — it routes to escalation, the
//           shared reviewer validator rejects a silent pass, and the ONLY
//           disposition that finalizes is a clean PASS.
// Clause 5: the back-translation is a SIGNAL, never a verdict — it is a
//           labelled field that cannot flip the outcome.
// Clause 6: the call routes through the ZDR boundary on the certified reviewer
//           profile, proven offline via a recorded dispatch result.

import { describe, expect, it } from "vitest";

import {
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
} from "../src/contracts/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  Q1BlindingError,
  Q1_MEANING_CATEGORIES,
  assertMeaningOnlyToolGrant,
  buildQ1CallSpec,
  canFinalize,
  interpretQ1Verdict,
  parseQ1ReviewInput,
  q1MeaningToolGrant,
  q1SystemPrompt,
  q1UserPrompt,
  runQ1Review,
  type EvidenceResolver,
  type Q1DispatchRefs,
  type Q1ReviewInput,
} from "../src/roles/q1/index.js";

const SNAP = `sha256:${"a".repeat(64)}` as const;
const HASH = `sha256:${"b".repeat(64)}` as const;

const baseInput: Q1ReviewInput = {
  unitId: "unit:1",
  contextSnapshotId: SNAP,
  localizationSnapshotId: SNAP,
  targetLanguage: "en-US",
  reviewScope: { kind: "global" },
  sourceFacts: [
    {
      factId: "fact:1",
      field: "text",
      text: "彼は駅で待っていた。",
      evidence: {
        evidenceHash: HASH,
        snapshotId: SNAP,
        subject: { kind: "unit", id: "unit:1" },
        playOrderIndex: 1,
      },
    },
  ],
  candidateTarget: "He was waiting at the station.",
  bibleRenderingIds: ["rendering:1"],
  localizedBible: [
    { renderingId: "rendering:1", text: "Use Station for 駅 in this localization." },
  ],
  neighbors: [{ surface: "accepted-target", unitId: "unit:0", text: "Morning came." }],
  backTranslationSignal: null,
};

const allVisible: EvidenceResolver = () => ({ resolved: true, visible: true });

function passVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:1",
    localizationSnapshotId: SNAP,
    roleId: "Q1",
    rubric: "meaning",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["fact:1"],
    repairConstraint: null,
    ...overrides,
  };
}

function failVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:2",
    localizationSnapshotId: SNAP,
    roleId: "Q1",
    rubric: "meaning",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "station" },
    category: "mistranslation",
    evidenceIds: ["fact:1"],
    repairConstraint: "Render 駅 as the correct referent.",
    ...overrides,
  };
}

function cannotAssessVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:3",
    localizationSnapshotId: SNAP,
    roleId: "Q1",
    rubric: "meaning",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["Need the source referent for 彼."],
    ...overrides,
  };
}

const refs: Q1DispatchRefs = {
  parentEventId: HASH,
  contextSnapshotId: HASH,
  localizationSnapshotId: SNAP,
  sealPayload: (plaintext): EncryptedPayloadRef => ({
    storageRef: `encrypted:q1:${plaintext.length}`,
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

// ── Clause 1: blinded to author identity ─────────────────────────────────────
describe("Clause 1 — blinded to author identity", () => {
  it("rejects a nested author-identity key", () => {
    const leaky = {
      ...baseInput,
      sourceFacts: [{ factId: "fact:1", field: "text", text: "x", author: "translator-7" }],
    };
    expect(() => parseQ1ReviewInput(leaky)).toThrow(Q1BlindingError);
  });

  it("rejects a top-level model/provider identity key", () => {
    expect(() => parseQ1ReviewInput({ ...baseInput, modelId: "deepseek" })).toThrow(
      Q1BlindingError,
    );
    expect(() => parseQ1ReviewInput({ ...baseInput, provider: "fireworks" })).toThrow(
      Q1BlindingError,
    );
  });

  it("assembles a prompt with no author identity", () => {
    const user = q1UserPrompt(baseInput).toLowerCase();
    for (const key of ["author", "translator", "model", "provider", "drafter"]) {
      expect(user).not.toMatch(new RegExp(`\\b${key}\\b`, "u"));
    }
  });
});

// ── Clause 2: meaning-only rubric ────────────────────────────────────────────
describe("Clause 2 — meaning only", () => {
  it("grants no screen or egress tool", () => {
    expect(() => assertMeaningOnlyToolGrant()).not.toThrow();
    const grant = q1MeaningToolGrant();
    expect(grant).not.toContain("render_and_ocr");
    expect(grant).not.toContain("web_search");
    expect(grant).not.toContain("back_translate");
    expect(grant).toContain("decode_get_neighbors");
    expect(grant).toContain("glossary_lookup");
  });

  it("states meaning-only in the system contract", () => {
    const system = q1SystemPrompt().toLowerCase();
    expect(system).toContain("meaning");
    expect(system).toContain("render");
  });

  it("rejects a FAIL whose category is outside meaning (an engine/render fault)", () => {
    const onscreen = failVerdict({ category: "onscreen-language" });
    const interpretation = interpretQ1Verdict(onscreen, allVisible);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(Q1_MEANING_CATEGORIES).not.toContain("onscreen-language");
  });
});

// ── Clause 3: strict verdict shape + visible evidence ────────────────────────
describe("Clause 3 — strict verdict shape and visible evidence", () => {
  it("a FAIL missing its repair constraint is not a valid verdict", () => {
    expect(() => interpretQ1Verdict(failVerdict({ repairConstraint: null }), allVisible)).toThrow();
  });

  it("a FAIL missing its span is not a valid verdict", () => {
    expect(() => interpretQ1Verdict(failVerdict({ span: null }), allVisible)).toThrow();
  });

  it("an unresolvable citation invalidates the verdict", () => {
    const missing: EvidenceResolver = () => ({ resolved: false, visible: false });
    const interpretation = interpretQ1Verdict(passVerdict(), missing);
    expect(interpretation.disposition).toBe("invalid");
    expect(canFinalize(interpretation)).toBe(false);
    expect(interpretation.issues.some((issue) => /does not resolve/u.test(issue.message))).toBe(
      true,
    );
  });

  it("an invisible citation invalidates the verdict", () => {
    const hidden: EvidenceResolver = () => ({ resolved: true, visible: false });
    const interpretation = interpretQ1Verdict(passVerdict(), hidden);
    expect(interpretation.disposition).toBe("invalid");
    expect(interpretation.issues.some((issue) => /not visible/u.test(issue.message))).toBe(true);
  });

  it("a clean PASS with visible evidence finalizes", () => {
    const interpretation = interpretQ1Verdict(passVerdict(), allVisible);
    expect(interpretation.disposition).toBe("finalize");
    expect(canFinalize(interpretation)).toBe(true);
  });
});

// ── Clause 4: CANNOT_ASSESS can never pass ───────────────────────────────────
describe("Clause 4 — CANNOT_ASSESS never passes", () => {
  it("a valid CANNOT_ASSESS escalates and never finalizes", () => {
    const interpretation = interpretQ1Verdict(cannotAssessVerdict(), allVisible);
    expect(interpretation.disposition).toBe("escalate");
    expect(canFinalize(interpretation)).toBe(false);
  });

  it("the shared reviewer validator rejects a CANNOT_ASSESS that requests no evidence", () => {
    // A CANNOT_ASSESS projection that tries to pass silently (no evidence
    // request) is flagged by the reviewer-shape validator this module builds on.
    const silentPass = {
      snapshotId: SNAP,
      verdicts: [
        {
          unitId: "unit:1",
          verdict: "CANNOT_ASSESS",
          severity: "none",
          category: "meaning",
          span: null,
          evidenceIds: [],
          repairConstraint: null,
          evidenceRequest: null,
        },
      ],
    };
    const issues = specialistFor("Q1").validate(silentPass);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => /never passes/u.test(issue.message))).toBe(true);
  });

  it("only a PASS disposition ever finalizes", () => {
    const verdicts = [passVerdict(), failVerdict(), cannotAssessVerdict()];
    for (const raw of verdicts) {
      const interpretation = interpretQ1Verdict(raw, allVisible);
      if (canFinalize(interpretation)) {
        expect(interpretation.verdict.verdict).toBe("PASS");
      }
    }
  });
});

// ── Clause 5: back-translation is a signal, never a verdict ──────────────────
describe("Clause 5 — back-translation is a signal", () => {
  it("the signal cannot flip the outcome", async () => {
    const withoutSignal = await runQ1Review(baseInput, refs, {
      dispatch: recordedDispatch(passVerdict()),
      resolveEvidence: allVisible,
    });
    const withContradictorySignal = await runQ1Review(
      {
        ...baseInput,
        backTranslationSignal: {
          kind: "signal",
          text: "He was NOT at the station.",
          note: "tripwire divergence",
        },
      },
      refs,
      { dispatch: recordedDispatch(passVerdict()), resolveEvidence: allVisible },
    );
    expect(withoutSignal.outcome).toBe("reviewed");
    expect(withContradictorySignal.outcome).toBe("reviewed");
    if (withoutSignal.outcome === "reviewed" && withContradictorySignal.outcome === "reviewed") {
      expect(withContradictorySignal.interpretation.disposition).toBe(
        withoutSignal.interpretation.disposition,
      );
      expect(withContradictorySignal.canFinalize).toBe(withoutSignal.canFinalize);
    }
  });

  it("labels the signal as interpret-never-a-verdict in the prompt", () => {
    const user = q1UserPrompt({
      ...baseInput,
      backTranslationSignal: { kind: "signal", text: "bt", note: "n" },
    });
    expect(user).toContain("BACK-TRANSLATION SIGNAL (interpret, never a verdict)");
  });
});

// ── Clause 6: ZDR boundary + certified profile + recorded path ───────────────
describe("Clause 6 — ZDR dispatch on the certified reviewer profile", () => {
  it("routes review to the certified deepseek-v4-flash reviewer profile with no provider pin", () => {
    const spec = buildQ1CallSpec(baseInput, refs);
    expect(spec.purpose).toBe("review");
    expect(spec.roleId).toBe("Q1");
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
    const outcome = await runQ1Review(baseInput, refs, {
      dispatch: failure,
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("no-verdict");
    expect(outcome.canFinalize).toBe(false);
  });

  it("a recorded PASS dispatch finalizes deterministically", async () => {
    const outcome = await runQ1Review(baseInput, refs, {
      dispatch: recordedDispatch(passVerdict()),
      resolveEvidence: allVisible,
    });
    expect(outcome.outcome).toBe("reviewed");
    expect(outcome.canFinalize).toBe(true);
  });
});
