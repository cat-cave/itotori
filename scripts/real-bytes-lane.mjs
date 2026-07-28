#!/usr/bin/env node
// Local real-byte entry point. Manifest entries choose a proof by engine; an
// unproved engine makes the lane red instead of borrowing another engine's pass.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "corpora", "manifest.v1.json");
const proofByEngine = new Map([
  ["reallive", [{ name: "kaifuu-reallive", args: ["test", "-p", "kaifuu-reallive", "--", "--ignored"] }]],
  [
    "siglus",
    [
      { name: "kaifuu-siglus", args: ["test", "-p", "kaifuu-siglus"] },
      { name: "utsushi-siglus-observe", args: ["test", "-p", "utsushi-siglus", "--test", "observe_real_bytes"] },
      { name: "utsushi-siglus-scene-vm", args: ["test", "-p", "utsushi-siglus", "--test", "scene_vm_real_bytes"] },
      { name: "utsushi-siglus-g00", args: ["test", "-p", "utsushi-siglus", "--test", "siglus_g00_real_bytes"] },
      { name: "utsushi-siglus-structure", args: ["test", "-p", "utsushi-siglus", "--test", "structure_export_real_bytes"] },
      { name: "utsushi-siglus-launch", args: ["test", "-p", "utsushi-siglus", "--test", "launch_hydration"] },
    ],
  ],
  ["softpal", [{ name: "kaifuu-softpal", args: ["test", "-p", "kaifuu-softpal", "--", "--ignored"] }]],
]);

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
    if (manifest.version !== 1 || !isRecord(manifest.corpora))
      throw new Error("expected version 1 and corpora{}");
    const corpora = [];
    for (const [identity, entry] of Object.entries(manifest.corpora)) {
      const [engine, ordinalText, variant, extra] = identity.split("/");
      if (
        !/^[a-z][a-z0-9-]*$/u.test(engine ?? "") ||
        !/^[1-9][0-9]*$/u.test(ordinalText ?? "") ||
        !/^[a-z][a-z0-9-]*$/u.test(variant ?? "") ||
        extra !== undefined ||
        typeof entry.path !== "string" ||
        entry.path.startsWith("/") ||
        entry.path.split(/[\\/]/u).includes("..")
      ) {
        throw new Error(
          "each corpus identity needs engine/ordinal/variant and a safe relative path",
        );
      }
      corpora.push({ engine, ordinal: Number(ordinalText), variant, path: entry.path });
    }
    return corpora;
  } catch (error) {
    fail(`invalid ${manifestPath}: ${error.message}`);
    return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function selectProofs(corpora) {
  return [...new Set(corpora.map((entry) => entry.engine))].map((engine) => {
    const args = proofByEngine.get(engine);
    return args
      ? { name: engine, proofs: args, outcome: "skipped", reason: "not started" }
      : { name: engine, outcome: "failed", reason: `declared but unproven engine ${engine}` };
  });
}

export function executedTestCount(output) {
  return [...output.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed;/gu)].reduce(
    (count, match) => count + Number(match[1]),
    0,
  );
}

function summary(statuses) {
  const counts = { executed: 0, skipped: 0, failed: 0 };
  for (const status of statuses) counts[status.outcome] += 1;
  for (const status of statuses)
    console.log(
      `real-bytes-lane: proof ${status.name}: ${status.outcome}${status.reason ? ` — ${status.reason}` : ""}`,
    );
  console.log(
    `real-bytes-lane: summary: ${counts.executed} executed, ${counts.skipped} skipped, ${counts.failed} failed`,
  );
  return counts;
}

function main() {
  const corpora = readManifest();
  if (!corpora) return;
  const statuses = selectProofs(corpora);
  const declaredEngines = statuses.map((status) => status.name);
  const statusFor = (engine) => statuses.find((status) => status.name === engine);
  const root = process.env.ITOTORI_CORPUS_ROOT;
  if (!root) {
    for (const status of statuses) {
      if (status.outcome === "skipped") status.reason = "ITOTORI_CORPUS_ROOT is unset";
    }
    const counts = summary(statuses);
    fail(`cannot pass with ${counts.executed} executed proofs`);
    return;
  }
  const available = [];
  const missing = [];
  for (const entry of corpora) {
    const path = resolve(root, entry.path);
    const label = `${entry.engine}/${entry.ordinal}/${entry.variant}`;
    if (existsSync(path)) available.push({ label, path });
    else missing.push({ label, reason: `declared path missing: ${path}` });
  }
  for (const corpus of available)
    console.log(`real-bytes-lane: corpus ${corpus.label} = ${corpus.path}`);
  for (const corpus of missing) console.log(`REAL-BYTES SKIP ${corpus.label}: ${corpus.reason}`);
  if (missing.length > 0) {
    for (const status of statuses) {
      if (status.outcome === "skipped") status.reason = "a declared corpus path is missing";
    }
    const counts = summary(statuses);
    fail(
      `cannot run the complete lane: ${missing.length} declared corpora are absent; ${counts.executed} proofs executed`,
    );
    return;
  }
  for (const engine of declaredEngines) {
    const status = statusFor(engine);
    if (status.outcome === "failed") continue;
    let executed = 0;
    for (const proof of status.proofs) {
      console.log(`real-bytes-lane: running ${engine}/${proof.name}`);
      const result = spawnSync("cargo", proof.args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
      });
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      const proofExecuted = executedTestCount(`${result.stdout ?? ""}${result.stderr ?? ""}`);
      executed += proofExecuted;
      if (result.error) {
        status.outcome = "failed";
        status.reason = `proof ${proof.name} did not start: ${result.error.message}`;
        break;
      }
      if (result.status !== 0) {
        status.outcome = "failed";
        status.reason = `proof ${proof.name} exited ${result.status} after ${proofExecuted} executed tests`;
        break;
      }
      if (proofExecuted === 0) {
        status.outcome = "failed";
        status.reason = `NAMED FAILURE: declared ${engine} proof ${proof.name} executed zero tests`;
        break;
      }
    }
    if (status.outcome !== "failed" && executed === 0) {
      status.outcome = "failed";
      status.reason = `NAMED FAILURE: declared engine ${engine} executed zero proofs`;
    } else if (status.outcome !== "failed") {
      status.outcome = "executed";
      status.reason = `${executed} tests across ${status.proofs.length} declared proofs; ${corpora.filter((entry) => entry.engine === engine).length} declared corpus entries`;
    }
  }
  const counts = summary(statuses);
  if (counts.executed === 0 || counts.skipped > 0 || counts.failed > 0) process.exitCode = 1;
}

function invokedAsMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (invokedAsMain()) main();
