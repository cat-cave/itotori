// Node-runner ownership is declared beside each test. Adding a test requires
// only the test and `<test>.node-runner.json`, never a shared list edit.
import { globSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const declarationSuffix = ".node-runner.json";
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function requiredDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`database node-runner directory is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`database node-runner directory is invalid: ${path}`);
  }
}

function requiredFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`database node-runner ${label} is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`database node-runner ${label} is invalid: ${path}`);
  }
}

function isNodeRunnerDeclaration(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).toSorted(lexical);
  return keys.length === 1 && keys[0] === "runner" && value.runner === "node:test";
}

function readDeclaration(path, relativePath) {
  let declaration;
  try {
    declaration = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`database node-runner declaration is not valid JSON: ${relativePath}`);
  }
  if (!isNodeRunnerDeclaration(declaration)) {
    throw new Error(
      `database node-runner declaration must be { runner: node:test }: ${relativePath}`,
    );
  }
}

export function discoverDatabaseRunnerNodeTestFiles(root = defaultRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("database node-runner root is invalid");
  }
  const packageRoot = resolve(root);
  const scriptsRoot = resolve(packageRoot, "scripts");
  requiredDirectory(scriptsRoot);

  const declaredTestFiles = new Set();
  const declarations = globSync(`scripts/**/*${declarationSuffix}`, { cwd: packageRoot })
    .map(portablePath)
    .toSorted(lexical);
  for (const declaration of declarations) {
    const testFile = declaration.slice(0, -declarationSuffix.length);
    if (!testFile.endsWith(".test.mjs")) {
      throw new Error(
        `database node-runner declaration is not adjacent to a Node test: ${declaration}`,
      );
    }
    if (declaredTestFiles.has(testFile)) {
      throw new Error(`database node-runner test has duplicate declarations: ${testFile}`);
    }
    declaredTestFiles.add(testFile);
    requiredFile(resolve(packageRoot, declaration), "declaration");
    requiredFile(resolve(packageRoot, testFile), "test");
    readDeclaration(resolve(packageRoot, declaration), declaration);
  }

  const testFiles = globSync("scripts/**/*.test.mjs", { cwd: packageRoot })
    .map(portablePath)
    .toSorted(lexical);
  for (const testFile of testFiles) {
    if (!declaredTestFiles.has(testFile)) {
      throw new Error(`database node-runner test has no adjacent declaration: ${testFile}`);
    }
  }
  if (testFiles.length === 0) throw new Error("database node-runner has no declared tests");
  return Object.freeze(testFiles);
}

// Keep the public API importable for the test-collection guard and DB runner.
export const databaseRunnerNodeTestFiles = discoverDatabaseRunnerNodeTestFiles();
