#!/usr/bin/env node
// Proves every conventionally named TS/JS suite under packages/ and apps/ is
// collected by one configured Vitest project or named by the DB Node runner.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { databaseRunnerNodeTestFiles } from "../packages/itotori-db/scripts/test-file-manifest.mjs";
import { DB_OWNED_APP_PROOFS } from "./ci/db-owned-app-proofs.mjs";
import { liveEvidenceSuites } from "./live-evidence-suite-manifest.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFilePattern = /\.test\.(?:[cm]?[jt]sx?)$/u;
const appTestPrefix = "apps/itotori/test/";
const appLiveEvidenceVitestPrefix = "apps/itotori/test/live-evidence/";
const appLiveEvidencePlaywrightPrefix = "apps/itotori/e2e/live-evidence/";

const vitestProjects = [
  "packages/localization-bridge-schema",
  "packages/itotori-db",
  "packages/itotori-ds",
  "apps/itotori",
  "apps/runtime-web-review",
];

export async function listOnDiskTestFiles(root = repoRoot) {
  const files = [];
  for (const directory of ["packages", "apps"]) {
    await collectTestFiles(path.join(root, directory), root, files);
  }
  return files.sort();
}

async function collectTestFiles(directory, root, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(absolutePath, root, files);
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(path.relative(root, absolutePath));
    }
  }
}

export function checkCollection(onDisk, collected) {
  const missing = onDisk.filter((file) => !collected.has(file));
  return { missing, onDiskCount: onDisk.length, collectedCount: collected.size };
}

// DB-backed app suites are absent from the portable Vitest project only
// because ci-tier1-db invokes every exact manifest path with a live database.
// Keep this ownership beside private-evidence ownership so an exclusion cannot
// become an uncollected green result.
export function applyExplicitDbOwnership({
  publicCollected,
  proofs = DB_OWNED_APP_PROOFS,
  fileExists = (file) => existsSync(path.join(repoRoot, file)),
}) {
  const namedFiles = new Set();
  for (const proof of proofs) {
    if (namedFiles.has(proof.test)) {
      throw new Error(`test collection guard: duplicate DB-owned suite ${proof.test}`);
    }
    namedFiles.add(proof.test);
    if (!fileExists(proof.test)) {
      throw new Error(`test collection guard: DB-owned suite does not exist: ${proof.test}`);
    }
    if (!proof.test.startsWith(appTestPrefix)) {
      throw new Error(
        `test collection guard: DB-owned suite is outside the app test directory: ${proof.test}`,
      );
    }
    if (publicCollected.has(proof.test)) {
      throw new Error(
        `test collection guard: public Vitest configuration must exclude DB-owned suite ${proof.test}`,
      );
    }
  }
  return new Set([...publicCollected, ...namedFiles]);
}

// A public Vitest omission is valid only when the manifest owns the exact file
// in a named private-evidence runner. This prevents an excluded test from
// becoming a false-green no-lane test while still allowing public collection
// to remain secretless.
export function applyExplicitLiveEvidenceOwnership({
  onDisk,
  publicCollected,
  suites = liveEvidenceSuites,
  fileExists = (file) => existsSync(path.join(repoRoot, file)),
}) {
  const namedFiles = new Set();
  for (const suite of suites) {
    if (namedFiles.has(suite.file)) {
      throw new Error(`test collection guard: duplicate named live evidence suite ${suite.file}`);
    }
    namedFiles.add(suite.file);
    if (!fileExists(suite.file)) {
      throw new Error(
        `test collection guard: named live evidence suite does not exist: ${suite.file}`,
      );
    }
    if (suite.framework === "vitest") {
      if (!suite.file.startsWith(appLiveEvidenceVitestPrefix)) {
        throw new Error(
          `test collection guard: Vitest live evidence is outside its named directory: ${suite.file}`,
        );
      }
      if (publicCollected.has(suite.file)) {
        throw new Error(
          `test collection guard: public Vitest configuration must exclude named live evidence suite ${suite.file}`,
        );
      }
    } else if (suite.framework === "playwright") {
      if (!suite.file.startsWith(appLiveEvidencePlaywrightPrefix)) {
        throw new Error(
          `test collection guard: Playwright live evidence is outside its named directory: ${suite.file}`,
        );
      }
    } else {
      throw new Error(`test collection guard: unknown live evidence framework ${suite.framework}`);
    }
  }

  for (const file of onDisk) {
    if (file.startsWith(appLiveEvidenceVitestPrefix) && !namedFiles.has(file)) {
      throw new Error(`test collection guard: excluded live evidence has no named owner: ${file}`);
    }
  }

  return new Set([...publicCollected, ...namedFiles]);
}

export async function collectConfiguredTestFiles(root = repoRoot) {
  const outputDirectory = await makeOutputDirectory();
  try {
    const collected = new Set();
    for (const project of vitestProjects) {
      const reportPath = path.join(outputDirectory, `${project.replaceAll("/", "-")}.json`);
      await execFileAsync("pnpm", ["exec", "vitest", "list", "--filesOnly", "--json", reportPath], {
        cwd: path.join(root, project),
      });
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      for (const result of report) {
        if (typeof result.file === "string") {
          collected.add(path.relative(root, result.file));
        }
      }
    }
    for (const file of databaseRunnerNodeTestFiles) {
      collected.add(path.join("packages/itotori-db", file));
    }
    return collected;
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}

async function makeOutputDirectory() {
  const prefix = path.join(tmpdir(), "itotori-test-collection-");
  return mkdtemp(prefix);
}

async function main() {
  const onDisk = await listOnDiskTestFiles();
  const publicCollected = await collectConfiguredTestFiles();
  const dbOwnedCollected = applyExplicitDbOwnership({
    publicCollected,
    fileExists: (file) => existsSync(path.join(repoRoot, file)),
  });
  const collected = applyExplicitLiveEvidenceOwnership({
    onDisk,
    publicCollected: dbOwnedCollected,
    fileExists: (file) => existsSync(path.join(repoRoot, file)),
  });
  const result = checkCollection(onDisk, collected);
  if (result.missing.length > 0) {
    throw new Error(
      `test collection guard: ${result.missing.length}/${result.onDiskCount} suite file(s) are not collected:\n` +
        result.missing.map((file) => `- ${file}`).join("\n"),
    );
  }
  console.log(
    `test collection guard: ${result.onDiskCount} on disk, ${publicCollected.size} public collection receipt(s), ` +
      `${result.collectedCount - publicCollected.size} explicit non-public owner(s), 0 uncollected`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
