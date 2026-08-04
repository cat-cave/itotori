// Catalog replay ownership is declared beside each DB suite. Adding a replay
// proof changes that suite and its adjacent declaration, never a shared list.
import { globSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG_REPLAY_DB_SCHEMA = "itotori.catalog-replay-db-proof.v1";
export const CATALOG_REPLAY_DB_MARKER = "@itotori-catalog-replay-db";

const declarationSuffix = ".catalog-replay-db.json";
const testRoot = "packages/itotori-db/test";
const marker = new RegExp(`^\\s*//\\s*${CATALOG_REPLAY_DB_MARKER}\\s*$`, "mu");
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function requiredFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`catalog replay declaration ${label} is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`catalog replay declaration ${label} is invalid: ${path}`);
  }
}

function requiredDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`catalog replay declaration directory is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`catalog replay declaration directory is invalid: ${path}`);
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
    throw new Error(`catalog replay declaration is not valid JSON: ${relativePath}`);
  }
  const keys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value).toSorted(lexical)
      : [];
  if (keys.length !== 1 || keys[0] !== "schema" || value.schema !== CATALOG_REPLAY_DB_SCHEMA) {
    throw new Error(
      `catalog replay declaration must be { schema: ${CATALOG_REPLAY_DB_SCHEMA} }: ${relativePath}`,
    );
  }
}

/**
 * Discover the DB replay suites from adjacent declarations. A source marker
 * and a declaration are both required: deleting either one fails instead of
 * quietly shrinking the proof set.
 */
export function discoverCatalogReplaySuites(root = defaultRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("catalog replay declaration repository root is invalid");
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
  const declaredTests = new Set();

  for (const declaration of declarations) {
    const testFile = declaration.slice(0, -declarationSuffix.length);
    if (!testFile.endsWith(".test.ts")) {
      throw new Error(`catalog replay declaration is not adjacent to a DB suite: ${declaration}`);
    }
    if (declaredTests.has(testFile)) {
      throw new Error(`catalog replay suite has duplicate declarations: ${testFile}`);
    }
    const declarationPath = resolve(suitesRoot, declaration);
    const testPath = resolve(suitesRoot, testFile);
    requiredFile(declarationPath, "file");
    requiredFile(testPath, "suite");
    readDeclaration(declarationPath, `${testRoot}/${declaration}`);
    if (!markedTests.has(testFile)) {
      throw new Error(`catalog replay declaration has no matching source marker: ${testFile}`);
    }
    declaredTests.add(testFile);
  }

  for (const testFile of markedTests) {
    if (!declaredTests.has(testFile)) {
      throw new Error(`catalog replay suite has no adjacent declaration: ${testRoot}/${testFile}`);
    }
  }
  if (declaredTests.size === 0) {
    throw new Error("catalog replay declaration set is empty");
  }
  return Object.freeze(
    [...declaredTests].toSorted(lexical).map((file) =>
      Object.freeze({
        file,
        filter: file.replace(/\.test\.ts$/u, ""),
      }),
    ),
  );
}
