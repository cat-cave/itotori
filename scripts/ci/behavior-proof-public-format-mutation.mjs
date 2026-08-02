import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "./behavior-fixed-success-mutation-contract.mjs";

const CELL = "cell::platform.public-formats-upgrade-predictably::all";

function replaceOnce(source, find, replacement, label) {
  const parts = source.split(find);
  if (parts.length !== 2) {
    throw new Error(`${label}-mutation-marker-count:${parts.length - 1}`);
  }
  return parts.join(replacement);
}

function mutateVersionAssertion(source) {
  const assertionStart = source.indexOf("export function assertFormatVersion(");
  if (assertionStart < 0) throw new Error("public-format-version-assertion-missing");
  const before = source.slice(0, assertionStart);
  const assertion = source.slice(assertionStart);
  return `${before}${replaceOnce(
    assertion,
    "if (observedText === decl.schemaVersion) return;",
    'if (observedText === decl.schemaVersion || observedText === "0.1.0") return;',
    "public-format-version-assertion",
  )}`;
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
      `public-format-mutation-build-failed:${result.status}\n${result.stderr}${result.stdout}`,
    );
  }
}

/** Builds an isolated reader that incorrectly accepts a legacy bridge format. */
export function preparePublicFormatFixedSuccessMutation(root, workRoot) {
  const mutationRoot = resolve(workRoot, "public-format-fixed-success-mutation");
  const sourcePackage = resolve(root, "packages", "localization-bridge-schema");
  const mutatedPackage = resolve(mutationRoot, "packages", "localization-bridge-schema");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(resolve(mutationRoot, "packages"), { recursive: true });
  cpSync(sourcePackage, mutatedPackage, { recursive: true });
  copyFileSync(resolve(root, "tsconfig.base.json"), resolve(mutationRoot, "tsconfig.base.json"));

  const sourcePath = resolve(mutatedPackage, "src", "format-stability.ts");
  const strictSource = readFileSync(sourcePath, "utf8");
  writeFileSync(sourcePath, mutateVersionAssertion(strictSource), "utf8");
  compileMutatedPackage(root, mutatedPackage);

  const emitted = readFileSync(resolve(mutatedPackage, "dist", "format-stability.js"), "utf8");
  if (!emitted.includes('observedText === decl.schemaVersion || observedText === "0.1.0"')) {
    throw new Error("public-format-mutation-build-marker-missing");
  }
  return mutationRoot;
}

export function prepareFixedSuccessMutation(root, workRoot) {
  const mutationRoot = preparePublicFormatFixedSuccessMutation(root, workRoot);
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, CELL),
  };
}
