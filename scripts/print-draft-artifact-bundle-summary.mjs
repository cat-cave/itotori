// ITOTORI-222 — DraftArtifactBundle summary printer.
//
// Loads the DraftArtifactBundle derived from
// `node apps/itotori/dist/cli.js agentic-loop-smoke
//  ... --draft-artifact-output` and asserts that it is well-formed
// against the schema package. Exits non-zero on any shape divergence
// so the recipe fails loudly when the orchestrator's adapter
// regresses.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  throw new Error("Usage: node scripts/print-draft-artifact-bundle-summary.mjs <bundle.json>");
}

const { assertDraftArtifactBundle } =
  await import("../packages/localization-bridge-schema/dist/index.js");

const bundle = JSON.parse(readFileSync(path, "utf8"));
assertDraftArtifactBundle(bundle);

console.log("Itotori draft artifact bundle is well-formed");
console.log(`schemaVersion=${bundle.schemaVersion}`);
console.log(`draftJobId=${bundle.draftJobId}`);
console.log(`projectId=${bundle.projectId}`);
console.log(`localeBranchId=${bundle.localeBranchId}`);
console.log(`drafts=${bundle.drafts.length}`);
console.log(`ledger.attemptCount=${bundle.ledgerSummary.attemptCount}`);
console.log(`ledger.totalCost=${bundle.ledgerSummary.totalCost}`);
console.log(`ledger.totalTokensIn=${bundle.ledgerSummary.totalTokensIn}`);
console.log(`ledger.totalTokensOut=${bundle.ledgerSummary.totalTokensOut}`);
for (const draft of bundle.drafts) {
  const selectedCandidate = draft.writtenOutcome.candidates.find(
    (candidate) => candidate.id === draft.writtenOutcome.selectedCandidateId,
  );
  if (!selectedCandidate) {
    throw new Error(`written outcome for ${draft.sourceUnitId} has no selected candidate`);
  }
  console.log(
    `draft sourceUnit=${draft.sourceUnitId} status=${draft.writtenOutcome.status} ` +
      `targetLocale=${draft.writtenOutcome.targetLocale} selectedLength=${selectedCandidate.body.length} ` +
      `qualityFlags=${draft.writtenOutcome.qualityFlags.join(",") || "none"} ` +
      `proof=${draft.providerProofId} ledger=${draft.costLedgerEntryRef}`,
  );
}
