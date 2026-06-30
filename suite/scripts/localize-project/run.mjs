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
  const requiredKeys = ["policyId", "pair", "enUsSentinel", "sceneId", "stages"];
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
  };
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
  if (result.error) {
    throw new Error(`command failed to start: ${printableRedacted}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`command exited with status ${result.status}: ${printableRedacted}`);
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

async function runRpgMakerMvMzPipeline(ctx) {
  const {
    args,
    policy,
    pairPolicyPath,
    projectMetadata,
    sentinelSubstring,
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
  const deltaPath = join(runDir, "patch.kaifuu");
  const patchedDataDir = join(runDir, "patched-data");
  const deltaAppliedDir = join(runDir, "delta-applied");
  const appliedDataDir = join(deltaAppliedDir, "data");
  const applyReportPath = join(runDir, "apply-report.json");
  const runtimeInputDir = join(runDir, "runtime-input");
  const runtimeArtifactsDir = join(runDir, "runtime-artifacts");
  const runtimeEvidencePath = join(runDir, "runtime-evidence.json");

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
    printDryRunPlan(
      [
        `cargo run -p kaifuu-cli -- extract --engine rpgmaker --game-dir ${realCorpusSource.placeholder} ${identityArgs.join(" ")} --bundle-output ${bridgeBundlePath} --findings-output ${findingsPath}`,
        `node apps/itotori/dist/cli.js localize-project-stage --bridge ${bridgeBundlePath} --pair-policy ${pairPolicyPath} --unit-index <first-dialogue-scene-unit> --engine-profile rpg-maker-mv-mz --output ${agenticLoopBundlePath} --translated-bundle-output ${translatedBundlePath} --patch-report-output ${patchReportPath} --provider-run-artifacts-dir ${providerRunArtifactsDir}`,
        `cargo run -p kaifuu-cli -- patch --engine rpgmaker --source ${realCorpusSource.placeholder} --bundle ${translatedBundlePath} --delta-output ${deltaPath} --patched-data-output ${patchedDataDir}`,
        `cargo run -p kaifuu-cli -- apply ${realCorpusSource.placeholder}/data --patch ${deltaPath} --output ${appliedDataDir} --report-output ${applyReportPath}`,
        `cargo run -p utsushi-cli -- rpgmaker-mv-capture --game-dir ${runtimeInputDir} --artifact-root ${runtimeArtifactsDir} --run-id ${runId} --expect-textline-contains ${sentinelSubstring} --output ${runtimeEvidencePath}`,
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

  // Readonly-source invariant: hash the source data tree before any work.
  const sourceTreeSha256Before = sha256OfDataTree(sourceDataDir);
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

  // -------------- Phase 2: agentic loop (live LLM) ----------------
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
  runCommand("node", stageArgs, process.env, { redact });

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

  // ----------- Phase 3: kaifuu patchback + .kaifuu delta ----------
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
      translatedBundlePath,
      "--delta-output",
      deltaPath,
      "--patched-data-output",
      patchedDataDir,
    ],
    process.env,
    { redact },
  );

  // --------------- Phase 4: kaifuu delta-apply --------------------
  // Reproduce the patched data tree from the `.kaifuu` package; this is
  // the artifact the runtime consumes (proves the delta round-trips).
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
      deltaPath,
      "--output",
      appliedDataDir,
      "--report-output",
      applyReportPath,
    ],
    process.env,
    { redact },
  );

  // ----------- Phase 5: bounded runtime text-trace evidence -------
  // The runner caps a single observation stream; replay the one patched
  // scene file (which carries the localized surface) rather than the full
  // corpus. The capture fails closed unless the sentinel lands in a line.
  const runtimeDataDir = join(runtimeInputDir, "data");
  mkdirSync(runtimeDataDir, { recursive: true });
  copyFileSync(join(appliedDataDir, sceneFile), join(runtimeDataDir, sceneFile));
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
      runtimeInputDir,
      "--artifact-root",
      runtimeArtifactsDir,
      "--run-id",
      runId,
      "--expect-textline-contains",
      sentinelSubstring,
      "--output",
      runtimeEvidencePath,
    ],
    process.env,
    { redact },
  );

  // Readonly-source invariant: re-hash + assert no drift.
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
    bridgeBundlePath,
    findingsPath,
    agenticLoopBundlePath,
    translatedBundlePath,
    patchReportPath,
    deltaPath,
    applyReportPath,
    runtimeEvidencePath,
  ]) {
    if (!existsSync(artifact)) {
      throw new Error(`expected artifact missing after successful run: ${artifact}`);
    }
  }

  const summary = {
    runDir: repoRelativePath(runDir),
    project: args.project,
    engine: projectMetadata.engine,
    boundedSlice: { unitIndex, sceneFile, totalUnits: bridge.units.length },
    sourceGame: {
      gameId: projectMetadata.gameId,
      gameVersion: projectMetadata.gameVersion,
      sourceProfileId: projectMetadata.sourceProfileId,
    },
    sourceLocale: projectMetadata.sourceLocale,
    pair: policy.pair,
    enUsSentinel: policy.enUsSentinel,
    sourceDataTreeSha256: sourceTreeSha256Before,
    artifacts: {
      bridgeBundle: portableRelativePath(runDir, bridgeBundlePath),
      extractionFindings: portableRelativePath(runDir, findingsPath),
      agenticLoopBundle: portableRelativePath(runDir, agenticLoopBundlePath),
      translatedBundle: portableRelativePath(runDir, translatedBundlePath),
      patchReport: portableRelativePath(runDir, patchReportPath),
      delta: portableRelativePath(runDir, deltaPath),
      applyReport: portableRelativePath(runDir, applyReportPath),
      runtimeEvidence: portableRelativePath(runDir, runtimeEvidencePath),
      providerRunArtifacts: portableRelativePath(runDir, providerRunArtifactsDir),
    },
  };
  writeFileSync(join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`[localize-project] SUCCESS — run dir: ${runDir}\n`);
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
  const sentinelSubstring = policy.enUsSentinel;
  const sceneId = policy.sceneId ?? args.scene;
  const ts = isoTimestampUtc();
  const runDirName = `${ts}-${args.project}`;
  const runDir = join(REPO_ROOT, "artifacts", "localize-project", runDirName);

  const bridgeBundlePath = join(runDir, "bridge-bundle.json");
  const agenticLoopBundlePath = join(runDir, "agentic-loop-bundle.v0.json");
  const translatedBundlePath = join(runDir, "translated-bridge.json");
  const patchReportPath = join(runDir, "patch-report.json");
  const replayLogPath = join(runDir, "replay-log.json");
  const providerRunArtifactsDir = join(runDir, "provider-runs");

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

  const realCorpusSource = resolveRealCorpusSource({
    dryRun,
    projectMetadata,
    corpusId: args.corpus,
  });
  const gameRoot = realCorpusSource.root;

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
      sentinelSubstring,
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
  const livePathRedactor = buildPathRedactor([
    { path: gameRoot, replacement: realCorpusSource.placeholder },
    { path: targetRoot, replacement: "<TARGET>" },
  ]);
  if (!dryRun && (targetRoot === undefined || targetRoot.length === 0)) {
    throw new Error("TARGET (writable path for the patched copy) must be set unless --dry-run");
  }
  if (!dryRun) {
    ensureWritableTargetDistinctFromSource(gameRoot, targetRoot, livePathRedactor);
  }

  if (dryRun) {
    printDryRunPlan(
      [
        `cargo run -p kaifuu-cli -- extract --engine reallive --game-root ${realCorpusSource.placeholder} --game-id ${projectMetadata.gameId} --game-version ${projectMetadata.gameVersion} --source-profile-id ${projectMetadata.sourceProfileId} --source-locale ${projectMetadata.sourceLocale} --scene ${sceneId} --bundle-output ${bridgeBundlePath}`,
        `node apps/itotori/dist/cli.js localize-project-stage --bridge ${bridgeBundlePath} --pair-policy ${pairPolicyPath} --unit-index ${args.unitIndex} --output ${agenticLoopBundlePath} --translated-bundle-output ${translatedBundlePath} --patch-report-output ${patchReportPath} --provider-run-artifacts-dir ${providerRunArtifactsDir}`,
        `cargo run -p kaifuu-cli -- patch --engine reallive --source ${realCorpusSource.placeholder} --target <TARGET> --bundle ${translatedBundlePath} --force`,
        `cargo run -p utsushi-cli -- replay-validate --engine reallive --seen <TARGET>/REALLIVEDATA/Seen.txt --scene ${sceneId} --expect-textline-contains ${sentinelSubstring} --print-replay-log ${replayLogPath}`,
      ],
      flattenPostures(policy),
      realCorpusSource,
    );
    return;
  }

  mkdirSync(runDir, { recursive: true });

  // Capture source sha256 BEFORE any work.
  const sourceSeenPath = resolveReallivedataSeen(gameRoot);
  const sourceSeenPlaceholder = `${realCorpusSource.placeholder}/REALLIVEDATA/Seen.txt`;
  const targetPlaceholder = "<TARGET>";
  const liveCommandRedactor = buildPathRedactor([
    { path: sourceSeenPath, replacement: sourceSeenPlaceholder },
    { path: gameRoot, replacement: realCorpusSource.placeholder },
    { path: targetRoot, replacement: targetPlaceholder },
  ]);
  const sourceSeenSha256Before = sha256OfFile(sourceSeenPath);
  process.stdout.write(
    `[localize-project] source Seen.txt sha256 (pre): ${sourceSeenSha256Before}\n`,
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
      "reallive",
      "--game-root",
      gameRoot,
      ...realliveIdentityArgs(projectMetadata),
      "--scene",
      String(sceneId),
      "--bundle-output",
      bridgeBundlePath,
    ],
    process.env,
    { redact: liveCommandRedactor },
  );

  // -------------- Phase 2: agentic loop (live LLM) ----------------
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
      "--force",
    ],
    process.env,
    { redact: liveCommandRedactor },
  );

  // --------------- Phase 4: replay-validate ----------------------
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
      "--expect-textline-contains",
      sentinelSubstring,
      "--print-replay-log",
      replayLogPath,
    ],
    process.env,
    { redact: liveReplayRedactor },
  );

  // ---- Readonly-source invariant: re-hash + assert no drift. ----
  const sourceSeenSha256After = sha256OfFile(sourceSeenPath);
  process.stdout.write(
    `[localize-project] source Seen.txt sha256 (post): ${sourceSeenSha256After}\n`,
  );
  if (sourceSeenSha256Before !== sourceSeenSha256After) {
    throw new Error(
      liveCommandRedactor(
        `kaifuu.reallive.source_mutated: source Seen.txt at ${sourceSeenPath} changed during the run (pre=${sourceSeenSha256Before}, post=${sourceSeenSha256After})`,
      ),
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
    enUsSentinel: policy.enUsSentinel,
    sourceSeenSha256: sourceSeenSha256Before,
    artifacts: {
      bridgeBundle: portableRelativePath(runDir, bridgeBundlePath),
      agenticLoopBundle: portableRelativePath(runDir, agenticLoopBundlePath),
      patchReport: portableRelativePath(runDir, patchReportPath),
      replayLog: portableRelativePath(runDir, replayLogPath),
      providerRunArtifacts: portableRelativePath(runDir, providerRunArtifactsDir),
    },
  };
  writeFileSync(join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`[localize-project] SUCCESS — run dir: ${runDir}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[localize-project] FAILED: ${error.message}\n`);
    process.exit(1);
  });
}
