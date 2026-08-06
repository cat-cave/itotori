import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "../../../../scripts/ci/behavior-fixed-success-mutation-contract.mjs";

export const cell = "cell::account.administer-access::all";

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
      `administer-access-mutation-build-failed:${result.status}\n${result.stderr}${result.stdout}`,
    );
  }
}

/**
 * Builds an isolated product copy that drops the account-scope membership check.
 * Cross-tenant administration then succeeds, and the behavior boundary must turn
 * red by observing that foreign resources became available.
 */
export function prepareAdministerAccessFixedSuccessMutation(root, workRoot) {
  const mutationRoot = resolve(workRoot, "administer-access-fixed-success-mutation");
  const sourcePackage = resolve(root, "packages", "itotori-db");
  const mutatedPackage = resolve(mutationRoot, "packages", "itotori-db");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(resolve(mutationRoot, "packages"), { recursive: true });
  cpSync(sourcePackage, mutatedPackage, { recursive: true });
  copyFileSync(resolve(root, "tsconfig.base.json"), resolve(mutationRoot, "tsconfig.base.json"));

  const path = resolve(mutatedPackage, "src", "authorization-account-permission.ts");
  const source = readFileSync(path, "utf8");
  const mutated = replaceOnce(
    source,
    "await requirePermission(db, actor, permission);\n\n  const identity = await loadActorIdentity(db, actor.userId);\n  const targetAccount = identity.accounts.find((account) => account.accountId === accountId);\n  if (targetAccount === undefined || !(await isAccountActive(db, accountId))) {\n    throw new AuthorizationError(actor, permission);\n  }\n\n  if (\n    identity.principalId !== null &&\n    (await hasDirectPermission(db, identity.principalId, permission))\n  ) {\n    return;\n  }\n  if (await permissionSetsIncludePermission(db, targetAccount.permissionSetIds, permission)) {\n    return;\n  }\n  throw new AuthorizationError(actor, permission);",
    "await requirePermission(db, actor, permission);\n  void accountId;\n  return;",
    "account-scope-bypass",
  );
  writeFileSync(path, mutated, "utf8");
  compileMutatedPackage(root, mutatedPackage);

  const emitted = readFileSync(
    resolve(mutatedPackage, "dist", "authorization-account-permission.js"),
    "utf8",
  );
  if (!emitted.includes("void accountId") || emitted.includes("loadActorIdentity")) {
    throw new Error("administer-access-mutation-build-marker-missing");
  }
  return mutationRoot;
}

export function prepareFixedSuccessMutation(root, workRoot) {
  const mutationRoot = prepareAdministerAccessFixedSuccessMutation(root, workRoot);
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, cell),
  };
}
