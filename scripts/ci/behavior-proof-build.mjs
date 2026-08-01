import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { relative, resolve } from "node:path";

function runTypeScript(root, config) {
  const result = spawnSync("pnpm", ["exec", "tsc", "-p", config], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `behavior glue compilation failed (${config}):\n${result.stderr}${result.stdout}`,
    );
  }
}

function runWorkspaceBuild(root, packageName) {
  const result = spawnSync("pnpm", ["--filter", packageName, "build"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `behavior runtime build failed (${packageName}):\n${result.stderr}${result.stdout}`,
    );
  }
}

const RUNTIME_PACKAGE_DIRECTORIES = ["localization-bridge-schema", "itotori-db"];

export function clearBehaviorRuntimeBuilds(root) {
  for (const directory of RUNTIME_PACKAGE_DIRECTORIES) {
    const dist = resolve(root, "packages", directory, "dist");
    if (relative(root, dist) !== `packages/${directory}/dist`) {
      throw new Error(`behavior-runtime-clean-target-invalid:${directory}`);
    }
    rmSync(dist, { force: true, recursive: true });
  }
}

function materializeProductRuntime(root) {
  const productRoot = resolve(root, ".tmp", "behavior-proof", "glue", "product");
  const runtimeRoot = resolve(root, "node_modules", ".pnpm", "node_modules");
  if (!lstatSync(runtimeRoot).isDirectory())
    throw new Error("behavior-runtime-node-modules-invalid");
  for (const [name, expected] of [
    ["@itotori/db", resolve(root, "packages", "itotori-db")],
    [
      "@itotori/localization-bridge-schema",
      resolve(root, "packages", "localization-bridge-schema"),
    ],
  ]) {
    if (realpathSync(resolve(runtimeRoot, name)) !== realpathSync(expected)) {
      throw new Error(`behavior-runtime-workspace-link-invalid:${name}`);
    }
  }
  const modules = resolve(productRoot, "node_modules");
  rmSync(modules, { force: true, recursive: true });
  mkdirSync(resolve(modules, "@itotori", "localization-bridge-schema"), { recursive: true });
  cpSync(realpathSync(resolve(runtimeRoot, "zod")), resolve(modules, "zod"), {
    dereference: true,
    recursive: true,
  });
  const schemaRoot = resolve(root, "packages", "localization-bridge-schema");
  copyFileSync(
    resolve(schemaRoot, "package.json"),
    resolve(modules, "@itotori", "localization-bridge-schema", "package.json"),
  );
  cpSync(
    resolve(schemaRoot, "dist"),
    resolve(modules, "@itotori", "localization-bridge-schema", "dist"),
    { recursive: true },
  );
}

function materializeFailureRuntime(root) {
  const failureRoot = resolve(root, ".tmp", "behavior-proof", "glue", "failure-product");
  const runtimeRoot = resolve(root, "node_modules", ".pnpm", "node_modules");
  if (!lstatSync(runtimeRoot).isDirectory())
    throw new Error("behavior-runtime-node-modules-invalid");
  const modules = resolve(failureRoot, "node_modules");
  rmSync(modules, { force: true, recursive: true });
  symlinkSync(runtimeRoot, modules, "dir");
}

export function compileBehaviorGlue(root) {
  rmSync(resolve(root, ".tmp", "behavior-proof", "glue"), {
    force: true,
    recursive: true,
  });
  clearBehaviorRuntimeBuilds(root);
  runWorkspaceBuild(root, "@itotori/localization-bridge-schema");
  runWorkspaceBuild(root, "@itotori/db");
  runTypeScript(root, "suite/behavior/tsconfig.json");
  runTypeScript(root, "suite/behavior/tsconfig.product.json");
  runTypeScript(root, "suite/behavior/tsconfig.failure-product.json");
  materializeProductRuntime(root);
  materializeFailureRuntime(root);
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function productImplementationBinding(
  root,
  workRoot = resolve(root, ".tmp", "behavior-proof"),
) {
  const productRoot = resolve(workRoot, "glue", "product");
  const sourcePaths = [
    "suite/behavior/product/managed-artifact-boundary.ts",
    "suite/behavior/product/evidence-scenario-projection.ts",
    "suite/behavior/product/evidence-expectation-scenario-boundary.ts",
    "suite/behavior/product/evidence-product-fixture.ts",
    "packages/itotori-db/src/managed-artifact-refs.ts",
    "packages/itotori-db/src/localization-artifact-integrity.ts",
    "packages/localization-bridge-schema/src/synthetic-large-project.ts",
    "packages/localization-bridge-schema/src/linecap-schema/patch-compatibility-validation.ts",
    "packages/localization-bridge-schema/src/linecap-schema/runtime-evidence-validation.ts",
    "apps/itotori/src/patchback/bind-scoped-targets.ts",
    "apps/itotori/src/patchback/build-patch-export.ts",
  ].map((path) => resolve(root, path));
  const modulePath = resolve(productRoot, "packages/itotori-db/src/managed-artifact-refs.js");
  const boundaryPath = resolve(productRoot, "suite/behavior/product/managed-artifact-boundary.js");
  const buildHash = createHash("sha256");
  for (const path of filesBelow(productRoot).toSorted()) {
    buildHash.update(relative(productRoot, path));
    buildHash.update("\0");
    buildHash.update(readFileSync(path));
    buildHash.update("\n");
  }
  return {
    productSourceDigest: createHash("sha256")
      .update(sourcePaths.map((path) => `${relative(root, path)}\0${fileDigest(path)}`).join("\n"))
      .digest("hex"),
    productBuildDigest: buildHash.digest("hex"),
    boundaryPath,
    modulePath,
  };
}

export function computeBehaviorBuildDigest(
  root,
  workRoot = resolve(root, ".tmp", "behavior-proof"),
) {
  const hash = createHash("sha256");
  const files = [
    ...filesBelow(resolve(workRoot, "glue")),
    ...filesBelow(resolve(root, "packages/localization-bridge-schema/dist")),
    ...filesBelow(resolve(root, "packages/itotori-db/dist")),
    resolve(root, "packages/localization-bridge-schema/package.json"),
    resolve(root, "packages/itotori-db/package.json"),
    resolve(root, "pnpm-lock.yaml"),
  ].toSorted();
  for (const path of files) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\n");
  }
  hash.update(readFileSync(resolve(root, "node_modules/@cucumber/cucumber/package.json")));
  return hash.digest("hex");
}
