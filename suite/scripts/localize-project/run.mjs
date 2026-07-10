#!/usr/bin/env node
/*
 * UTSUSHI-228 — alpha-closing driver for `just localize-project`.
 *
 * Chains the four phases of the alpha-defining end-to-end pipeline:
 *
 *   1. kaifuu-cli extract --engine reallive  (KAIFUU-210)
 *      -> artifacts/localize-project/<ts>/bridge-bundle.json
 *
 *   2. itotori localize-project-stage     (UTSUSHI-228 itself —
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
 *   - A source root is REQUIRED unless `--dry-run`: either
 *     LOCALIZE_PROJECT_SOURCE_PATH, ITOTORI_REAL_CORPUS_MANIFEST, or
 *     ITOTORI_REAL_GAME_ROOT.
 *   - `TARGET` env var is REQUIRED unless `--dry-run`. The driver
 *     refuses to write inside the source tree.
 *   - The resolved source `REALLIVEDATA/Seen.txt`
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
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { verifyProviderRunArtifactEvidence } from "./verify-artifacts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../../..");
const DEFAULT_ALPHA_TARGET_DATA_PATH = join(
  REPO_ROOT,
  "presets",
  "localize-project.alpha-target-data.json",
);
const REAL_CORPUS_MANIFEST_SCHEMA = "itotori.real-corpus-manifest.v0";
const LOCAL_ENV_FILE_ENV_VAR = "ITOTORI_LOCAL_ENV_FILE";
const LOCAL_ENV_ALLOWLIST = new Set([
  "OPENROUTER_API_KEY",
  "OPENROUTER_LIVE",
  "OPENROUTER_ZDR_ACCOUNT_ASSERTED",
  "OPENROUTER_ZDR_DOWNGRADE",
  "ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER",
  "ITOTORI_REAL_CORPUS_MANIFEST",
  "ITOTORI_REAL_GAME_ROOT",
  "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ",
  "LOCALIZE_PROJECT_SOURCE_PATH",
  "TARGET",
]);

function usage() {
  return [
    "usage: node suite/scripts/localize-project/run.mjs --project <NAME> [--corpus <ID>] [--dry-run] [--scene <N>] [--unit-index <N>] [--provider-kind <live|fake>] [--env-file <PATH>] [--target-data <PATH>] [--project-metadata <PATH>] [--pair-policy <PATH>]",
    "",
    "Required env (unless --dry-run):",
    "  OPENROUTER_API_KEY              live OpenRouter key for the (modelId, providerId) pair",
    "  ITOTORI_REAL_CORPUS_MANIFEST     local manifest with corpora[].{corpusId,projectId,engine,root}",
    "  ITOTORI_REAL_GAME_ROOT           fallback readonly path for a single selected corpus",
    "  LOCALIZE_PROJECT_SOURCE_PATH     direct readonly project source root (still supported)",
    "  TARGET                          writable path for the patched copy (must NOT alias source)",
    "",
    "Flags:",
    "  --project <NAME>                project config id; must match loaded metadata projectId and pair-policy policyId",
    "  --corpus <ID>                   corpus id inside ITOTORI_REAL_CORPUS_MANIFEST (default: unique corpus for project/engine)",
    "  --dry-run                       print per-phase commands and exit 0 without invoking an LLM",
    "  --scene <N>                     scene id passed to kaifuu extract / utsushi replay-validate (default 1)",
    "  --unit-index <N>                bridge unit index to translate (default 0)",
    "  --provider-kind <live|fake>     forwarded to the agentic-loop stage; fake requires ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1",
    `  --env-file <PATH>               explicitly load allowlisted local env keys (or set ${LOCAL_ENV_FILE_ENV_VAR})`,
    `  --target-data <PATH>            allowlisted alpha target data used when metadata/policy paths are omitted (default ${DEFAULT_ALPHA_TARGET_DATA_PATH})`,
    "  --project-metadata <PATH>       caller-supplied project identity metadata for extraction",
    "  --pair-policy <PATH>            caller-supplied pair-policy config for the agentic-loop stage",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    project: undefined,
    corpus: undefined,
    dryRun: false,
    scene: 1,
    unitIndex: 0,
    providerKind: undefined,
    envFilePath: undefined,
    targetDataPath: DEFAULT_ALPHA_TARGET_DATA_PATH,
    projectMetadataPath: undefined,
    pairPolicyPath: undefined,
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
      case "--corpus": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--corpus requires a value");
        args.corpus = value;
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
      case "--env-file": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--env-file requires a value");
        args.envFilePath = resolvePath(value);
        break;
      }
      case "--target-data": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--target-data requires a value");
        args.targetDataPath = resolvePath(value);
        break;
      }
      case "--project-metadata": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--project-metadata requires a value");
        args.projectMetadataPath = resolvePath(value);
        break;
      }
      case "--pair-policy": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--pair-policy requires a value");
        args.pairPolicyPath = resolvePath(value);
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

function parseLocalEnvValue(rawValue, lineNo) {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if (quote === `"` || quote === "'") {
      if (!trimmed.endsWith(quote)) {
        throw new Error(`local env file line ${lineNo} has an unterminated quoted value`);
      }
      const inner = trimmed.slice(1, -1);
      if (quote === "'") return inner;
      return inner.replace(/\\([nrt"\\])/gu, (_match, escaped) => {
        switch (escaped) {
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          default:
            return escaped;
        }
      });
    }
  }
  return trimmed;
}

function loadExplicitLocalEnvFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("explicit local env file was requested but does not exist");
    }
    throw new Error("explicit local env file was requested but could not be read");
  }

  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const rawLine = lines[index];
    if (rawLine.includes("\0")) {
      throw new Error(`local env file line ${lineNo} contains an unsafe NUL byte`);
    }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`local env file line ${lineNo} must be KEY=value`);
    }
    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(`local env file line ${lineNo} has an invalid key name`);
    }
    if (!LOCAL_ENV_ALLOWLIST.has(key)) continue;
    const value = parseLocalEnvValue(line.slice(equalsIndex + 1), lineNo);
    if (value.includes("\0")) {
      throw new Error(`local env file line ${lineNo} contains an unsafe NUL byte`);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildPathRedactor(rules) {
  const normalized = rules
    .filter((rule) => rule !== undefined && rule.path !== undefined && rule.path.length > 0)
    .map((rule) => ({ path: String(rule.path), replacement: String(rule.replacement) }))
    .sort((a, b) => b.path.length - a.path.length);
  return (text) => {
    let redacted = String(text);
    for (const rule of normalized) {
      redacted = redacted.replace(new RegExp(escapeRegExp(rule.path), "gu"), rule.replacement);
    }
    return redacted;
  };
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

function pathIsInsideRoot(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function portableRelativePath(fromDir, path) {
  const rel = relative(fromDir, path);
  return (rel === "" ? "." : rel).split(sep).join("/");
}

function repoRelativePath(path) {
  return portableRelativePath(REPO_ROOT, path);
}

function canonicalExistingPrefix(path) {
  const absolute = resolvePath(path);
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let canonicalPrefix = root;
  let consumed = 0;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      lstatSync(current);
      canonicalPrefix = realpathSync(current);
      consumed = index + 1;
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return resolvePath(canonicalPrefix, ...parts.slice(consumed));
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

function loadPairPolicy(pairPolicyPath) {
  if (!existsSync(pairPolicyPath)) {
    throw new Error(
      `pair-policy file missing at ${pairPolicyPath}; the driver does NOT default — this is by design`,
    );
  }
  const raw = readFileSync(pairPolicyPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`pair-policy JSON parse failed at ${pairPolicyPath}: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pair-policy at ${pairPolicyPath} must be a JSON object`);
  }
  // ITOTORI-234 / ITOTORI-238 — v0.3 forcing function: reject v0.1 /
  // v0.2 / absent schema version inputs at the driver boundary.
  // Mirrors the typed PairPolicyVersionMismatchError thrown by the TS
  // parser; we keep this duplicate gate inline because the driver is
  // plain Node JS (no TS imports) and needs to fail fast BEFORE
  // forking the stage command.
  const EXPECTED_SCHEMA = "itotori.pair-policy.v0.3";
  if (parsed.schemaVersion !== EXPECTED_SCHEMA) {
    throw new Error(
      `pair-policy at ${pairPolicyPath} has schemaVersion='${String(parsed.schemaVersion)}'; expected '${EXPECTED_SCHEMA}' (v0.1 and v0.2 files are no longer accepted — ITOTORI-238 no-legacy-compat)`,
    );
  }
  const requiredKeys = ["policyId", "pair", "sceneId", "stages"];
  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      throw new Error(`pair-policy at ${pairPolicyPath} missing required key '${key}'`);
    }
  }
  return parsed;
}

function requireMetadataString(record, key, metadataPath) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`project metadata at ${metadataPath} missing required string '${key}'`);
  }
  return value;
}

// Engine identity blocks the driver understands. Exactly one must be
// present in a project-metadata / alpha-target record. The block key
// selects the engine the four phases dispatch through (RealLive Seen.txt
// patchback + replay-validate, or RPG Maker MV/MZ JSON patchback + delta +
// text-trace runtime evidence).
const ENGINE_IDENTITY_BLOCKS = [
  { key: "reallive", engine: "reallive" },
  { key: "rpgMakerMvMz", engine: "rpg-maker-mv-mz" },
];

function parseProjectMetadataRecord(parsed, metadataPath) {
  const EXPECTED_SCHEMA = "itotori.localize-project.project-metadata.v0";
  if (parsed.schemaVersion !== EXPECTED_SCHEMA) {
    throw new Error(
      `project metadata at ${metadataPath} has schemaVersion='${String(parsed.schemaVersion)}'; expected '${EXPECTED_SCHEMA}'`,
    );
  }
  const present = ENGINE_IDENTITY_BLOCKS.filter(
    (candidate) =>
      typeof parsed[candidate.key] === "object" &&
      parsed[candidate.key] !== null &&
      !Array.isArray(parsed[candidate.key]),
  );
  if (present.length === 0) {
    throw new Error(
      `project metadata at ${metadataPath} must carry exactly one engine identity block ('reallive' or 'rpgMakerMvMz')`,
    );
  }
  if (present.length > 1) {
    throw new Error(
      `project metadata at ${metadataPath} carries multiple engine identity blocks; exactly one is allowed`,
    );
  }
  const { key, engine } = present[0];
  const block = parsed[key];
  return {
    projectId: requireMetadataString(parsed, "projectId", metadataPath),
    engine,
    gameId: requireMetadataString(block, "game_id", metadataPath),
    gameVersion: requireMetadataString(block, "game_version", metadataPath),
    sourceProfileId: requireMetadataString(block, "source_profile_id", metadataPath),
    sourceLocale: requireMetadataString(block, "source_locale", metadataPath),
    // alpha-006a — optional vault by-id sourcing key. When present (and
    // ITOTORI_VAULT_ROOT is set) the RealLive extract sources the corpus
    // read-only through the vault adapter instead of a raw --game-root.
    vaultCanonicalId: optionalMetadataString(block, "vault_canonical_id", metadataPath),
    // Config-driven translation scope (drives the byte-fidelity contract on
    // patchback). Defaults to `dialogue-only` when unset.
    translationScope:
      optionalMetadataString(block, "translation_scope", metadataPath) ?? "dialogue-only",
    // Opt-in stable artifact subdir under `artifacts/` (alpha capstone lands
    // its acceptance bundle at a fixed path, not a timestamped run dir).
    stableArtifactSubdir: optionalMetadataString(block, "stable_artifact_subdir", metadataPath),
    // Real g00 background stem the render composites when the pinned
    // dialogue scene's headless drive inherits its background from a prior
    // scene (empty terminal graphics stack). Real art, never a synthetic
    // fill; RealLive only.
    renderBgAsset: optionalMetadataString(block, "render_bg_asset", metadataPath),
  };
}

function optionalMetadataString(record, key, metadataPath) {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `project metadata at ${metadataPath} field '${key}' must be a non-empty string when present`,
    );
  }
  return value;
}

function requireManifestString(record, key, manifestPath, entryLabel) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `real corpus manifest at ${manifestPath} ${entryLabel} missing required string '${key}'`,
    );
  }
  return value;
}

function loadProjectMetadata(metadataPath) {
  if (!existsSync(metadataPath)) {
    throw new Error(
      `project metadata file missing at ${metadataPath}; the driver does NOT default RealLive bridge identity metadata`,
    );
  }
  const raw = readFileSync(metadataPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`project metadata JSON parse failed at ${metadataPath}: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`project metadata at ${metadataPath} must be a JSON object`);
  }
  return parseProjectMetadataRecord(parsed, metadataPath);
}

function requireTargetDataString(record, key, targetDataPath, entryLabel) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `alpha target data at ${targetDataPath} ${entryLabel} missing required string '${key}'`,
    );
  }
  return value;
}

function resolveTargetPresetPath(pathValue) {
  if (isAbsolute(pathValue)) return pathValue;
  return resolvePath(REPO_ROOT, pathValue);
}

function loadAlphaTargetData(targetDataPath) {
  if (!existsSync(targetDataPath)) {
    throw new Error(`alpha target data file missing at ${targetDataPath}`);
  }
  const raw = readFileSync(targetDataPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`alpha target data JSON parse failed at ${targetDataPath}: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`alpha target data at ${targetDataPath} must be a JSON object`);
  }
  const EXPECTED_SCHEMA = "itotori.localize-project.alpha-target-data.v0";
  if (parsed.schemaVersion !== EXPECTED_SCHEMA) {
    throw new Error(
      `alpha target data at ${targetDataPath} has schemaVersion='${String(parsed.schemaVersion)}'; expected '${EXPECTED_SCHEMA}'`,
    );
  }
  if (!Array.isArray(parsed.targets)) {
    throw new Error(`alpha target data at ${targetDataPath} missing required array 'targets'`);
  }
  const targets = parsed.targets.map((target, index) => {
    const entryLabel = `targets[${index}]`;
    if (typeof target !== "object" || target === null || Array.isArray(target)) {
      throw new Error(`alpha target data at ${targetDataPath} ${entryLabel} must be an object`);
    }
    const projectId = requireTargetDataString(target, "projectId", targetDataPath, entryLabel);
    const pairPolicyPathValue = requireTargetDataString(
      target,
      "pairPolicyPath",
      targetDataPath,
      entryLabel,
    );
    // Forward whichever engine identity block the target carries; the
    // record parser enforces exactly-one-engine.
    const engineBlock = {};
    for (const candidate of ENGINE_IDENTITY_BLOCKS) {
      if (target[candidate.key] !== undefined) {
        engineBlock[candidate.key] = target[candidate.key];
      }
    }
    const metadata = parseProjectMetadataRecord(
      {
        schemaVersion: "itotori.localize-project.project-metadata.v0",
        projectId,
        ...engineBlock,
      },
      `${targetDataPath} ${entryLabel}`,
    );
    return {
      projectId,
      pairPolicyPath: resolveTargetPresetPath(pairPolicyPathValue),
      metadata,
    };
  });
  return { schemaVersion: parsed.schemaVersion, targets };
}

function selectAlphaTarget(targetData, targetDataPath, requestedProject) {
  const matches = targetData.targets.filter((target) => target.projectId === requestedProject);
  if (matches.length === 0) {
    throw new Error(
      `alpha target data at ${targetDataPath} has no target for --project '${requestedProject}'; pass --project-metadata and --pair-policy for a caller-supplied project`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `alpha target data at ${targetDataPath} has multiple targets for --project '${requestedProject}'`,
    );
  }
  return matches[0];
}

function loadProjectConfig(args) {
  let target;
  if (args.projectMetadataPath === undefined || args.pairPolicyPath === undefined) {
    const targetData = loadAlphaTargetData(args.targetDataPath);
    target = selectAlphaTarget(targetData, args.targetDataPath, args.project);
  }
  const projectMetadata =
    args.projectMetadataPath === undefined
      ? target.metadata
      : loadProjectMetadata(args.projectMetadataPath);
  const pairPolicyPath = args.pairPolicyPath ?? target.pairPolicyPath;
  const pairPolicy = loadPairPolicy(pairPolicyPath);
  return { pairPolicy, pairPolicyPath, projectMetadata };
}

function validateProjectSelection(requestedProject, projectMetadata, pairPolicy) {
  const mismatches = [];
  if (projectMetadata.projectId !== requestedProject) {
    mismatches.push(`metadata projectId='${projectMetadata.projectId}'`);
  }
  if (pairPolicy.policyId !== requestedProject) {
    mismatches.push(`pair-policy policyId='${pairPolicy.policyId}'`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `--project '${requestedProject}' does not match loaded project config (${mismatches.join(", ")})`,
    );
  }
}

function loadRealCorpusManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `real corpus manifest missing at ${manifestPath}; set ITOTORI_REAL_CORPUS_MANIFEST to a local JSON file with schemaVersion='${REAL_CORPUS_MANIFEST_SCHEMA}' and corpora[].{corpusId,projectId,engine,root}`,
    );
  }
  const raw = readFileSync(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`real corpus manifest JSON parse failed at ${manifestPath}: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`real corpus manifest at ${manifestPath} must be a JSON object`);
  }
  if (parsed.schemaVersion !== REAL_CORPUS_MANIFEST_SCHEMA) {
    throw new Error(
      `real corpus manifest at ${manifestPath} has schemaVersion='${String(parsed.schemaVersion)}'; expected '${REAL_CORPUS_MANIFEST_SCHEMA}'`,
    );
  }
  if (!Array.isArray(parsed.corpora)) {
    throw new Error(`real corpus manifest at ${manifestPath} missing required array 'corpora'`);
  }
  const corpora = parsed.corpora.map((entry, index) => {
    const entryLabel = `corpora[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`real corpus manifest at ${manifestPath} ${entryLabel} must be an object`);
    }
    const sourceLocale = entry.sourceLocale;
    if (
      sourceLocale !== undefined &&
      (typeof sourceLocale !== "string" || sourceLocale.length === 0)
    ) {
      throw new Error(
        `real corpus manifest at ${manifestPath} ${entryLabel} sourceLocale must be a non-empty string when present`,
      );
    }
    return {
      corpusId: requireManifestString(entry, "corpusId", manifestPath, entryLabel),
      projectId: requireManifestString(entry, "projectId", manifestPath, entryLabel),
      engine: requireManifestString(entry, "engine", manifestPath, entryLabel),
      root: requireManifestString(entry, "root", manifestPath, entryLabel),
      sourceLocale,
    };
  });
  return { schemaVersion: parsed.schemaVersion, corpora };
}

function selectRealCorpusFromManifest(manifest, manifestPath, selection) {
  const projectMatches = manifest.corpora.filter(
    (corpus) => corpus.projectId === selection.projectId && corpus.engine === selection.engine,
  );
  const matches =
    selection.corpusId === undefined
      ? projectMatches
      : projectMatches.filter((corpus) => corpus.corpusId === selection.corpusId);
  if (matches.length === 0) {
    const corpusClause =
      selection.corpusId === undefined ? "" : `, corpusId='${selection.corpusId}'`;
    throw new Error(
      `ITOTORI_REAL_CORPUS_MANIFEST did not contain a corpus for projectId='${selection.projectId}'${corpusClause}, engine='${selection.engine}'; expected corpora[].{corpusId,projectId,engine,root}`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((corpus) => corpus.corpusId).join(", ");
    throw new Error(
      `ITOTORI_REAL_CORPUS_MANIFEST has multiple corpora for projectId='${selection.projectId}', engine='${selection.engine}' (${ids}); pass --corpus <ID> to select one`,
    );
  }
  const selected = matches[0];
  if (selected.sourceLocale !== undefined && selected.sourceLocale !== selection.sourceLocale) {
    throw new Error(
      `ITOTORI_REAL_CORPUS_MANIFEST selected corpus '${selected.corpusId}' has sourceLocale='${selected.sourceLocale}', but project metadata requires '${selection.sourceLocale}'`,
    );
  }
  return {
    envName: "ITOTORI_REAL_CORPUS_MANIFEST",
    root: selected.root,
    placeholder: "<ITOTORI_REAL_CORPUS_MANIFEST root>",
    dryRunLabel: `ITOTORI_REAL_CORPUS_MANIFEST corpusId=${selected.corpusId} projectId=${selected.projectId} engine=${selected.engine} root=<ITOTORI_REAL_CORPUS_MANIFEST root>`,
    manifestPath,
    corpus: selected,
  };
}

function missingRealCorpusSourceMessage() {
  return [
    "real corpus source root is required unless --dry-run",
    `set ITOTORI_REAL_CORPUS_MANIFEST to a local JSON descriptor with schemaVersion='${REAL_CORPUS_MANIFEST_SCHEMA}' and corpora[].{corpusId,projectId,engine,root},`,
    "or set ITOTORI_REAL_GAME_ROOT for a single-corpus local run,",
    "or set LOCALIZE_PROJECT_SOURCE_PATH to a direct source root",
  ].join(" ");
}

// Per-engine convenience env var for a single local corpus root, mirroring
// the read-only-fixture env the engine's real-bytes tests already honor.
const ENGINE_REAL_GAME_ROOT_ENV = {
  reallive: "ITOTORI_REAL_GAME_ROOT",
  "rpg-maker-mv-mz": "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ",
};

function resolveRealCorpusSource({ dryRun, projectMetadata, corpusId }) {
  const engine = projectMetadata.engine;
  const manifestPath = process.env.ITOTORI_REAL_CORPUS_MANIFEST;
  if (manifestPath !== undefined && manifestPath.length > 0) {
    const manifest = loadRealCorpusManifest(manifestPath);
    return selectRealCorpusFromManifest(manifest, manifestPath, {
      projectId: projectMetadata.projectId,
      corpusId,
      engine,
      sourceLocale: projectMetadata.sourceLocale,
    });
  }

  // Engine-specific single-corpus env var (e.g.
  // ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ for the MV/MZ www root).
  const engineEnvName = ENGINE_REAL_GAME_ROOT_ENV[engine];
  if (engineEnvName !== undefined && engineEnvName !== "ITOTORI_REAL_GAME_ROOT") {
    const engineRoot = process.env[engineEnvName];
    if (engineRoot !== undefined && engineRoot.length > 0) {
      return {
        envName: engineEnvName,
        root: engineRoot,
        placeholder: `<${engineEnvName}>`,
        dryRunLabel: `${engineEnvName} single corpus root=<${engineEnvName}> projectId=${projectMetadata.projectId} engine=${engine}`,
        corpus: {
          corpusId: corpusId ?? projectMetadata.projectId,
          projectId: projectMetadata.projectId,
          engine,
          root: engineRoot,
          sourceLocale: projectMetadata.sourceLocale,
        },
      };
    }
  }

  const gameRoot = process.env.ITOTORI_REAL_GAME_ROOT;
  if (gameRoot !== undefined && gameRoot.length > 0) {
    return {
      envName: "ITOTORI_REAL_GAME_ROOT",
      root: gameRoot,
      placeholder: "<ITOTORI_REAL_GAME_ROOT>",
      dryRunLabel: `ITOTORI_REAL_GAME_ROOT single corpus root=<ITOTORI_REAL_GAME_ROOT> projectId=${projectMetadata.projectId} engine=${engine}`,
      corpus: {
        corpusId: corpusId ?? projectMetadata.projectId,
        projectId: projectMetadata.projectId,
        engine,
        root: gameRoot,
        sourceLocale: projectMetadata.sourceLocale,
      },
    };
  }

  const directSourceRoot = process.env.LOCALIZE_PROJECT_SOURCE_PATH;
  if (directSourceRoot !== undefined && directSourceRoot.length > 0) {
    return {
      envName: "LOCALIZE_PROJECT_SOURCE_PATH",
      root: directSourceRoot,
      placeholder: "<LOCALIZE_PROJECT_SOURCE_PATH>",
      dryRunLabel: "LOCALIZE_PROJECT_SOURCE_PATH direct source root=<LOCALIZE_PROJECT_SOURCE_PATH>",
    };
  }

  if (dryRun) {
    return {
      envName: undefined,
      root: undefined,
      placeholder:
        "<ITOTORI_REAL_CORPUS_MANIFEST root|ITOTORI_REAL_GAME_ROOT|LOCALIZE_PROJECT_SOURCE_PATH>",
      dryRunLabel:
        "unresolved source root; live run requires ITOTORI_REAL_CORPUS_MANIFEST, ITOTORI_REAL_GAME_ROOT, or LOCALIZE_PROJECT_SOURCE_PATH",
    };
  }

  throw new Error(missingRealCorpusSourceMessage());
}

function realliveIdentityArgs(projectMetadata) {
  return [
    "--game-id",
    projectMetadata.gameId,
    "--game-version",
    projectMetadata.gameVersion,
    "--source-profile-id",
    projectMetadata.sourceProfileId,
    "--source-locale",
    projectMetadata.sourceLocale,
  ];
}

// ITOTORI-234 / ITOTORI-238 — deterministic seed derivation matching
// packages/localization-bridge-schema/src/pair-policy.v0.3.ts
// (`deriveDefaultSeed`). Duplicated inline because the driver does not
// import TS code.
function deriveDefaultSeed(leafPath) {
  const hex = createHash("sha256").update(leafPath).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16);
}

// Flatten the v0.3 stage tree into (leafPath, posture) tuples mirroring
// `flattenPairPolicyV03Postures` in the schema package.
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

function ensureWritableTargetDistinctFromSource(sourceRoot, targetRoot, redact = (text) => text) {
  const sourceAbs = resolvePath(sourceRoot);
  const targetAbs = resolvePath(targetRoot);
  try {
    if (lstatSync(targetAbs).isSymbolicLink()) {
      throw new Error(redact(`TARGET (${targetAbs}) must not be a symlink`));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let sourceCanonical;
  let targetCanonical;
  try {
    sourceCanonical = realpathSync(sourceAbs);
    targetCanonical = canonicalExistingPrefix(targetAbs);
  } catch {
    throw new Error(redact("failed to canonicalize source/TARGET paths before patching"));
  }
  if (sourceAbs === targetAbs || sourceCanonical === targetCanonical) {
    throw new Error(
      redact(`TARGET (${targetAbs}) must not alias resolved source root (${sourceAbs})`),
    );
  }
  if (
    pathIsInsideRoot(targetAbs, sourceAbs) ||
    pathIsInsideRoot(sourceAbs, targetAbs) ||
    pathIsInsideRoot(targetCanonical, sourceCanonical) ||
    pathIsInsideRoot(sourceCanonical, targetCanonical)
  ) {
    throw new Error(
      redact(
        `TARGET (${targetAbs}) must not nest with resolved source root (${sourceAbs}); pick a fully-disjoint path`,
      ),
    );
  }
  rejectTargetTreeSymlinks(targetAbs, redact);
}

function rejectTargetTreeSymlinks(targetRoot, redact = (text) => text) {
  let rootStat;
  try {
    rootStat = lstatSync(targetRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(redact(`TARGET (${targetRoot}) tree must not contain symlinks`));
  }
  if (!rootStat.isDirectory()) return;

  const stack = [targetRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(redact(`TARGET (${targetRoot}) tree must not contain symlinks: ${path}`));
      }
      if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }
}

function runCommand(command, args, env = process.env, options = {}) {
  const { redact = (text) => text, ...spawnOptions } = options;
  const printable = `${command} ${args.join(" ")}`;
  const printableRedacted = redact(printable);
  process.stdout.write(`[localize-project] $ ${printableRedacted}\n`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
    ...spawnOptions,
  });
  if (result.stdout !== undefined && result.stdout.length > 0) {
    process.stdout.write(redact(result.stdout));
  }
  if (result.stderr !== undefined && result.stderr.length > 0) {
    process.stderr.write(redact(result.stderr));
  }
  // Capture the (already-redacted) child output on any thrown error so the
  // chain-outcome classifier can inspect it for component semantic codes
  // (e.g. a kaifuu/utsushi out-of-profile diagnostic printed to stderr).
  const childStdout = result.stdout !== undefined ? redact(result.stdout) : "";
  const childStderr = result.stderr !== undefined ? redact(result.stderr) : "";
  if (result.error) {
    const error = new Error(
      `command failed to start: ${printableRedacted}: ${result.error.message}`,
    );
    error.childStdout = childStdout;
    error.childStderr = childStderr;
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(`command exited with status ${result.status}: ${printableRedacted}`);
    error.childStdout = childStdout;
    error.childStderr = childStderr;
    throw error;
  }
}

function printDryRunPlan(plan, postures, realCorpusSource) {
  process.stdout.write(
    "[localize-project] --dry-run plan (no LLM calls; 0 ProviderRunRecords would be written):\n",
  );
  process.stdout.write(`[localize-project] Real corpus source: ${realCorpusSource.dryRunLabel}\n`);
  // ITOTORI-227 — the OpenRouter privacy posture is part of the dry-run
  // plan so the operator can confirm the account-level ZDR setting is
  // asserted and every non-public request body will carry
  // provider.zdr=true. The constructor-level assertion runs in the live
  // path; for dry-run we surface its expected state here.
  const zdrAccountAsserted = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1" ? "1" : "MISSING";
  process.stdout.write(
    `[localize-project] ZDR account asserted: OPENROUTER_ZDR_ACCOUNT_ASSERTED=${zdrAccountAsserted}\n`,
  );
  process.stdout.write(
    "[localize-project] Per-stage provider.zdr posture: true (all non-public input classifications)\n",
  );
  // ITOTORI-234 — the v0.3 pair-policy carries per-stage zdr + seed
  // postures resolved at parse time. Emit one line per leaf so the
  // operator can confirm the (zdr, seed) pair the orchestrator will
  // pass into every invocation. Acceptance criterion #1: this block
  // is what the test asserts on.
  process.stdout.write(
    "[localize-project] Per-stage posture (ITOTORI-234 v0.3 — leafPath: zdr=<bool> seed=<int>):\n",
  );
  for (const posture of postures) {
    process.stdout.write(
      `[localize-project]   stage ${posture.leafPath}: zdr=${posture.zdr} seed=${posture.seed}\n`,
    );
  }
  for (const line of plan) {
    process.stdout.write(`[localize-project] (planned) $ ${line}\n`);
  }
  process.stdout.write("[localize-project] DRY-RUN: 0 LLM calls would be made.\n");
}

export function verifyProviderRunArtifactsAfterStage({
  agenticLoopBundlePath,
  patchReportPath,
  providerRunArtifactsDir,
  expectedPair,
}) {
  const pair = expectedPair ?? {};
  return verifyProviderRunArtifactEvidence({
    agenticLoopBundlePath,
    patchReportPath,
    providerRunArtifactsDir,
    expectedModelId: pair.modelId,
    expectedProviderId: pair.providerId,
  });
}

// ---------- RPG Maker MV/MZ engine pipeline (vertical slice) ----------

// Runtime scene files the `utsushi-rpgmaker-mv` E1 port emits text from:
// CommonEvents + numbered Maps (Show Text / Scroll / Choices). Database /
// System surfaces are NOT replayed, so the bounded translation target must
// land in one of these files for the runtime trace to carry it.
const RPG_MAKER_RUNTIME_SCENE_FILE = /^(CommonEvents|Map\d+)\.json$/u;

/** Parse a `rpgmaker:<file>#<json-pointer>` surface key into the file. */
function rpgMakerSurfaceFile(sourceUnitKey) {
  const rest = String(sourceUnitKey).replace(/^rpgmaker:/u, "");
  const hashIndex = rest.indexOf("#");
  return hashIndex === -1 ? rest : rest.slice(0, hashIndex);
}

/**
 * Pick the bounded live-translation target: the first `dialogue` unit
 * whose surface lives in a runtime-replayed scene file. Translating one
 * such unit (rest no-op) keeps the live LLM cost to a single billed
 * invocation while guaranteeing the patched text shows up in the runtime
 * trace the validator asserts on.
 */
function selectRpgMakerDialogueUnit(bridge) {
  const units = Array.isArray(bridge.units) ? bridge.units : [];
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit === null || typeof unit !== "object" || unit.surfaceKind !== "dialogue") continue;
    const file = rpgMakerSurfaceFile(unit.sourceUnitKey);
    if (RPG_MAKER_RUNTIME_SCENE_FILE.test(file)) {
      return { unitIndex: index, sceneFile: file };
    }
  }
  throw new Error(
    "kaifuu.rpgmaker: no dialogue unit found in a CommonEvents/Map scene file; cannot bound the runtime slice",
  );
}

/** Deterministic sha256 over a `data/` tree (sorted rel-path + bytes). */
function sha256OfDataTree(dataDir) {
  const files = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`refusing to hash symlink at ${join(dir, entry.name)}`);
      }
      const abs = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files.push([rel, abs]);
    }
  };
  walk(dataDir, "");
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hash = createHash("sha256");
  for (const [rel, abs] of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(abs));
  }
  return hash.digest("hex");
}

/**
 * Real on-disk asset-inventory scan of an RPG Maker MV/MZ `data/` tree.
 * Counts/hashes only — never copies or embeds raw asset bytes — so the
 * inventory artifact is safe to persist next to the run. This is the
 * inventory primitive that runs over the REAL corpus (no synthetic
 * fixture engine, and NOT the registry `asset-inventory` command, which
 * hard-errors on a corpus with no first-party registered adapter).
 */
function scanRpgMakerDataInventory(dataDir) {
  let dataJsonFileCount = 0;
  let runtimeSceneFileCount = 0;
  let totalDataBytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`refusing to inventory symlink at ${join(dir, entry.name)}`);
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".json")) {
          dataJsonFileCount += 1;
          totalDataBytes += statSync(abs).size;
          if (RPG_MAKER_RUNTIME_SCENE_FILE.test(entry.name)) {
            runtimeSceneFileCount += 1;
          }
        }
      }
    }
  };
  walk(dataDir);
  return {
    dataJsonFileCount,
    runtimeSceneFileCount,
    totalDataBytes,
    dataTreeSha256: sha256OfDataTree(dataDir),
  };
}

/**
 * Wire the `kaifuu detect` detection primitive into the front of the run.
 * `detect` exits 0 even when no first-party adapter matches (status
 * `unknown`) — that is recorded as an INFORMATIONAL structured finding,
 * not a silent skip. A non-zero exit (genuine detection failure) is
 * surfaced by `runCommand` as a thrown error.
 */
function runKaifuuDetect({ gameRoot, outputPath, redact }) {
  runCommand(
    "cargo",
    ["run", "-p", "kaifuu-cli", "--quiet", "--", "detect", gameRoot, "--output", outputPath],
    process.env,
    { redact },
  );
  const report = JSON.parse(readFileSync(outputPath, "utf8"));
  const adapterIds = Array.isArray(report.detections)
    ? report.detections.map((detection) => detection.adapterId).filter(Boolean)
    : [];
  return { status: report.status, adapterIds, warnings: report.warnings ?? [] };
}

/**
 * Compose the identity-first inventory/readiness record. The run reports
 * catalog / local-corpus / readiness identity HERE — before the extract
 * (bridge-import) phase — so bridge import is no longer the first project
 * fact. All anomalies become structured findings (never silent skips).
 */
function buildInventoryReadiness({ realCorpusSource, projectMetadata, detection, dataInventory }) {
  const SOURCE_KIND_BY_ENV = {
    ITOTORI_REAL_CORPUS_MANIFEST: "catalog-manifest",
    ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ: "local-corpus",
    ITOTORI_REAL_GAME_ROOT: "local-corpus",
    LOCALIZE_PROJECT_SOURCE_PATH: "direct-source",
  };
  const sourceKind = SOURCE_KIND_BY_ENV[realCorpusSource.envName] ?? "unknown";
  const corpus = realCorpusSource.corpus;
  const localCorpus = {
    sourceKind,
    sourceEnv: realCorpusSource.envName ?? null,
    corpusId: corpus?.corpusId ?? projectMetadata.projectId,
    projectId: corpus?.projectId ?? projectMetadata.projectId,
    engine: projectMetadata.engine,
    sourceLocale: corpus?.sourceLocale ?? projectMetadata.sourceLocale,
    // The on-disk root is NEVER embedded; only the env-var name + the
    // redaction placeholder are recorded.
    rootPlaceholder: realCorpusSource.placeholder,
  };
  const readiness = {
    gameId: projectMetadata.gameId,
    gameVersion: projectMetadata.gameVersion,
    sourceProfileId: projectMetadata.sourceProfileId,
    sourceLocale: projectMetadata.sourceLocale,
    engine: projectMetadata.engine,
  };
  const findings = [];
  if (detection.status !== "matched") {
    findings.push({
      code: "inventory.detection.no_first_party_adapter",
      severity: "info",
      message: `kaifuu detect status='${detection.status}' (probed adapters: ${detection.adapterIds.join(", ") || "none"}); RPG Maker MV/MZ uses a dedicated extract path, so an unmatched registry detection is expected and recorded as evidence, not a failure`,
    });
  }
  if (dataInventory.runtimeSceneFileCount === 0) {
    findings.push({
      code: "inventory.runtime_scene.absent",
      severity: "blocking",
      message:
        "no CommonEvents/Map*.json runtime scene file found under data/; the bounded runtime slice cannot be proven",
    });
  }
  const blockingFindings = findings.filter((finding) => finding.severity === "blocking");
  return {
    schemaVersion: "itotori.localize-project.rpg-maker-mv-mz.inventory-readiness.v0",
    identityFirst: true,
    project: projectMetadata.projectId,
    localCorpus,
    readiness,
    detection: { status: detection.status, adapterIds: detection.adapterIds },
    assetInventory: dataInventory,
    findings,
    readinessVerdict: blockingFindings.length === 0 ? "ready" : "blocked",
  };
}

/**
 * Read the per-invocation billed cost + ZDR posture straight from the
 * persisted provider-run artifacts (`run.cost.amountMicrosUsd` /
 * `run.routingPosture.zdr`). Cost is NEVER approximated or hardcoded — it
 * is summed from the real `usage.cost` the live OpenRouter calls reported.
 */
export function summarizeProviderBilledCost(providerRunArtifactsDir) {
  if (!existsSync(providerRunArtifactsDir)) {
    return {
      available: false,
      invocationCount: 0,
      billedMicrosUsd: 0,
      billedUsd: "0.00000000",
      zdrEnforcedCount: 0,
    };
  }
  let invocationCount = 0;
  let billedMicrosUsd = 0;
  let zdrEnforcedCount = 0;
  for (const entry of readdirSync(providerRunArtifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const artifactPath = join(providerRunArtifactsDir, entry.name, "provider-run.json");
    if (!existsSync(artifactPath)) continue;
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const run = artifact.run ?? {};
    invocationCount += 1;
    const cost = run.cost ?? {};
    if (cost.costKind === "billed" && Number.isInteger(cost.amountMicrosUsd)) {
      billedMicrosUsd += cost.amountMicrosUsd;
    }
    if (run.routingPosture?.zdr === true) {
      zdrEnforcedCount += 1;
    }
  }
  return {
    available: invocationCount > 0,
    invocationCount,
    billedMicrosUsd,
    billedUsd: (billedMicrosUsd / 1_000_000).toFixed(8),
    zdrEnforcedCount,
  };
}

const ZEROED_COST_SUMMARY = Object.freeze({
  available: false,
  invocationCount: 0,
  billedMicrosUsd: 0,
  billedUsd: "0.00000000",
  zdrEnforcedCount: 0,
});

/**
 * Compose the feedback-driven loop summary from the initial + rerun
 * iterations.
 *
 * This is the single place the rerun's re-billing is proven, not merely
 * asserted:
 *
 *   1. DISTINCT ARTIFACTS — the rerun's provider-run directory MUST differ
 *      from the initial iteration's. A shared directory would alias the
 *      initial slice's artifacts, so the "second" billed amount would be a
 *      copy / double-count rather than a real second slice. We hard-fail.
 *   2. INDEPENDENT COST SOURCE — cost is re-read independently from EACH
 *      iteration's own provider-run artifacts. The rerun's billed cost is
 *      therefore a pure function of the rerun's real second-slice artifacts.
 *   3. rerunCompleted IS DERIVED — it is true only when the rerun's real
 *      second-slice artifact set actually exists on disk, never assumed.
 *      Absent rerun artifacts -> `rerunCompleted: false` and no rerun cost.
 *
 * `fake` provider skips real billing entirely (zeroed), matching the slice
 * iterations' own cost handling.
 */
export function buildRerunLoopSummary({
  providerKind,
  initialPaths,
  rerunPaths,
  initialVerdict,
  rerunVerdict,
}) {
  if (rerunPaths.providerRunArtifactsDir === initialPaths.providerRunArtifactsDir) {
    throw new Error(
      `rerun re-billing invariant: the rerun's provider-run dir must differ from the initial iteration's, else the second slice's cost is a copy of the first (both '${rerunPaths.providerRunArtifactsDir}')`,
    );
  }

  // The rerun's real second-slice artifact set. `rerunCompleted` is proof a
  // real second bounded slice ran, so it is derived from these existing.
  const rerunArtifactSet = [
    rerunPaths.agenticLoopBundlePath,
    rerunPaths.patchReportPath,
    rerunPaths.deltaPath,
    rerunPaths.applyReportPath,
    rerunPaths.runtimeEvidencePath,
    rerunPaths.providerRunArtifactsDir,
  ];
  const rerunCompleted = rerunArtifactSet.every((artifact) => existsSync(artifact));

  const initialCost =
    providerKind === "fake"
      ? { ...ZEROED_COST_SUMMARY }
      : summarizeProviderBilledCost(initialPaths.providerRunArtifactsDir);
  // The rerun cost is sourced ONLY from the rerun's own artifacts, and only
  // once the rerun actually completed — never inherited from `initialCost`.
  const rerunCost =
    providerKind === "fake" || !rerunCompleted
      ? { ...ZEROED_COST_SUMMARY }
      : summarizeProviderBilledCost(rerunPaths.providerRunArtifactsDir);

  const totalBilledMicrosUsd = initialCost.billedMicrosUsd + rerunCost.billedMicrosUsd;
  return {
    identityFirst: true,
    iterations: [
      { iteration: "initial", verdict: initialVerdict, cost: initialCost },
      { iteration: "rerun", verdict: rerunVerdict, cost: rerunCost },
    ],
    rerunCompleted,
    totalBilledMicrosUsd,
    totalBilledUsd: (totalBilledMicrosUsd / 1_000_000).toFixed(8),
  };
}

/**
 * Build the localized-bundle artifact for the alpha capstone: the primary
 * (model, provider) pair + localized English line from patch-report.json,
 * plus the SERVED pair, the REAL /generation cost, and the ZDR posture of
 * every live invocation pulled from the per-invocation provider-run
 * records. Aggregates into ONE readable file the acceptance can point at.
 */
function buildLocalizedBundleArtifact({
  runDir,
  patchReportPath,
  providerRunArtifactsDir,
  decompileReportPath,
  sceneOnePngPath,
  zdrAccountAsserted,
}) {
  const patchReport = JSON.parse(readFileSync(patchReportPath, "utf8"));
  const decompileReport = existsSync(decompileReportPath)
    ? JSON.parse(readFileSync(decompileReportPath, "utf8"))
    : {};
  const invocations = [];
  let totalCostUsd = 0;
  let allServedZdr = true;
  if (existsSync(providerRunArtifactsDir)) {
    const dirs = readdirSync(providerRunArtifactsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of dirs) {
      const artifactPath = join(providerRunArtifactsDir, name, "provider-run.json");
      if (!existsSync(artifactPath)) continue;
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      const run = artifact.run ?? {};
      const provider = run.provider ?? {};
      const cost = run.cost ?? {};
      const posture = run.routingPosture ?? {};
      // Authoritative full-precision billed cost (OpenRouter usage.cost),
      // mirrored verbatim on cost.amountUsd and usageResponseJson.cost.
      const generationCost = run.usageResponseJson?.cost ?? cost.amountUsd ?? "0";
      const parsed = Number.parseFloat(String(generationCost));
      if (Number.isFinite(parsed)) totalCostUsd += parsed;
      const zdr = posture.zdr === true;
      if (!zdr) allServedZdr = false;
      invocations.push({
        runId: run.runId,
        taskKind: run.taskKind,
        status: run.status,
        requestedModelId: provider.requestedModelId,
        requestedProviderId: provider.requestedProviderId,
        servedModelId: provider.actualModelId,
        servedProviderId: provider.upstreamProvider ?? provider.requestedProviderId,
        costKind: cost.costKind,
        generationCostUsd: String(generationCost),
        routingPosture: {
          zdr,
          allow_fallbacks: posture.allow_fallbacks === true,
          data_collection: posture.data_collection,
          order: Array.isArray(posture.order) ? posture.order : [],
        },
      });
    }
  }
  return {
    schemaVersion: "itotori.localize-project.localized-bundle.v0",
    policyId: patchReport.policyId,
    sceneId: patchReport.sceneId,
    // The single primary pair the request preferred (provider.order[0]).
    primaryPair: patchReport.pair,
    // The exact localized English line the live LLM produced.
    localizedText: patchReport.finalDraftText,
    translatedTargetText: patchReport.translatedTargetText,
    decompile: {
      unknownOpcodes: decompileReport.unknownOpcodes,
      sourceSeenSha256: decompileReport.sourceSeenSha256,
    },
    zdr: {
      accountAsserted: zdrAccountAsserted === true,
      allServedZdr,
    },
    billedCallCount: invocations.length,
    totalCostUsd: totalCostUsd.toFixed(10),
    invocations,
    redactedScenePng: portableRelativePath(runDir, sceneOnePngPath),
  };
}

/**
 * Synthesize the structured feedback record from a completed iteration's
 * runtime + patch + apply + cost evidence. This is the FEEDBACK half of
 * the iterate cycle: every anomaly is a structured finding, and the
 * verdict drives whether a rerun is recommended.
 */
function synthesizeRpgMakerFeedback({
  iteration,
  project,
  boundedSlice,
  runtimeEvidence,
  patchReport,
  applyReport,
  costSummary,
  priorVerdict,
}) {
  const findings = [];
  if (runtimeEvidence.matched !== true) {
    findings.push({
      code: "runtime.observed_text.not_matched",
      severity: "blocking",
      message: `the engine's runtime trace (lines=${runtimeEvidence.lineCount}) did not observe the real translated text in any emitted TextLine (matchCode=${runtimeEvidence.matchCode})`,
    });
  } else {
    findings.push({
      code: "runtime.observed_text.confirmed",
      severity: "info",
      message: `the engine observed the real translated text in its runtime trace (lines=${runtimeEvidence.lineCount})`,
    });
  }
  const applyStatus =
    applyReport?.status ?? applyReport?.result?.status ?? applyReport?.outcome ?? "unknown";
  if (typeof applyStatus === "string" && /fail/iu.test(applyStatus)) {
    findings.push({
      code: "delta.apply.failed",
      severity: "blocking",
      message: `delta-apply reported status='${applyStatus}'`,
    });
  }
  if (costSummary.available && costSummary.billedMicrosUsd <= 0) {
    findings.push({
      code: "cost.non_billed_live_success",
      severity: "blocking",
      message: "live invocations completed but no billed cost was recorded",
    });
  }
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const verdict = blocking.length === 0 ? "observed-text-confirmed-in-runtime" : "needs-iteration";
  return {
    schemaVersion: "itotori.localize-project.rpg-maker-mv-mz.feedback.v0",
    iteration,
    project,
    boundedSlice,
    runtime: {
      matched: runtimeEvidence.matched,
      lineCount: runtimeEvidence.lineCount,
      matchCode: runtimeEvidence.matchCode,
      assertObservedText: runtimeEvidence.assertObservedText,
    },
    patch: {
      bridgeUnitId: patchReport?.bridgeUnitId ?? null,
      unitCount: patchReport?.unitCount ?? null,
    },
    cost: costSummary,
    findings,
    verdict,
    rerunRecommended: blocking.length > 0,
    ...(priorVerdict === undefined ? {} : { priorVerdict }),
  };
}

/**
 * Run ONE bounded translate->patch->delta-apply->runtime iteration of the
 * MV/MZ slice into `paths`. Shared by the initial run and the feedback-
 * driven rerun so both exercise the identical composed loop. The bridge
 * bundle + bounded unit index are produced once (extract) and reused, so
 * a rerun re-bills only the single bounded translation slice.
 */
async function runRpgMakerSliceIteration({
  iterationLabel,
  paths,
  args,
  policy,
  pairPolicyPath,
  bridgeBundlePath,
  sourceDataDir,
  gameRoot,
  unitIndex,
  sceneFile,
  runId,
  redact,
}) {
  const stageArgs = [
    join(REPO_ROOT, "apps", "itotori", "dist", "cli.js"),
    "localize-project-stage",
    "--bridge",
    bridgeBundlePath,
    "--pair-policy",
    pairPolicyPath,
    "--unit-index",
    String(unitIndex),
    "--engine-profile",
    "rpg-maker-mv-mz",
    "--output",
    paths.agenticLoopBundlePath,
    "--translated-bundle-output",
    paths.translatedBundlePath,
    "--patch-report-output",
    paths.patchReportPath,
    "--provider-run-artifacts-dir",
    paths.providerRunArtifactsDir,
  ];
  if (args.providerKind !== undefined) {
    stageArgs.push("--provider-kind", args.providerKind);
  }
  runCommand("node", stageArgs, process.env, { redact });

  if (args.providerKind !== "fake") {
    const providerProof = verifyProviderRunArtifactsAfterStage({
      agenticLoopBundlePath: paths.agenticLoopBundlePath,
      patchReportPath: paths.patchReportPath,
      providerRunArtifactsDir: paths.providerRunArtifactsDir,
      expectedPair: policy.pair,
    });
    process.stdout.write(
      `[localize-project] [${iterationLabel}] provider-run artifacts: ${providerProof.providerRunArtifactCount} verified for ${providerProof.invocations.length} live invocation(s)\n`,
    );
  }

  // The REAL translated draft the stage produced. The runtime capture
  // asserts the engine OBSERVES this text in an emitted TextLine — the
  // observed-output evidence is the intersection of the LLM's real
  // translation and the engine's real decode, not a planted sentinel.
  const patchReport = JSON.parse(readFileSync(paths.patchReportPath, "utf8"));
  const expectedObservedText = patchReport.finalDraftText;
  if (typeof expectedObservedText !== "string" || expectedObservedText.length === 0) {
    throw new Error(
      `runtime evidence: patch-report at ${paths.patchReportPath} has no non-empty finalDraftText to assert the runtime capture against`,
    );
  }

  runCommand(
    "cargo",
    [
      "run",
      "-p",
      "kaifuu-cli",
      "--quiet",
      "--",
      "patch",
      "--engine",
      "rpgmaker",
      "--source",
      gameRoot,
      "--bundle",
      paths.translatedBundlePath,
      "--delta-output",
      paths.deltaPath,
      "--patched-data-output",
      paths.patchedDataDir,
    ],
    process.env,
    { redact },
  );

  runCommand(
    "cargo",
    [
      "run",
      "-p",
      "kaifuu-cli",
      "--quiet",
      "--",
      "apply",
      sourceDataDir,
      "--patch",
      paths.deltaPath,
      "--output",
      paths.appliedDataDir,
      "--report-output",
      paths.applyReportPath,
    ],
    process.env,
    { redact },
  );

  const runtimeDataDir = join(paths.runtimeInputDir, "data");
  mkdirSync(runtimeDataDir, { recursive: true });
  copyFileSync(join(paths.appliedDataDir, sceneFile), join(runtimeDataDir, sceneFile));
  runCommand(
    "cargo",
    [
      "run",
      "-p",
      "utsushi-cli",
      "--quiet",
      "--",
      "rpgmaker-mv-capture",
      "--game-dir",
      paths.runtimeInputDir,
      "--artifact-root",
      paths.runtimeArtifactsDir,
      "--run-id",
      runId,
      "--assert-observed-text",
      expectedObservedText,
      "--output",
      paths.runtimeEvidencePath,
    ],
    process.env,
    { redact },
  );

  const runtimeEvidence = JSON.parse(readFileSync(paths.runtimeEvidencePath, "utf8"));
  const applyReport = JSON.parse(readFileSync(paths.applyReportPath, "utf8"));
  const costSummary =
    args.providerKind === "fake"
      ? {
          available: false,
          invocationCount: 0,
          billedMicrosUsd: 0,
          billedUsd: "0.00000000",
          zdrEnforcedCount: 0,
        }
      : summarizeProviderBilledCost(paths.providerRunArtifactsDir);
  return { runtimeEvidence, patchReport, applyReport, costSummary };
}

/** Build the per-iteration output-path set rooted at `iterationDir`. */
function rpgMakerIterationPaths(iterationDir) {
  return {
    agenticLoopBundlePath: join(iterationDir, "agentic-loop-bundle.v0.json"),
    translatedBundlePath: join(iterationDir, "translated-bridge.json"),
    patchReportPath: join(iterationDir, "patch-report.json"),
    deltaPath: join(iterationDir, "patch.kaifuu"),
    patchedDataDir: join(iterationDir, "patched-data"),
    appliedDataDir: join(iterationDir, "delta-applied", "data"),
    applyReportPath: join(iterationDir, "apply-report.json"),
    runtimeInputDir: join(iterationDir, "runtime-input"),
    runtimeArtifactsDir: join(iterationDir, "runtime-artifacts"),
    runtimeEvidencePath: join(iterationDir, "runtime-evidence.json"),
    providerRunArtifactsDir: join(iterationDir, "provider-runs"),
  };
}

async function runRpgMakerMvMzPipeline(ctx) {
  const {
    args,
    policy,
    pairPolicyPath,
    projectMetadata,
    runDir,
    bridgeBundlePath,
    agenticLoopBundlePath,
    translatedBundlePath,
    patchReportPath,
    providerRunArtifactsDir,
    dryRun,
    realCorpusSource,
    gameRoot,
  } = ctx;

  const findingsPath = join(runDir, "extraction-findings.json");
  const detectionReportPath = join(runDir, "detection-report.json");
  const inventoryReadinessPath = join(runDir, "inventory-readiness.json");
  const feedbackPath = join(runDir, "feedback.json");
  const rerunDir = join(runDir, "rerun");

  // Iteration 1 writes the canonical top-level artifact names; the rerun
  // writes the identical set under `rerun/`.
  const initialPaths = {
    agenticLoopBundlePath,
    translatedBundlePath,
    patchReportPath,
    deltaPath: join(runDir, "patch.kaifuu"),
    patchedDataDir: join(runDir, "patched-data"),
    appliedDataDir: join(runDir, "delta-applied", "data"),
    applyReportPath: join(runDir, "apply-report.json"),
    runtimeInputDir: join(runDir, "runtime-input"),
    runtimeArtifactsDir: join(runDir, "runtime-artifacts"),
    runtimeEvidencePath: join(runDir, "runtime-evidence.json"),
    providerRunArtifactsDir,
  };
  const rerunPaths = rpgMakerIterationPaths(rerunDir);

  const identityArgs = [
    "--game-id",
    projectMetadata.gameId,
    "--game-version",
    projectMetadata.gameVersion,
    "--source-profile-id",
    projectMetadata.sourceProfileId,
    "--source-locale",
    projectMetadata.sourceLocale,
  ];
  const runId = `rpgmaker-mv-mz-${args.project}`;

  if (dryRun) {
    process.stdout.write(
      "[localize-project] MV/MZ full loop: inventory/readiness FRONT -> extract -> draft/QA -> patch -> delta-apply -> runtime -> feedback -> rerun (iterate cycle)\n",
    );
    printDryRunPlan(
      [
        `cargo run -p kaifuu-cli -- detect ${realCorpusSource.placeholder} --output ${detectionReportPath}`,
        `cargo run -p kaifuu-cli -- extract --engine rpgmaker --game-dir ${realCorpusSource.placeholder} ${identityArgs.join(" ")} --bundle-output ${bridgeBundlePath} --findings-output ${findingsPath}`,
        `node apps/itotori/dist/cli.js localize-project-stage --bridge ${bridgeBundlePath} --pair-policy ${pairPolicyPath} --unit-index <first-dialogue-scene-unit> --engine-profile rpg-maker-mv-mz --output ${agenticLoopBundlePath} --translated-bundle-output ${translatedBundlePath} --patch-report-output ${patchReportPath} --provider-run-artifacts-dir ${providerRunArtifactsDir}`,
        `cargo run -p kaifuu-cli -- patch --engine rpgmaker --source ${realCorpusSource.placeholder} --bundle ${translatedBundlePath} --delta-output ${initialPaths.deltaPath} --patched-data-output ${initialPaths.patchedDataDir}`,
        `cargo run -p kaifuu-cli -- apply ${realCorpusSource.placeholder}/data --patch ${initialPaths.deltaPath} --output ${initialPaths.appliedDataDir} --report-output ${initialPaths.applyReportPath}`,
        `cargo run -p utsushi-cli -- rpgmaker-mv-capture --game-dir ${initialPaths.runtimeInputDir} --artifact-root ${initialPaths.runtimeArtifactsDir} --run-id ${runId} --assert-observed-text <real-translated-draft-from-patch-report> --output ${initialPaths.runtimeEvidencePath}`,
        `(in-driver) synthesize feedback -> ${feedbackPath}`,
        `node apps/itotori/dist/cli.js localize-project-stage --bridge ${bridgeBundlePath} --pair-policy ${pairPolicyPath} --unit-index <first-dialogue-scene-unit> --engine-profile rpg-maker-mv-mz --output ${rerunPaths.agenticLoopBundlePath} --translated-bundle-output ${rerunPaths.translatedBundlePath} --patch-report-output ${rerunPaths.patchReportPath} --provider-run-artifacts-dir ${rerunPaths.providerRunArtifactsDir}`,
        `cargo run -p kaifuu-cli -- patch --engine rpgmaker --source ${realCorpusSource.placeholder} --bundle ${rerunPaths.translatedBundlePath} --delta-output ${rerunPaths.deltaPath} --patched-data-output ${rerunPaths.patchedDataDir}`,
        `cargo run -p kaifuu-cli -- apply ${realCorpusSource.placeholder}/data --patch ${rerunPaths.deltaPath} --output ${rerunPaths.appliedDataDir} --report-output ${rerunPaths.applyReportPath}`,
        `cargo run -p utsushi-cli -- rpgmaker-mv-capture --game-dir ${rerunPaths.runtimeInputDir} --artifact-root ${rerunPaths.runtimeArtifactsDir} --run-id ${runId}-rerun --assert-observed-text <real-translated-draft-from-patch-report> --output ${rerunPaths.runtimeEvidencePath}`,
        `(in-driver) synthesize rerun feedback -> ${join(rerunDir, "feedback.json")}`,
      ],
      flattenPostures(policy),
      realCorpusSource,
    );
    return;
  }

  mkdirSync(runDir, { recursive: true });

  const sourceDataDir = join(gameRoot, "data");
  if (!existsSync(sourceDataDir)) {
    throw new Error(
      `kaifuu.rpgmaker: ${realCorpusSource.placeholder}/data not found; the source root must be the game's www/ directory`,
    );
  }
  const redact = buildPathRedactor([{ path: gameRoot, replacement: realCorpusSource.placeholder }]);

  // ============ Phase 0: inventory / readiness FRONT =============
  // The run reports catalog / local-corpus / readiness identity HERE,
  // before the extract (bridge-import) phase, so bridge import is no
  // longer the first project fact. `kaifuu detect` is the real detection
  // primitive over the real corpus; the asset inventory is a real on-disk
  // data-tree scan (counts/hashes only). Anomalies are structured findings.
  process.stdout.write(
    "[localize-project] === inventory/readiness FRONT (corpus identity first) ===\n",
  );
  const detection = runKaifuuDetect({ gameRoot, outputPath: detectionReportPath, redact });
  const dataInventory = scanRpgMakerDataInventory(sourceDataDir);
  const inventoryReadiness = buildInventoryReadiness({
    realCorpusSource,
    projectMetadata,
    detection,
    dataInventory,
  });
  writeFileSync(inventoryReadinessPath, `${JSON.stringify(inventoryReadiness, null, 2)}\n`);
  process.stdout.write(
    `[localize-project] local-corpus identity: sourceKind=${inventoryReadiness.localCorpus.sourceKind} corpusId=${inventoryReadiness.localCorpus.corpusId} projectId=${inventoryReadiness.localCorpus.projectId} engine=${inventoryReadiness.localCorpus.engine} sourceLocale=${inventoryReadiness.localCorpus.sourceLocale}\n`,
  );
  process.stdout.write(
    `[localize-project] readiness identity: gameId=${inventoryReadiness.readiness.gameId} gameVersion=${inventoryReadiness.readiness.gameVersion} sourceProfileId=${inventoryReadiness.readiness.sourceProfileId}\n`,
  );
  process.stdout.write(
    `[localize-project] detection: status=${detection.status} (probed adapters: ${detection.adapterIds.join(", ") || "none"})\n`,
  );
  process.stdout.write(
    `[localize-project] asset inventory (real www/data scan): dataJsonFiles=${dataInventory.dataJsonFileCount} runtimeSceneFiles=${dataInventory.runtimeSceneFileCount} totalDataBytes=${dataInventory.totalDataBytes} dataTreeSha256=${dataInventory.dataTreeSha256}\n`,
  );
  for (const finding of inventoryReadiness.findings) {
    process.stdout.write(
      `[localize-project] inventory finding [${finding.severity}] ${finding.code}: ${finding.message}\n`,
    );
  }
  process.stdout.write(
    `[localize-project] readiness verdict: ${inventoryReadiness.readinessVerdict} (identity reported BEFORE bridge import)\n`,
  );
  if (inventoryReadiness.readinessVerdict !== "ready") {
    throw new Error(
      `kaifuu.rpgmaker.readiness_blocked: inventory/readiness front recorded blocking finding(s); see ${inventoryReadinessPath}`,
    );
  }

  // Readonly-source invariant: hash the source data tree before any work.
  const sourceTreeSha256Before = dataInventory.dataTreeSha256;
  process.stdout.write(
    `[localize-project] source www/data sha256 (pre): ${sourceTreeSha256Before}\n`,
  );

  // ------------------- Phase 1: kaifuu extract --------------------
  runCommand(
    "cargo",
    [
      "run",
      "-p",
      "kaifuu-cli",
      "--quiet",
      "--",
      "extract",
      "--engine",
      "rpgmaker",
      "--game-dir",
      gameRoot,
      ...identityArgs,
      "--bundle-output",
      bridgeBundlePath,
      "--findings-output",
      findingsPath,
    ],
    process.env,
    { redact },
  );

  // Bound the live slice to one runtime-replayed dialogue surface.
  const bridge = JSON.parse(readFileSync(bridgeBundlePath, "utf8"));
  const { unitIndex, sceneFile } = selectRpgMakerDialogueUnit(bridge);
  process.stdout.write(
    `[localize-project] bounded slice: unit-index=${unitIndex} scene-file=${sceneFile} (of ${bridge.units.length} units)\n`,
  );

  // --------- Phases 2-5: bounded translate/QA/patch/delta/runtime --------
  process.stdout.write("[localize-project] === iteration: initial ===\n");
  const initial = await runRpgMakerSliceIteration({
    iterationLabel: "initial",
    paths: initialPaths,
    args,
    policy,
    pairPolicyPath,
    bridgeBundlePath,
    sourceDataDir,
    gameRoot,
    unitIndex,
    sceneFile,
    runId,
    redact,
  });

  // ------------------- Phase 6: feedback synthesis ----------------
  const boundedSlice = { unitIndex, sceneFile, totalUnits: bridge.units.length };
  const feedback = synthesizeRpgMakerFeedback({
    iteration: "initial",
    project: args.project,
    boundedSlice,
    runtimeEvidence: initial.runtimeEvidence,
    patchReport: initial.patchReport,
    applyReport: initial.applyReport,
    costSummary: initial.costSummary,
  });
  writeFileSync(feedbackPath, `${JSON.stringify(feedback, null, 2)}\n`);
  process.stdout.write(
    `[localize-project] feedback verdict: ${feedback.verdict} (findings=${feedback.findings.length}; billedUsd=${feedback.cost.billedUsd}, billedMicrosUsd=${feedback.cost.billedMicrosUsd}, zdrEnforced=${feedback.cost.zdrEnforcedCount}/${feedback.cost.invocationCount})\n`,
  );

  // ------------- Phase 7: feedback-driven rerun (iterate) ---------
  // The iterate cycle: re-run the bounded slice (reusing the already
  // extracted bridge bundle + bounded unit), re-derive feedback. This
  // proves the loop closes and can iterate. Cost stays bounded — the
  // rerun re-bills only the single bounded translation slice.
  process.stdout.write(
    `[localize-project] === iteration: rerun (feedback verdict=${feedback.verdict}) ===\n`,
  );
  mkdirSync(rerunDir, { recursive: true });
  const rerun = await runRpgMakerSliceIteration({
    iterationLabel: "rerun",
    paths: rerunPaths,
    args,
    policy,
    pairPolicyPath,
    bridgeBundlePath,
    sourceDataDir,
    gameRoot,
    unitIndex,
    sceneFile,
    runId: `${runId}-rerun`,
    redact,
  });
  const rerunFeedback = synthesizeRpgMakerFeedback({
    iteration: "rerun",
    project: args.project,
    boundedSlice,
    runtimeEvidence: rerun.runtimeEvidence,
    patchReport: rerun.patchReport,
    applyReport: rerun.applyReport,
    costSummary: rerun.costSummary,
    priorVerdict: feedback.verdict,
  });
  const rerunFeedbackPath = join(rerunDir, "feedback.json");
  writeFileSync(rerunFeedbackPath, `${JSON.stringify(rerunFeedback, null, 2)}\n`);
  process.stdout.write(
    `[localize-project] rerun feedback verdict: ${rerunFeedback.verdict} (findings=${rerunFeedback.findings.length}; billedUsd=${rerunFeedback.cost.billedUsd})\n`,
  );

  // Readonly-source invariant: re-hash + assert no drift across both
  // iterations.
  const sourceTreeSha256After = sha256OfDataTree(sourceDataDir);
  process.stdout.write(
    `[localize-project] source www/data sha256 (post): ${sourceTreeSha256After}\n`,
  );
  if (sourceTreeSha256Before !== sourceTreeSha256After) {
    throw new Error(
      `kaifuu.rpgmaker.source_mutated: source www/data tree changed during the run (pre=${sourceTreeSha256Before}, post=${sourceTreeSha256After})`,
    );
  }

  for (const artifact of [
    detectionReportPath,
    inventoryReadinessPath,
    bridgeBundlePath,
    findingsPath,
    agenticLoopBundlePath,
    translatedBundlePath,
    patchReportPath,
    initialPaths.deltaPath,
    initialPaths.applyReportPath,
    initialPaths.runtimeEvidencePath,
    feedbackPath,
    rerunPaths.agenticLoopBundlePath,
    rerunPaths.patchReportPath,
    rerunPaths.deltaPath,
    rerunPaths.applyReportPath,
    rerunPaths.runtimeEvidencePath,
    rerunFeedbackPath,
  ]) {
    if (!existsSync(artifact)) {
      throw new Error(`expected artifact missing after successful run: ${artifact}`);
    }
  }

  // The loop summary re-derives cost INDEPENDENTLY from each iteration's
  // own provider-run artifacts and records `rerunCompleted` only when the
  // rerun's real second-slice artifact set exists on disk — so the rerun's
  // billed cost is a fresh second bounded slice, never a copy of the
  // initial. See `buildRerunLoopSummary`.
  const loop = buildRerunLoopSummary({
    providerKind: args.providerKind,
    initialPaths,
    rerunPaths,
    initialVerdict: feedback.verdict,
    rerunVerdict: rerunFeedback.verdict,
  });
  const summary = {
    runDir: repoRelativePath(runDir),
    project: args.project,
    engine: projectMetadata.engine,
    boundedSlice,
    sourceGame: {
      gameId: projectMetadata.gameId,
      gameVersion: projectMetadata.gameVersion,
      sourceProfileId: projectMetadata.sourceProfileId,
    },
    sourceLocale: projectMetadata.sourceLocale,
    pair: policy.pair,
    sourceDataTreeSha256: sourceTreeSha256Before,
    localCorpusIdentity: inventoryReadiness.localCorpus,
    readinessVerdict: inventoryReadiness.readinessVerdict,
    loop,
    artifacts: {
      detectionReport: portableRelativePath(runDir, detectionReportPath),
      inventoryReadiness: portableRelativePath(runDir, inventoryReadinessPath),
      bridgeBundle: portableRelativePath(runDir, bridgeBundlePath),
      extractionFindings: portableRelativePath(runDir, findingsPath),
      agenticLoopBundle: portableRelativePath(runDir, agenticLoopBundlePath),
      translatedBundle: portableRelativePath(runDir, translatedBundlePath),
      patchReport: portableRelativePath(runDir, patchReportPath),
      delta: portableRelativePath(runDir, initialPaths.deltaPath),
      applyReport: portableRelativePath(runDir, initialPaths.applyReportPath),
      runtimeEvidence: portableRelativePath(runDir, initialPaths.runtimeEvidencePath),
      feedback: portableRelativePath(runDir, feedbackPath),
      providerRunArtifacts: portableRelativePath(runDir, providerRunArtifactsDir),
      rerunRuntimeEvidence: portableRelativePath(runDir, rerunPaths.runtimeEvidencePath),
      rerunFeedback: portableRelativePath(runDir, rerunFeedbackPath),
    },
  };
  writeFileSync(join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`[localize-project] SUCCESS — run dir: ${runDir}\n`);
}

/**
 * Runtime-evidence assertion (RealLive). Reads the engine's own replay
 * log (its OBSERVED, decoded TextLine bodies) and the patch-report's
 * `finalDraftText` (the REAL translated draft the LLM produced and the
 * patchback wrote into Seen.txt), then asserts the engine actually
 * decoded that translated text from the patched bytes. The evidence is
 * the intersection of two independently-produced real artifacts — the
 * VM's decode output and the LLM's translation — NOT a substring the
 * harness planted into both sides.
 */
function assertReplayObservedTranslatedText({ replayLogPath, patchReportPath }) {
  const patchReport = JSON.parse(readFileSync(patchReportPath, "utf8"));
  const expected = patchReport.finalDraftText;
  if (typeof expected !== "string" || expected.length === 0) {
    throw new Error(
      `runtime evidence: patch-report at ${patchReportPath} has no non-empty finalDraftText to validate the replay against`,
    );
  }
  const replayLog = JSON.parse(readFileSync(replayLogPath, "utf8"));
  const events = Array.isArray(replayLog.events) ? replayLog.events : [];
  const sjisDecoder = new TextDecoder("shift_jis", { fatal: false });
  let textLineCount = 0;
  let matchingTextLineCount = 0;
  for (const event of events) {
    if (!event || typeof event !== "object" || event.kind !== "text_line") continue;
    textLineCount += 1;
    const bodyUtf8 = typeof event.bodyUtf8 === "string" ? event.bodyUtf8 : "";
    let observed = bodyUtf8.includes(expected);
    if (!observed && typeof event.bodyShiftJisHex === "string") {
      // Byte-stable fallback: re-decode the raw Shift-JIS bytes the
      // engine captured, in case the sink's UTF-8 flush coalesced.
      const bytes = Buffer.from(event.bodyShiftJisHex, "hex");
      observed = sjisDecoder.decode(bytes).includes(expected);
    }
    if (observed) matchingTextLineCount += 1;
  }
  if (matchingTextLineCount === 0) {
    throw new Error(
      `runtime evidence: the engine's replay produced ${textLineCount} decoded TextLine(s), none of which observed the real translated text patched into Seen.txt (see ${replayLogPath}); the patched bytes did not round-trip through the VM's decode`,
    );
  }
  return { textLineCount, matchingTextLineCount, expectedText: expected };
}

// ---------- ALPHA-006 criterion 5 — three-way chain-outcome classification ----------
//
// The RealLive localize-project chain resolves to exactly ONE of three
// honest outcomes, and the run report records which:
//
//   in-profile-pass            every phase succeeded on supported input.
//   in-profile-bug             something that SHOULD work broke — a crash,
//                              a byte-mismatch, a replay/render failure on
//                              supported input, or a non-zero unknown-opcode
//                              count (the 100%-decompilation bar; fail-closed).
//   out-of-profile-diagnostic  a component honestly reported an input
//                              construct outside the CURRENT support profile
//                              (NOT a bug — a "we don't handle this yet"
//                              signal). Distinguished from a bug so the
//                              chain never mislabels an unsupported construct.
export const CHAIN_OUTCOMES = Object.freeze({
  pass: "in-profile-pass",
  bug: "in-profile-bug",
  outOfProfile: "out-of-profile-diagnostic",
});

export const RUN_REPORT_SCHEMA = "itotori.localize-project.run-report.v0";

// Component-layer semantic codes that mean "the input carries a construct
// outside the current profile". Any of these anywhere in a failure's text
// (thrown message + captured child stdout/stderr) classifies the whole chain
// as out-of-profile-diagnostic — an honest unsupported-construct signal, not
// an in-profile bug. Every signature is a DOTTED structured code emitted
// verbatim by its component; bare enum-variant names are deliberately NOT
// listed — a variant name like `OutOfProfileCompression` is redundant with
// the dotted code its error always carries, and matching the bare substring
// only adds false-positive surface (an unrelated crash whose Debug output or
// child stderr merely contains that substring would be silently downgraded
// out of a real bug, violating the alpha-006f fail-closed bar). Sourced
// verbatim from the emitting components:
//   - kaifuu-reallive diagnostics.rs (SEMANTIC_REALLIVE_OUT_OF_PROFILE_INPUT)
//   - kaifuu-cli partial path (kaifuu.reallive.partial.out_of_profile_input)
//   - utsushi-reallive nwa.rs (NWA_OUT_OF_PROFILE_COMPRESSION_CODE — the
//     dotted code NwaDecodeError::OutOfProfileCompression always carries in
//     its `({code})` Display/Debug tail)
const OUT_OF_PROFILE_CODE_SIGNATURES = Object.freeze([
  "kaifuu.reallive.out_of_profile_input",
  "kaifuu.reallive.partial.out_of_profile_input",
  "utsushi.reallive.nwa.out_of_profile_compression",
]);

/**
 * Build an Error the driver has already classified into one of the three
 * chain outcomes. `classifyChainFailure` returns the carried classification
 * verbatim — this is how the unknownOpcodes fail-closed assertion and the
 * source-mutation guard force `in-profile-bug` regardless of message text.
 */
function classifiedChainError(message, { outcome, diagnosticCode, phase }) {
  const error = new Error(message);
  error.itotoriOutcome = outcome;
  error.itotoriDiagnosticCode = diagnosticCode;
  error.itotoriPhase = phase;
  return error;
}

/**
 * Classify a caught chain failure into one of the three ALPHA-006 outcomes.
 * Precedence:
 *   1. A driver-pre-classified error (carries `itotoriOutcome`) wins verbatim.
 *   2. A component out-of-profile semantic code anywhere in the error text
 *      (message + captured child stdout/stderr) -> out-of-profile-diagnostic.
 *   3. Anything else is a genuine in-profile chain bug (a crash, a byte
 *      mismatch, a replay/render break on supported input).
 */
export function classifyChainFailure(error, { phase } = {}) {
  const resolvedPhase = error?.itotoriPhase ?? phase ?? "unknown";
  if (typeof error?.itotoriOutcome === "string") {
    return {
      outcome: error.itotoriOutcome,
      diagnosticCode: error.itotoriDiagnosticCode ?? "chain.unclassified",
      phase: resolvedPhase,
    };
  }
  const haystack = [error?.message, error?.childStdout, error?.childStderr]
    .filter((part) => typeof part === "string")
    .join("\n");
  for (const code of OUT_OF_PROFILE_CODE_SIGNATURES) {
    if (haystack.includes(code)) {
      return { outcome: CHAIN_OUTCOMES.outOfProfile, diagnosticCode: code, phase: resolvedPhase };
    }
  }
  return {
    outcome: CHAIN_OUTCOMES.bug,
    diagnosticCode: "chain.in_profile_bug",
    phase: resolvedPhase,
  };
}

/**
 * Fail-closed on the 100%-decompilation bar (alpha-chain-fail-closed).
 * Reads the alpha-006e decompile report and asserts a ZERO unknown-opcode
 * count. A non-zero count is a REAL decompile bug (not an out-of-profile
 * input), so it throws a pre-classified `in-profile-bug` error the chain
 * hard-fails on — the count is no longer merely recorded. Returns the (zero)
 * count on success.
 */
export function assertZeroUnknownOpcodes(decompileReportPath) {
  const report = JSON.parse(readFileSync(decompileReportPath, "utf8"));
  const unknown = report.unknownOpcodes;
  if (typeof unknown !== "number" || !Number.isInteger(unknown) || unknown < 0) {
    throw classifiedChainError(
      `kaifuu.decompile.unknown_opcodes_missing: decompile report at ${decompileReportPath} has non-integer unknownOpcodes='${String(unknown)}'; cannot prove the zero-unknown decompilation bar`,
      {
        outcome: CHAIN_OUTCOMES.bug,
        diagnosticCode: "kaifuu.decompile.unknown_opcodes_missing",
        phase: "extract",
      },
    );
  }
  if (unknown !== 0) {
    throw classifiedChainError(
      `kaifuu.decompile.unknown_opcodes_nonzero: extract decompiled ${unknown} unrecognised opcode(s); the 100%-decompilation bar requires 0 — failing closed as an in-profile bug (alpha-chain-fail-closed)`,
      {
        outcome: CHAIN_OUTCOMES.bug,
        diagnosticCode: "kaifuu.decompile.unknown_opcodes_nonzero",
        phase: "extract",
      },
    );
  }
  return unknown;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedEnvFilePath =
    args.envFilePath ?? (process.env[LOCAL_ENV_FILE_ENV_VAR] || undefined);
  if (requestedEnvFilePath !== undefined) {
    loadExplicitLocalEnvFile(resolvePath(requestedEnvFilePath));
  }
  const { pairPolicy: policy, pairPolicyPath, projectMetadata } = loadProjectConfig(args);
  validateProjectSelection(args.project, projectMetadata, policy);
  const sceneId = policy.sceneId ?? args.scene;
  const ts = isoTimestampUtc();
  const runDirName = `${ts}-${args.project}`;
  const dryRun = args.dryRun;
  // Alpha capstone: land the acceptance bundle at a stable path
  // (artifacts/<subdir>/) rather than a timestamped run dir, so the node's
  // declared acceptance greps resolve verbatim. Dry-run keeps the
  // timestamped dir (nothing is written there).
  const runDir =
    projectMetadata.stableArtifactSubdir !== undefined && !dryRun
      ? join(REPO_ROOT, "artifacts", projectMetadata.stableArtifactSubdir)
      : join(REPO_ROOT, "artifacts", "localize-project", runDirName);

  const bridgeBundlePath = join(runDir, "bridge-bundle.json");
  const agenticLoopBundlePath = join(runDir, "agentic-loop-bundle.v0.json");
  const translatedBundlePath = join(runDir, "translated-bridge.json");
  const patchReportPath = join(runDir, "patch-report.json");
  const replayLogPath = join(runDir, "replay-log.json");
  const renderEvidencePath = join(runDir, "render-evidence.json");
  const renderArtifactsDir = join(runDir, "render-artifacts");
  const providerRunArtifactsDir = join(runDir, "provider-runs");
  const decompileReportPath = join(runDir, "decompile-report.json");
  const sceneOnePngPath = join(runDir, "scene-1.png");
  const localizedBundlePath = join(runDir, "localized-bundle.json");

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

  // alpha-006a — vault by-id sourcing. When the project declares a vault
  // canonical id AND ITOTORI_VAULT_ROOT is set, the RealLive extract sources
  // the corpus read-only through the vault adapter (materialised to scratch)
  // instead of a raw --game-root. The materialised game-root is not known
  // until `extract` runs, so in vault mode `resolveRealCorpusSource` is
  // skipped and the source path is read back from the decompile report.
  const vaultRoot = process.env.ITOTORI_VAULT_ROOT;
  const vaultMode =
    projectMetadata.engine === "reallive" &&
    !dryRun &&
    projectMetadata.vaultCanonicalId !== undefined &&
    vaultRoot !== undefined &&
    vaultRoot.length > 0;

  const realCorpusSource = vaultMode
    ? {
        envName: "ITOTORI_VAULT_ROOT",
        // Resolved after extract materialises the vault tree to scratch.
        root: undefined,
        placeholder: "<VAULT_MATERIALIZED_ROOT>",
        dryRunLabel: `ITOTORI_VAULT_ROOT vault-canonical-id=${projectMetadata.vaultCanonicalId} projectId=${projectMetadata.projectId}`,
      }
    : resolveRealCorpusSource({
        dryRun,
        projectMetadata,
        corpusId: args.corpus,
      });
  // In vault mode this is filled in after Phase 1 extract resolves the
  // materialised tree; in raw-path mode it is the configured source root.
  let gameRoot = realCorpusSource.root;

  // RPG Maker MV/MZ vertical slice: a self-contained engine pipeline that
  // writes the patched copy + delta under the run dir (no external TARGET),
  // bounds the live LLM slice to one dialogue surface, and emits text-trace
  // runtime evidence. The RealLive Seen.txt path below is untouched.
  if (projectMetadata.engine === "rpg-maker-mv-mz") {
    await runRpgMakerMvMzPipeline({
      args,
      policy,
      pairPolicyPath,
      projectMetadata,
      runDir,
      bridgeBundlePath,
      agenticLoopBundlePath,
      translatedBundlePath,
      patchReportPath,
      providerRunArtifactsDir,
      dryRun,
      realCorpusSource,
      gameRoot,
    });
    return;
  }

  const targetRoot = process.env.TARGET;
  let livePathRedactor = buildPathRedactor([
    { path: gameRoot, replacement: realCorpusSource.placeholder },
    { path: targetRoot, replacement: "<TARGET>" },
  ]);
  if (!dryRun && (targetRoot === undefined || targetRoot.length === 0)) {
    throw new Error("TARGET (writable path for the patched copy) must be set unless --dry-run");
  }
  // In vault mode the source root is not known until extract materialises
  // the tree; the source-vs-target distinctness check runs after Phase 1.
  if (!dryRun && !vaultMode) {
    ensureWritableTargetDistinctFromSource(gameRoot, targetRoot, livePathRedactor);
  }

  if (dryRun) {
    printDryRunPlan(
      [
        `cargo run -p kaifuu-cli -- extract --engine reallive --game-root ${realCorpusSource.placeholder} --game-id ${projectMetadata.gameId} --game-version ${projectMetadata.gameVersion} --source-profile-id ${projectMetadata.sourceProfileId} --source-locale ${projectMetadata.sourceLocale} --scene ${sceneId} --bundle-output ${bridgeBundlePath} --decompile-report-output ${decompileReportPath}`,
        `node apps/itotori/dist/cli.js localize-project-stage --bridge ${bridgeBundlePath} --pair-policy ${pairPolicyPath} --unit-index ${args.unitIndex} --output ${agenticLoopBundlePath} --translated-bundle-output ${translatedBundlePath} --patch-report-output ${patchReportPath} --provider-run-artifacts-dir ${providerRunArtifactsDir}`,
        `cargo run -p kaifuu-cli -- patch --engine reallive --source ${realCorpusSource.placeholder} --target <TARGET> --bundle ${translatedBundlePath} --scope ${projectMetadata.translationScope} --force`,
        `cargo run -p utsushi-cli -- replay-validate --engine reallive --seen <TARGET>/REALLIVEDATA/Seen.txt --scene ${sceneId} --print-replay-log ${replayLogPath} --require-zero-unknown`,
        `cargo run -p utsushi-cli -- render-validate --engine reallive --seen <TARGET>/REALLIVEDATA/Seen.txt --scene ${sceneId} --gameexe <TARGET>/REALLIVEDATA/Gameexe.ini --game-dir <TARGET>/REALLIVEDATA --artifact-root ${renderArtifactsDir} --expect-text-contains <real-translated-draft-from-patch-report> --redaction on --output ${renderEvidencePath}`,
      ],
      flattenPostures(policy),
      realCorpusSource,
    );
    return;
  }

  mkdirSync(runDir, { recursive: true });

  const targetPlaceholder = "<TARGET>";

  // ALPHA-006 criterion 5 — classify + ALWAYS emit the run report, on
  // success AND on failure. `currentPhase` tracks which phase is executing
  // so a caught failure records the phase it broke in; `sourceSeenShaForReport`
  // captures the source hash once known so even a mid-chain failure report
  // carries it.
  let currentPhase = "extract";
  let sourceSeenShaForReport;
  const reportRedactor = (text) => livePathRedactor(String(text ?? ""));
  const writeClassifiedRunReport = (report) => {
    writeFileSync(join(runDir, "run-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  };
  try {
    if (vaultMode) {
      // ---- Phase 1 (vault): kaifuu extract via the read-only vault adapter
      // (alpha-006a). The vault materialises the corpus to scratch; the
      // resolved game-root + source Seen.txt sha256 come back in the
      // decompile report, which the driver reads to source the rest of the
      // chain (no raw --game-root). --decompile-report-output emits the
      // alpha-006e zero-unknown report at the same time.
      runCommand(
        "cargo",
        [
          "run",
          "-p",
          "kaifuu-cli",
          "--quiet",
          "--",
          "extract",
          "--engine",
          "reallive",
          "--vault-canonical-id",
          projectMetadata.vaultCanonicalId,
          ...realliveIdentityArgs(projectMetadata),
          "--scene",
          String(sceneId),
          "--bundle-output",
          bridgeBundlePath,
          "--decompile-report-output",
          decompileReportPath,
        ],
        process.env,
        { redact: livePathRedactor },
      );
      const decompileReport = JSON.parse(readFileSync(decompileReportPath, "utf8"));
      if (
        typeof decompileReport.resolvedGameRoot !== "string" ||
        decompileReport.resolvedGameRoot.length === 0
      ) {
        throw new Error(
          `decompile report at ${decompileReportPath} missing resolvedGameRoot; cannot source the vault-materialised tree`,
        );
      }
      gameRoot = decompileReport.resolvedGameRoot;
      // Source root is now known: enforce source-vs-target distinctness.
      ensureWritableTargetDistinctFromSource(
        gameRoot,
        targetRoot,
        buildPathRedactor([
          { path: gameRoot, replacement: realCorpusSource.placeholder },
          { path: targetRoot, replacement: targetPlaceholder },
        ]),
      );
    }

    // Capture source sha256 BEFORE any mutating work (raw mode: before
    // extract; vault mode: after the read-only extract materialised the
    // pristine tree). Both hash the SAME resolved path so the post-run drift
    // guard compares like-for-like.
    const sourceSeenPath = resolveReallivedataSeen(gameRoot);
    const sourceSeenPlaceholder = `${realCorpusSource.placeholder}/REALLIVEDATA/Seen.txt`;
    livePathRedactor = buildPathRedactor([
      { path: gameRoot, replacement: realCorpusSource.placeholder },
      { path: targetRoot, replacement: targetPlaceholder },
    ]);
    const liveCommandRedactor = buildPathRedactor([
      { path: sourceSeenPath, replacement: sourceSeenPlaceholder },
      { path: gameRoot, replacement: realCorpusSource.placeholder },
      { path: targetRoot, replacement: targetPlaceholder },
    ]);
    const sourceSeenSha256Before = sha256OfFile(sourceSeenPath);
    sourceSeenShaForReport = sourceSeenSha256Before;
    process.stdout.write(
      `[localize-project] source Seen.txt sha256 (pre): ${sourceSeenSha256Before}\n`,
    );

    if (!vaultMode) {
      // ---- Phase 1 (raw path): kaifuu extract from a raw --game-root
      // (env-gated test helper). Emits the same alpha-006e decompile report.
      runCommand(
        "cargo",
        [
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
          ...realliveIdentityArgs(projectMetadata),
          "--scene",
          String(sceneId),
          "--bundle-output",
          bridgeBundlePath,
          "--decompile-report-output",
          decompileReportPath,
        ],
        process.env,
        { redact: liveCommandRedactor },
      );
    }

    // ---- Fail-closed on the 100%-decompilation bar (alpha-chain-fail-closed).
    // A non-zero unknown-opcode count is a REAL decompile bug — hard-fail
    // classified as in-profile-bug, distinct from an out-of-profile diagnostic.
    const unknownOpcodeCount = assertZeroUnknownOpcodes(decompileReportPath);
    process.stdout.write(
      `[localize-project] decompile: ${unknownOpcodeCount} unknown opcode(s) (zero-unknown bar met)\n`,
    );

    // -------------- Phase 2: agentic loop (live LLM) ----------------
    currentPhase = "agentic-loop";
    const stageArgs = [
      join(REPO_ROOT, "apps", "itotori", "dist", "cli.js"),
      "localize-project-stage",
      "--bridge",
      bridgeBundlePath,
      "--pair-policy",
      pairPolicyPath,
      "--unit-index",
      String(args.unitIndex),
      "--output",
      agenticLoopBundlePath,
      "--translated-bundle-output",
      translatedBundlePath,
      "--patch-report-output",
      patchReportPath,
      "--provider-run-artifacts-dir",
      providerRunArtifactsDir,
    ];
    if (args.providerKind !== undefined) {
      stageArgs.push("--provider-kind", args.providerKind);
    }
    runCommand("node", stageArgs, process.env, { redact: liveCommandRedactor });

    if (args.providerKind !== "fake") {
      const providerProof = verifyProviderRunArtifactsAfterStage({
        agenticLoopBundlePath,
        patchReportPath,
        providerRunArtifactsDir,
        expectedPair: policy.pair,
      });
      process.stdout.write(
        `[localize-project] provider-run artifacts: ${providerProof.providerRunArtifactCount} verified for ${providerProof.invocations.length} live invocation(s) under ${providerRunArtifactsDir}\n`,
      );
    }

    // ----------------- Phase 3: kaifuu patch -----------------------
    currentPhase = "patch";
    // Run kaifuu-cli `patch --engine reallive`. The CLI itself copies the
    // source tree into TARGET and bumps writable mode; it expects TARGET to
    // be empty unless `--force` is passed (we pass it, since TARGET was
    // already writability-checked earlier via ensureWritableTargetDistinctFromSource).
    // We let kaifuu-cli own the copy + writable-mode bumping in one place;
    // that's why the driver does not pre-copy the tree here.
    runCommand(
      "cargo",
      [
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
        "--scope",
        projectMetadata.translationScope,
        "--force",
      ],
      process.env,
      { redact: liveCommandRedactor },
    );

    // --------------- Phase 4: replay-validate ----------------------
    currentPhase = "replay-validate";
    const targetSeenPath = resolveReallivedataSeen(targetRoot);
    const liveReplayRedactor = buildPathRedactor([
      { path: sourceSeenPath, replacement: sourceSeenPlaceholder },
      { path: targetSeenPath, replacement: `${targetPlaceholder}/REALLIVEDATA/Seen.txt` },
      { path: gameRoot, replacement: realCorpusSource.placeholder },
      { path: targetRoot, replacement: targetPlaceholder },
    ]);
    runCommand(
      "cargo",
      [
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
        "--print-replay-log",
        replayLogPath,
        "--require-zero-unknown",
      ],
      process.env,
      { redact: liveReplayRedactor },
    );

    // ---- Observed-output evidence: assert the ENGINE decoded the REAL
    // translated text from the patched bytes. This is derived from the
    // engine's own replay log (its observed TextLine bodies), compared
    // against the real translated draft the LLM produced (recorded in
    // patch-report.json) — NOT a harness-planted sentinel substring.
    const runtimeObservation = assertReplayObservedTranslatedText({
      replayLogPath,
      patchReportPath,
    });
    process.stdout.write(
      `[localize-project] runtime evidence: engine OBSERVED the real translated text in ${runtimeObservation.matchingTextLineCount} of ${runtimeObservation.textLineCount} decoded TextLine(s) (observed-output-confirmed)\n`,
    );

    // ---- Real rendered frame (E2): rasterize the localized scene through
    // the real g00 render pipeline and assert the rendered text layer (built
    // from the engine's OBSERVED TextLine bodies) reflects the real
    // translated text. Redaction defaults ON so no copyrighted pixels are
    // published; only the deterministic report (hashes/counts + the frame
    // pointer) is retained here.
    currentPhase = "render-validate";
    // The message-window render reads the game's real Gameexe.ini (box
    // geometry + #NAMAE/#COLOR_TABLE speaker colours) and composites the
    // real decoded g00 stack. Both live in the patched TARGET tree
    // alongside the localized Seen.txt (dialogue-only scope leaves them
    // byte-identical to source): REALLIVEDATA/{Gameexe.ini,g00}.
    const targetReallivedataDir = dirname(targetSeenPath);
    const targetGameexePath = join(targetReallivedataDir, "Gameexe.ini");
    // A headless drive of the pinned dialogue scene inherits its
    // background from a prior scene, so its own terminal graphics stack
    // can be empty; the render composites this REAL g00 background stem's
    // decoded art in that case (config-driven fallback, real art — never a
    // synthetic fill). Overridable per project via renderBgAsset.
    const renderBgArgs = projectMetadata.renderBgAsset
      ? ["--bg-asset", projectMetadata.renderBgAsset]
      : [];
    runCommand(
      "cargo",
      [
        "run",
        "-p",
        "utsushi-cli",
        "--quiet",
        "--",
        "render-validate",
        "--engine",
        "reallive",
        "--seen",
        targetSeenPath,
        "--scene",
        String(sceneId),
        "--gameexe",
        targetGameexePath,
        "--game-dir",
        targetReallivedataDir,
        // Pristine source Seen.txt: recovers the REAL per-speaker #NAMAE
        // colour for the message-window name box when a dialogue-only
        // translation rewrote the inline 【…】 name off the Japanese key.
        "--source-seen",
        sourceSeenPath,
        ...renderBgArgs,
        "--artifact-root",
        renderArtifactsDir,
        "--expect-text-contains",
        runtimeObservation.expectedText,
        "--redaction",
        "on",
        "--output",
        renderEvidencePath,
      ],
      process.env,
      { redact: liveReplayRedactor },
    );
    const renderEvidence = JSON.parse(readFileSync(renderEvidencePath, "utf8"));
    if (renderEvidence.containsExpected !== true) {
      throw new Error(
        `runtime evidence: the real rendered frame's localized text layer did not contain the real translated text (see ${renderEvidencePath})`,
      );
    }
    process.stdout.write(
      `[localize-project] render evidence: E2 frame ${renderEvidence.evidenceTier} rendered ${renderEvidence.renderedLineCount} localized line(s); rendered-text sha256=${renderEvidence.renderedTextSha256} redaction=${renderEvidence.redaction}\n`,
    );

    // ---- Copy the emitted redacted public PNG to the stable scene-1.png
    // acceptance path (consume alpha-006b). Redaction is ON (default), so the
    // committed frame carries no copyrighted g00 pixels — assert that before
    // landing it.
    if (renderEvidence.redaction !== "on") {
      throw new Error(
        `render evidence redaction is '${String(renderEvidence.redaction)}'; refusing to land a non-redacted scene-1.png`,
      );
    }
    if (
      typeof renderEvidence.artifactPath !== "string" ||
      renderEvidence.artifactPath.length === 0
    ) {
      throw new Error(`render evidence at ${renderEvidencePath} missing artifactPath`);
    }
    copyFileSync(renderEvidence.artifactPath, sceneOnePngPath);
    process.stdout.write(
      `[localize-project] redacted scene frame -> ${portableRelativePath(runDir, sceneOnePngPath)} (redaction=on, no g00 pixels)\n`,
    );

    // ---- Localized-bundle artifact: surface the served (model, provider)
    // pair(s), the REAL /generation cost, and the ZDR posture pulled from the
    // per-invocation provider-run records into ONE readable file, alongside
    // the primary pair + localized English line from patch-report.json. This
    // satisfies the "localized bundle from a live ZDR call, cost recorded"
    // acceptance in a single artifact.
    if (args.providerKind !== "fake") {
      const localizedBundle = buildLocalizedBundleArtifact({
        runDir,
        patchReportPath,
        providerRunArtifactsDir,
        decompileReportPath,
        sceneOnePngPath,
        zdrAccountAsserted: process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1",
      });
      writeFileSync(localizedBundlePath, `${JSON.stringify(localizedBundle, null, 2)}\n`);
      process.stdout.write(
        `[localize-project] localized bundle: primary ${localizedBundle.primaryPair.modelId}@${localizedBundle.primaryPair.providerId}; ${localizedBundle.invocations.length} live ZDR invocation(s); total /generation cost USD ${localizedBundle.totalCostUsd}; all-served-ZDR=${localizedBundle.zdr.allServedZdr}\n`,
      );
    }

    // ---- Readonly-source invariant: re-hash + assert no drift. ----
    currentPhase = "finalize";
    const sourceSeenSha256After = sha256OfFile(sourceSeenPath);
    process.stdout.write(
      `[localize-project] source Seen.txt sha256 (post): ${sourceSeenSha256After}\n`,
    );
    if (sourceSeenSha256Before !== sourceSeenSha256After) {
      // The read-only source changed during a run on supported input — a real
      // in-profile chain bug (fail-closed), NOT an out-of-profile diagnostic.
      throw classifiedChainError(
        liveCommandRedactor(
          `kaifuu.reallive.source_mutated: source Seen.txt at ${sourceSeenPath} changed during the run (pre=${sourceSeenSha256Before}, post=${sourceSeenSha256After})`,
        ),
        {
          outcome: CHAIN_OUTCOMES.bug,
          diagnosticCode: "kaifuu.reallive.source_mutated",
          phase: "finalize",
        },
      );
    }

    // ---- Final summary: every artifact exists. ----
    for (const artifact of [
      bridgeBundlePath,
      agenticLoopBundlePath,
      patchReportPath,
      replayLogPath,
      renderEvidencePath,
    ]) {
      if (!existsSync(artifact)) {
        throw new Error(`expected artifact missing after successful run: ${artifact}`);
      }
    }

    // Emit the classified run report — a full SUCCESS run resolves to
    // in-profile-pass (ALPHA-006 criterion 5). The same run-summary.json is
    // written on failure by the catch below, so every run is classified.
    const summary = {
      schemaVersion: RUN_REPORT_SCHEMA,
      outcome: CHAIN_OUTCOMES.pass,
      diagnosticCode: null,
      failingPhase: null,
      unknownOpcodes: unknownOpcodeCount,
      runDir: repoRelativePath(runDir),
      project: args.project,
      sceneId,
      sourceGame: {
        gameId: projectMetadata.gameId,
        gameVersion: projectMetadata.gameVersion,
        sourceProfileId: projectMetadata.sourceProfileId,
      },
      sourceLocale: projectMetadata.sourceLocale,
      pair: policy.pair,
      sourceSeenSha256: sourceSeenSha256Before,
      sourcedVia: vaultMode ? "vault-canonical-id" : realCorpusSource.envName,
      vaultCanonicalId: vaultMode ? projectMetadata.vaultCanonicalId : undefined,
      translationScope: projectMetadata.translationScope,
      artifacts: {
        bridgeBundle: portableRelativePath(runDir, bridgeBundlePath),
        agenticLoopBundle: portableRelativePath(runDir, agenticLoopBundlePath),
        patchReport: portableRelativePath(runDir, patchReportPath),
        replayLog: portableRelativePath(runDir, replayLogPath),
        renderEvidence: portableRelativePath(runDir, renderEvidencePath),
        providerRunArtifacts: portableRelativePath(runDir, providerRunArtifactsDir),
        decompileReport: portableRelativePath(runDir, decompileReportPath),
        sceneOnePng: portableRelativePath(runDir, sceneOnePngPath),
        localizedBundle:
          args.providerKind !== "fake"
            ? portableRelativePath(runDir, localizedBundlePath)
            : undefined,
      },
    };
    writeClassifiedRunReport(summary);
    process.stdout.write(
      `[localize-project] OUTCOME=${CHAIN_OUTCOMES.pass} — run dir: ${runDir}\n`,
    );
    process.stdout.write(`[localize-project] SUCCESS — run dir: ${runDir}\n`);
  } catch (error) {
    // ALPHA-006 criterion 5 — DO NOT collapse the failure into a bare
    // exit(1). Classify it into one of the three outcomes, ALWAYS emit the
    // run report with that classification, print it, then rethrow so the
    // top-level handler exits non-zero with the classification visible.
    const { outcome, diagnosticCode, phase } = classifyChainFailure(error, {
      phase: currentPhase,
    });
    const failureReport = {
      schemaVersion: RUN_REPORT_SCHEMA,
      outcome,
      diagnosticCode,
      failingPhase: phase,
      diagnosticMessage: reportRedactor(error?.message),
      runDir: repoRelativePath(runDir),
      project: args.project,
      engine: projectMetadata.engine,
      sceneId,
      sourceGame: {
        gameId: projectMetadata.gameId,
        gameVersion: projectMetadata.gameVersion,
        sourceProfileId: projectMetadata.sourceProfileId,
      },
      sourceLocale: projectMetadata.sourceLocale,
      pair: policy.pair,
      sourceSeenSha256: sourceSeenShaForReport ?? null,
      sourcedVia: vaultMode ? "vault-canonical-id" : realCorpusSource.envName,
      vaultCanonicalId: vaultMode ? projectMetadata.vaultCanonicalId : undefined,
      translationScope: projectMetadata.translationScope,
    };
    writeClassifiedRunReport(failureReport);
    process.stderr.write(
      `[localize-project] OUTCOME=${outcome} code=${diagnosticCode} phase=${phase} — run report: ${join(repoRelativePath(runDir), "run-summary.json")}\n`,
    );
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[localize-project] FAILED: ${error.message}\n`);
    process.exit(1);
  });
}
