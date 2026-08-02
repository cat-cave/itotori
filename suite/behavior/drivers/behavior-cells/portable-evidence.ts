import { observeEvidence, type EvidenceObservation } from "../portable-evidence.js";
import {
  check,
  requireCaseValue,
  type BehaviorCellStepContext,
  type BehaviorCellStepExecutor,
  type BehaviorCellStepResult,
} from "./step-contract.js";
import { fixedSuccessEnabled } from "./fixed-success-mutation.js";

const observations = new WeakMap<object, EvidenceObservation>();

function observationFor(execution: object): EvidenceObservation {
  const observation = observations.get(execution);
  if (observation === undefined) throw new Error("evidence-not-observed");
  return observation;
}

export const executeCellStep: BehaviorCellStepExecutor = async (
  context: BehaviorCellStepContext,
): Promise<BehaviorCellStepResult> => {
  const { index, selected, text } = context;
  if (index === 0) {
    const fixedSuccess = fixedSuccessEnabled(
      context.mode,
      context.mutationArtifactPath,
      selected.cell,
    );
    const evidenceKind = requireCaseValue(selected.values, "evidence_kind");
    const sourceClass = requireCaseValue(selected.values, "source_class");
    const privacyClass = requireCaseValue(selected.values, "privacy_class");
    const contentCase = requireCaseValue(selected.values, "content_case");
    check(
      text ===
        `${evidenceKind} from ${sourceClass} has ${privacyClass} visibility and ${contentCase}`,
      "evidence-given-mismatch",
    );
    const observation = observeEvidence(
      {
        caseId: selected.id,
        evidenceKind,
        sourceClass,
        privacyClass,
        contentCase,
        referenceKind: requireCaseValue(selected.values, "reference_kind"),
        candidateRevision: context.candidateTreeDigest,
        repositoryRoot: context.repositoryRoot,
        workRoot: context.workRoot,
      },
      fixedSuccess,
    );
    observations.set(context.execution, observation);
    return { observationCount: observation.observedFields };
  }
  const observation = observationFor(context.execution);
  if (index === 1) {
    check(
      text ===
        `an independent auditor resolves its ${requireCaseValue(selected.values, "reference_kind")} in a fresh environment`,
      "evidence-when-mismatch",
    );
    return {};
  }
  const expected = requireCaseValue(selected.values, "audit_outcome");
  const clauses = [
    "producer, source revision, input and output hashes, privacy class, and outcome are present",
    `resolution ends as ${expected}`,
    "reference expectations identify a producer independent from the output under evaluation",
    "copying evaluated output into expected data invalidates provenance",
    "every accepted artifact set belongs to one coherent source lineage and regenerates all dependents deterministically after a source change",
    "tampering, stale revision, or environment-local location makes the evidence invalid",
  ];
  check(text === clauses[index - 2], `portable-evidence-step-${index - 1}-mismatch`);
  const conditions = [
    observation.metadataComplete && observation.restrictedPublicationWithheld,
    observation.auditOutcome === expected && observation.freshResolution,
    observation.independentProducer,
    observation.copiedExpectationRejected,
    observation.coherentLineage && observation.deterministicDependents,
    observation.tamperRejected &&
      observation.staleRevisionRejected &&
      observation.localLocationRejected,
  ];
  const condition = conditions[index - 2];
  if (condition === undefined) throw new Error("unbound-portable-evidence-step");
  check(condition, `portable-evidence-assertion-${index - 1}`);
  if (index === 7) observations.delete(context.execution);
  return { assertionCount: 1 };
};
