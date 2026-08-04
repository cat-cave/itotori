// Private-evidence ownership is declared beside each test, then derived here.
// Adding a suite means adding its test and `<test>.live-evidence.json`; no
// shared registry needs an edit.
import { globSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = "apps/itotori/";
const declarationSuffix = ".live-evidence.json";
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const liveEvidenceRoots = Object.freeze([
  Object.freeze({
    directory: "apps/itotori/test/live-evidence",
    framework: "vitest",
    testFilePattern: /\.test\.ts$/u,
    testGlob: "**/*.test.ts",
  }),
  Object.freeze({
    directory: "apps/itotori/e2e/live-evidence",
    framework: "playwright",
    testFilePattern: /\.e2e\.ts$/u,
    testGlob: "**/*.e2e.ts",
  }),
]);

const frameworkForRunner = Object.freeze({
  "real-bytes": "vitest",
  "model-profile": "vitest",
  "browser-real-bytes": "playwright",
});

export const LIVE_EVIDENCE_RUNNERS = Object.freeze(Object.keys(frameworkForRunner));

function requiredDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`live evidence ${label} is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`live evidence ${label} is not a directory: ${path}`);
  }
}

function requiredFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`live evidence ${label} is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`live evidence ${label} is not a file: ${path}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function readRunnerDeclaration(path, relativePath) {
  let declaration;
  try {
    declaration = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`live evidence declaration is not valid JSON: ${relativePath}`);
  }
  const keys = isRecord(declaration) ? Object.keys(declaration).toSorted(lexical) : [];
  if (keys.length !== 1 || keys[0] !== "runner" || typeof declaration.runner !== "string") {
    throw new Error(`live evidence declaration must contain only a runner: ${relativePath}`);
  }
  return declaration.runner;
}

function compareSuites(left, right) {
  const runnerDifference =
    LIVE_EVIDENCE_RUNNERS.indexOf(left.runner) - LIVE_EVIDENCE_RUNNERS.indexOf(right.runner);
  return runnerDifference === 0 ? lexical(left.file, right.file) : runnerDifference;
}

function suitesFromRoot(repositoryRoot, root) {
  const evidenceRoot = resolve(repositoryRoot, root.directory);
  requiredDirectory(evidenceRoot, "suite directory");

  const declaredTestFiles = new Set();
  const sidecars = globSync(`**/*${declarationSuffix}`, { cwd: evidenceRoot })
    .map(portablePath)
    .toSorted(lexical);
  const suites = sidecars.map((sidecar) => {
    const testFile = sidecar.slice(0, -declarationSuffix.length);
    const relativeFile = `${root.directory}/${testFile}`;
    if (!root.testFilePattern.test(testFile)) {
      throw new Error(`live evidence declaration is not adjacent to a suite: ${relativeFile}`);
    }
    if (declaredTestFiles.has(testFile)) {
      throw new Error(`live evidence suite has duplicate declarations: ${relativeFile}`);
    }
    declaredTestFiles.add(testFile);

    const declarationPath = resolve(evidenceRoot, sidecar);
    const testPath = resolve(evidenceRoot, testFile);
    requiredFile(declarationPath, "declaration");
    requiredFile(testPath, "suite");

    const runner = readRunnerDeclaration(declarationPath, relativeFile);
    const expectedFramework = frameworkForRunner[runner];
    if (expectedFramework === undefined) {
      throw new Error(`live evidence declaration has unknown runner ${JSON.stringify(runner)}`);
    }
    if (expectedFramework !== root.framework) {
      throw new Error(
        `live evidence declaration routes ${relativeFile} to ${runner}, which requires ${expectedFramework}`,
      );
    }
    return Object.freeze({
      file: relativeFile,
      framework: root.framework,
      runner,
    });
  });

  const onDiskTestFiles = globSync(root.testGlob, { cwd: evidenceRoot })
    .map(portablePath)
    .toSorted(lexical);
  for (const testFile of onDiskTestFiles) {
    if (!declaredTestFiles.has(testFile)) {
      throw new Error(
        `live evidence suite has no adjacent declaration: ${root.directory}/${testFile}`,
      );
    }
  }
  return suites;
}

export function discoverLiveEvidenceSuites(root = defaultRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("live evidence repository root is invalid");
  }
  const suites = liveEvidenceRoots.flatMap((evidenceRoot) =>
    suitesFromRoot(resolve(root), evidenceRoot),
  );
  const namedFiles = new Set();
  for (const suite of suites) {
    if (namedFiles.has(suite.file)) {
      throw new Error(`live evidence suite is declared more than once: ${suite.file}`);
    }
    namedFiles.add(suite.file);
  }
  for (const runner of LIVE_EVIDENCE_RUNNERS) {
    if (!suites.some((suite) => suite.runner === runner)) {
      throw new Error(`live evidence runner has no declared suite: ${runner}`);
    }
  }
  return Object.freeze(suites.toSorted(compareSuites));
}

export const liveEvidenceSuites = discoverLiveEvidenceSuites();

export const appLiveEvidenceVitestFiles = Object.freeze(
  liveEvidenceSuites
    .filter((suite) => suite.framework === "vitest")
    .map((suite) => suite.file.slice(appRoot.length)),
);

export const appLiveEvidencePlaywrightFiles = Object.freeze(
  liveEvidenceSuites
    .filter((suite) => suite.framework === "playwright")
    .map((suite) => suite.file.slice(appRoot.length)),
);

export const appLiveEvidencePlaywrightTestPaths = Object.freeze(
  appLiveEvidencePlaywrightFiles.map((file) => file.slice("e2e/".length)),
);

export function publicAppVitestExclusionArguments() {
  return appLiveEvidenceVitestFiles.flatMap((file) => ["--exclude", file]);
}

export function suitesForLiveEvidenceRunner(runner) {
  if (!LIVE_EVIDENCE_RUNNERS.includes(runner)) {
    throw new Error(`unknown live evidence runner ${JSON.stringify(runner)}`);
  }
  return liveEvidenceSuites.filter((suite) => suite.runner === runner);
}

export function isManifestOwnedLiveEvidenceFile(file) {
  return liveEvidenceSuites.some((suite) => suite.file === file);
}
