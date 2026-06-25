#!/usr/bin/env node
/*
 * UTSUSHI-228 — alpha-closing driver for `just localize-sweetie-hd`.
 *
 * Chains the four phases of the alpha-defining end-to-end pipeline:
 *
 *   1. kaifuu-cli extract --engine reallive  (KAIFUU-210)
 *      -> artifacts/localize-sweetie-hd/<ts>/bridge-bundle.json
 *
 *   2. itotori localize-sweetie-hd-stage     (UTSUSHI-228 itself —
 *      live OpenRouter via ITOTORI-221, agentic loop via ITOTORI-222)
 *      -> artifacts/.../agentic-loop-bundle.v0.json
 *         artifacts/.../translated-bridge.json
 *         artifacts/.../patch-report.json
 *
 *   3. kaifuu-cli patch --engine reallive    (KAIFUU-211)
 *      -> writes <TARGET>/REALLIVEDATA/Seen.txt patched in place
 *
 *   4. utsushi-cli replay-validate --engine reallive (UTSUSHI-227)
 *      -> artifacts/.../replay-log.json
 *
 * Hard contracts (audit-focus mirrors):
 *
 *   - The pair-policy file is REQUIRED. No defaulting; missing/malformed
 *     pair-policy halts the driver at phase 1.
 *   - OPENROUTER_API_KEY is REQUIRED unless `--dry-run`. No fallback to
 *     RecordedModelProvider. If OPENROUTER_LIVE=1 is set but the API
 *     key is missing the driver fails loudly (no silent downgrade).
 *   - `KAIFUU_REAL_SWEETIE_HD_PATH` is REQUIRED unless `--dry-run`.
 *   - `TARGET` env var is REQUIRED unless `--dry-run`. The driver
 *     refuses to write inside the source tree.
 *   - The source `<KAIFUU_REAL_SWEETIE_HD_PATH>/REALLIVEDATA/Seen.txt`
 *     is sha256-checked before AND after the run; any drift fails the
 *     command.
 *   - `--dry-run` prints the per-step commands and exits 0 without
 *     invoking any LLM (zero ProviderRunRecords written).
 *
 * Linux-only (no Wine, no Windows helpers).
 */
"use strict";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../../..");
const PAIR_POLICY_PATH = join(REPO_ROOT, "presets", "localize-sweetie-hd.pair-policy.json");

function usage() {
  return [
    "usage: node suite/scripts/localize-sweetie-hd/run.mjs --project <NAME> [--dry-run] [--scene <N>] [--unit-index <N>] [--provider-kind <live|fake>]",
    "",
    "Required env (unless --dry-run):",
    "  OPENROUTER_API_KEY              live OpenRouter key for the (modelId, providerId) pair",
    "  KAIFUU_REAL_SWEETIE_HD_PATH     readonly path to the extracted Sweetie HD game root",
    "  TARGET                          writable path for the patched copy (must NOT alias source)",
    "",
    "Flags:",
    "  --project <NAME>                project label baked into the run directory name",
    "  --dry-run                       print per-phase commands and exit 0 without invoking an LLM",
    "  --scene <N>                     scene id passed to kaifuu extract / utsushi replay-validate (default 1)",
    "  --unit-index <N>                bridge unit index to translate (default 0)",
    "  --provider-kind <live|fake>     forwarded to the agentic-loop stage; fake requires ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    project: undefined,
    dryRun: false,
    scene: 1,
    unitIndex: 0,
    providerKind: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--project": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--project requires a value");
        args.project = value;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--scene": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--scene requires a value");
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0)
          throw new Error("--scene must be a non-negative integer");
        args.scene = parsed;
        break;
      }
      case "--unit-index": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--unit-index requires a value");
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0)
          throw new Error("--unit-index must be a non-negative integer");
        args.unitIndex = parsed;
        break;
      }
      case "--provider-kind": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--provider-kind requires a value");
        if (value !== "live" && value !== "fake")
          throw new Error(`--provider-kind '${value}' must be 'live' or 'fake'`);
        args.providerKind = value;
        break;
      }
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}\n\n${usage()}`);
    }
  }
  if (args.project === undefined) {
    throw new Error(`--project is required\n\n${usage()}`);
  }
  return args;
}

function isoTimestampUtc(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function sha256OfFile(path) {
  const bytes = readFileSync(path);
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

function copyDirRecursive(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing to follow symlink at ${join(srcDir, entry.name)}`);
    }
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
      try {
        const stat = statSync(dstPath);
        chmodSync(dstPath, stat.mode | 0o200);
      } catch {
        // best-effort writability bump; non-Unix platforms ignored.
      }
    }
  }
}

function resolveReallivedataSeen(gameRoot) {
  const direct = join(gameRoot, "REALLIVEDATA", "Seen.txt");
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(gameRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(gameRoot, entry.name, "REALLIVEDATA", "Seen.txt");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`REALLIVEDATA/Seen.txt not found under ${gameRoot}`);
}

function loadPairPolicy() {
  if (!existsSync(PAIR_POLICY_PATH)) {
    throw new Error(
      `pair-policy file missing at ${PAIR_POLICY_PATH}; the driver does NOT default — this is by design`,
    );
  }
  const raw = readFileSync(PAIR_POLICY_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`pair-policy JSON parse failed at ${PAIR_POLICY_PATH}: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pair-policy at ${PAIR_POLICY_PATH} must be a JSON object`);
  }
  // ITOTORI-234 — v0.2 forcing function: reject v0.1 / absent schema
  // version inputs at the driver boundary. Mirrors the typed
  // PairPolicyVersionMismatchError thrown by the TS parser; we keep
  // this duplicate gate inline because the driver is plain Node JS
  // (no TS imports) and needs to fail fast BEFORE forking the stage
  // command.
  const EXPECTED_SCHEMA = "itotori.pair-policy.v0.2";
  if (parsed.schemaVersion !== EXPECTED_SCHEMA) {
    throw new Error(
      `pair-policy at ${PAIR_POLICY_PATH} has schemaVersion='${String(parsed.schemaVersion)}'; expected '${EXPECTED_SCHEMA}' (v0.1 files are no longer accepted — ITOTORI-234 no-legacy-compat)`,
    );
  }
  const requiredKeys = ["policyId", "pair", "enUsSentinel", "sceneId", "stages"];
  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      throw new Error(`pair-policy at ${PAIR_POLICY_PATH} missing required key '${key}'`);
    }
  }
  return parsed;
}

// ITOTORI-234 — deterministic seed derivation matching
// packages/localization-bridge-schema/src/pair-policy.v0.2.ts
// (`deriveDefaultSeed`). Duplicated inline because the driver does not
// import TS code.
function deriveDefaultSeed(leafPath) {
  const hex = createHash("sha256").update(leafPath).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16);
}

// Flatten the v0.2 stage tree into (leafPath, posture) tuples mirroring
// `flattenPairPolicyV02Postures` in the schema package.
function flattenPostures(policy) {
  const out = [];
  const groups = [
    [
      "context",
      ["sceneSummary", "characterRelationship", "terminologyCandidate", "routeChoiceMap"],
    ],
    ["preTranslation", ["speakerLabel"]],
    ["translation", ["primary"]],
    ["qa", ["styleAdherence", "semanticDrift", "toneRegister", "unresolvedTerminology"]],
    ["repair", ["primary"]],
  ];
  for (const [group, leaves] of groups) {
    for (const leaf of leaves) {
      const leafPath = `${group}.${leaf}`;
      const node = policy.stages?.[group]?.[leaf];
      if (node === undefined) continue;
      const zdr = typeof node.zdr === "boolean" ? node.zdr : true;
      const seed =
        typeof node.seed === "number" && Number.isInteger(node.seed) && node.seed >= 0
          ? node.seed
          : deriveDefaultSeed(leafPath);
      out.push({ leafPath, zdr, seed });
    }
    // Optional regrade leaf for translation.
    if (group === "translation" && policy.stages?.translation?.regrade !== undefined) {
      const leafPath = "translation.regrade";
      const node = policy.stages.translation.regrade;
      const zdr = typeof node.zdr === "boolean" ? node.zdr : true;
      const seed =
        typeof node.seed === "number" && Number.isInteger(node.seed) && node.seed >= 0
          ? node.seed
          : deriveDefaultSeed(leafPath);
      out.push({ leafPath, zdr, seed });
    }
  }
  return out;
}

function ensureWritableTargetDistinctFromSource(sourceRoot, targetRoot) {
  const sourceAbs = resolvePath(sourceRoot);
  const targetAbs = resolvePath(targetRoot);
  if (sourceAbs === targetAbs) {
    throw new Error(
      `TARGET (${targetAbs}) must not alias KAIFUU_REAL_SWEETIE_HD_PATH (${sourceAbs})`,
    );
  }
  if (targetAbs.startsWith(sourceAbs + "/") || sourceAbs.startsWith(targetAbs + "/")) {
    throw new Error(
      `TARGET (${targetAbs}) must not nest with KAIFUU_REAL_SWEETIE_HD_PATH (${sourceAbs}); pick a fully-disjoint path`,
    );
  }
}

function runCommand(command, args, env = process.env, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  process.stdout.write(`[localize-sweetie-hd] $ ${printable}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", env, ...options });
  if (result.error) {
    throw new Error(`command failed to start: ${printable}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`command exited with status ${result.status}: ${printable}`);
  }
}

function printDryRunPlan(plan, postures) {
  process.stdout.write(
    "[localize-sweetie-hd] --dry-run plan (no LLM calls; 0 ProviderRunRecords would be written):\n",
  );
  // ITOTORI-227 — the OpenRouter privacy posture is part of the dry-run
  // plan so the operator can confirm the account-level ZDR setting is
  // asserted and every non-public request body will carry
  // provider.zdr=true. The constructor-level assertion runs in the live
  // path; for dry-run we surface its expected state here.
  const zdrAccountAsserted = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1" ? "1" : "MISSING";
  process.stdout.write(
    `[localize-sweetie-hd] ZDR account asserted: OPENROUTER_ZDR_ACCOUNT_ASSERTED=${zdrAccountAsserted}\n`,
  );
  process.stdout.write(
    "[localize-sweetie-hd] Per-stage provider.zdr posture: true (all non-public input classifications)\n",
  );
  // ITOTORI-234 — the v0.2 pair-policy carries per-stage zdr + seed
  // postures resolved at parse time. Emit one line per leaf so the
  // operator can confirm the (zdr, seed) pair the orchestrator will
  // pass into every invocation. Acceptance criterion #1: this block
  // is what the test asserts on.
  process.stdout.write(
    "[localize-sweetie-hd] Per-stage posture (ITOTORI-234 v0.2 — leafPath: zdr=<bool> seed=<int>):\n",
  );
  for (const posture of postures) {
    process.stdout.write(
      `[localize-sweetie-hd]   stage ${posture.leafPath}: zdr=${posture.zdr} seed=${posture.seed}\n`,
    );
  }
  for (const line of plan) {
    process.stdout.write(`[localize-sweetie-hd] (planned) $ ${line}\n`);
  }
  process.stdout.write("[localize-sweetie-hd] DRY-RUN: 0 LLM calls would be made.\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPairPolicy();
  const sentinelSubstring = policy.enUsSentinel;
  const sceneId = policy.sceneId ?? args.scene;
  const ts = isoTimestampUtc();
  const runDirName = `${ts}-${args.project}`;
  const runDir = join(REPO_ROOT, "artifacts", "localize-sweetie-hd", runDirName);

  const bridgeBundlePath = join(runDir, "bridge-bundle.json");
  const agenticLoopBundlePath = join(runDir, "agentic-loop-bundle.v0.json");
  const translatedBundlePath = join(runDir, "translated-bridge.json");
  const patchReportPath = join(runDir, "patch-report.json");
  const replayLogPath = join(runDir, "replay-log.json");

  const dryRun = args.dryRun;

  // ------- Phase 0: environment + pair-policy validation -------
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const openrouterLive = process.env.OPENROUTER_LIVE;
  if (!dryRun) {
    if (
      openrouterLive === "1" &&
      (openrouterApiKey === undefined || openrouterApiKey.length === 0)
    ) {
      throw new Error(
        "OPENROUTER_LIVE=1 is set but OPENROUTER_API_KEY is empty/unset; the no-fallback rule forbids downgrading to the recorded provider in live mode. Either unset OPENROUTER_LIVE or export OPENROUTER_API_KEY.",
      );
    }
    if (openrouterApiKey === undefined || openrouterApiKey.length === 0) {
      throw new Error(
        "OPENROUTER_API_KEY must be set unless --dry-run; the driver does not fall back to the recorded provider",
      );
    }
  }

  const gameRoot = process.env.KAIFUU_REAL_SWEETIE_HD_PATH;
  if (!dryRun && (gameRoot === undefined || gameRoot.length === 0)) {
    throw new Error("KAIFUU_REAL_SWEETIE_HD_PATH must be set unless --dry-run");
  }
  const targetRoot = process.env.TARGET;
  if (!dryRun && (targetRoot === undefined || targetRoot.length === 0)) {
    throw new Error("TARGET (writable path for the patched copy) must be set unless --dry-run");
  }
  if (!dryRun) {
    ensureWritableTargetDistinctFromSource(gameRoot, targetRoot);
  }

  if (dryRun) {
    printDryRunPlan(
      [
        `cargo run -p kaifuu-cli -- extract --engine reallive --scene ${sceneId} --bundle-output ${bridgeBundlePath}`,
        `node apps/itotori/dist/cli.js localize-sweetie-hd-stage --bridge ${bridgeBundlePath} --pair-policy ${PAIR_POLICY_PATH} --unit-index ${args.unitIndex} --output ${agenticLoopBundlePath} --translated-bundle-output ${translatedBundlePath} --patch-report-output ${patchReportPath}`,
        `cargo run -p kaifuu-cli -- patch --engine reallive --source <KAIFUU_REAL_SWEETIE_HD_PATH> --target <TARGET> --bundle ${translatedBundlePath} --force`,
        `cargo run -p utsushi-cli -- replay-validate --engine reallive --seen <TARGET>/REALLIVEDATA/Seen.txt --scene ${sceneId} --expect-textline-contains ${sentinelSubstring} --print-replay-log ${replayLogPath}`,
      ],
      flattenPostures(policy),
    );
    return;
  }

  mkdirSync(runDir, { recursive: true });

  // Capture source sha256 BEFORE any work.
  const sourceSeenPath = resolveReallivedataSeen(gameRoot);
  const sourceSeenSha256Before = sha256OfFile(sourceSeenPath);
  process.stdout.write(
    `[localize-sweetie-hd] source Seen.txt sha256 (pre): ${sourceSeenSha256Before}\n`,
  );

  // ------------------- Phase 1: kaifuu extract --------------------
  runCommand("cargo", [
    "run",
    "-p",
    "kaifuu-cli",
    "--quiet",
    "--",
    "extract",
    "--engine",
    "reallive",
    "--game-root",
    gameRoot,
    "--scene",
    String(sceneId),
    "--bundle-output",
    bridgeBundlePath,
  ]);

  // -------------- Phase 2: agentic loop (live LLM) ----------------
  const stageArgs = [
    join(REPO_ROOT, "apps", "itotori", "dist", "cli.js"),
    "localize-sweetie-hd-stage",
    "--bridge",
    bridgeBundlePath,
    "--pair-policy",
    PAIR_POLICY_PATH,
    "--unit-index",
    String(args.unitIndex),
    "--output",
    agenticLoopBundlePath,
    "--translated-bundle-output",
    translatedBundlePath,
    "--patch-report-output",
    patchReportPath,
  ];
  if (args.providerKind !== undefined) {
    stageArgs.push("--provider-kind", args.providerKind);
  }
  runCommand("node", stageArgs);

  // ----------------- Phase 3: kaifuu patch -----------------------
  // Re-resolve target writability + copy the source tree to TARGET.
  // The kaifuu-cli `patch --engine reallive` step itself ALSO copies
  // the source tree, but it expects target to be empty (unless --force).
  // We let kaifuu-cli do the copying so the writable-mode bumping is
  // owned in one place; that's why we don't pre-copy here.
  runCommand("cargo", [
    "run",
    "-p",
    "kaifuu-cli",
    "--quiet",
    "--",
    "patch",
    "--engine",
    "reallive",
    "--source",
    gameRoot,
    "--target",
    targetRoot,
    "--bundle",
    translatedBundlePath,
    "--force",
  ]);

  // --------------- Phase 4: replay-validate ----------------------
  const targetSeenPath = resolveReallivedataSeen(targetRoot);
  runCommand("cargo", [
    "run",
    "-p",
    "utsushi-cli",
    "--quiet",
    "--",
    "replay-validate",
    "--engine",
    "reallive",
    "--seen",
    targetSeenPath,
    "--scene",
    String(sceneId),
    "--expect-textline-contains",
    sentinelSubstring,
    "--print-replay-log",
    replayLogPath,
  ]);

  // ---- Readonly-source invariant: re-hash + assert no drift. ----
  const sourceSeenSha256After = sha256OfFile(sourceSeenPath);
  process.stdout.write(
    `[localize-sweetie-hd] source Seen.txt sha256 (post): ${sourceSeenSha256After}\n`,
  );
  if (sourceSeenSha256Before !== sourceSeenSha256After) {
    throw new Error(
      `kaifuu.reallive.source_mutated: source Seen.txt at ${sourceSeenPath} changed during the run (pre=${sourceSeenSha256Before}, post=${sourceSeenSha256After})`,
    );
  }

  // ---- Final summary: every artifact exists. ----
  for (const artifact of [
    bridgeBundlePath,
    agenticLoopBundlePath,
    patchReportPath,
    replayLogPath,
  ]) {
    if (!existsSync(artifact)) {
      throw new Error(`expected artifact missing after successful run: ${artifact}`);
    }
  }

  // Emit a one-line run summary so callers can scrape it.
  const summary = {
    runDir,
    sceneId,
    pair: policy.pair,
    enUsSentinel: policy.enUsSentinel,
    sourceSeenSha256: sourceSeenSha256Before,
    artifacts: {
      bridgeBundle: bridgeBundlePath,
      agenticLoopBundle: agenticLoopBundlePath,
      patchReport: patchReportPath,
      replayLog: replayLogPath,
    },
  };
  writeFileSync(join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`[localize-sweetie-hd] SUCCESS — run dir: ${runDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`[localize-sweetie-hd] FAILED: ${error.message}\n`);
  process.exit(1);
});
