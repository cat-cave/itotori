#!/usr/bin/env node
// Proves every conventionally named TS/JS suite under packages/ and apps/ is
// collected by one configured Vitest project or named by the DB Node runner.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { databaseRunnerNodeTestFiles } from "../packages/itotori-db/scripts/test-file-manifest.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFilePattern = /\.test\.(?:[cm]?[jt]sx?)$/u;

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
  const collected = await collectConfiguredTestFiles();
  const result = checkCollection(onDisk, collected);
  if (result.missing.length > 0) {
    throw new Error(
      `test collection guard: ${result.missing.length}/${result.onDiskCount} suite file(s) are not collected:\n` +
        result.missing.map((file) => `- ${file}`).join("\n"),
    );
  }
  console.log(
    `test collection guard: ${result.onDiskCount} on disk, ${result.collectedCount} collected, 0 uncollected`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
