import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "../../../../scripts/ci/behavior-fixed-success-mutation-contract.mjs";

export const cell = "cell::platform.deployment-inputs-and-secrets-are-safe::all";

function replaceOnce(source, find, replacement, label) {
  const parts = source.split(find);
  if (parts.length !== 2) {
    throw new Error(`${label}-mutation-marker-count:${parts.length - 1}`);
  }
  return parts.join(replacement);
}

/**
 * Builds a compiled product clone that incorrectly accepts an unknown
 * deployment setting. The JSON boundary imports that clone by absolute path,
 * so the driver can only observe the real loader's changed behavior.
 */
export function prepareDeploymentInputsFixedSuccessMutation(root, workRoot) {
  const mutationRoot = resolve(workRoot, "deployment-inputs-fixed-success-mutation");
  const sourcePath = resolve(
    workRoot,
    "glue",
    "product",
    "apps",
    "itotori",
    "src",
    "config",
    "deployment-config-file.js",
  );
  const targetRoot = resolve(mutationRoot, "apps", "itotori", "src", "config");
  const targetPath = resolve(targetRoot, "deployment-config-file.js");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  const strictSource = readFileSync(sourcePath, "utf8");
  const mutatedSource = replaceOnce(
    strictSource,
    'if (!documentedSettings.has(name)) {\n            throw new DeploymentConfigFileError(path, "unknown-setting", name);\n        }',
    'if (false) {\n            throw new DeploymentConfigFileError(path, "unknown-setting", name);\n        }',
    "deployment-inputs-unknown-setting",
  );
  writeFileSync(targetPath, mutatedSource, "utf8");
  if (!readFileSync(targetPath, "utf8").includes("if (false) {")) {
    throw new Error("deployment-inputs-mutation-build-marker-missing");
  }
  return mutationRoot;
}

export function prepareFixedSuccessMutation(root, workRoot) {
  const mutationRoot = prepareDeploymentInputsFixedSuccessMutation(root, workRoot);
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, cell),
  };
}
