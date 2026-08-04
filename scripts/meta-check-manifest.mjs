// Meta checks are declared beside their owner. The source marker makes an
// omitted declaration a hard failure instead of silently dropping coverage.
import { spawnSync } from "node:child_process";
import { globSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const META_CHECK_SCHEMA = "itotori.meta-check.v1";
export const META_CHECK_MARKER = "@itotori-meta-check";

const declarationSuffix = ".meta-check.json";
const marker = new RegExp(`^\\s*//\\s*${META_CHECK_MARKER}\\s*$`, "mu");
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function portablePath(value) {
  return value.replaceAll("\\\\", "/");
}

function requiredFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`meta check ${label} is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`meta check ${label} is invalid: ${path}`);
  }
}

function sourceFiles(root) {
  return ["scripts/**/*.mjs", "fixtures/**/*.mjs", "packages/*/test/**/*.ts"]
    .flatMap((pattern) => globSync(pattern, { cwd: root }))
    .map(portablePath)
    .toSorted(lexical);
}

function markedSources(root) {
  const marked = new Set();
  for (const source of sourceFiles(root)) {
    const sourcePath = resolve(root, source);
    requiredFile(sourcePath, "source");
    if (marker.test(readFileSync(sourcePath, "utf8"))) marked.add(source);
  }
  return marked;
}

function readDeclaration(path, declaration) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`meta check declaration is not valid JSON: ${declaration}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`meta check declaration is invalid: ${declaration}`);
  }
  const keys = Object.keys(value).toSorted(lexical);
  const hasArgs = Object.hasOwn(value, "args");
  const expected = hasArgs ? ["args", "kind", "schema"] : ["kind", "schema"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.schema !== META_CHECK_SCHEMA ||
    typeof value.kind !== "string" ||
    (hasArgs &&
      (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string")))
  ) {
    throw new Error(`meta check declaration is invalid: ${declaration}`);
  }
  return Object.freeze({
    kind: value.kind,
    args: hasArgs ? Object.freeze([...value.args]) : undefined,
  });
}

function packageVitestArguments(root, owner) {
  const match = /^packages\/([^/]+)\/test\/(.+\.test\.ts)$/u.exec(owner);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`meta package-vitest owner is invalid: ${owner}`);
  }
  const packageManifest = resolve(root, "packages", match[1], "package.json");
  requiredFile(packageManifest, "package manifest");
  let packageValue;
  try {
    packageValue = JSON.parse(readFileSync(packageManifest, "utf8"));
  } catch {
    throw new Error(
      `meta package manifest is not valid JSON: ${portablePath(relative(root, packageManifest))}`,
    );
  }
  if (typeof packageValue?.name !== "string" || packageValue.name.length === 0) {
    throw new Error(
      `meta package manifest has no package name: ${portablePath(relative(root, packageManifest))}`,
    );
  }
  return Object.freeze([
    "--filter",
    packageValue.name,
    "exec",
    "vitest",
    "run",
    `test/${match[2]}`,
    "--exclude",
    "**/.direnv/**",
  ]);
}

function commandFor(root, entry) {
  if (entry.kind === "node-test") {
    if (!entry.owner.endsWith(".test.mjs") || entry.args !== undefined) {
      throw new Error(`meta node-test declaration is invalid: ${entry.declaration}`);
    }
    return Object.freeze({ command: "node", args: Object.freeze(["--test", entry.owner]) });
  }
  if (entry.kind === "node-script") {
    if (!entry.owner.endsWith(".mjs") || entry.owner.endsWith(".test.mjs")) {
      throw new Error(`meta node-script declaration is invalid: ${entry.declaration}`);
    }
    return Object.freeze({
      command: "node",
      args: Object.freeze([entry.owner, ...(entry.args ?? [])]),
    });
  }
  if (entry.kind === "package-vitest") {
    if (entry.args !== undefined) {
      throw new Error(`meta package-vitest declaration is invalid: ${entry.declaration}`);
    }
    return Object.freeze({ command: "pnpm", args: packageVitestArguments(root, entry.owner) });
  }
  throw new Error(`meta check declaration has unknown kind: ${entry.declaration}`);
}

function sortKey(entry) {
  const owner = entry.owner.replace(/\.test\.(?:mjs|ts)$/u, "").replace(/\.mjs$/u, "");
  const priority = entry.kind === "node-script" ? "1" : "0";
  return `${owner}\u0000${priority}\u0000${entry.owner}`;
}

/**
 * Discover all enrolled meta checks. A source marker and an adjacent
 * declaration must occur together, so deleting either one fails closed.
 */
export function discoverMetaChecks(root = defaultRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("meta check repository root is invalid");
  }
  const repositoryRoot = resolve(root);
  const marked = markedSources(repositoryRoot);
  const declarations = globSync(`**/*${declarationSuffix}`, { cwd: repositoryRoot })
    .map(portablePath)
    .toSorted(lexical);
  const declared = new Set();
  const checks = [];
  for (const declaration of declarations) {
    const owner = declaration.slice(0, -declarationSuffix.length);
    const declarationPath = resolve(repositoryRoot, declaration);
    const ownerPath = resolve(repositoryRoot, owner);
    requiredFile(declarationPath, "declaration");
    requiredFile(ownerPath, "source");
    if (declared.has(owner)) {
      throw new Error(`meta check has duplicate declarations: ${owner}`);
    }
    if (!marked.has(owner)) {
      throw new Error(`meta check declaration has no matching source marker: ${owner}`);
    }
    const value = readDeclaration(declarationPath, declaration);
    const entry = Object.freeze({ declaration, owner, ...value });
    checks.push(Object.freeze({ ...entry, ...commandFor(repositoryRoot, entry) }));
    declared.add(owner);
  }
  for (const owner of marked) {
    if (!declared.has(owner)) {
      throw new Error(`meta check source has no adjacent declaration: ${owner}`);
    }
  }
  if (checks.length === 0) throw new Error("meta check declaration set is empty");
  return Object.freeze(checks.toSorted((left, right) => lexical(sortKey(left), sortKey(right))));
}

export function runMetaChecks(root = defaultRoot, execute = spawnSync) {
  const checks = discoverMetaChecks(root);
  for (const check of checks) {
    const result = execute(check.command, check.args, { cwd: resolve(root), stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`meta check failed: ${check.command} ${check.args.join(" ")}`);
    }
  }
  return checks;
}

function main() {
  const checks = runMetaChecks(process.cwd());
  console.log(`meta checks: passed. ${checks.length} discovered declarations.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
