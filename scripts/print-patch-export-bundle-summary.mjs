// ITOTORI-025 — `just hello-patch` summary printer.
//
// Loads the PatchExportBundle produced by
// `node apps/itotori/dist/cli.js export-patch-v2 ...` and asserts that
// it is well-formed against the schema package. Exits non-zero on any
// shape divergence so `just hello-patch` fails loudly when the
// patch-export pipeline regresses.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  throw new Error("Usage: node scripts/print-patch-export-bundle-summary.mjs <bundle.json>");
}

const { assertPatchExportBundle } =
  await import("../packages/localization-bridge-schema/dist/index.js");

const bundle = JSON.parse(readFileSync(path, "utf8"));
assertPatchExportBundle(bundle);

console.log("Itotori patch-export bundle is well-formed");
console.log(`schemaVersion=${bundle.schemaVersion}`);
console.log(`projectId=${bundle.projectId}`);
console.log(`localeBranchId=${bundle.localeBranchId}`);
console.log(`targetLocale=${bundle.targetLocale}`);
console.log(`sourceBridgeHash=${bundle.sourceBridgeHash}`);
console.log(`drafts=${bundle.drafts.length}`);
console.log(`assetDecisions=${bundle.assetDecisions.length}`);
console.log(`preflightResults=${bundle.preflightResults.length}`);
console.log(`provenance.draftArtifactBundleId=${bundle.provenance.draftArtifactBundleId}`);
console.log(`provenance.exportedAt=${bundle.provenance.exportedAt}`);
console.log(`provenance.exportedByUserId=${bundle.provenance.exportedByUserId}`);
for (const draft of bundle.drafts) {
  console.log(
    `draft sourceUnit=${draft.sourceUnitId} draftId=${draft.draftId} mappings=${draft.protectedSpanMappings.length}`,
  );
}
for (const result of bundle.preflightResults) {
  console.log(
    `preflight check=${result.check} status=${result.status} blockingExport=${result.blockingExport}`,
  );
}
