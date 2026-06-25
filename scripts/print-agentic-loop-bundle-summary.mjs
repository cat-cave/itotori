// ITOTORI-222 — AgenticLoopBundle summary printer.
//
// Loads the AgenticLoopBundle produced by
// `node apps/itotori/dist/cli.js agentic-loop-smoke ...` and asserts
// that it is well-formed against the schema package. Exits non-zero
// on any shape divergence so the recipe fails loudly when the
// orchestrator regresses.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  throw new Error("Usage: node scripts/print-agentic-loop-bundle-summary.mjs <bundle.json>");
}

const { assertAgenticLoopBundle } =
  await import("../packages/localization-bridge-schema/dist/index.js");

const bundle = JSON.parse(readFileSync(path, "utf8"));
assertAgenticLoopBundle(bundle);

console.log("Itotori agentic-loop bundle is well-formed");
console.log(`schemaVersion=${bundle.schemaVersion}`);
console.log(`bridgeUnitId=${bundle.bridgeUnitId}`);
console.log(`projectId=${bundle.projectId}`);
console.log(`sourceLocale=${bundle.sourceLocale} targetLocale=${bundle.targetLocale}`);
console.log(`stages=${bundle.stages.length}`);
for (const stage of bundle.stages) {
  console.log(
    `stage name=${stage.stageName} outcome=${stage.outcome} ` +
      `invocations=${stage.invocations.length} ` +
      `tokensIn=${stage.tokensIn} tokensOut=${stage.tokensOut} ` +
      `cost=${stage.costUsd}`,
  );
}
console.log(
  `routing outcome=${bundle.routingSummary.outcome} ` +
    `routedFindings=${bundle.routingSummary.routedFindingCount} ` +
    `critical=${bundle.routingSummary.criticalFindingCount} ` +
    `repairAttempts=${bundle.routingSummary.repairAttempts}/` +
    `${bundle.routingSummary.maxRepairAttempts}`,
);
if (bundle.finalDraft.draftText !== undefined) {
  console.log(`finalDraft.draftText=${bundle.finalDraft.draftText}`);
} else if (bundle.finalDraft.deferredReason !== undefined) {
  console.log(`finalDraft.deferredReason=${bundle.finalDraft.deferredReason}`);
}
