#!/usr/bin/env node

import { buildBehaviorProofPlan } from "./behavior-proof-plan.mjs";
import { pathToFileURL } from "node:url";

export async function runManifestGate() {
  const { plan, cucumberCollection } = await buildBehaviorProofPlan();
  if (
    plan.counts.behaviors !== 47 ||
    plan.counts.canonicalEngines !== 47 ||
    plan.counts.authoredCases !== 570 ||
    plan.counts.selectedCases !== 3_400 ||
    plan.counts.applicableCells !== 687 ||
    plan.counts.nonApplicablePairs !== 96 ||
    cucumberCollection.length !== plan.counts.authoredCases
  ) {
    throw new Error(`behavior manifest count mismatch: ${JSON.stringify(plan.counts)}`);
  }
  process.stdout.write(
    `Behavior manifest: ${plan.counts.behaviors} outlines, ` +
      `${plan.counts.authoredCases} authored rows, ${plan.counts.selectedCases} selected cases, ` +
      `${plan.counts.applicableCells} applicable cells, ` +
      `${plan.counts.nonApplicablePairs} non-applicable pairs; ` +
      `Cucumber collected ${cucumberCollection.length} pickles.\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runManifestGate().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
