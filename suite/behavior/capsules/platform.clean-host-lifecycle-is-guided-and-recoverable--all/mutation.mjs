import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "../../../../scripts/ci/behavior-fixed-success-mutation-contract.mjs";

export const cell = "cell::platform.clean-host-lifecycle-is-guided-and-recoverable::all";

function replaceOnce(source, find, replacement, label) {
  const parts = source.split(find);
  if (parts.length !== 2) {
    throw new Error(`${label}-mutation-marker-count:${parts.length - 1}`);
  }
  return parts.join(replacement);
}

/**
 * Copies the emitted lifecycle module and its real sibling modules, then turns
 * its authorization gate into an incorrect success. The product boundary
 * imports this isolated compiled copy, so no driver result is fabricated.
 */
export function prepareCleanHostLifecycleFixedSuccessMutation(root, workRoot) {
  const mutationRoot = resolve(workRoot, "clean-host-lifecycle-fixed-success-mutation");
  const sourceRoot = resolve(workRoot, "glue", "product", "apps", "itotori", "src");
  const targetRoot = resolve(mutationRoot, "apps", "itotori", "src");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  for (const name of [
    "install-lifecycle.js",
    "install-lifecycle-contract.js",
    "install-lifecycle-support.js",
  ]) {
    copyFileSync(resolve(sourceRoot, name), resolve(targetRoot, name));
  }

  const sourcePath = resolve(targetRoot, "install-lifecycle.js");
  const strictSource = readFileSync(sourcePath, "utf8");
  const mutatedSource = replaceOnce(
    strictSource,
    "const signatureValid = verify(null, canonicalManifestBytes(manifest), publicKeyPem, signature);",
    "const signatureValid = true;",
    "clean-host-lifecycle-signature",
  );
  writeFileSync(sourcePath, mutatedSource, "utf8");
  if (!readFileSync(sourcePath, "utf8").includes("const signatureValid = true;")) {
    throw new Error("clean-host-lifecycle-mutation-build-marker-missing");
  }
  return mutationRoot;
}

export function prepareFixedSuccessMutation(root, workRoot) {
  const mutationRoot = prepareCleanHostLifecycleFixedSuccessMutation(root, workRoot);
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, cell),
  };
}
