#!/usr/bin/env node
// Local real-byte entry point. The private inventory is the single authority
// for staged corpora; the registry test verifies it before any proof runs.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverRealBytesProofs } from "./real-bytes-proof-manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_PROOF_ROLE = "engine";
const SUPPORT_PROOF_ROLE = "support";

function fail(message) {
  console.error(`real-bytes-lane: ${message}`);
  process.exitCode = 1;
}

function requestedRole(argv) {
  if (argv.length === 0) return ENGINE_PROOF_ROLE;
  if (argv.length === 1 && argv[0] === "--support") return SUPPORT_PROOF_ROLE;
  fail("expected no arguments or --support");
  return undefined;
}

export function selectProofs(entries, allProofs = discoverRealBytesProofs()) {
  const engines = [...new Set(entries.map((entry) => entry.engine ?? entry))];
  return engines.map((engine) => {
    const proofs = allProofs.filter(
      (proof) => proof.engine === engine && proof.role === ENGINE_PROOF_ROLE,
    );
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

function executeProof(proof, group) {
  console.log(`real-bytes-lane: running ${group}/${proof.name}`);
  const result = spawnSync("cargo", proof.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  const executed = executedTestCount(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error) {
    return { executed, reason: `proof ${proof.name} did not start: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      executed,
      reason: `proof ${proof.name} exited ${result.status} after ${executed} executed tests`,
    };
  }
  if (executed === 0) {
    return {
      executed,
      reason: `NAMED FAILURE: declared ${group} proof ${proof.name} executed zero tests`,
    };
  }
  return { executed };
}

function runSupportProofs(proofs) {
  let passed = true;
  for (const proof of proofs) {
    const result = executeProof(proof, SUPPORT_PROOF_ROLE);
    if (result.reason !== undefined) {
      fail(`support ${result.reason}`);
      passed = false;
    }
  }
  return passed;
}

function main(argv = process.argv.slice(2)) {
  const role = requestedRole(argv);
  if (role === undefined) return;
  const inventoryCheck = spawnSync(
    "cargo",
    [
      "test",
      "-p",
      "corpus-registry",
      "--features",
      "real-bytes",
      "--test",
      "corpus_registry_staged",
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (inventoryCheck.error || inventoryCheck.status !== 0) {
    fail("private inventory did not resolve every required staged corpus");
    return;
  }
  const proofs = discoverRealBytesProofs(repoRoot);
  const engineProofs = proofs.filter((proof) => proof.role === ENGINE_PROOF_ROLE);
  const supportProofs = proofs.filter((proof) => proof.role === SUPPORT_PROOF_ROLE);
  // The engine receipt is the periodic oracle's compact, named proof. Keep it
  // ahead of application evidence; the full support sweep is manifest-derived
  // too, but runs after that evidence via the explicit --support invocation.
  if (role === SUPPORT_PROOF_ROLE) {
    runSupportProofs(supportProofs);
    return;
  }
  const statuses = selectProofs([...new Set(engineProofs.map(({ engine }) => engine))], proofs);
  for (const status of statuses) {
    if (status.outcome === "failed") continue;
    let executed = 0;
    for (const proof of status.proofs) {
      const result = executeProof(proof, status.name);
      executed += result.executed;
      if (result.reason !== undefined) {
        status.outcome = "failed";
        status.reason = result.reason;
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
