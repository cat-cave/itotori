#!/usr/bin/env node
// Local real-byte entry point. The private inventory is the single authority
// for staged corpora; the registry test verifies it before any proof runs.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverRealBytesProofs } from "./real-bytes-proof-manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`real-bytes-lane: ${message}`);
  process.exitCode = 1;
}

export function selectProofs(entries, allProofs = discoverRealBytesProofs()) {
  const engines = [...new Set(entries.map((entry) => entry.engine ?? entry))];
  return engines.map((engine) => {
    const proofs = allProofs.filter((proof) => proof.engine === engine);
    return proofs.length > 0
      ? { name: engine, proofs, outcome: "skipped", reason: "not started" }
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
  const inventoryCheck = spawnSync(
    "cargo",
    ["test", "-p", "corpus-registry", "--test", "corpus_registry_staged", "--", "--ignored"],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (inventoryCheck.error || inventoryCheck.status !== 0) {
    fail("private inventory did not resolve every required staged corpus");
    return;
  }
  const proofs = discoverRealBytesProofs(repoRoot);
  const statuses = selectProofs([...new Set(proofs.map(({ engine }) => engine))], proofs);
  for (const status of statuses) {
    if (status.outcome === "failed") continue;
    let executed = 0;
    for (const proof of status.proofs) {
      console.log(`real-bytes-lane: running ${status.name}/${proof.name}`);
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
        status.reason = `NAMED FAILURE: declared ${status.name} proof ${proof.name} executed zero tests`;
        break;
      }
    }
    if (status.outcome !== "failed" && executed === 0) {
      status.outcome = "failed";
      status.reason = `NAMED FAILURE: declared engine ${status.name} executed zero proofs`;
    } else if (status.outcome !== "failed") {
      status.outcome = "executed";
      status.reason = `${executed} tests across ${status.proofs.length} declared proofs; private inventory verified before execution`;
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
