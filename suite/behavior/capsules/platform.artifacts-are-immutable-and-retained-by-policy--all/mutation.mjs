import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "../../../../scripts/ci/behavior-fixed-success-mutation-contract.mjs";

export const cell = "cell::platform.artifacts-are-immutable-and-retained-by-policy::all";

function replaceOnce(source, find, replacement, label) {
  const parts = source.split(find);
  if (parts.length !== 2) {
    throw new Error(`${label}-mutation-marker-count:${parts.length - 1}`);
  }
  return parts.join(replacement);
}

function compileMutatedPackage(root, packageRoot) {
  const result = spawnSync("pnpm", ["exec", "tsc", "-p", resolve(packageRoot, "tsconfig.json")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `immutable-artifact-mutation-build-failed:${result.status}\n${result.stderr}${result.stdout}`,
    );
  }
}

/**
 * Builds an isolated product copy whose version reader accepts an unsupported
 * format. The behavior boundary must reject that mutated product by observing
 * the missing typed incompatibility failure; no observation is fabricated.
 */
export function prepareImmutableArtifactFixedSuccessMutation(root, workRoot) {
  const mutationRoot = resolve(workRoot, "immutable-artifact-fixed-success-mutation");
  const sourcePackage = resolve(root, "packages", "itotori-db");
  const mutatedPackage = resolve(mutationRoot, "packages", "itotori-db");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(resolve(mutationRoot, "packages"), { recursive: true });
  cpSync(sourcePackage, mutatedPackage, { recursive: true });
  copyFileSync(resolve(root, "tsconfig.base.json"), resolve(mutationRoot, "tsconfig.base.json"));

  const sourcePath = resolve(mutatedPackage, "src", "immutable-artifact-version.ts");
  const strictSource = readFileSync(sourcePath, "utf8");
  const mutatedSource = replaceOnce(
    strictSource,
    "if (supportedVersions.includes(observedVersion)) return;",
    "if (supportedVersions.includes(observedVersion) || observedVersion.length > 0) return;",
    "immutable-artifact-version",
  );
  writeFileSync(sourcePath, mutatedSource, "utf8");
  compileMutatedPackage(root, mutatedPackage);

  const emitted = readFileSync(
    resolve(mutatedPackage, "dist", "immutable-artifact-version.js"),
    "utf8",
  );
  if (
    !emitted.includes("supportedVersions.includes(observedVersion) || observedVersion.length > 0")
  ) {
    throw new Error("immutable-artifact-mutation-build-marker-missing");
  }
  return mutationRoot;
}

export function prepareFixedSuccessMutation(root, workRoot) {
  const mutationRoot = prepareImmutableArtifactFixedSuccessMutation(root, workRoot);
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, cell),
  };
}
