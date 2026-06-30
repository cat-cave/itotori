// ITOTORI-090 — Deterministic QA stage unit tests.

import { describe, expect, it } from "vitest";
import {
  DeterministicQaError,
  runDeterministicQaStage,
  type DeterministicQaInput,
} from "../../src/benchmark-stages/index.js";

const U1 = "019ed010-0000-7000-8000-000000000001";
const U2 = "019ed010-0000-7000-8000-000000000002";

function input(): DeterministicQaInput {
  return {
    startedAt: "2026-06-28T12:01:05.000Z",
    completedAt: "2026-06-28T12:01:05.100Z",
    baselineOutputs: [
      {
        systemId: "raw-mtl-baseline",
        systemKind: "raw_mtl_baseline",
        units: [
          // drops the {player} protected span → protected-span-preservation fails
          { unitId: U1, label: "line-001", sourceText: "Hello, {player}!", targetText: "Hello, !" },
          // empty target → non-empty-target fails
          { unitId: U2, label: "line-002", sourceText: "Save it.", targetText: "  " },
        ],
      },
    ],
  };
}

describe("deterministic-qa stage", () => {
  it("emits per-(system, check) results with pass/fail counts and finding ids", () => {
    const result = runDeterministicQaStage(input());
    const protectedSpan = result.results.find((r) => r.checkName === "protected-span-preservation");
    const nonEmpty = result.results.find((r) => r.checkName === "non-empty-target");

    expect(protectedSpan?.ruleCount).toBe(2);
    expect(protectedSpan?.failedRuleCount).toBe(1);
    expect(protectedSpan?.passedRuleCount).toBe(1);
    expect(protectedSpan?.findingIds).toHaveLength(1);

    expect(nonEmpty?.failedRuleCount).toBe(1);
    expect(nonEmpty?.findingIds).toHaveLength(1);
  });

  it("produces deterministic_qa findings carrying rule, severity, and affected unit", () => {
    const result = runDeterministicQaStage(input());
    expect(result.findings).toHaveLength(2);
    const dropped = result.findings.find((f) => f.category === "technical_integrity");
    expect(dropped?.detectorKind).toBe("deterministic_qa");
    expect(dropped?.qualitySeverity).toBe("major");
    expect(dropped?.affectedRefs[0].subjectId).toBe(U1);
    const empty = result.findings.find((f) => f.category === "accuracy");
    expect(empty?.qualitySeverity).toBe("critical");
    expect(empty?.affectedRefs[0].subjectId).toBe(U2);
  });

  it("is reproducible across runs", () => {
    expect(runDeterministicQaStage(input())).toEqual(runDeterministicQaStage(input()));
  });

  it("passes a clean translation with no findings", () => {
    const clean = input();
    clean.baselineOutputs[0].units = [
      { unitId: U1, label: "line-001", sourceText: "Hello, {player}!", targetText: "Hi {player}!" },
    ];
    const result = runDeterministicQaStage(clean);
    expect(result.findings).toHaveLength(0);
    expect(result.results.every((r) => r.failedRuleCount === 0)).toBe(true);
  });

  it("refuses empty baseline outputs", () => {
    expect(() => runDeterministicQaStage({ ...input(), baselineOutputs: [] })).toThrow(
      DeterministicQaError,
    );
  });
});
