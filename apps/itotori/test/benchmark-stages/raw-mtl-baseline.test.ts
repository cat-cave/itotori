// ITOTORI-090 — Raw MTL baseline stage unit tests.

import { describe, expect, it } from "vitest";
import {
  RawMtlBaselineError,
  runRawMtlBaselineStage,
  type RawMtlBaselineInput,
} from "../../src/benchmark-stages/index.js";

const U1 = "019ed010-0000-7000-8000-000000000001";
const U2 = "019ed010-0000-7000-8000-000000000002";
const RUN_ID = "019ed010-0000-7000-8000-000000000101";

function providerRun(id: string) {
  return {
    providerRunId: id,
    taskKind: "draft_translation" as const,
    startedAt: "2026-06-28T12:00:10.000Z",
    completedAt: "2026-06-28T12:00:11.000Z",
    status: "succeeded" as const,
    provider: {
      providerFamily: "external_mtl" as const,
      endpointFamily: "recorded-fixture",
      providerName: "fixture-mtl",
      requestedModelId: "fixture-mtl-v1",
      actualModelId: "fixture-mtl-v1",
    },
    prompt: { promptPresetId: "raw-mtl-baseline-v1", promptTemplateVersion: "1.0.0" },
    structuredOutputMode: "json_schema",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    tokenUsage: {
      tokenCountSource: "deterministic_counter" as const,
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
    },
    cost: { costKind: "zero" as const, currency: "USD" as const, amountMicrosUsd: 0 },
  };
}

function baseInput(): RawMtlBaselineInput {
  return {
    targetLocale: "en-US",
    corpusTargetLocale: "en-US",
    corpus: [
      { unitId: U1, label: "line-001", sourceText: "Hello, {player}!" },
      { unitId: U2, label: "line-002", sourceText: "Save {count}?" },
    ],
    recordedSystems: [
      {
        systemId: "raw-mtl-baseline",
        systemKind: "raw_mtl_baseline",
        displayName: "Raw MTL",
        generatedAt: "2026-06-28T12:00:10.000Z",
        promptPresetId: "raw-mtl-baseline-v1",
        providerRun: providerRun(RUN_ID),
        translatedUnits: [
          { unitId: U1, targetText: "Hello, !" },
          { unitId: U2, targetText: "Save {count}?" },
        ],
      },
    ],
  };
}

describe("raw-mtl-baseline stage", () => {
  it("records source unit ids, provider metadata, and translated text references", () => {
    const result = runRawMtlBaselineStage(baseInput());
    expect(result.systems).toHaveLength(1);
    expect(result.systems[0].providerRunIds).toEqual([RUN_ID]);
    expect(result.providerRuns[0].systemId).toBe("raw-mtl-baseline");
    expect(result.baselineOutputs[0].units.map((u) => u.unitId)).toEqual([U1, U2]);
    expect(result.baselineOutputs[0].units[0]).toMatchObject({
      sourceText: "Hello, {player}!",
      targetText: "Hello, !",
    });
  });

  it("is reproducible: identical inputs produce identical outputs", () => {
    expect(runRawMtlBaselineStage(baseInput())).toEqual(runRawMtlBaselineStage(baseInput()));
  });

  it("refuses when no raw_mtl_baseline system is present", () => {
    const input = baseInput();
    input.recordedSystems[0].systemKind = "itotori_draft";
    expect(() => runRawMtlBaselineStage(input)).toThrow(RawMtlBaselineError);
    expect(() => runRawMtlBaselineStage(input)).toThrow(/raw_mtl_baseline/u);
  });

  it("refuses a translated unit that references an unknown source unit", () => {
    const input = baseInput();
    input.recordedSystems[0].translatedUnits[0].unitId = "019ed010-0000-7000-8000-0000000009ff";
    expect(() => runRawMtlBaselineStage(input)).toThrow(/unknown source unit/u);
  });

  it("refuses when the recorded corpus locale disagrees with the manifest", () => {
    const input = baseInput();
    input.corpusTargetLocale = "fr-FR";
    expect(() => runRawMtlBaselineStage(input)).toThrow(/does not match/u);
  });
});
