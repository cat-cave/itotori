#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { writeFixtureContent } from "./generate-kaifuu-encrypted-public-fixtures-content.mjs";
import { stableJson } from "./generate-kaifuu-encrypted-public-fixtures-helpers.mjs";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveFixtureRoot = resolve(repoRoot, "fixtures/public/kaifuu-encrypted-matrix");
const liveManifestPath = resolve(repoRoot, "fixtures/public/kaifuu-encrypted-matrix.manifest.json");
const checkMode = process.argv.includes("--check");
// Cached kaifuu-cli cargo runner (see cargoRunner() below). Declared here — above
// the top-level driver code — so it is initialized before any call to cargoRunner.
let cargoRunnerCached;
const stagingRoot = mkdtempSync(join(tmpdir(), "itotori-kaifuu-encrypted-matrix-"));
const fixtureRoot = resolve(stagingRoot, "kaifuu-encrypted-matrix");
const manifestPath = resolve(stagingRoot, "kaifuu-encrypted-matrix.manifest.json");
let promotionSequence = 0;

// The generator may throw from any command. Exit handlers are synchronous, so
// this removes the unique staging tree for both successful and failed runs
// without ever touching the live fixture tree before promotion.
process.once("exit", () => {
  rmSync(stagingRoot, { recursive: true, force: true });
});

const originalFixtureTree = checkMode ? snapshotTree(liveFixtureRoot) : null;
const originalManifest =
  checkMode && existsSync(liveManifestPath) ? readFileSync(liveManifestPath) : null;

// Expected outputs that are still AUTHORED by their originating command rather
// than re-derived here. This generator owns the raw fixture bytes those commands
// read, so these non-Siglus reports remain preserved byte-for-byte across a
// regeneration instead of being wiped with the rest of the fixture tree.
//
// Preservation is REQUIRED: reading a missing committed expected output throws
// (see `readRequiredExpectedOutput`), so regenerating after a preserved report is
// deleted fails loudly instead of silently staling the fixture matrix.
const preservedExpectedOutputs = [
  "expected/xp3-compressed-detector-profile-v0.1.json",
  "expected/xp3-encrypted-detector-profile-v0.1.json",
  "expected/xp3-plain-detector-profile-v0.1.json",
  "expected/xp3-unknown-detection-report-v0.1.json",
  "expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
].map((relativePath) => ({
  relativePath,
  content: readRequiredExpectedOutput(relativePath),
}));

const files = [];

writeFixtureContent({
  preservedExpectedOutputs,
  writeBytes,
  writeJson,
  writeText,
});

writeSiglusExpectedOutputs();
writeManifest();
if (checkMode) {
  checkForDrift(originalFixtureTree, originalManifest);
} else {
  promoteStaging();
}

function writeManifest() {
  const manifest = {
    $schema: "./manifest.schema.json",
    schemaVersion: "0.1.0",
    fixture: {
      id: "kaifuu-encrypted-matrix",
      title: "Kaifuu Synthetic Encrypted Matrix",
      kind: "synthetic",
      summary:
        "Generated public fixture-only encrypted, packed, missing-key, helper-required, validation-failed, redaction, parser-boundary, and unknown archive detector cases.",
      sourceLocale: "ja-JP",
      targetLocales: [],
      publicRedistribution: "allowed",
      license: {
        spdx: "CC0-1.0",
        evidence:
          "Generated synthetic bytes and JSON authored in-repository by fixtures/generate-kaifuu-encrypted-public-fixtures.mjs.",
      },
      provenance: {
        author: "Kaifuu fixture authors",
        creationMethod:
          "Deterministic generator writes tiny synthetic archive-like byte strings, public fixture-only key labels, helper results, negative profile fixtures, preserved XP3/RPG Maker expected outputs, and command-regenerated Siglus detector/profile/inventory/parser-boundary expected outputs.",
        rawAssetPolicy: "contains-no-copyrighted-game-assets",
      },
    },
    files: files
      .map((file) => {
        const path = resolve(fixtureRoot, fixtureRelativePath(file.path));
        const content = Buffer.from(readFile(path));
        return {
          ...file,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: statSync(path).size,
          redistributable: true,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path)),
    aggregateStats: {
      files: files.length,
      textUnits: 0,
      sourceTextUtf16CodeUnits: 0,
      protectedSpans: 0,
      sourceLocales: ["ja-JP"],
      targetLocales: [],
      engineKinds: [
        "bgi-ethornell-synthetic-container",
        "kiri-kiri-xp3-synthetic-archive-profile-matrix",
        "rpg-maker-mv-mz-synthetic-encrypted-assets",
        "siglus-synthetic-scene-pck",
        "wolf-rpg-editor-synthetic-archive",
        "unknown-synthetic-archive-signals",
      ],
      notes:
        "All bytes are generated fixture-only data. Public helper results cover missing_key, helper_required, helper_unavailable, validation_failed, and redaction_failure paths; XP3 and Siglus detector expected outputs cover identify/profile/inventory-only boundaries; Siglus parser-boundary output covers key-ref-only known-key smoke slots and diagnostics; negative profiles cover raw-key-looking and private-path-looking secret refs.",
    },
    benchmarkUse: {
      allowedInPublicCi: true,
      allowedInPublicReports: true,
      reportingLabel: "public:kaifuu-encrypted-matrix",
    },
  };
  writeFile(manifestPath, stableJson(manifest));
}

function writeJson(relativePath, value, role, mediaType = "application/json") {
  writeText(relativePath, stableJson(value), role, mediaType);
}

function writeText(relativePath, text, role, mediaType) {
  writeBytes(relativePath, Buffer.from(text, "utf8"), role, mediaType);
}

function writeBytes(relativePath, content, role, mediaType) {
  const path = resolve(fixtureRoot, relativePath);
  writeFile(path, content);
  files.push({
    path: `fixtures/public/kaifuu-encrypted-matrix/${relativePath}`,
    role,
    mediaType,
  });
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function readFile(path) {
  return readFileSync(path);
}

function readRequiredExpectedOutput(relativePath) {
  const path = resolve(liveFixtureRoot, relativePath);
  try {
    return readFileSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `missing committed expected output fixtures/public/kaifuu-encrypted-matrix/${relativePath}; ` +
          "this generator preserves (does not re-derive) this command-authored expected report, so regenerate " +
          "only from a tree that still contains it (or restore from git).",
      );
    }
    throw error;
  }
}

function writeSiglusExpectedOutputs() {
  writeCommandExpectedOutput("expected/siglus-detection-report-v0.1.json", [
    "detect",
    resolve(fixtureRoot, "raw/siglus"),
    "--output",
    resolve(fixtureRoot, "expected/siglus-detection-report-v0.1.json"),
  ]);
  writeCommandExpectedOutput("expected/siglus-detector-profile-v0.1.json", [
    "profile",
    "init",
    resolve(fixtureRoot, "raw/siglus"),
    "--output",
    resolve(fixtureRoot, "expected/siglus-detector-profile-v0.1.json"),
  ]);
  writeCommandExpectedOutput("expected/siglus-asset-inventory-v0.1.json", [
    "asset-inventory",
    resolve(fixtureRoot, "raw/siglus"),
    "--output",
    resolve(fixtureRoot, "expected/siglus-asset-inventory-v0.1.json"),
  ]);
  writeCommandExpectedOutput("expected/siglus-parser-boundary-smoke-v0.1.json", [
    "siglus",
    "parser-boundary-smoke",
    "--scene",
    resolve(fixtureRoot, "raw/siglus/Scene.pck"),
    "--gameexe",
    resolve(fixtureRoot, "raw/siglus/Gameexe.dat"),
    "--key-request",
    resolve(
      repoRoot,
      "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    ),
    "--output",
    resolve(fixtureRoot, "expected/siglus-parser-boundary-smoke-v0.1.json"),
  ]);
}

// Resolve how to invoke `cargo` for kaifuu-cli fixture regeneration. Locally we
// enter the nix devshell via `direnv exec .` so the pinned toolchain + shared
// CARGO_TARGET_DIR are used. On the hosted CI runner direnv/nix are absent but
// `cargo` is on PATH (the dtolnay toolchain honoring rust-toolchain.toml), so we
// invoke cargo directly — spawning `direnv` there fails with ENOENT and false-
// reds `just check`. Probed once and cached (the cache var is declared at the
// top of the file so top-level driver code can call this before this point).
function cargoRunner() {
  if (cargoRunnerCached === undefined) {
    let hasDirenv = false;
    try {
      execFileSync("direnv", ["version"], { stdio: "ignore" });
      hasDirenv = true;
    } catch {
      hasDirenv = false;
    }
    cargoRunnerCached = hasDirenv
      ? { command: "direnv", prefix: ["exec", ".", "cargo"] }
      : { command: "cargo", prefix: [] };
  }
  return cargoRunnerCached;
}

function writeCommandExpectedOutput(relativePath, args) {
  if (
    process.argv.includes("--fail-first-siglus-command") &&
    relativePath === "expected/siglus-detection-report-v0.1.json"
  ) {
    throw new Error("test-only injected failure before the first Siglus fixture command");
  }
  mkdirSync(dirname(resolve(fixtureRoot, relativePath)), { recursive: true });
  const runner = cargoRunner();
  execFileSync(
    runner.command,
    [...runner.prefix, "run", "--quiet", "-p", "kaifuu-cli", "--", ...args],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  files.push({
    path: `fixtures/public/kaifuu-encrypted-matrix/${relativePath}`,
    role: "expected-output",
    mediaType: "application/json",
  });
}

function snapshotTree(root) {
  const entries = new Map();
  if (!existsSync(root)) {
    return entries;
  }
  for (const relativePath of listFiles(root)) {
    entries.set(relativePath, readFileSync(resolve(root, relativePath)));
  }
  return entries;
}

function listFiles(root, relativeDir = "") {
  const dir = resolve(root, relativeDir);
  const filesInDir = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      filesInDir.push(...listFiles(root, relativePath));
    } else if (entry.isFile()) {
      filesInDir.push(relativePath);
    }
  }
  return filesInDir.sort((left, right) => left.localeCompare(right));
}

function checkForDrift(originalFiles, originalManifestBytes) {
  const regeneratedFiles = snapshotTree(fixtureRoot);
  const problems = compareFileMaps(
    originalFiles,
    regeneratedFiles,
    "fixtures/public/kaifuu-encrypted-matrix",
  );
  const regeneratedManifestBytes = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  if (!buffersEqual(originalManifestBytes, regeneratedManifestBytes)) {
    problems.push("fixtures/public/kaifuu-encrypted-matrix.manifest.json changed");
  }

  if (problems.length === 0) {
    return;
  }

  throw new Error(
    `public encrypted fixture matrix is stale or hand-edited; regenerate with ` +
      `\`node fixtures/generate-kaifuu-encrypted-public-fixtures.mjs\`:\n  ${problems.join("\n  ")}`,
  );
}

function compareFileMaps(before, after, label) {
  const problems = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const relativePath of [...paths].sort((left, right) => left.localeCompare(right))) {
    if (!before.has(relativePath)) {
      problems.push(`${label}/${relativePath} was added`);
    } else if (!after.has(relativePath)) {
      problems.push(`${label}/${relativePath} was removed`);
    } else if (!buffersEqual(before.get(relativePath), after.get(relativePath))) {
      problems.push(`${label}/${relativePath} changed`);
    }
  }
  return problems;
}

function promoteStaging() {
  const stagedFiles = snapshotTree(fixtureRoot);
  for (const [relativePath, content] of stagedFiles.entries()) {
    atomicReplace(resolve(liveFixtureRoot, relativePath), content);
  }

  atomicReplace(liveManifestPath, readFileSync(manifestPath));

  for (const relativePath of listFiles(liveFixtureRoot)) {
    if (!stagedFiles.has(relativePath)) {
      rmSync(resolve(liveFixtureRoot, relativePath), { force: true });
    }
  }
  pruneEmptyDirectories(liveFixtureRoot);
}

function atomicReplace(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.itotori-staging-${process.pid}-${promotionSequence++}`,
  );
  writeFileSync(temporaryPath, content);
  renameSync(temporaryPath, path);
}

function pruneEmptyDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = resolve(root, entry.name);
    pruneEmptyDirectories(path);
    if (readdirSync(path).length === 0) {
      rmdirSync(path);
    }
  }
}

function fixtureRelativePath(manifestFilePath) {
  const prefix = "fixtures/public/kaifuu-encrypted-matrix/";
  if (!manifestFilePath.startsWith(prefix)) {
    throw new Error(`fixture manifest path escapes the generated matrix: ${manifestFilePath}`);
  }
  return manifestFilePath.slice(prefix.length);
}

function buffersEqual(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return Buffer.compare(left, right) === 0;
}
