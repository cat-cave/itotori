#!/usr/bin/env node
/*
 * the relevant capability — Private-local encrypted corpus triage core.
 *
 * Pure, deterministic core for the `kaifuu:private-local-triage` workflow. It
 * turns operator-authored, ALREADY-REDACTED private-local triage manifests into
 * a SAFE AGGREGATE readiness report. Missing or empty private input is a typed
 * failure diagnostic, never an evidence artifact.
 *
 * COPYRIGHT / STRICT-PROOF LAW (this module is the enforcement point):
 *   - The triage NEVER reads raw keys, raw encrypted bytes, decrypted text, or
 *     retail assets. Its ONLY input is the redacted manifest JSON an operator
 *     writes to describe a corpus (logical ids, helper classes, proof HASHES,
 *     detector results, aggregate counts, readiness bins, redacted command
 *     lines). No shell-outs, no filesystem reads beyond the manifest JSON.
 *   - Every value that reaches an emitted artifact is scanned for secrets
 *     (absolute local paths, raw key/hex material, `local-secret:` refs, PEM
 *     blocks). A leak throws BEFORE anything is written — it never redacts
 *     silently and never emits.
 *   - Output is byte-deterministic (sorted keys, no timestamps, no absolute
 *     paths), so committed README-safe evidence is stable and diffable.
 */
"use strict";

export const SCHEMA_VERSION = "itotori.kaifuu-private-local-triage-report.v0.1";
export const MANIFEST_SCHEMA_VERSION = "itotori.kaifuu-private-local-triage-manifest.v0.1";
export const GENERATOR_PATH = "suite/scripts/kaifuu-private-local-triage/run.mjs";
export const TRIAGE_TASK = "kaifuu:private-local-triage";
export const PRIVATE_INPUT_DIAGNOSTIC_SCHEMA_VERSION = "itotori.private-input-diagnostic.v1";
export const PRIVATE_INPUT_REASON_CODES = [
  "private-input-explicitly-absent",
  "private-input-manifest-missing",
  "private-input-root-missing",
  "private-input-directory-empty",
  "private-input-selection-empty",
  "private-input-zero-bytes",
  "private-input-argument-missing",
  "private-input-directory-unreadable",
  "private-input-manifest-not-file",
  "private-input-invalid",
];
const INVALID_INPUT_REASON_CODES = new Set([
  "private-input-argument-missing",
  "private-input-directory-unreadable",
  "private-input-manifest-not-file",
  "private-input-invalid",
]);

// Per-engine aggregate bins cover MV/MZ encrypted media plus the other
// encrypted engines the beta readiness lane tracks. Order is fixed so bins
// serialize deterministically.
export const ENGINES = [
  "rpg-maker-mv",
  "rpg-maker-mz",
  "kirikiri-xp3",
  "siglus",
  "wolf",
  "rgss3-vx-ace",
];

// Readiness bins classify each corpus entry's encrypted-input readiness. Order
// is fixed so per-engine bin objects serialize deterministically.
export const READINESS_BINS = [
  "ready",
  "helper_required",
  "key_missing",
  "unsupported_variant",
  "detector_unknown",
  "blocked",
];

export const HELPER_CLASSES = [
  "staticParser",
  "runtimeHelper",
  "patchDatabase",
  "executableAnalysis",
  "none",
];

export const COUNT_KEYS = ["assets", "encryptedAssets", "textUnits", "archives"];

// Canonical redacted command strings. The real argv is NEVER recorded because
// it can carry local absolute paths; the mode maps to a fixed logical command.
export const COMMANDS = {
  manifest: "vp run kaifuu:private-local-triage -- --manifest <private-manifest>",
  corpusDir: "vp run kaifuu:private-local-triage -- --corpus-dir <private-corpus-directory>",
};

const LOGICAL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;

// Secret scanners. Every string that reaches an emitted artifact is tested
// against these; a match throws (the workflow never leaks, never silently
// redacts). `sha256:<64hex>` proof hashes are the ONLY long hex runs allowed.
const ABSOLUTE_PATH_RE =
  /(?:^|[\s"'=(:,[])(?:\/(?:home|Users|root|mnt|scratch|media|opt|srv|var|Volumes)\/|[A-Za-z]:[\\/])/u;
const LOCAL_SECRET_RE = /local-secret:/iu;
const PEM_RE = /-----BEGIN[ A-Z]*(?:PRIVATE KEY|PGP)/u;
const HEX_RUN_RE = /[0-9a-fA-F]{24,}/gu;

function isAllowedHexRun(text, matchIndex) {
  // Allowed only when the run is the hex tail of a `sha256:` proof hash.
  const prefix = text.slice(Math.max(0, matchIndex - 7), matchIndex);
  return prefix.endsWith("sha256:");
}

export function findSecretLeak(text) {
  if (typeof text !== "string") {
    return null;
  }
  if (ABSOLUTE_PATH_RE.test(text)) {
    return "absolute-local-path";
  }
  if (LOCAL_SECRET_RE.test(text)) {
    return "local-secret-ref";
  }
  if (PEM_RE.test(text)) {
    return "pem-key-block";
  }
  for (const match of text.matchAll(HEX_RUN_RE)) {
    if (!isAllowedHexRun(text, match.index)) {
      return "raw-key-or-hex-blob";
    }
  }
  return null;
}

// Deep secret scan: throws a structured error naming the JSON path of the first
// leaking string. Runs over the FINAL artifact right before serialization.
export function assertNoSecrets(value, path = "$") {
  if (typeof value === "string") {
    const kind = findSecretLeak(value);
    if (kind !== null) {
      throw new Error(`secret-leak (${kind}) at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const kind = findSecretLeak(key);
      if (kind !== null) {
        throw new Error(`secret-leak (${kind}) at ${path}.<key>`);
      }
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

// Deterministic serialization: sorted keys, 2-space indent, trailing newline.
// Matches the repo formatter so committed examples stay byte-stable.
export function stableStringify(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export class PrivateInputContractError extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    if (!PRIVATE_INPUT_REASON_CODES.includes(reasonCode)) {
      throw new Error("unknown private input failure reason");
    }
    this.name = "PrivateInputContractError";
    this.reasonCode = reasonCode;
  }
}

export function requirePrivateOptionValue(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value === "-h" || value.startsWith("--")) {
    throw new PrivateInputContractError("private-input-argument-missing");
  }
  return value;
}

export function claimPrivateOption(seen, option) {
  if (seen.has(option)) {
    throw new PrivateInputContractError("private-input-invalid");
  }
  seen.add(option);
}

export function rejectPrivateSelectorConflict(selectors) {
  if (selectors.size > 1) {
    throw new PrivateInputContractError("private-input-invalid");
  }
}

export function rejectPrivateHelpConflict(argv, help) {
  const args = argv.filter((value) => value !== "--");
  if (help && (args.length !== 1 || (args[0] !== "--help" && args[0] !== "-h"))) {
    throw new PrivateInputContractError("private-input-invalid");
  }
}

export function buildPrivateInputFailureDiagnostic({ task, reasonCode }) {
  if (typeof task !== "string" || task.length === 0) {
    throw new Error("private input diagnostic task must be nonempty");
  }
  if (!PRIVATE_INPUT_REASON_CODES.includes(reasonCode)) {
    throw new Error(`unknown private input failure reason: ${JSON.stringify(reasonCode)}`);
  }
  const diagnostic = {
    schemaVersion: PRIVATE_INPUT_DIAGNOSTIC_SCHEMA_VERSION,
    status: "failed",
    task,
    failureClass: INVALID_INPUT_REASON_CODES.has(reasonCode) ? "invalid-input" : "missing-input",
    reasonCode,
    diagnosticOutcome: "safe-actionable-remediation",
    effectOutcome: "no-effects",
  };
  assertNoSecrets(diagnostic);
  return diagnostic;
}

export function privateInputFailure(task, reasonCode) {
  return {
    kind: "failure",
    diagnostic: buildPrivateInputFailureDiagnostic({ task, reasonCode }),
  };
}

export function privateInputFailureFromError(task, error) {
  const reasonCode =
    error instanceof PrivateInputContractError ? error.reasonCode : "private-input-invalid";
  return privateInputFailure(task, reasonCode);
}

export function emptyEngineBins() {
  const bins = {};
  for (const engine of ENGINES) {
    const engineBins = {};
    for (const bin of READINESS_BINS) {
      engineBins[bin] = 0;
    }
    bins[engine] = engineBins;
  }
  return bins;
}

function emptyAggregateCounts() {
  const counts = { corpora: 0, entries: 0 };
  for (const key of COUNT_KEYS) {
    counts[key] = 0;
  }
  return counts;
}

function requireLogicalId(field, value, index) {
  if (typeof value !== "string" || !LOGICAL_ID_RE.test(value)) {
    throw new Error(
      `manifest entry ${index}: ${field} must be a lowercase logical id ([a-z0-9._-], no paths), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireEnum(field, value, allowed, index) {
  if (!allowed.includes(value)) {
    throw new Error(
      `manifest entry ${index}: ${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireCounts(raw, index) {
  const counts = {};
  const source = raw ?? {};
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`manifest entry ${index}: counts must be an object`);
  }
  for (const key of COUNT_KEYS) {
    const n = source[key] ?? 0;
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`manifest entry ${index}: counts.${key} must be a non-negative integer`);
    }
    counts[key] = n;
  }
  return counts;
}

function requireProofHashes(raw, index) {
  const list = raw ?? [];
  if (!Array.isArray(list)) {
    throw new Error(`manifest entry ${index}: proofHashes must be an array`);
  }
  for (const hash of list) {
    if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
      throw new Error(
        `manifest entry ${index}: proofHashes must be sha256:<64 hex> strings, got ${JSON.stringify(hash)}`,
      );
    }
  }
  return [...list].sort();
}

function requireStringList(field, raw, index) {
  const list = raw ?? [];
  if (!Array.isArray(list)) {
    throw new Error(`manifest entry ${index}: ${field} must be an array of strings`);
  }
  for (const item of list) {
    if (typeof item !== "string") {
      throw new Error(`manifest entry ${index}: ${field} entries must be strings`);
    }
  }
  return [...list].sort();
}

// Validate + normalize one operator manifest entry into a redacted report
// entry. Rejects unknown engines/bins, non-hash proof refs, and non-logical
// ids; the secret scan is applied to the whole report before write.
export function normalizeEntry(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`manifest entry ${index}: must be an object`);
  }
  const corpusId = requireLogicalId("corpusId", entry.corpusId, index);
  const engine = requireEnum("engine", entry.engine, ENGINES, index);
  const readinessBin = requireEnum("readinessBin", entry.readinessBin, READINESS_BINS, index);
  const helperClass =
    entry.helperClass === undefined || entry.helperClass === null
      ? "none"
      : requireEnum("helperClass", entry.helperClass, HELPER_CLASSES, index);

  const normalized = {
    corpusId,
    engine,
    readinessBin,
    keyProfileIdRedacted:
      entry.keyProfileIdRedacted === undefined || entry.keyProfileIdRedacted === null
        ? null
        : requireLogicalId("keyProfileIdRedacted", entry.keyProfileIdRedacted, index),
    helperClass,
    helperVersion:
      entry.helperVersion === undefined || entry.helperVersion === null
        ? null
        : String(entry.helperVersion),
    helperAvailable: entry.helperAvailable === true,
    proofHashes: requireProofHashes(entry.proofHashes, index),
    detectorResults: requireStringList("detectorResults", entry.detectorResults, index),
    counts: requireCounts(entry.counts, index),
    commandLines: requireStringList("commandLines", entry.commandLines, index),
  };
  return normalized;
}

export function normalizeManifest(manifest, source = "manifest") {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${source}: manifest must be an object`);
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `${source}: schemaVersion must be ${MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(manifest.schemaVersion)}`,
    );
  }
  const corpora = manifest.corpora;
  if (!Array.isArray(corpora)) {
    throw new Error(`${source}: corpora must be an array`);
  }
  return corpora.map((entry, index) => normalizeEntry(entry, index));
}

// Aggregate validated entries into the safe readiness report. Entries are
// sorted by (corpusId, engine) for determinism; the secret scan runs last.
export function buildReadinessReport(entries, { command = COMMANDS.manifest } = {}) {
  if (entries.length === 0) {
    throw new Error("readiness report requires at least one selected private input");
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.corpusId !== b.corpusId) {
      return a.corpusId < b.corpusId ? -1 : 1;
    }
    return a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0;
  });

  const engineReadinessBins = emptyEngineBins();
  const aggregateCounts = emptyAggregateCounts();
  const corpusIds = new Set();

  for (const entry of sorted) {
    corpusIds.add(entry.corpusId);
    aggregateCounts.entries += 1;
    for (const key of COUNT_KEYS) {
      aggregateCounts[key] += entry.counts[key];
    }
    engineReadinessBins[entry.engine][entry.readinessBin] += 1;
  }
  aggregateCounts.corpora = corpusIds.size;

  const report = {
    schemaVersion: SCHEMA_VERSION,
    status: "ok",
    reason: null,
    command,
    generatedBy: GENERATOR_PATH,
    aggregateCounts,
    engineReadinessBins,
    entries: sorted,
  };
  assertNoSecrets(report);
  return report;
}
