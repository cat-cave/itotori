#!/usr/bin/env node
// @itotori-meta-check
// Discover per-test CI ownership sidecars. A sidecar's path names its test, so
// adding an owned test changes that test and its adjacent declaration only.

import { execFileSync } from "node:child_process";
import { globSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");
export const TEST_OWNERSHIP_SCHEMA = "itotori.test-ownership.v1";
export const OWNERSHIP_SUFFIX = ".ownership.json";
export const DB_OWNED_LANE = "ci-tier1-db";
export const PORTABLE_APP_LANE = "ci-tier1-ts-public";
export const APP_SUITE_SHARDS = Object.freeze([
  "ci-tier1-ts-public-1of2",
  "ci-tier1-ts-public-2of2",
]);

const DIRECT_RECIPE_LANES = new Set(["ci-tier0-meta", "ci-tier1-ts-public-1of2"]);
const KNOWN_LANES = new Set([...DIRECT_RECIPE_LANES, PORTABLE_APP_LANE, DB_OWNED_LANE]);
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEST_FILE = /(?:^|\/)\S+\.test\.(?:[cm]?[jt]sx?)$/u;
const APP_TEST = /^apps\/itotori\/test\/\S+\.test\.(?:[cm]?[jt]sx?)$/u;
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`test-ownership-${label}-invalid`);
  }
  return value;
}

function requiredIdentifier(value, label) {
  const text = requiredText(value, label);
  if (!IDENTIFIER.test(text)) throw new Error(`test-ownership-${label}-invalid`);
  return text;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).toSorted(lexical);
  const sortedExpected = expected.toSorted(lexical);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`test-ownership-${label}-keys-invalid`);
  }
}

function existingFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`test-ownership-${label}-missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`test-ownership-${label}-type-invalid`);
  }
}

function parseClaim(value, label) {
  if (!isRecord(value)) throw new Error(`test-ownership-${label}-invalid`);
  exactKeys(value, ["id", "marker", "title"], label);
  return Object.freeze({
    id: requiredIdentifier(value.id, `${label}-id`),
    title: requiredText(value.title, `${label}-title`),
    marker: requiredText(value.marker, `${label}-marker`),
  });
}

function testPathFromSidecar(sidecarPath) {
  if (!sidecarPath.endsWith(OWNERSHIP_SUFFIX)) {
    throw new Error(`test-ownership-sidecar-name-invalid:${sidecarPath}`);
  }
  const test = sidecarPath.slice(0, -OWNERSHIP_SUFFIX.length);
  if (!TEST_FILE.test(test))
    throw new Error(`test-ownership-sidecar-test-name-invalid:${sidecarPath}`);
  return test;
}

function parseOwnership(contents, sidecarPath) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`test-ownership-json-invalid:${sidecarPath}`);
  }
  if (!isRecord(parsed)) throw new Error(`test-ownership-entry-invalid:${sidecarPath}`);
  const optional = [
    ...(Object.hasOwn(parsed, "coverage") ? ["coverage"] : []),
    ...(Object.hasOwn(parsed, "dbProof") ? ["dbProof"] : []),
    ...(Object.hasOwn(parsed, "recipeToken") ? ["recipeToken"] : []),
  ];
  exactKeys(parsed, ["lanes", "schema", ...optional], `entry:${sidecarPath}`);
  if (parsed.schema !== TEST_OWNERSHIP_SCHEMA) {
    throw new Error(`test-ownership-schema-invalid:${sidecarPath}`);
  }
  if (!Array.isArray(parsed.lanes) || !parsed.lanes.every((lane) => typeof lane === "string")) {
    throw new Error(`test-ownership-lanes-invalid:${sidecarPath}`);
  }
  const lanes = Object.freeze([...parsed.lanes]);
  const coverage =
    parsed.coverage === undefined
      ? undefined
      : parseClaim(parsed.coverage, `coverage:${sidecarPath}`);
  const dbProof =
    parsed.dbProof === undefined
      ? undefined
      : parseClaim(parsed.dbProof, `db-proof:${sidecarPath}`);
  const recipeToken =
    parsed.recipeToken === undefined
      ? undefined
      : requiredText(parsed.recipeToken, `recipe-token:${sidecarPath}`);
  return Object.freeze({
    sidecar: sidecarPath,
    test: testPathFromSidecar(sidecarPath),
    lanes,
    ...(coverage === undefined ? {} : { coverage }),
    ...(dbProof === undefined ? {} : { dbProof }),
    ...(recipeToken === undefined ? {} : { recipeToken }),
  });
}

function isInside(root, target) {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith("../");
}

function checkDescriptor(entry, root, { verifyTest = true, verifyMarkers = true } = {}) {
  if (verifyTest) {
    const testPath = resolve(root, entry.test);
    if (!isInside(root, testPath))
      throw new Error(`test-ownership-test-path-escapes:${entry.sidecar}`);
    existingFile(testPath, `test:${entry.test}`);
    if (verifyMarkers) {
      const contents = readFileSync(testPath, "utf8");
      for (const [kind, claim] of [
        ["coverage", entry.coverage],
        ["db-proof", entry.dbProof],
      ]) {
        if (claim !== undefined && !contents.includes(claim.marker)) {
          throw new Error(`test-ownership-${kind}-marker-missing:${entry.test}:${claim.marker}`);
        }
      }
    }
  }
  if (entry.recipeToken !== undefined && entry.coverage === undefined) {
    throw new Error(`test-ownership-recipe-token-without-coverage:${entry.test}`);
  }
}

function checkDuplicates(entries) {
  const tests = new Set();
  const categoryIds = new Set();
  const proofIds = new Set();
  for (const entry of entries) {
    if (tests.has(entry.test)) throw new Error(`test-ownership-duplicate-test:${entry.test}`);
    tests.add(entry.test);
    if (entry.coverage !== undefined) {
      if (categoryIds.has(entry.coverage.id)) {
        throw new Error(`test-ownership-duplicate-coverage:${entry.coverage.id}`);
      }
      categoryIds.add(entry.coverage.id);
    }
    if (entry.dbProof !== undefined) {
      if (proofIds.has(entry.dbProof.id)) {
        throw new Error(`test-ownership-duplicate-db-proof:${entry.dbProof.id}`);
      }
      proofIds.add(entry.dbProof.id);
    }
  }
}

export function discoverTestOwnership(root = repoRoot, options = {}) {
  const repositoryRoot = resolve(root);
  const sidecars = globSync("**/*.test.*.ownership.json", {
    cwd: repositoryRoot,
    exclude: ["**/.git/**", "**/.direnv/**", "**/dist/**", "**/node_modules/**"],
  }).toSorted(lexical);
  const entries = sidecars.map((sidecar) => {
    const path = resolve(repositoryRoot, sidecar);
    existingFile(path, `sidecar:${sidecar}`);
    const entry = parseOwnership(readFileSync(path, "utf8"), sidecar);
    checkDescriptor(entry, repositoryRoot, options);
    return entry;
  });
  checkDuplicates(entries);
  return Object.freeze(entries);
}

export function laneOwnershipFailures(entries) {
  const failures = [];
  for (const entry of entries) {
    if (entry.lanes.length === 0) {
      failures.push(`${entry.test}: owned by no lane`);
      continue;
    }
    if (entry.lanes.length !== 1) {
      failures.push(`${entry.test}: owned by multiple lanes (${entry.lanes.join(", ")})`);
      continue;
    }
    const [lane] = entry.lanes;
    if (!KNOWN_LANES.has(lane)) failures.push(`${entry.test}: unknown lane "${lane}"`);
    if (entry.dbProof !== undefined && lane !== DB_OWNED_LANE) {
      failures.push(`${entry.test}: DB proof must be owned by ${DB_OWNED_LANE}`);
    }
    if (lane === DB_OWNED_LANE && entry.dbProof === undefined) {
      failures.push(`${entry.test}: DB-owned lane needs dbProof`);
    }
    if (lane === DB_OWNED_LANE && !APP_TEST.test(entry.test)) {
      failures.push(`${entry.test}: DB-owned proof must live under apps/itotori/test/`);
    }
    if (lane === PORTABLE_APP_LANE && !APP_TEST.test(entry.test)) {
      failures.push(`${entry.test}: portable app proof must live under apps/itotori/test/`);
    }
    if (DIRECT_RECIPE_LANES.has(lane) && entry.recipeToken === undefined) {
      failures.push(`${entry.test}: direct recipe lane ${lane} needs recipeToken`);
    }
    if (!DIRECT_RECIPE_LANES.has(lane) && entry.recipeToken !== undefined) {
      failures.push(`${entry.test}: ${lane} cannot carry recipeToken`);
    }
  }
  return failures;
}

export function dbOwnedAppProofs(entries) {
  return Object.freeze(
    entries
      .filter(({ dbProof }) => dbProof !== undefined)
      .map(({ dbProof, test }) => ({
        proof: dbProof.id,
        title: dbProof.title,
        test,
        marker: dbProof.marker,
      }))
      .toSorted((left, right) => lexical(left.proof, right.proof)),
  );
}

export function dbOwnedAppTestFiles(entries) {
  return Object.freeze(
    dbOwnedAppProofs(entries).map(({ test }) => test.slice("apps/itotori/".length)),
  );
}

export function publicCoverageClaims(entries) {
  return Object.freeze(
    entries
      .filter(({ coverage }) => coverage !== undefined)
      .map(({ coverage, lanes, recipeToken, test }) => ({
        category: coverage.id,
        title: coverage.title,
        marker: coverage.marker,
        test,
        lanes,
        ...(recipeToken === undefined ? {} : { recipeToken }),
      }))
      .toSorted((left, right) => lexical(left.category, right.category)),
  );
}

export function ownershipForLane(entries, lane) {
  return Object.freeze(entries.filter((entry) => entry.lanes.includes(lane)));
}

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function ownershipAtRevision(root, revision) {
  const sidecars = (git(root, ["ls-tree", "-r", "--name-only", revision]) ?? "")
    .split("\n")
    .filter(
      (path) =>
        path.endsWith(OWNERSHIP_SUFFIX) && TEST_FILE.test(path.slice(0, -OWNERSHIP_SUFFIX.length)),
    )
    .toSorted(lexical);
  const entries = sidecars.map((sidecar) => {
    const contents = git(root, ["show", `${revision}:${sidecar}`]);
    if (contents === null) throw new Error(`test-ownership-baseline-read-failed:${sidecar}`);
    const entry = parseOwnership(contents, sidecar);
    checkDescriptor(entry, root, { verifyTest: false, verifyMarkers: false });
    return entry;
  });
  checkDuplicates(entries);
  return Object.freeze(entries);
}

export function mergeBaseOwnership(root = repoRoot) {
  const base = git(root, ["merge-base", "HEAD", "origin/main"]);
  if (base === null) throw new Error("test-ownership-cannot-establish-merge-base");
  return ownershipAtRevision(root, base);
}

function claimedIds(entries, key) {
  return new Set(entries.flatMap((entry) => (entry[key] === undefined ? [] : [entry[key].id])));
}

export function removedOwnershipClaims(current, baseline) {
  const failures = [];
  for (const [key, label] of [
    ["coverage", "public category"],
    ["dbProof", "DB-owned proof"],
  ]) {
    const currentIds = claimedIds(current, key);
    for (const id of claimedIds(baseline, key)) {
      if (!currentIds.has(id)) failures.push(`previously declared ${label} "${id}" is missing`);
    }
  }
  return failures;
}

export function runOwnershipGuard(root = repoRoot) {
  const entries = discoverTestOwnership(root);
  const baseline = mergeBaseOwnership(root);
  const head = ownershipAtRevision(root, "HEAD");
  return {
    entries,
    baseline,
    head,
    failures: [
      ...laneOwnershipFailures(entries),
      ...removedOwnershipClaims(entries, [...baseline, ...head]),
    ],
  };
}

function main() {
  try {
    const result = runOwnershipGuard();
    if (result.failures.length > 0) {
      process.stderr.write(
        `test ownership: FAILED.\n${result.failures.map((failure) => `  ${failure}`).join("\n")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `test ownership: passed. ${result.entries.length} discovered declarations; ` +
        `${result.baseline.length} at merge base and ${result.head.length} at HEAD.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `test ownership: FAILED. ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
