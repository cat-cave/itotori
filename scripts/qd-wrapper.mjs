#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  auditLifecycleGateResult,
  disposeAuditRunInSnapshot,
  runningAuditRunsFromNodeShow,
} from "./qd-lifecycle.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

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
    const key = arg.slice(2);
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

  const snapshot = await loadSnapshot(realQd, root, globalArgs);
  const { run, recordedMissing } = disposeAuditRunInSnapshot(snapshot, {
    nodeId: options.nodeId,
    runId: options.runId,
    status: options.status,
    rationale: options.rationale,
    startedAt: options.startedAt,
    recordMissing: options.recordMissing,
  });

  const tempDir = path.join(root, ".tmp", "qd-lifecycle");
  await mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `snapshot-${randomUUID()}.json`);
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  await removeLocalDatabase(root);
  runChecked(realQd, [...globalArgs, "import", "--from", path.relative(root, tempPath)], {
    quiet: options.json,
  });

  const roadmapPath = path.join(root, "roadmap", "spec-dag.json");
  if (existsSync(roadmapPath)) {
    runChecked(realQd, [...globalArgs, "export", "--out", "roadmap/spec-dag.json"], {
      quiet: options.json,
    });
  }

  const result = { ok: true, nodeId: options.nodeId, run, recordedMissing };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Disposed audit run ${run.id} for ${options.nodeId} as ${run.status}`);
}

async function loadSnapshot(realQd, root, globalArgs) {
  try {
    return captureJson(realQd, [...globalArgs, "export", "--json"]);
  } catch (error) {
    const exportPath = path.join(root, "roadmap", "spec-dag.json");
    if (!existsSync(exportPath)) throw error;
    return JSON.parse(await readFile(exportPath, "utf8"));
  }
}

async function removeLocalDatabase(root) {
  await Promise.all(
    ["qd.db", "qd.db-wal", "qd.db-shm"].map(async (name) => {
      try {
        await unlink(path.join(root, ".qd", name));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }),
  );
}

function runChecked(realQd, args, options = {}) {
  const result = spawnSync(realQd.command, [...realQd.args, ...args], {
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.quiet ? "utf8" : undefined,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.quiet) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      if (detail) console.error(detail);
    }
    process.exit(result.status ?? 1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
