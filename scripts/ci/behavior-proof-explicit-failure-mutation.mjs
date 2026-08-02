import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "./behavior-fixed-success-mutation-contract.mjs";

const CELL = "cell::quality.failures-stay-explicit::all";

/**
 * Prepares the fixed-success driver mutation as a separately bound artifact.
 * The driver rejects its normal observed failure only when this artifact is in
 * the fixed-success plan, so an omitted preparation cannot silently pass.
 */
export function prepareFixedSuccessMutation(_root, workRoot) {
  const mutationRoot = resolve(workRoot, "explicit-failure-fixed-success-mutation");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(mutationRoot, { recursive: true });
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, CELL),
  };
}
