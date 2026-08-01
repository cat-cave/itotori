import { assertNoSecrets } from "../kaifuu-private-local-triage/triage.mjs";
import {
  ATTEMPT_KINDS,
  CAPABILITY_LEVELS,
  COMMANDS,
  ENGINES,
  GENERATOR_PATH,
  HELPER_CLASSES,
  MANIFEST_SCHEMA_VERSION,
  OUTCOMES,
  plannedAttemptKinds,
  REPORT_SCHEMA_VERSION,
} from "./key-hunt-contract.mjs";

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
  if (attempts.length === 0) {
    throw new Error("key-hunt report requires at least one selected private input");
  }
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
