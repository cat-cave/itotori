#!/usr/bin/env node
// Compare the project control-plane surface with its merge-base snapshot.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
export const PREFIXED_NAME =
  /(?<![A-Za-z0-9_])(?:ITOTORI|KAIFUU|UTSUSHI)_[A-Z0-9_]+(?![A-Za-z0-9_])/g;
const SURFACE_MEASURES = [
  { field: "envVarNames", label: "env-var names" },
  { field: "justRecipes", label: "just recipes" },
];
const STATED_LIMITS =
  "stated limits: static tracked-text comparison with the merge-base; growth fails, while reductions are reported without blocking; dynamically constructed names, untracked files, recipe semantics, and other command surfaces are not counted.\n";

export function findEnvVarNames(contents) {
  return new Set([...contents.matchAll(PREFIXED_NAME)].map((match) => match[0]));
}

export function findRecipeNames(contents) {
  const names = new Set();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\s+[^:#]+)?\s*:/u);
    if (match !== null && !line.includes(":=")) names.add(match[1]);
  }
  return names;
}

export function listTrackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => {
      try {
        lstatSync(join(root, file));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
}

export function readTrackedFile(root, file) {
  const path = join(root, file);
  return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8");
}

export function measureSurface(root, files = listTrackedFiles(root)) {
  const names = new Set();
  for (const file of files) {
    const contents = readTrackedFile(root, file);
    for (const name of findEnvVarNames(contents)) names.add(name);
  }
  const justfile = readFileSync(join(root, "justfile"), "utf8");
  return { envVarNames: names.size, justRecipes: findRecipeNames(justfile).size };
}

export function readTrackedFileAtRevision(root, revision, file) {
  return execFileSync("git", ["show", `${revision}:${file}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readTrackedContentsAtRevision(root, revision) {
  const blobIds = execFileSync(
    "git",
    ["ls-tree", "-r", "--format=%(objecttype) %(objectname)", revision],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^blob ([0-9a-f]+)$/u);
      return match === null ? [] : [match[1]];
    });
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    encoding: "buffer",
    input: Buffer.from(blobIds.join("\n")),
    maxBuffer: 128 * 1024 * 1024,
  });
  const contents = [];
  let offset = 0;
  for (const blobId of blobIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error(`cannot read tracked blob ${blobId} at ${revision}`);
    const header = output.toString("utf8", offset, headerEnd);
    const match = header.match(/^([0-9a-f]+) blob (\d+)$/u);
    if (match === null || match[1] !== blobId) {
      throw new Error(`cannot read tracked blob ${blobId} at ${revision}`);
    }
    const start = headerEnd + 1;
    const end = start + Number.parseInt(match[2], 10);
    if (output[end] !== 0x0a) throw new Error(`truncated tracked blob ${blobId} at ${revision}`);
    contents.push(output.toString("utf8", start, end));
    offset = end + 1;
  }
  return contents;
}

export function measureSurfaceAtRevision(root, revision) {
  const names = new Set();
  for (const contents of readTrackedContentsAtRevision(root, revision)) {
    for (const name of findEnvVarNames(contents)) {
      names.add(name);
    }
  }
  const justfile = readTrackedFileAtRevision(root, revision, "justfile");
  return { envVarNames: names.size, justRecipes: findRecipeNames(justfile).size };
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

export function mergeBase(root) {
  const base = git(root, ["merge-base", "HEAD", "origin/main"]);
  if (base === null)
    throw new Error("cannot establish merge-base with origin/main for surface comparison");
  return base;
}

export function measureMergeBaseSurface(root) {
  const revision = mergeBase(root);
  return { revision, surface: measureSurfaceAtRevision(root, revision) };
}

export function evaluateSurface(actual, base) {
  const failures = [];
  for (const { field, label } of SURFACE_MEASURES) {
    const change = actual[field] - base[field];
    if (change > 0) {
      failures.push(`${label} grew: measured ${actual[field]}, merge-base ${base[field]}.`);
    }
  }
  return failures;
}

export function reportSurfaceReductions(actual, base) {
  const reductions = [];
  for (const { field, label } of SURFACE_MEASURES) {
    if (actual[field] < base[field]) {
      reductions.push(`${label} shrank: measured ${actual[field]}, merge-base ${base[field]}.`);
    }
  }
  return reductions;
}

function main() {
  if (process.argv.length > 2) {
    process.stderr.write("usage: node scripts/surface-budget.mjs\n");
    process.exitCode = 1;
    return;
  }
  let actual;
  let base;
  try {
    actual = measureSurface(repoRoot);
    base = measureMergeBaseSurface(repoRoot);
  } catch (error) {
    process.stderr.write(`surface budget: FAILED. ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const failures = evaluateSurface(actual, base.surface);
  const reductions = reportSurfaceReductions(actual, base.surface);
  if (failures.length > 0) {
    process.stderr.write(
      `surface budget: FAILED.\n${[...failures, ...reductions]
        .map((message) => `  ${message}`)
        .join("\n")}\n${STATED_LIMITS}`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `surface budget: passed. env-var names: ${actual.envVarNames}/${base.surface.envVarNames}; ` +
      `just recipes: ${actual.justRecipes}/${base.surface.justRecipes} (merge-base ${base.revision}).\n` +
      (reductions.length === 0
        ? ""
        : `${reductions.map((reduction) => `  ${reduction}`).join("\n")}\n`) +
      STATED_LIMITS,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
