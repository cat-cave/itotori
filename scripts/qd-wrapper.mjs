#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  auditLifecycleGateResult,
  disposeAuditRunInSnapshot,
  runningAuditRunsFromNodeShow,
} from "./qd-lifecycle.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const qdDatabaseFiles = ["qd.db", "qd.db-wal", "qd.db-shm"];
const auditDispositionLockName = "audit-disposition.lock";

async function main() {
  const args = process.argv.slice(2);
  const { root, globalArgs, commandArgs } = parseGlobalArgs(args);
  const realQd = findRealQd();

  if (commandArgs[0] === "gate" && commandArgs[1]) {
    return gateWithAuditLifecycle(realQd, globalArgs, commandArgs[1], args);
  }

  if (commandArgs[0] === "audit" && (!commandArgs[1] || commandArgs[1] === "--help")) {
    console.log(`usage: qd audit <start|pass|dispose|cancel|supersede> ...

Lifecycle:
  qd audit dispose <node> --run-id <id> --rationale <text> [--status cancelled|superseded]
  qd audit cancel <node> --run-id <id> --rationale <text>
  qd audit supersede <node> --run-id <id> --rationale <text>

Disposition closes a running audit run by setting a terminal status, finished_at,
and an audit-visible rationale summary.`);
    return;
  }

  if (commandArgs[0] === "audit" && ["dispose", "cancel", "supersede"].includes(commandArgs[1])) {
    const action = commandArgs[1];
    const nodeId = commandArgs[2];
    const options = parseOptions(commandArgs.slice(3));
    const status = action === "supersede" ? "superseded" : (options.status ?? "cancelled");
    return disposeAuditRun(realQd, root, globalArgs, {
      nodeId,
      runId: options["run-id"],
      status,
      rationale: options.rationale ?? options.summary,
      startedAt: options["started-at"],
      recordMissing: Boolean(options["record-missing"]),
      json: args.includes("--json"),
    });
  }

  if (isCiRecordPass(commandArgs)) {
    validateCiRecordPassEvidence(root, commandArgs);
  }

  if (isRoadmapSpecDagExport(root, commandArgs)) {
    return runRealThenCanonicalizeSpecDag(realQd, args, root);
  }

  return runReal(realQd, args);
}

function parseGlobalArgs(args) {
  if (args[0] === "--root") {
    if (!args[1]) throw new Error("--root requires a path");
    return {
      root: path.resolve(args[1]),
      globalArgs: ["--root", args[1]],
      commandArgs: args.slice(2),
    };
  }

  return {
    root: process.env.QD_ROOT ? path.resolve(process.env.QD_ROOT) : findProjectRoot(process.cwd()),
    globalArgs: [],
    commandArgs: args,
  };
}

function findProjectRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, ".qd"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return repoRoot;
    current = parent;
  }
}

function findRealQd() {
  if (process.env.QD_REAL_NODE_SCRIPT) {
    return { command: process.execPath, args: [process.env.QD_REAL_NODE_SCRIPT] };
  }
  if (process.env.QD_REAL_BIN) return { command: process.env.QD_REAL_BIN, args: [] };

  const ownRealPath = realpathSync(scriptPath);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "qd");
    try {
      accessSync(candidate, constants.X_OK);
      if (
        realpathSync(candidate) !== ownRealPath &&
        realpathSync(candidate) !== realpathSync(path.join(repoRoot, "bin", "qd"))
      ) {
        return { command: candidate, args: [] };
      }
    } catch {
      // Keep searching PATH.
    }
  }

  throw new Error("Unable to find the underlying qd binary in PATH");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const equalsIndex = arg.indexOf("=");
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    if (equalsIndex >= 0) {
      options[key] = arg.slice(equalsIndex + 1);
      continue;
    }
    if (key === "json" || key === "record-missing") {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function runReal(realQd, args) {
  const result = spawnSync(realQd.command, [...realQd.args, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function runRealThenCanonicalizeSpecDag(realQd, args, root) {
  const result = spawnSync(realQd.command, [...realQd.args, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  canonicalizeSpecDagExport(root);
  process.exit(0);
}

export function isRoadmapSpecDagExport(root, commandArgs) {
  if (commandArgs[0] !== "export") return false;
  const outPath = exportOutPath(commandArgs);
  if (!outPath) return false;
  return path.resolve(root, outPath) === path.resolve(root, "roadmap", "spec-dag.json");
}

export function isCiRecordPass(commandArgs) {
  return commandArgs[0] === "ci" && commandArgs[1] === "record-pass";
}

export function validateCiRecordPassEvidence(root, commandArgs) {
  const options = parseOptions(commandArgs.slice(3));
  const evidence = [
    options["log-path"] ? "--log-path" : null,
    options.url ? "--url" : null,
    options["external-id"] ? "--external-id" : null,
  ].filter(Boolean);

  if (evidence.length === 0) {
    throw new Error(
      "qd ci record-pass requires durable evidence: --url, --external-id, or --log-path",
    );
  }
  if (evidence.length > 1) {
    throw new Error(
      `qd ci record-pass must use exactly one evidence option, got ${evidence.join(", ")}`,
    );
  }

  if (options.url) validateEvidenceUrl(options.url);
  if (options["log-path"]) validateEvidenceLogPath(root, options["log-path"]);
  validateRecordPassSummary(options.summary);
}

function validateEvidenceUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`qd ci record-pass --url must be an absolute HTTP(S) URL: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`qd ci record-pass --url must use http or https: ${value}`);
  }
}

function validateEvidenceLogPath(root, value) {
  if (looksLikeUrl(value)) {
    throw new Error("qd ci record-pass URL evidence must use --url, not --log-path");
  }
  if (path.isAbsolute(value)) {
    throw new Error(
      `qd ci record-pass --log-path must be repo-relative so qd export is portable: ${value}`,
    );
  }

  const normalized = normalizeRepoRelativePath(value);
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`qd ci record-pass --log-path must stay inside the repo: ${value}`);
  }
  if (normalized === ".qd" || normalized.startsWith(".qd/")) {
    throw new Error("qd ci record-pass --log-path must not point at local-only .qd state");
  }
  if (normalized === "artifacts" || normalized.startsWith("artifacts/")) {
    throw new Error(
      "qd ci record-pass --log-path must not point at gitignored artifacts/; use docs/qd-ci-evidence/ or --url",
    );
  }

  const resolved = path.resolve(root, normalized);
  if (!existsSync(resolved)) {
    throw new Error(`qd ci record-pass --log-path evidence file does not exist: ${normalized}`);
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`qd ci record-pass --log-path evidence is not a file: ${normalized}`);
  }
}

function validateRecordPassSummary(summary) {
  if (!summary) return;
  const localQdLogPattern =
    /(?:^|[\s=])(?:\.qd\/logs\/|\/[^\s]*\/\.qd\/logs\/|[A-Za-z]:[\\/][^\s]*[\\/]\.qd[\\/]logs[\\/])/u;
  if (localQdLogPattern.test(summary)) {
    throw new Error(
      "qd ci record-pass --summary must not cite local-only .qd/logs paths; use --url, --external-id, or repo-relative evidence",
    );
  }
}

function normalizeRepoRelativePath(value) {
  return path.posix.normalize(value.replaceAll(path.win32.sep, path.posix.sep));
}

function looksLikeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function exportOutPath(commandArgs) {
  for (let index = 1; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--out") return commandArgs[index + 1];
    if (arg.startsWith("--out=")) return arg.slice("--out=".length);
  }
  return null;
}

function canonicalizeSpecDagExport(root) {
  const specDagPath = path.join(root, "roadmap", "spec-dag.json");
  canonicalizeSpecDagFile(root, specDagPath);
}

function canonicalizeSpecDagFile(root, specDagPath) {
  const result = spawnSync("pnpm", ["exec", "vp", "check", "--fix", "--no-lint", specDagPath], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm exec vp check failed with exit ${result.status}`);
  }
}

function captureJson(realQd, args) {
  const result = spawnSync(realQd.command, [...realQd.args, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(detail || `qd ${args.join(" ")} failed with exit ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function gateWithAuditLifecycle(realQd, globalArgs, nodeId, originalArgs) {
  const json = originalArgs.includes("--json");
  const nodeShow = captureJson(realQd, [...globalArgs, "node", "show", nodeId, "--full", "--json"]);
  const runningAudits = runningAuditRunsFromNodeShow(nodeShow);

  if (runningAudits.length > 0) {
    const result = auditLifecycleGateResult(nodeId, { ok: true, blocking: [] }, runningAudits);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(
        `qd gate blocked: ${nodeId} has running audit run(s): ${runningAudits
          .map((run) => `${run.id} started ${run.started_at}`)
          .join(", ")}`,
      );
      console.error("Close them with qd audit dispose <node> --run-id <id> --rationale <text>.");
    }
    process.exit(1);
  }

  return runReal(realQd, originalArgs);
}

async function disposeAuditRun(realQd, root, globalArgs, options) {
  if (!options.nodeId)
    throw new Error("usage: qd audit dispose <node> --run-id <id> --rationale <text>");
  if (!options.runId) throw new Error("qd audit dispose requires --run-id");

  await withAuditDispositionLock(root, async () => {
    const operationDir = path.join(root, ".tmp", "qd-lifecycle", randomUUID());
    const stagedRoot = path.join(operationDir, "staged-root");

    try {
      const snapshot = await loadSnapshot(realQd, root, globalArgs);
      const { run, recordedMissing } = disposeAuditRunInSnapshot(snapshot, {
        nodeId: options.nodeId,
        runId: options.runId,
        status: options.status,
        rationale: options.rationale,
        startedAt: options.startedAt,
        recordMissing: options.recordMissing,
      });

      await prepareStagedRoot(root, stagedRoot);
      const tempPath = path.join(stagedRoot, "snapshot.json");
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

      runChecked(realQd, ["--root", stagedRoot, "import", "--from", "snapshot.json"], {
        quiet: options.json,
      });
      validateStagedDisposition(realQd, stagedRoot, options, run);

      await installValidatedDatabase(root, stagedRoot, operationDir, async () => {
        await replaceRoadmapSpecDagExport(realQd, root, globalArgs, operationDir, options);
      });

      const result = { ok: true, nodeId: options.nodeId, run, recordedMissing };
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Disposed audit run ${run.id} for ${options.nodeId} as ${run.status}`);
    } finally {
      await rm(operationDir, { recursive: true, force: true });
    }
  });
}

async function replaceRoadmapSpecDagExport(realQd, root, globalArgs, operationDir, options) {
  const roadmapPath = path.join(root, "roadmap", "spec-dag.json");
  if (!existsSync(roadmapPath)) return;

  const tempRoadmapPath = path.join(operationDir, "spec-dag.json");
  const backupRoadmapPath = path.join(operationDir, "original-spec-dag.json");
  await copyAndVerifyFile(roadmapPath, backupRoadmapPath);

  try {
    runChecked(realQd, [...globalArgs, "export", "--out", path.relative(root, tempRoadmapPath)], {
      quiet: options.json,
    });
    await rename(tempRoadmapPath, roadmapPath);
    canonicalizeSpecDagExport(root);
  } catch (error) {
    await copyFile(backupRoadmapPath, roadmapPath);
    await rm(tempRoadmapPath, { force: true });
    throw error;
  }
}

async function loadSnapshot(realQd, root, globalArgs) {
  try {
    return captureJson(realQd, [...globalArgs, "export", "--json"]);
  } catch (error) {
    if (existsSync(path.join(root, ".qd", "qd.db"))) throw error;
    const exportPath = path.join(root, "roadmap", "spec-dag.json");
    if (!existsSync(exportPath)) throw error;
    return JSON.parse(await readFile(exportPath, "utf8"));
  }
}

async function withAuditDispositionLock(root, callback) {
  const lockPath = path.join(root, ".qd", auditDispositionLockName);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`qd audit disposition lock already exists: ${lockPath}`);
    }
    throw error;
  }

  try {
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function prepareStagedRoot(root, stagedRoot) {
  const liveQdDir = path.join(root, ".qd");
  const stagedQdDir = path.join(stagedRoot, ".qd");
  await mkdir(stagedQdDir, { recursive: true });

  for (const entry of await readdir(liveQdDir, { withFileTypes: true })) {
    if (qdDatabaseFiles.includes(entry.name) || entry.name === auditDispositionLockName) continue;
    await cp(path.join(liveQdDir, entry.name), path.join(stagedQdDir, entry.name), {
      recursive: true,
    });
  }
}

function validateStagedDisposition(realQd, stagedRoot, options, expectedRun) {
  const stagedSnapshot = captureJson(realQd, ["--root", stagedRoot, "export", "--json"]);
  const stagedRun = Array.isArray(stagedSnapshot?.runs)
    ? stagedSnapshot.runs.find((run) => run?.id === options.runId)
    : null;

  if (!stagedRun) throw new Error(`staged qd import did not include audit run ${options.runId}`);
  if (stagedRun.node_id !== options.nodeId) {
    throw new Error(`staged audit run ${options.runId} belongs to ${stagedRun.node_id}`);
  }
  if (stagedRun.status !== expectedRun.status) {
    throw new Error(`staged audit run ${options.runId} has status ${stagedRun.status}`);
  }
  if (stagedRun.finished_at !== expectedRun.finished_at) {
    throw new Error(`staged audit run ${options.runId} has mismatched finished_at`);
  }
  if (stagedRun.summary !== expectedRun.summary) {
    throw new Error(`staged audit run ${options.runId} has mismatched summary`);
  }
}

async function installValidatedDatabase(root, stagedRoot, operationDir, afterInstall) {
  const liveQdDir = path.join(root, ".qd");
  const stagedQdDir = path.join(stagedRoot, ".qd");
  const backupDir = path.join(operationDir, "original-db");
  await mkdir(backupDir, { recursive: true });

  if (!existsSync(path.join(stagedQdDir, "qd.db"))) {
    throw new Error("staged qd import did not create .qd/qd.db");
  }

  const backedUpNames = [];
  const changedNames = [];

  try {
    for (const name of qdDatabaseFiles) {
      const livePath = path.join(liveQdDir, name);
      if (existsSync(livePath)) {
        await copyAndVerifyFile(livePath, path.join(backupDir, name));
        backedUpNames.push(name);
      }
    }

    for (const name of qdDatabaseFiles) {
      const stagedPath = path.join(stagedQdDir, name);
      const livePath = path.join(liveQdDir, name);
      if (existsSync(stagedPath)) {
        await rename(stagedPath, livePath);
        changedNames.push(name);
      } else if (existsSync(livePath)) {
        await rm(livePath, { force: true });
        changedNames.push(name);
      }
    }

    await afterInstall();
    await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await restoreOriginalDatabase(liveQdDir, backupDir, { backedUpNames, changedNames });
    throw error;
  }
}

async function copyAndVerifyFile(sourcePath, destinationPath) {
  await copyFile(sourcePath, destinationPath);
  const [source, destination] = await Promise.all([
    readFile(sourcePath),
    readFile(destinationPath),
  ]);
  if (!source.equals(destination)) {
    throw new Error(`backup verification failed for ${sourcePath}`);
  }
}

async function restoreOriginalDatabase(liveQdDir, backupDir, { backedUpNames, changedNames }) {
  for (const name of changedNames) {
    const livePath = path.join(liveQdDir, name);
    if (existsSync(livePath)) await rm(livePath, { force: true });
  }

  for (const name of backedUpNames) {
    const backupPath = path.join(backupDir, name);
    if (existsSync(backupPath)) await copyFile(backupPath, path.join(liveQdDir, name));
  }
}

function runChecked(realQd, args, options = {}) {
  const result = spawnSync(realQd.command, [...realQd.args, ...args], {
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.quiet ? "utf8" : undefined,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let detail = "";
    if (options.quiet) {
      detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      if (detail) console.error(detail);
    }
    throw new Error(detail || `qd ${args.join(" ")} failed with exit ${result.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
