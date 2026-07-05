// UTSUSHI-011 — Deterministic runtime-evidence checks.
//
// This is the NON-LLM lane. It resolves the runtime report through the managed
// store and runs every unambiguous detector (missing-text, wrong-branch, exact
// mismatch, geometric layout overflow) plus the informational OCR-hint pass. It
// runs BEFORE / ALONGSIDE the QA agent: a deterministic check catches an
// unambiguous finding (e.g. a bridge unit with no observed runtime text)
// without ever calling a model.
//
// The agent (prompt-template.ts) handles the residual ambiguity the
// deterministic checks CANNOT settle: semantic paraphrase vs. mistranslation,
// aesthetic-but-in-bounds layout, and OCR-hint interpretation.

import type { RuntimeEvidenceArtifactStore } from "./artifact-store.js";
import {
  collectOcrHints,
  detectLayout,
  detectMismatch,
  detectMissingText,
  detectWrongBranch,
} from "./tools.js";
import {
  RuntimeEvidenceArtifactUnresolvedError,
  type ManagedArtifactRef,
  type RuntimeEvidenceExpectations,
  type RuntimeEvidenceFinding,
  type RuntimeEvidenceFindingKind,
} from "./shapes.js";

export type RuntimeEvidenceDeterministicCheckInput = {
  store: RuntimeEvidenceArtifactStore;
  runtimeReportRef: ManagedArtifactRef;
  expectations: RuntimeEvidenceExpectations;
  /** Include the informational OCR-hint pass in the aggregate. Default true. */
  includeOcrHints?: boolean;
};

export type RuntimeEvidenceDeterministicCheckResult = {
  runtimeReportId: string;
  evidenceTier: string;
  findings: RuntimeEvidenceFinding[];
  byKind: Record<RuntimeEvidenceFindingKind, number>;
  /** True when at least one non-informational finding fired (missing/wrong/mismatch/layout). */
  hasBlockingFinding: boolean;
};

const EMPTY_BY_KIND: Record<RuntimeEvidenceFindingKind, number> = {
  missing_text: 0,
  wrong_branch: 0,
  layout: 0,
  mismatch: 0,
  ocr_hint: 0,
};

/**
 * Run the deterministic runtime-evidence checks. No provider, no randomness —
 * re-running over the same managed artifacts yields identical findings.
 */
export function runRuntimeEvidenceDeterministicChecks(
  input: RuntimeEvidenceDeterministicCheckInput,
): RuntimeEvidenceDeterministicCheckResult {
  const report = input.store.resolveRuntimeReport(input.runtimeReportRef);
  if (report === null) {
    throw new RuntimeEvidenceArtifactUnresolvedError(
      input.runtimeReportRef.artifactId,
      input.runtimeReportRef.artifactKind,
    );
  }

  const findings: RuntimeEvidenceFinding[] = [
    ...detectMissingText(report, input.runtimeReportRef, input.expectations.units),
    ...detectWrongBranch(report, input.runtimeReportRef, input.expectations.branches),
    ...detectMismatch(report, input.runtimeReportRef, input.expectations.units),
    ...detectLayout(report, input.store),
  ];
  if (input.includeOcrHints !== false) {
    findings.push(...collectOcrHints(report, input.store));
  }

  const byKind: Record<RuntimeEvidenceFindingKind, number> = { ...EMPTY_BY_KIND };
  for (const finding of findings) {
    byKind[finding.findingKind] += 1;
  }

  const hasBlockingFinding =
    byKind.missing_text + byKind.wrong_branch + byKind.mismatch + byKind.layout > 0;

  return {
    runtimeReportId: report.runtimeReportId,
    evidenceTier: report.evidenceTier,
    findings,
    byKind,
    hasBlockingFinding,
  };
}
