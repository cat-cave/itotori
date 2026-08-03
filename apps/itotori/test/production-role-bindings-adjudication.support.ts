import { ReviewVerdictSchema, type ReviewVerdict } from "../src/contracts/index.js";
import type { LaneVerdict } from "../src/workflow/index.js";

export function contestedVerdicts(
  unitId: string,
  localizationSnapshotId: string,
  bibleRenderingId: string,
  repairConstraint = "Preserve the revised grounded sense.",
): readonly LaneVerdict[] {
  return [
    {
      lane: "Q1",
      verdict: reviewVerdict({
        roleId: "Q1",
        rubric: "meaning",
        unitId,
        localizationSnapshotId,
        evidenceId: bibleRenderingId,
        bibleRenderingId,
        verdict: "PASS",
      }),
    },
    {
      lane: "Q3",
      verdict: reviewVerdict({
        roleId: "Q3",
        rubric: "terminology",
        unitId,
        localizationSnapshotId,
        evidenceId: unitId,
        bibleRenderingId,
        verdict: "FAIL",
        repairConstraint,
      }),
    },
  ];
}

function reviewVerdict(input: {
  readonly roleId: "Q1" | "Q3";
  readonly rubric: "meaning" | "terminology";
  readonly unitId: string;
  readonly localizationSnapshotId: string;
  readonly evidenceId: string;
  readonly bibleRenderingId: string;
  readonly verdict: "PASS" | "FAIL";
  readonly repairConstraint?: string;
}): ReviewVerdict {
  const base = {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review:${input.roleId}:${input.unitId}`,
    localizationSnapshotId: input.localizationSnapshotId,
    roleId: input.roleId,
    rubric: input.rubric,
    unitId: input.unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: [input.bibleRenderingId] },
    evidenceIds: [input.evidenceId],
  };
  if (input.verdict === "PASS") {
    return ReviewVerdictSchema.parse({
      ...base,
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      repairConstraint: null,
    });
  }
  return ReviewVerdictSchema.parse({
    ...base,
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:fixture", surface: "source", text: "fixture" },
    category: "term-sense",
    repairConstraint: input.repairConstraint ?? "Preserve the revised grounded sense.",
  });
}
