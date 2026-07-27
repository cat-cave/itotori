#!/usr/bin/env node
// Local real-byte entry point. The registry is deliberately data-driven: this
// runner neither knows engine names nor constructs per-engine environment keys.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "corpora", "manifest.v1.json");

function fail(message) {
  console.error(`real-bytes-lane: ${message}`);
  process.exitCode = 1;
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    fail(
      `missing ${manifestPath}; copy corpora/manifest.v1.example.json to ` +
        "corpora/manifest.v1.json and replace its role-shaped paths with local directories",
    );
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.version !== 1 || !Array.isArray(manifest.corpora))
      throw new Error("expected version 1 and corpora[]");
    for (const entry of manifest.corpora) {
      if (
        typeof entry?.engine !== "string" ||
        !Number.isInteger(entry.ordinal) ||
        typeof entry.variant !== "string" ||
        typeof entry.path !== "string" ||
        entry.path.startsWith("/") ||
        entry.path.split(/[\\/]/u).includes("..")
      ) {
        throw new Error("each corpus needs engine, ordinal, variant, and a safe relative path");
      }
    }
    return manifest;
  } catch (error) {
    fail(`invalid ${manifestPath}: ${error.message}`);
    return null;
  }
}

function main() {
  const manifest = readManifest();
  if (!manifest) return;
  const root = process.env.ITOTORI_CORPUS_ROOT;
  if (!root) {
    fail("ran 0 proofs; skipped all because ITOTORI_CORPUS_ROOT is unset");
    return;
  }
  const available = [];
  const skipped = [];
  for (const entry of manifest.corpora) {
    const path = resolve(root, entry.path);
    const label = `${entry.engine}/${entry.ordinal}/${entry.variant}`;
    if (existsSync(path)) available.push({ label, path });
    else skipped.push({ label, reason: `declared path missing: ${path}` });
  }
  for (const corpus of available)
    console.log(`real-bytes-lane: corpus ${corpus.label} = ${corpus.path}`);
  for (const corpus of skipped) console.log(`REAL-BYTES SKIP ${corpus.label}: ${corpus.reason}`);
  if (skipped.length > 0) {
    fail(`cannot run the complete lane: ${skipped.length} declared corpora are absent`);
    return;
  }

  const proofs = [
    [
      "registry",
      ["test", "-p", "corpus-registry", "--test", "corpus_registry_staged", "--", "--nocapture"],
    ],
    ["reallive", ["test", "-p", "kaifuu-reallive", "--", "--ignored"]],
  ];
  let failures = 0;
  for (const [name, args] of proofs) {
    console.log(`real-bytes-lane: running ${name}`);
    const result = spawnSync("cargo", args, { cwd: repoRoot, env: process.env, stdio: "inherit" });
    if (result.error) {
      failures += 1;
      console.error(`real-bytes-lane: ${name} did not start: ${result.error.message}`);
    } else if (result.status !== 0) {
      failures += 1;
      console.error(`real-bytes-lane: ${name} failed (exit ${result.status})`);
    }
  }
  console.log(
    `real-bytes-lane: ran ${proofs.length} proof suites; ${skipped.length} corpus entries skipped; ${failures} suites failed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main();
