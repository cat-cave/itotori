import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "../../../../scripts/ci/behavior-fixed-success-mutation-contract.mjs";

export const cell = "cell::quality.evidence-is-traceable-and-portable::all";

/**
 * Prepares the portable-evidence fixed-success mutation as a separately bound
 * artifact. The cell driver validates this binding before entering its mutant
 * branch, so a missing mutation never looks like a killed cell.
 */
export function prepareFixedSuccessMutation(_root, workRoot) {
  const mutationRoot = resolve(workRoot, "portable-evidence-fixed-success-mutation");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(mutationRoot, { recursive: true });
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, cell),
  };
}
