#!/usr/bin/env node
/*
 * KAIFUU-094 — Siglus private-local **redacted validation summary** renderer.
 *
 * Pure, deterministic core for the `siglus:private-local-validation-render`
 * workflow. It turns operator-authored, ALREADY-REDACTED private-local Siglus
 * VALIDATION manifests (describing local known-key / decrypt / patch-verify
 * runs — the KAIFUU-070 known-key smoke and the broader Scene.pck / Gameexe.dat
 * stack) into a SAFE AGGREGATE validation summary, and produces a deterministic
 * REDACTED no-corpus artifact when no private inputs exist.
 *
 * This is the SIGLUS analogue of KAIFUU-036's private-local encrypted corpus
 * triage: it REUSES that redaction boundary (`findSecretLeak` structural scan +
 * `assertNoSecrets`-style recursive walk + `stableStringify`), and extends the
 * leak scanner with Siglus-specific content categories.
 *
 * COPYRIGHT / STRICT-PROOF LAW (this module is the enforcement point):
 *   - The renderer NEVER reads raw keys, key material, decrypted script text,
 *     retail Scene.pck / Gameexe.dat bytes, story/scene filenames, or helper raw
 *     dumps. Its ONLY input is the redacted validation-manifest JSON an operator
 *     writes to describe a corpus's validation runs (logical profile ids,
 *     capability levels, helper OUTCOME CATEGORIES, validation STATUSES, failure
 *     CATEGORIES, aggregate COUNTS, proof HASHES). No shell-outs; no filesystem
 *     reads beyond the manifest JSON.
 *   - The rendered summary emits ONLY aggregates / categories / statuses /
 *     profile-ids / capability-levels / counts / hashes. Every value that
 *     reaches the emitted artifact is DEEP-SCANNED for leaks; a leak THROWS
 *     BEFORE anything is written (fail-loud, emit nothing — never silently
 *     redacts). The scanner catches: raw keys / key material (hex runs, PEM),
 *     decrypted script text / source text (non-ASCII content), story/scene
 *     FILENAMES (asset extensions), helper raw dumps (control chars / newlines),
 *     `local-secret:` refs, and absolute local paths.
 *   - Output is byte-deterministic (sorted keys, no timestamps, no absolute
 *     paths), so the committed public-safe fixture and the no-corpus artifact
 *     are stable and diffable and validate in public CI without private assets.
 */
"use strict";

// Reuse the KAIFUU-036 redaction boundary directly: the structural secret
// scanner and the deterministic serializer. The Siglus renderer composes the
// base scanner with additional content categories below.
import {
  findSecretLeak as findBaseSecretLeak,
  stableStringify,
} from "../kaifuu-private-local-triage/triage.mjs";

export { stableStringify };

export const SUMMARY_SCHEMA_VERSION = "itotori.siglus-private-local-validation-report.v0.1";
export const MANIFEST_SCHEMA_VERSION = "itotori.siglus-private-local-validation-manifest.v0.1";
export const GENERATOR_PATH = "suite/scripts/siglus-private-local-validation-renderer/run.mjs";
export const RENDER_TASK = "siglus:private-local-validation-render";
export const ENGINE_FAMILY = "siglus";

// Honest Siglus validation capability tiers. Order is fixed so bins serialize
// deterministically. These mirror the crate's honest scope: the narrow
// KAIFUU-070 known-key smoke tiers are real; `broad-unsupported` marks the real
// Scene.pck / Gameexe.dat broad path that remains a skeleton stub (siglus-04/06)
// so an aggregate can NEVER imply unsupported production capability.
export const CAPABILITY_LEVELS = [
  "detect-only",
  "known-key-extract",
  "known-key-patch-verify",
  "broad-unsupported",
];

// Validation statuses. `skipped`/`private_inputs_absent` is the missing-corpus
// diagnostic; `redaction_violation` is surfaced by a THROW (never a status),
// `unknown_profile` and `helper_required` are first-class statuses so the four
// acceptance diagnostics stay distinct.
export const VALIDATION_STATUSES = [
  "passed",
  "helper_required",
  "unknown_profile",
  "unsupported_variant",
  "out_of_profile",
  "failed",
  "skipped",
];

// Helper OUTCOME CATEGORIES (never raw helper outputs/dumps).
export const HELPER_OUTCOME_CATEGORIES = [
  "not_required",
  "available_passed",
  "required_missing",
  "out_of_profile",
  "error",
];

// Failure CATEGORIES — the typed KnownKeySmokeError families mapped to stable
// category labels (never raw error detail / dumps).
export const FAILURE_CATEGORIES = [
  "none",
  "out_of_profile_compression",
  "bad_magic",
  "truncated",
  "invalid_utf16le",
  "bad_unit_key",
  "unit_not_found",
  "verify_mismatch",
  "unknown",
];

// Aggregate validation count keys. Order fixed for deterministic serialization.
export const COUNT_KEYS = [
  "scenesValidated",
  "unitsValidated",
  "gameexeEntriesValidated",
  "filesProcessed",
];

// Canonical redacted command strings. The real argv is NEVER recorded (it can
// carry local absolute paths); the mode maps to a fixed logical command.
export const COMMANDS = {
  noCorpus: "vp run siglus:private-local-validation-render -- --no-corpus",
  manifest: "vp run siglus:private-local-validation-render -- --manifest <private-manifest>",
  corpusDir:
    "vp run siglus:private-local-validation-render -- --corpus-dir <private-corpus-directory>",
};

const LOGICAL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;

// --- Extended Siglus leak scanner -------------------------------------------
//
// Composes the KAIFUU-036 structural scanner (absolute paths, raw key/hex runs,
// PEM blocks, `local-secret:` refs) with Siglus content categories. The rendered
// summary is ASCII logical-ids/enums/counts/hashes ONLY, so:
//   - any non-ASCII string is decrypted script / source text leakage;
//   - any control char / newline is a helper raw dump;
//   - any game-asset filename extension is a story/scene filename.

// Control chars (excluding TAB) + newlines never appear in the redacted summary;
// their presence means a raw helper dump leaked in.
// eslint-disable-next-line no-control-regex -- matching control code points is the detector's purpose
const CONTROL_RE = /[\u0000-\u0008\u000A-\u001F]/u;
// The redacted summary is pure ASCII; any non-ASCII byte is decrypted Siglus
// script / retail source text.
// eslint-disable-next-line no-control-regex -- the negated ASCII range boundary includes \u0000
const NON_ASCII_RE = /[^\u0000-\u007F]/u;
// Game-asset / story-script filename extensions. Deliberately EXCLUDES repo
// authoring extensions (`.mjs`, `.json`, `.md`, `.toml`) that legitimately
// appear in `generatedBy` — only retail asset/script extensions are leaks.
const ASSET_FILENAME_RE =
  /\.(?:pck|dat|ss|ke|seen|scn|scene|g00|nwa|ova|ogg|wav|png|bmp|jpg|dpk|omg|mask|exe|dll|txt)\b/iu;

export function findSecretLeak(text) {
  if (typeof text !== "string") {
    return null;
  }
  // KAIFUU-036 structural scan first: absolute-local-path, local-secret-ref,
  // pem-key-block, raw-key-or-hex-blob (sha256 proof tails allowed).
  const base = findBaseSecretLeak(text);
  if (base !== null) {
    return base;
  }
  if (CONTROL_RE.test(text)) {
    return "helper-raw-dump";
  }
  if (NON_ASCII_RE.test(text)) {
    return "decrypted-script-or-source-text";
  }
  if (ASSET_FILENAME_RE.test(text)) {
    return "story-or-scene-filename";
  }
  return null;
}

// Deep secret scan: throws a structured error naming the JSON path of the first
// leaking string (key OR value OR array item). Runs over the FINAL artifact
// right before serialization — the fail-loud enforcement point.
export function assertNoSecrets(value, path = "$") {
  if (typeof value === "string") {
    const kind = findSecretLeak(value);
    if (kind !== null) {
      throw new Error(`siglus-redaction-violation (${kind}) at ${path}`);
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
        throw new Error(`siglus-redaction-violation (${kind}) at ${path}.<key>`);
      }
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

// --- Validators -------------------------------------------------------------

function requireLogicalId(field, value, index) {
  if (typeof value !== "string" || !LOGICAL_ID_RE.test(value)) {
    throw new Error(
      `manifest run ${index}: ${field} must be a lowercase logical id ([a-z0-9._-], no paths/filenames), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireEnum(field, value, allowed, index) {
  if (!allowed.includes(value)) {
    throw new Error(
      `manifest run ${index}: ${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireCounts(raw, index) {
  const counts = {};
  const source = raw ?? {};
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`manifest run ${index}: counts must be an object`);
  }
  for (const key of COUNT_KEYS) {
    const n = source[key] ?? 0;
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`manifest run ${index}: counts.${key} must be a non-negative integer`);
    }
    counts[key] = n;
  }
  return counts;
}

function requireProofHashes(raw, index) {
  const list = raw ?? [];
  if (!Array.isArray(list)) {
    throw new Error(`manifest run ${index}: proofHashes must be an array`);
  }
  for (const hash of list) {
    if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
      throw new Error(
        `manifest run ${index}: proofHashes must be sha256:<64 hex> strings, got ${JSON.stringify(hash)}`,
      );
    }
  }
  return [...list].sort();
}

// Validate + normalize one operator validation-run entry into a redacted
// summary run. Rejects unknown capability levels / statuses / categories and
// non-logical profile ids; the deep secret scan is applied to the whole summary
// before write.
export function normalizeRun(run, index) {
  if (run === null || typeof run !== "object" || Array.isArray(run)) {
    throw new Error(`manifest run ${index}: must be an object`);
  }
  return {
    profileId: requireLogicalId("profileId", run.profileId, index),
    capabilityLevel: requireEnum("capabilityLevel", run.capabilityLevel, CAPABILITY_LEVELS, index),
    validationStatus: requireEnum(
      "validationStatus",
      run.validationStatus,
      VALIDATION_STATUSES,
      index,
    ),
    helperOutcomeCategory: requireEnum(
      "helperOutcomeCategory",
      run.helperOutcomeCategory,
      HELPER_OUTCOME_CATEGORIES,
      index,
    ),
    failureCategory:
      run.failureCategory === undefined || run.failureCategory === null
        ? "none"
        : requireEnum("failureCategory", run.failureCategory, FAILURE_CATEGORIES, index),
    counts: requireCounts(run.counts, index),
    proofHashes: requireProofHashes(run.proofHashes, index),
  };
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
  const runs = manifest.runs;
  if (!Array.isArray(runs)) {
    throw new Error(`${source}: runs must be an array`);
  }
  return runs.map((run, index) => normalizeRun(run, index));
}

function emptyBins(labels) {
  const bins = {};
  for (const label of labels) {
    bins[label] = 0;
  }
  return bins;
}

function emptyAggregateCounts() {
  const counts = { profiles: 0, runs: 0 };
  for (const key of COUNT_KEYS) {
    counts[key] = 0;
  }
  return counts;
}

// Aggregate validated runs into the safe validation summary. Runs are sorted by
// (profileId, capabilityLevel, validationStatus) for determinism; the secret
// scan runs last (throws on any leak before the summary is returned/written).
export function buildValidationSummary(runs, { command = COMMANDS.manifest } = {}) {
  const sorted = [...runs].sort((a, b) => {
    if (a.profileId !== b.profileId) {
      return a.profileId < b.profileId ? -1 : 1;
    }
    if (a.capabilityLevel !== b.capabilityLevel) {
      return a.capabilityLevel < b.capabilityLevel ? -1 : 1;
    }
    return a.validationStatus < b.validationStatus
      ? -1
      : a.validationStatus > b.validationStatus
        ? 1
        : 0;
  });

  const capabilityLevelBins = emptyBins(CAPABILITY_LEVELS);
  const helperOutcomeBins = emptyBins(HELPER_OUTCOME_CATEGORIES);
  const validationStatusBins = emptyBins(VALIDATION_STATUSES);
  const failureCategoryBins = emptyBins(FAILURE_CATEGORIES);
  const aggregateCounts = emptyAggregateCounts();
  const profileIds = new Set();

  for (const run of sorted) {
    profileIds.add(run.profileId);
    aggregateCounts.runs += 1;
    for (const key of COUNT_KEYS) {
      aggregateCounts[key] += run.counts[key];
    }
    capabilityLevelBins[run.capabilityLevel] += 1;
    helperOutcomeBins[run.helperOutcomeCategory] += 1;
    validationStatusBins[run.validationStatus] += 1;
    failureCategoryBins[run.failureCategory] += 1;
  }
  aggregateCounts.profiles = profileIds.size;

  const summary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    status: "ok",
    reason: null,
    command,
    generatedBy: GENERATOR_PATH,
    engineFamily: ENGINE_FAMILY,
    aggregateCounts,
    capabilityLevelBins,
    helperOutcomeBins,
    validationStatusBins,
    failureCategoryBins,
    runs: sorted,
  };
  assertNoSecrets(summary);
  return summary;
}

// The deterministic REDACTED no-corpus artifact. Zeroed aggregate counts + empty
// bins, checked paths reduced to logical ids, no timestamp. Absence of a private
// corpus is NEVER a failure — it renders this skipped summary and exits clean.
export function buildNoCorpusArtifact({
  command = COMMANDS.noCorpus,
  checkedPaths = ["private-local-root"],
} = {}) {
  const logicalIds = [...new Set(checkedPaths)].sort();
  for (const id of logicalIds) {
    if (!LOGICAL_ID_RE.test(id)) {
      throw new Error(`no-corpus checkedPaths must be logical ids, got ${JSON.stringify(id)}`);
    }
  }
  const artifact = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    status: "skipped",
    reason: "private_inputs_absent",
    command,
    generatedBy: GENERATOR_PATH,
    engineFamily: ENGINE_FAMILY,
    checkedPaths: logicalIds,
    aggregateCounts: emptyAggregateCounts(),
    capabilityLevelBins: emptyBins(CAPABILITY_LEVELS),
    helperOutcomeBins: emptyBins(HELPER_OUTCOME_CATEGORIES),
    validationStatusBins: emptyBins(VALIDATION_STATUSES),
    failureCategoryBins: emptyBins(FAILURE_CATEGORIES),
    runs: [],
  };
  assertNoSecrets(artifact);
  return artifact;
}
