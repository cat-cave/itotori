#!/usr/bin/env node
/*
 * KAIFUU-067 — Private-local key-hunting run workflow (deterministic core).
 *
 * Pure, deterministic core for the `kaifuu:key-hunt` workflow. It ORCHESTRATES
 * the established private-local + helper + redaction patterns into a key-hunting
 * run: it PLANS which helper attempts apply to a detected engine + capability
 * level (KAIFUU-070 Siglus known-key, XP3 key, MV/MZ key, Wolf archive key,
 * RGSS3 key — plan, never brute-force), turns operator-authored, ALREADY-REDACTED
 * key-hunt manifests into a SAFE AGGREGATE redacted report of per-attempt
 * outcomes, and produces a deterministic REDACTED no-corpus artifact when no
 * private inputs exist.
 *
 * This is a SIBLING of KAIFUU-036 (private-local encrypted corpus triage) and
 * KAIFUU-094 (Siglus private-local validation renderer). It REUSES their
 * redaction boundary directly — the structural secret scanner (`findSecretLeak`),
 * the recursive deep-scan (`assertNoSecrets`), and the deterministic serializer
 * (`stableStringify`) — and composes them with the KAIFUU-085/090/129 helper
 * result + secret-ref pattern.
 *
 * COPYRIGHT / STRICT-PROOF LAW (this module is the enforcement point):
 *   - The workflow NEVER reads raw keys, raw encrypted bytes, decrypted text, or
 *     retail assets, and NEVER shells out to a real helper (Wine/Proton/native
 *     Windows). The attempt planner RESOLVES the plan; actual helper execution is
 *     out-of-band and its OUTCOME is recorded by the operator in a redacted
 *     manifest. Its ONLY input is that redacted manifest JSON (logical corpus /
 *     helper / key-profile ids, capability levels, helper classes, tool versions,
 *     redacted command lines, per-attempt OUTCOMES, proof HASHES).
 *   - TWO redaction boundaries:
 *       * The emitted REDACTED REPORT is scanned with the KAIFUU-036 base scanner
 *         (`assertNoSecrets`), which rejects absolute local paths, `local-secret:`
 *         refs, PEM blocks, and raw key/hex material. The report therefore carries
 *         NO secret refs and NO raw keys — only counts, profile ids, proof hashes,
 *         tool versions, and redacted command lines.
 *       * A CONFIRMED key is represented by a KEY VALIDATION RESULT record that
 *         stores ONLY a `local-secret:` ref + a `sha256:` proof hash + a logical
 *         key-profile id. That record is scanned with `assertNoRawKey`, which
 *         ALLOWS the `local-secret:` ref (its intended storage form) but rejects
 *         any raw key material, PEM block, or absolute local path in ANY field.
 *         The report surfaces ONLY the key-profile id + proof hash from it — never
 *         the secret ref.
 *   - Every value that reaches an emitted artifact is DEEP-SCANNED; a leak THROWS
 *     BEFORE anything is written (fail-loud, emit nothing — never silently
 *     redacts).
 *   - Output is byte-deterministic (sorted keys, no timestamps, no absolute
 *     paths), so the committed public-safe examples and the no-corpus artifact are
 *     stable and diffable and validate in public CI without private assets.
 */
"use strict";

// Reuse the KAIFUU-036 redaction boundary directly.
import {
  assertNoSecrets,
  findSecretLeak,
  stableStringify,
} from "../kaifuu-private-local-triage/triage.mjs";

export { assertNoSecrets, findSecretLeak, stableStringify };

export const REPORT_SCHEMA_VERSION = "itotori.kaifuu-key-hunt-report.v0.1";
export const MANIFEST_SCHEMA_VERSION = "itotori.kaifuu-key-hunt-manifest.v0.1";
export const GENERATOR_PATH = "suite/scripts/kaifuu-key-hunt/run.mjs";
export const KEY_HUNT_TASK = "kaifuu:key-hunt";

// Canonical redacted command strings. The real argv is NEVER recorded (it can
// carry local absolute paths); the mode maps to a fixed logical command.
export const COMMANDS = {
  noCorpus: "vp run kaifuu:key-hunt -- --no-corpus",
  manifest: "vp run kaifuu:key-hunt -- --manifest <private-manifest>",
  corpusDir: "vp run kaifuu:key-hunt -- --corpus-dir <private-corpus-directory>",
};

// Per-engine outcome bins cover the encrypted engines the beta key-hunting lane
// tracks. Order is fixed so bins serialize deterministically. Matches KAIFUU-036.
export const ENGINES = [
  "rpg-maker-mv",
  "rpg-maker-mz",
  "kirikiri-xp3",
  "siglus",
  "wolf",
  "rgss3-vx-ace",
];

// The five per-attempt OUTCOME categories the acceptance requires. Order fixed
// for deterministic serialization.
//   - attempted   : the helper ran and produced a CANDIDATE key still pending
//                   round-trip confirmation (validation in flight).
//   - succeeded   : the helper ran and the candidate was CONFIRMED (it decrypts /
//                   round-trips); carries a key-validation result (ref + proof).
//   - failed      : the helper ran but no key was confirmed (candidate rejected).
//   - skipped     : an attempt was PLANNED but not run (helper capability/binary
//                   absent on this host, or gated).
//   - unsupported : no attempt applies (unsupported engine or corpus variant).
export const OUTCOMES = ["attempted", "succeeded", "failed", "skipped", "unsupported"];

// Helper capability levels, ordered weakest -> strongest. The attempt planner
// uses this ordering to decide whether a planned attempt is RUNNABLE at the
// detected capability (KAIFUU-090 wine-local, KAIFUU-129 native-windows).
export const CAPABILITY_LEVELS = [
  "detect-only",
  "static-known-key",
  "wine-local",
  "native-windows",
];

// Helper classes (mirror KAIFUU-036). `none` marks an unsupported engine/variant.
export const HELPER_CLASSES = [
  "staticParser",
  "runtimeHelper",
  "patchDatabase",
  "executableAnalysis",
  "none",
];

// Attempt kinds the planner can select. `none` is the sentinel for an
// unsupported engine/variant (no hunting path).
export const ATTEMPT_KINDS = [
  "siglus-known-key",
  "xp3-key",
  "mv-mz-key",
  "wolf-archive-key",
  "rgss3-key",
  "none",
];

// --- Attempt planner --------------------------------------------------------
//
// The planner SELECTS which helper attempts apply to a detected engine +
// capability level. It PLANS the canonical attempt(s) for the engine (it does
// NOT brute-force a key space) and marks each attempt RUNNABLE only when the
// detected capability meets the attempt's minimum. An unknown engine yields an
// empty plan (every attempt for it is `unsupported`).
const ENGINE_PLANS = {
  siglus: [
    {
      attemptKind: "siglus-known-key",
      helperClass: "staticParser",
      minCapability: "static-known-key",
    },
  ],
  "kirikiri-xp3": [
    { attemptKind: "xp3-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
  "rpg-maker-mv": [
    { attemptKind: "mv-mz-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
  "rpg-maker-mz": [
    { attemptKind: "mv-mz-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
  wolf: [
    { attemptKind: "wolf-archive-key", helperClass: "runtimeHelper", minCapability: "wine-local" },
  ],
  "rgss3-vx-ace": [
    { attemptKind: "rgss3-key", helperClass: "staticParser", minCapability: "static-known-key" },
  ],
};

function capabilityRank(level) {
  const rank = CAPABILITY_LEVELS.indexOf(level);
  if (rank < 0) {
    throw new Error(`unknown capability level: ${JSON.stringify(level)}`);
  }
  return rank;
}

// Resolve the planned attempts for (engine, capabilityLevel). Returns a stable
// descriptor: `supportedEngine` is false for an unknown engine (its attempts are
// `unsupported`); each planned attempt is marked `runnable` when the detected
// capability meets its minimum (otherwise it must be `skipped`).
export function planAttempts(engine, capabilityLevel) {
  const rank = capabilityRank(capabilityLevel);
  const plans = ENGINE_PLANS[engine];
  if (plans === undefined) {
    return { engine, capabilityLevel, supportedEngine: false, attempts: [] };
  }
  const attempts = plans.map((plan) => ({
    attemptKind: plan.attemptKind,
    helperClass: plan.helperClass,
    minCapability: plan.minCapability,
    runnable: rank >= capabilityRank(plan.minCapability),
  }));
  return { engine, capabilityLevel, supportedEngine: true, attempts };
}

// The set of attempt kinds the planner would select for an engine (ignoring
// capability). Used to validate that a manifest attempt's declared kind belongs
// to the engine's plan.
export function plannedAttemptKinds(engine) {
  const plans = ENGINE_PLANS[engine];
  return plans === undefined ? [] : plans.map((plan) => plan.attemptKind);
}

// --- Key-validation-result scanner (allows the `local-secret:` ref) ---------
//
// A CONFIRMED key is stored ONLY as a `local-secret:` ref + a `sha256:` proof
// hash. This scanner is the enforcement point for that record: unlike the base
// report scanner it ALLOWS the `local-secret:` prefix (the intended storage
// form) but still rejects any raw key material, PEM block, or absolute local
// path in ANY field — so a raw key smuggled anywhere (even inside a
// `local-secret:` string) THROWS.
const ABSOLUTE_PATH_RE =
  /(?:^|[\s"'=(:,[])(?:\/(?:home|Users|root|mnt|scratch|media|opt|srv|var|Volumes)\/|[A-Za-z]:[\\/])/u;
const PEM_RE = /-----BEGIN[ A-Z]*(?:PRIVATE KEY|PGP)/u;
const HEX_RUN_RE = /[0-9a-fA-F]{24,}/gu;
const SECRET_REF_RE = /^local-secret:[a-z0-9][a-z0-9._/-]*$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const LOGICAL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;

function isSha256Tail(text, matchIndex) {
  return text.slice(Math.max(0, matchIndex - 7), matchIndex).endsWith("sha256:");
}

// Returns a leak kind for raw key material / PEM / absolute path, or null. Does
// NOT flag a `local-secret:` ref (that is the allowed storage form).
export function findRawKeyLeak(text) {
  if (typeof text !== "string") {
    return null;
  }
  if (ABSOLUTE_PATH_RE.test(text)) {
    return "absolute-local-path";
  }
  if (PEM_RE.test(text)) {
    return "pem-key-block";
  }
  for (const match of text.matchAll(HEX_RUN_RE)) {
    if (!isSha256Tail(text, match.index)) {
      return "raw-key-or-hex-blob";
    }
  }
  return null;
}

// Deep raw-key scan for a key-validation result: throws naming the JSON path of
// the first raw-key/PEM/absolute-path leak. Allows `local-secret:` refs.
export function assertNoRawKey(value, path = "$") {
  if (typeof value === "string") {
    const kind = findRawKeyLeak(value);
    if (kind !== null) {
      throw new Error(`key-validation-leak (${kind}) at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawKey(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const kind = findRawKeyLeak(key);
      if (kind !== null) {
        throw new Error(`key-validation-leak (${kind}) at ${path}.<key>`);
      }
      assertNoRawKey(child, `${path}.${key}`);
    }
  }
}

// --- Validators -------------------------------------------------------------

function requireLogicalId(field, value, index) {
  if (typeof value !== "string" || !LOGICAL_ID_RE.test(value)) {
    throw new Error(
      `manifest attempt ${index}: ${field} must be a lowercase logical id ([a-z0-9._-], no paths), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireEnum(field, value, allowed, index) {
  if (!allowed.includes(value)) {
    throw new Error(
      `manifest attempt ${index}: ${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireProofHashes(raw, index) {
  const list = raw ?? [];
  if (!Array.isArray(list)) {
    throw new Error(`manifest attempt ${index}: proofHashes must be an array`);
  }
  for (const hash of list) {
    if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
      throw new Error(
        `manifest attempt ${index}: proofHashes must be sha256:<64 hex> strings, got ${JSON.stringify(hash)}`,
      );
    }
  }
  return [...list].sort();
}

function requireCommandLines(raw, index) {
  const list = raw ?? [];
  if (!Array.isArray(list)) {
    throw new Error(`manifest attempt ${index}: commandLines must be an array of strings`);
  }
  for (const item of list) {
    if (typeof item !== "string") {
      throw new Error(`manifest attempt ${index}: commandLines entries must be strings`);
    }
  }
  return [...list].sort();
}

// Validate + normalize the KEY VALIDATION RESULT for a `succeeded` attempt. It
// carries ONLY a logical key-profile id, a `local-secret:` ref, and a `sha256:`
// proof hash. The raw-key scan runs over it (a raw key in ANY field throws).
export function normalizeKeyValidation(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`manifest attempt ${index}: keyValidation must be an object`);
  }
  const keyProfileId = requireLogicalId("keyValidation.keyProfileId", raw.keyProfileId, index);
  const secretRef = raw.secretRef;
  if (typeof secretRef !== "string" || !SECRET_REF_RE.test(secretRef)) {
    throw new Error(
      `manifest attempt ${index}: keyValidation.secretRef must be a local-secret:<logical-ref>, got ${JSON.stringify(secretRef)}`,
    );
  }
  const proofHash = raw.proofHash;
  if (typeof proofHash !== "string" || !SHA256_RE.test(proofHash)) {
    throw new Error(
      `manifest attempt ${index}: keyValidation.proofHash must be sha256:<64 hex>, got ${JSON.stringify(proofHash)}`,
    );
  }
  const result = { keyProfileId, secretRef, proofHash };
  // Enforce the ref-only storage boundary: raw key material anywhere throws.
  assertNoRawKey(result, `attempt[${index}].keyValidation`);
  return result;
}

// Validate + normalize one operator key-hunt attempt into a redacted report
// attempt. Rejects unknown engines/outcomes/capability levels/helper classes,
// attempt kinds that do not belong to the engine's plan, non-hash proof refs,
// and non-logical ids. `succeeded` REQUIRES a keyValidation; every other outcome
// FORBIDS one. The secret scans run over the whole report before write.
export function normalizeAttempt(attempt, index) {
  if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt)) {
    throw new Error(`manifest attempt ${index}: must be an object`);
  }
  const corpusId = requireLogicalId("corpusId", attempt.corpusId, index);
  const engine = requireEnum("engine", attempt.engine, ENGINES, index);
  const capabilityLevel = requireEnum(
    "capabilityLevel",
    attempt.capabilityLevel,
    CAPABILITY_LEVELS,
    index,
  );
  const attemptKind = requireEnum("attemptKind", attempt.attemptKind, ATTEMPT_KINDS, index);
  const helperClass = requireEnum("helperClass", attempt.helperClass, HELPER_CLASSES, index);
  const outcome = requireEnum("outcome", attempt.outcome, OUTCOMES, index);

  // The attempt kind must belong to the engine's plan — unless the attempt is
  // `unsupported`, which may carry the `none` sentinel (no hunting path).
  const planned = plannedAttemptKinds(engine);
  if (attemptKind === "none") {
    if (outcome !== "unsupported") {
      throw new Error(
        `manifest attempt ${index}: attemptKind "none" is only valid for outcome "unsupported"`,
      );
    }
  } else if (!planned.includes(attemptKind)) {
    throw new Error(
      `manifest attempt ${index}: attemptKind ${JSON.stringify(attemptKind)} is not in the ${engine} plan (${planned.join(", ") || "none"})`,
    );
  }

  const helperId = requireLogicalId("helperId", attempt.helperId ?? "none", index);
  const helperVersion =
    attempt.helperVersion === undefined || attempt.helperVersion === null
      ? null
      : String(attempt.helperVersion);

  let keyValidation = null;
  if (outcome === "succeeded") {
    if (attempt.keyValidation === undefined || attempt.keyValidation === null) {
      throw new Error(
        `manifest attempt ${index}: outcome "succeeded" requires a keyValidation (secretRef + proofHash)`,
      );
    }
    keyValidation = normalizeKeyValidation(attempt.keyValidation, index);
  } else if (attempt.keyValidation !== undefined && attempt.keyValidation !== null) {
    throw new Error(
      `manifest attempt ${index}: keyValidation is only valid for outcome "succeeded" (got outcome ${JSON.stringify(outcome)})`,
    );
  }

  return {
    corpusId,
    engine,
    capabilityLevel,
    attemptKind,
    helperClass,
    helperId,
    helperVersion,
    outcome,
    // The report surfaces ONLY the key-profile id + proof hash — never the
    // secret ref (that stays in the private-local key-validation record).
    keyProfileId: keyValidation === null ? null : keyValidation.keyProfileId,
    proofHashes: requireProofHashes(attempt.proofHashes, index),
    commandLines: requireCommandLines(attempt.commandLines, index),
    // Retained for callers that store the validation record; NOT serialized into
    // the redacted report (see buildKeyHuntReport).
    keyValidation,
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
  const attempts = manifest.helperAttempts;
  if (!Array.isArray(attempts)) {
    throw new Error(`${source}: helperAttempts must be an array`);
  }
  return attempts.map((attempt, index) => normalizeAttempt(attempt, index));
}

function emptyEngineOutcomeBins() {
  const bins = {};
  for (const engine of ENGINES) {
    const engineBins = {};
    for (const outcome of OUTCOMES) {
      engineBins[outcome] = 0;
    }
    bins[engine] = engineBins;
  }
  return bins;
}

function emptyOutcomeBins() {
  const bins = {};
  for (const outcome of OUTCOMES) {
    bins[outcome] = 0;
  }
  return bins;
}

function emptyAggregateCounts() {
  return { corpora: 0, attempts: 0 };
}

// Aggregate validated attempts into the safe redacted report. Attempts are
// sorted by (corpusId, engine, attemptKind, outcome) for determinism; the secret
// scan runs last (throws on any leak before the report is returned/written).
export function buildKeyHuntReport(attempts, { command = COMMANDS.manifest } = {}) {
  const sorted = [...attempts].sort((a, b) => {
    if (a.corpusId !== b.corpusId) return a.corpusId < b.corpusId ? -1 : 1;
    if (a.engine !== b.engine) return a.engine < b.engine ? -1 : 1;
    if (a.attemptKind !== b.attemptKind) return a.attemptKind < b.attemptKind ? -1 : 1;
    return a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0;
  });

  const engineOutcomeBins = emptyEngineOutcomeBins();
  const outcomeBins = emptyOutcomeBins();
  const aggregateCounts = emptyAggregateCounts();
  const corpusIds = new Set();
  const toolVersionSet = new Set();
  const commandLineSet = new Set();
  const reportAttempts = [];

  for (const attempt of sorted) {
    corpusIds.add(attempt.corpusId);
    aggregateCounts.attempts += 1;
    engineOutcomeBins[attempt.engine][attempt.outcome] += 1;
    outcomeBins[attempt.outcome] += 1;
    if (attempt.helperVersion !== null) {
      toolVersionSet.add(`${attempt.helperId}@${attempt.helperVersion}`);
    }
    for (const line of attempt.commandLines) {
      commandLineSet.add(line);
    }
    // Strip the internal keyValidation record; surface ONLY the redacted fields.
    reportAttempts.push({
      corpusId: attempt.corpusId,
      engine: attempt.engine,
      capabilityLevel: attempt.capabilityLevel,
      attemptKind: attempt.attemptKind,
      helperClass: attempt.helperClass,
      helperId: attempt.helperId,
      helperVersion: attempt.helperVersion,
      outcome: attempt.outcome,
      keyProfileId: attempt.keyProfileId,
      proofHashes: attempt.proofHashes,
      commandLines: attempt.commandLines,
    });
  }
  aggregateCounts.corpora = corpusIds.size;

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "ok",
    reason: null,
    command,
    generatedBy: GENERATOR_PATH,
    aggregateCounts,
    outcomeBins,
    engineOutcomeBins,
    toolVersions: [...toolVersionSet].sort(),
    commandLines: [...commandLineSet].sort(),
    helperAttempts: reportAttempts,
  };
  assertNoSecrets(report);
  return report;
}

// The deterministic REDACTED no-corpus artifact. Zeroed aggregate counts + empty
// bins, `helperAttempts: []`, checked paths reduced to logical ids, no timestamp.
// Absence of a private corpus is NEVER a failure — it emits this and exits clean.
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
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "skipped",
    reason: "private_inputs_absent",
    command,
    generatedBy: GENERATOR_PATH,
    checkedPaths: logicalIds,
    aggregateCounts: emptyAggregateCounts(),
    outcomeBins: emptyOutcomeBins(),
    engineOutcomeBins: emptyEngineOutcomeBins(),
    toolVersions: [],
    commandLines: [],
    helperAttempts: [],
  };
  assertNoSecrets(artifact);
  return artifact;
}
