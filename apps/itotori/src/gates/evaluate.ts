// Run the deterministic localization + evidence gates over a snapshot and its
// accepted outputs.
//
// The orchestration is itself deterministic and dispatches ZERO model calls.
// Gates that need only (snapshot, accepted) always run. The glossary gate runs
// when approved forms are supplied; the render gate runs when render facts are
// supplied. The evidence gate is NOT optional in the presence of evidence: if
// any accepted output cites evidence and no corpus is supplied, the pass fails
// loud (no silent skip). Every gate that ran is reported so the facts-dominate
// join knows which reviewer findings a passing fact may override.

import type { Defect, DefectBundle } from "../contracts/index.js";

import type { DeterministicGate } from "./contract-types.js";
import { byteBoxGate } from "./byte-box.js";
import { cardinalityOrderHashGate } from "./cardinality.js";
import {
  assertEvidenceCorpusPresent,
  evidenceScopeGate,
  requiresEvidenceCorpus,
} from "./evidence-scope.js";
import { glossaryExactGate } from "./glossary-exact.js";
import { joinDefects, type JoinInput } from "./join.js";
import { markupControlsGate } from "./markup-controls.js";
import { patchCoverageGate } from "./patch-coverage.js";
import { protectedSpansGate } from "./protected-spans.js";
import { renderOcrGate } from "./render-ocr.js";
import { shiftJisGate } from "./shift-jis.js";
import type { DeterministicGateInput } from "./types.js";

export type DeterministicGateReport = {
  defects: Defect[];
  evaluatedGates: DeterministicGate[];
};

export function evaluateDeterministicGates(input: DeterministicGateInput): DeterministicGateReport {
  const { snapshot, accepted } = input;
  const defects: Defect[] = [];
  const evaluatedGates: DeterministicGate[] = [];

  const run = (gate: DeterministicGate, produced: Defect[]): void => {
    evaluatedGates.push(gate);
    defects.push(...produced);
  };

  run("cardinality-order-hash", cardinalityOrderHashGate(snapshot, accepted));
  run("protected-spans", protectedSpansGate(snapshot, accepted));
  run("shift-jis", shiftJisGate(snapshot, accepted));
  run("byte-box", byteBoxGate(snapshot, accepted, input.boxLimits));
  run("markup-controls", markupControlsGate(snapshot, accepted));
  run("patch-coverage", patchCoverageGate(snapshot, accepted, input.workScope));

  if (input.glossary !== undefined) {
    run("glossary-exact", glossaryExactGate(snapshot, accepted, input.glossary));
  }

  // Evidence: fail loud if outputs cite evidence but no corpus was supplied.
  assertEvidenceCorpusPresent(accepted, input.contextFacts, input.contextSnapshotId);
  if (input.contextFacts !== undefined && input.contextSnapshotId !== undefined) {
    run(
      "evidence-scope",
      evidenceScopeGate(snapshot, accepted, input.contextFacts, input.contextSnapshotId),
    );
  } else if (requiresEvidenceCorpus(accepted)) {
    // Unreachable — assertEvidenceCorpusPresent throws first — but keeps the
    // "no silent skip" contract explicit for a future caller.
    evaluatedGates.push("evidence-scope");
  }

  if (input.render != null) {
    run("render-ocr", renderOcrGate(snapshot, accepted, input.render));
  }

  return { defects, evaluatedGates };
}

/** Convenience: evaluate the deterministic gates and fold them, plus any
 * reviewer verdicts, into a facts-dominate DefectBundle. */
export function evaluateAndJoin(
  input: DeterministicGateInput,
  join: Pick<JoinInput, "localizationSnapshotId" | "draftBatchId" | "reviews">,
): DefectBundle {
  const report = evaluateDeterministicGates(input);
  return joinDefects({
    localizationSnapshotId: join.localizationSnapshotId,
    draftBatchId: join.draftBatchId,
    reviews: join.reviews ?? [],
    deterministic: report.defects,
    evaluatedGates: report.evaluatedGates,
  });
}
