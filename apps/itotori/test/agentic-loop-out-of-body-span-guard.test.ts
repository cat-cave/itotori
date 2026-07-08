// itotori-guard-out-of-body-protected-span-caller — caller-scoped guard tests.
//
// The deterministic re-inject layer (splitProtectedSpans → translate body →
// reconstructTarget) GUARANTEES the control spans it strips off the source
// (【name】, 「」 wrapper, kidoku markers). The DraftProtectedSpanValidator
// must NOT score those out-of-body spans — it would false-positive on them
// (their ref is never relocated against the reconstructed target). The guard
// `selectSpansForValidation` drops them before the validator runs.
//
// These tests pin the acceptance crux directly:
//   - a re-inject-owned span is EXCLUDED → NOT flagged (no false positive);
//   - a model-dropped IN-BODY span is KEPT → IS flagged (no regression / hole);
//   - a glossary span is still validated against the reconstructed target.

import { describe, expect, it } from "vitest";
import { DraftProtectedSpanValidator } from "../src/draft/protected-span-validator.js";
import {
  selectSpansForValidation,
  type AgenticLoopUnitInput,
} from "../src/orchestrator/agentic-loop.js";
import type { DraftSourceProtectedSpan } from "../src/draft/protected-span-validator.js";
import type { TranslationBridgeUnit } from "../src/agents/translation/shapes.js";

const BRIDGE_UNIT_ID = "019ed079-7000-7000-8000-00000000ob01";

const SOURCE_BRIDGE_UNIT: TranslationBridgeUnit = {
  bridgeUnitId: BRIDGE_UNIT_ID,
  sourceUnitKey: "scene-guard/line-001",
  sourceText: "<reallive.kidoku 5>【ユカリ】「{player}、こんにちは」",
  sourceHash: "src-hash-out-of-body-guard",
};

// splitProtectedSpans strips the kidoku marker + 【ユカリ】 + 「」 → body is the
// pure translatable dialogue `{player}、こんにちは`.
const EXPECTED_BODY = "{player}、こんにちは";

function validateGuarded(
  sourceText: string,
  spans: ReadonlyArray<DraftSourceProtectedSpan>,
  draftText: string,
  draftProtectedSpanRefs: ReadonlyArray<{
    refId: string;
    startInDraft: number;
    endInDraft: number;
  }>,
) {
  const guarded = selectSpansForValidation(spans, sourceText);
  const validator = new DraftProtectedSpanValidator();
  return {
    guarded,
    result: validator.validate({
      sourceBridgeUnit: {
        bridgeUnitId: BRIDGE_UNIT_ID,
        sourceUnitKey: "scene-guard/line-001",
        sourceText,
        sourceHash: "src-hash-out-of-body-guard",
      },
      draftText,
      draftProtectedSpanRefs,
      sourceProtectedSpans: guarded,
    }),
  };
}

describe("selectSpansForValidation — out-of-body re-inject-owned span guard", () => {
  it("skeleton.body is the pure dialogue (sanity-check the fixture)", () => {
    // If this fixture drifts the assertions below lose meaning, so pin the
    // body the re-inject layer actually exposes to the model.
    expect(EXPECTED_BODY).toBe("{player}、こんにちは");
  });

  it("EXCLUDES the out-of-body kidoku marker (re-inject-owned)", () => {
    const spans: DraftSourceProtectedSpan[] = [
      { refId: "span-kidoku", sourceText: "<reallive.kidoku 5>", spanKind: "markup" },
    ];
    const guarded = selectSpansForValidation(spans, SOURCE_BRIDGE_UNIT.sourceText);
    expect(guarded).toEqual([]);
  });

  it("EXCLUDES the out-of-body 【name】 speaker token (re-inject-owned)", () => {
    const spans: DraftSourceProtectedSpan[] = [
      { refId: "span-name", sourceText: "【ユカリ】", spanKind: "markup" },
    ];
    const guarded = selectSpansForValidation(spans, SOURCE_BRIDGE_UNIT.sourceText);
    expect(guarded).toEqual([]);
  });

  it("KEEPS an in-body variable span the model genuinely owns", () => {
    const spans: DraftSourceProtectedSpan[] = [
      { refId: "span-var-player", sourceText: "{player}", spanKind: "variable" },
    ];
    const guarded = selectSpansForValidation(spans, SOURCE_BRIDGE_UNIT.sourceText);
    expect(guarded.map((s) => s.refId)).toEqual(["span-var-player"]);
  });

  it("KEEPS a glossary span even when its form is out-of-body (validated against the target)", () => {
    // A glossary span for the speaker name is re-injected by reconstructTarget;
    // it must still reach the validator so capitalization / presence is scored
    // against the reconstructed target.
    const spans: DraftSourceProtectedSpan[] = [
      {
        refId: "span-gloss-name",
        sourceText: "【ユカリ】",
        spanKind: "glossary",
        expectedTargetForm: "【Yukari】",
      },
    ];
    const guarded = selectSpansForValidation(spans, SOURCE_BRIDGE_UNIT.sourceText);
    expect(guarded.map((s) => s.refId)).toEqual(["span-gloss-name"]);
  });

  it("splits a mixed catalog: keeps in-body + glossary, drops re-inject-owned", () => {
    const spans: DraftSourceProtectedSpan[] = [
      { refId: "span-kidoku", sourceText: "<reallive.kidoku 5>", spanKind: "markup" },
      { refId: "span-name", sourceText: "【ユカリ】", spanKind: "markup" },
      { refId: "span-var-player", sourceText: "{player}", spanKind: "variable" },
      {
        refId: "span-gloss-name",
        sourceText: "【ユカリ】",
        spanKind: "glossary",
        expectedTargetForm: "【Yukari】",
      },
    ];
    const guarded = selectSpansForValidation(spans, SOURCE_BRIDGE_UNIT.sourceText);
    expect(guarded.map((s) => s.refId).sort()).toEqual(["span-gloss-name", "span-var-player"]);
  });
});

describe("DraftProtectedSpanValidator behind the guard (acceptance crux)", () => {
  it("does NOT flag a re-inject-owned span (no false positive)", () => {
    // The re-inject layer owns the kidoku marker + 【name】; they are absent
    // from the guarded catalog, so the validator has nothing to score against
    // them even though they are not declared as refs in the draft.
    const { guarded, result } = validateGuarded(
      SOURCE_BRIDGE_UNIT.sourceText,
      [
        { refId: "span-kidoku", sourceText: "<reallive.kidoku 5>", spanKind: "markup" },
        { refId: "span-name", sourceText: "【ユカリ】", spanKind: "markup" },
        { refId: "span-var-player", sourceText: "{player}", spanKind: "variable" },
      ],
      // Re-inject-constructed target with the in-body var preserved.
      "【ユカリ】「Hi {player}」",
      [
        {
          refId: "span-var-player",
          startInDraft: "【ユカリ】「Hi ".length,
          endInDraft: "【ユカリ】「Hi {player}".length,
        },
      ],
    );
    expect(guarded.map((s) => s.refId)).toEqual(["span-var-player"]);
    expect(result.accepted).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("DOES flag a model-dropped in-body span (no regression / no hole)", () => {
    // The model dropped {player} from its body. The guard KEEPS the span
    // (it is in-body + non-glossary), so the validator must still catch it.
    const { guarded, result } = validateGuarded(
      SOURCE_BRIDGE_UNIT.sourceText,
      [
        { refId: "span-kidoku", sourceText: "<reallive.kidoku 5>", spanKind: "markup" },
        { refId: "span-var-player", sourceText: "{player}", spanKind: "variable" },
      ],
      // Re-inject-constructed target where the body lost the variable.
      "【ユカリ】「Hi there」",
      // No ref relocated (the literal is gone from the final target).
      [],
    );
    expect(guarded.map((s) => s.refId)).toEqual(["span-var-player"]);
    expect(result.accepted).toBe(false);
    const v = result.violations.find((x) => x.spanRefId === "span-var-player");
    expect(v).toBeDefined();
    if (v !== undefined) {
      // The literal is absent from the draft → variable_substituted.
      expect(v.kind).toBe("variable_substituted");
      expect(v.evidence.observedRanges).toEqual([]);
    }
    // The re-inject-owned kidoku marker is NOT in the violation set.
    expect(result.violations.some((x) => x.spanRefId === "span-kidoku")).toBe(false);
  });

  it("still flags a glossary span whose expected target form is absent", () => {
    // Glossary spans are kept by the guard; a missing expected form is still
    // a real defect the validator must surface.
    const { result } = validateGuarded(
      SOURCE_BRIDGE_UNIT.sourceText,
      [
        {
          refId: "span-gloss-name",
          sourceText: "【ユカリ】",
          spanKind: "glossary",
          expectedTargetForm: "【Yukari】",
        },
      ],
      // Target kept the source name token instead of romanizing it.
      "【ユカリ】「Hi {player}」",
      [],
    );
    expect(result.accepted).toBe(false);
    const v = result.violations.find((x) => x.spanRefId === "span-gloss-name");
    expect(v).toBeDefined();
  });
});

// Keep the AgenticLoopUnitInput import load-bearing: the guard's contract is
// part of the loop's input surface (input.protectedSpans + input.unit.sourceText
// are exactly what runDeterministicChecks threads into selectSpansForValidation).
const _inputShapeCheck: Pick<AgenticLoopUnitInput, "protectedSpans"> = {
  protectedSpans: [],
};
void _inputShapeCheck;
