// Permission-denial DB suites declare themselves beside their test files.
// Adding a suite changes only that suite, its marker, and its declaration.
import { globSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PERMISSION_DENIAL_DB_SCHEMA = "itotori.permission-denial-db-proof.v1";
export const PERMISSION_DENIAL_DB_MARKER = "@itotori-permission-denial-db";

const declarationSuffix = ".permission-denial-db.json";
const testRoot = "packages/itotori-db/test";
const marker = new RegExp(`^\\s*//\\s*${PERMISSION_DENIAL_DB_MARKER}\\s*$`, "mu");
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function requiredFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`permission-denial declaration ${label} is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`permission-denial declaration ${label} is invalid: ${path}`);
  }
}

function requiredDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`permission-denial declaration directory is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`permission-denial declaration directory is invalid: ${path}`);
  }
}

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function readDeclaration(path, relativePath) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`permission-denial declaration is not valid JSON: ${relativePath}`);
  }
  const keys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value).toSorted(lexical)
      : [];
  if (
    keys.length !== 2 ||
    keys[0] !== "matrixExport" ||
    keys[1] !== "schema" ||
    value.schema !== PERMISSION_DENIAL_DB_SCHEMA ||
    typeof value.matrixExport !== "string" ||
    !identifier.test(value.matrixExport)
  ) {
    throw new Error(`permission-denial declaration must name a matrix export: ${relativePath}`);
  }
  return value.matrixExport;
}

/**
 * Discover permission-denial DB suites from adjacent declarations. A source
 * marker and declaration are both required, preventing a deleted declaration
 * from quietly shrinking the proof set.
 */
export function discoverPermissionDenialSuites(root = defaultRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("permission-denial declaration repository root is invalid");
  }
  const repositoryRoot = resolve(root);
  const suitesRoot = resolve(repositoryRoot, testRoot);
  requiredDirectory(suitesRoot);

  const testFiles = globSync("**/*.test.ts", { cwd: suitesRoot })
    .map(portablePath)
    .toSorted(lexical);
  const markedTests = new Set(
    testFiles.filter((testFile) => {
      const testPath = resolve(suitesRoot, testFile);
      requiredFile(testPath, "suite");
      return marker.test(readFileSync(testPath, "utf8"));
    }),
  );
  const declarations = globSync(`**/*${declarationSuffix}`, { cwd: suitesRoot })
    .map(portablePath)
    .toSorted(lexical);
  const suites = [];

  for (const declaration of declarations) {
    const file = declaration.slice(0, -declarationSuffix.length);
    if (!file.endsWith(".test.ts")) {
      throw new Error(
        `permission-denial declaration is not adjacent to a DB suite: ${declaration}`,
      );
    }
    const declarationPath = resolve(suitesRoot, declaration);
    const testPath = resolve(suitesRoot, file);
    requiredFile(declarationPath, "file");
    requiredFile(testPath, "suite");
    const matrixExport = readDeclaration(declarationPath, `${testRoot}/${declaration}`);
    if (!markedTests.has(file)) {
      throw new Error(`permission-denial declaration has no matching source marker: ${file}`);
    }
    suites.push(Object.freeze({ file, filter: file.replace(/\.test\.ts$/u, ""), matrixExport }));
  }

  const declared = new Set(suites.map(({ file }) => file));
  if (declared.size !== suites.length) {
    throw new Error("permission-denial suite has duplicate declarations");
  }
  for (const file of markedTests) {
    if (!declared.has(file)) {
      throw new Error(`permission-denial suite has no adjacent declaration: ${testRoot}/${file}`);
    }
  }
  if (suites.length === 0) throw new Error("permission-denial declaration set is empty");
  return Object.freeze(suites.toSorted((left, right) => lexical(left.file, right.file)));
}
