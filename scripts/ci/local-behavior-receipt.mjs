import { OWNED_CELLS, canonicalDigest } from "./build-cell-report.mjs";

export function buildLocalArtifactReceipt(
  plan,
  selectionPlanDigest,
  candidateBuildDigest,
  laneFragments,
  caseResults,
  mutations,
  portable,
) {
  return {
    schema: "itotori.local-behavior-receipt.v1",
    trust: "local-candidate",
    trustRole: "local-candidate-contract",
    protectedAttestationPresent: false,
    candidateTreeDigest: plan.candidateTreeDigest,
    candidateBuildDigest,
    selectionPlanDigest,
    classificationDigest: plan.classificationDigest,
    laneFragments: laneFragments.map(({ lane, shard, shardCount, messageDigest, junitDigest }) => ({
      lane,
      shard,
      shardCount,
      messageDigest,
      junitDigest,
    })),
    caseResultsDigest: canonicalDigest(
      caseResults.toSorted((left, right) => left.caseId.localeCompare(right.caseId)),
    ),
    mutationResultsDigest: canonicalDigest(mutations),
    portableEvidenceDigest: portable.evidenceDigest,
    portableAuditReceiptDigest: portable.auditReceiptDigest,
    productSourceDigest: portable.productSourceDigest,
    productBuildDigest: portable.productBuildDigest,
    cells: OWNED_CELLS,
  };
}
