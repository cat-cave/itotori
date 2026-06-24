// ITOTORI-019 — `just hello-draft` summary printer.
//
// Loads the DraftArtifactBundle produced by
// `node apps/itotori/dist/cli.js draft-fixture ...` and asserts that
// it is well-formed against the schema package. Exits non-zero on any
// shape divergence so `just hello-draft` fails loudly when the
// drafting fixture command regresses.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  throw new Error("Usage: node scripts/print-draft-fixture-bundle-summary.mjs <bundle.json>");
}

const { assertDraftArtifactBundle } =
  await import("../packages/localization-bridge-schema/dist/index.js");

const bundle = JSON.parse(readFileSync(path, "utf8"));
assertDraftArtifactBundle(bundle);

console.log("Itotori draft fixture bundle is well-formed");
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
  console.log(
    `draft sourceUnit=${draft.sourceUnitId} state=${draft.retryFallbackState} ` +
      `accepted=${draft.protectedSpanValidationResult.accepted} ` +
      `proof=${draft.providerProofId} ledger=${draft.costLedgerEntryRef}`,
  );
}
