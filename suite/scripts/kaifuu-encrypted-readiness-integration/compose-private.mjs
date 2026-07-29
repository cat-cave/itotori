import {
  assertNoSecrets,
  COMMANDS,
  emptyAggregateCounts,
  emptyEngineBins,
  ENGINES,
  GENERATOR_PATH,
  PRIVATE_CORPUS_CHECKED_INPUT,
  PRIVATE_MANIFEST_SCHEMA_VERSION,
  READINESS_BINS,
  SCHEMA_VERSION,
} from "./compose-core.mjs";

const LOGICAL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;

function requireLogicalId(field, value) {
  if (typeof value !== "string" || !LOGICAL_ID_RE.test(value)) {
    throw new Error(
      `${field} must be a lowercase logical id ([a-z0-9._-], no paths), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// --- Private-encrypted-corpus aggregation ------------------------------------

function requireEnum(field, value, allowed, index) {
  if (!allowed.includes(value)) {
    throw new Error(
      `private-corpus entry ${index}: ${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireCount(field, value, index) {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`private-corpus entry ${index}: ${field} must be a non-negative integer`);
  }
  return n;
}

export function normalizePrivateEntry(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`private-corpus entry ${index}: must be an object`);
  }
  const corpusIdRedacted = requireLogicalId(
    `private-corpus entry ${index}: corpusIdRedacted`,
    entry.corpusIdRedacted,
  );
  const engine = requireEnum("engine", entry.engine, ENGINES, index);
  const readinessBin = requireEnum("readinessBin", entry.readinessBin, READINESS_BINS, index);
  const proofHash =
    entry.proofHash === undefined || entry.proofHash === null ? null : entry.proofHash;
  if (proofHash !== null && (typeof proofHash !== "string" || !SHA256_RE.test(proofHash))) {
    throw new Error(
      `private-corpus entry ${index}: proofHash must be a sha256:<64 hex> string, got ${JSON.stringify(proofHash)}`,
    );
  }
  return {
    corpusIdRedacted,
    engine,
    readinessBin,
    proofHash,
    encryptedArchives: requireCount("encryptedArchives", entry.encryptedArchives, index),
    encryptedAssets: requireCount("encryptedAssets", entry.encryptedAssets, index),
    keyProfiles: requireCount("keyProfiles", entry.keyProfiles, index),
    helperProfiles: requireCount("helperProfiles", entry.helperProfiles, index),
  };
}

export function normalizePrivateManifest(manifest, source = "private-corpus-manifest") {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${source}: manifest must be an object`);
  }
  if (manifest.schemaVersion !== PRIVATE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `${source}: schemaVersion must be ${PRIVATE_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(manifest.schemaVersion)}`,
    );
  }
  if (!Array.isArray(manifest.corpora)) {
    throw new Error(`${source}: corpora must be an array`);
  }
  return manifest.corpora.map((entry, index) => normalizePrivateEntry(entry, index));
}

// --- Artifact builders --------------------------------------------------------

function statusFor(prerequisiteFindings, privateSkipped) {
  if (prerequisiteFindings.length > 0) {
    return "failed";
  }
  return privateSkipped ? "skipped" : "ok";
}

// The composed alpha-readiness evidence artifact when a PRIVATE encrypted
// corpus IS configured. Aggregates the operator's already-redacted entries into
// per-engine readiness bins; carries the public prerequisite composition too.
export function buildComposedReport(entries, { composed }) {
  const sorted = [...entries].sort((a, b) => {
    if (a.corpusIdRedacted !== b.corpusIdRedacted) {
      return a.corpusIdRedacted < b.corpusIdRedacted ? -1 : 1;
    }
    return a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0;
  });

  const engineReadinessBins = emptyEngineBins();
  const aggregateCounts = emptyAggregateCounts();
  const corpusIds = new Set();
  for (const entry of sorted) {
    corpusIds.add(entry.corpusIdRedacted);
    aggregateCounts.entries += 1;
    aggregateCounts.encryptedArchives += entry.encryptedArchives;
    aggregateCounts.encryptedAssets += entry.encryptedAssets;
    aggregateCounts.keyProfiles += entry.keyProfiles;
    aggregateCounts.helperProfiles += entry.helperProfiles;
    engineReadinessBins[entry.engine][entry.readinessBin] += 1;
  }
  aggregateCounts.corpora = corpusIds.size;

  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    status: statusFor(composed.findings, false),
    reason: null,
    command: COMMANDS.privateManifest,
    generatedBy: GENERATOR_PATH,
    composes: composed.composes,
    composedEvidenceHash: composed.composedEvidenceHash,
    prerequisiteFindings: composed.findings,
    corpusIds: [...corpusIds].sort(),
    aggregateCounts,
    engineReadinessBins,
    entries: sorted,
  };
  assertNoSecrets(artifact);
  return artifact;
}

// The deterministic REDACTED no-corpus artifact. Zeroed aggregate counts +
// empty per-engine bins, corpus ids empty, checked inputs reduced to a logical
// id, no timestamp, no local paths. Still NAMES + aggregates the public
// prerequisite composition (proving the composed path is intact).
export function buildNoCorpusArtifact({ composed }) {
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    status: statusFor(composed.findings, true),
    reason: "private_inputs_absent",
    command: COMMANDS.noCorpus,
    generatedBy: GENERATOR_PATH,
    composes: composed.composes,
    composedEvidenceHash: composed.composedEvidenceHash,
    prerequisiteFindings: composed.findings,
    checkedInputs: [PRIVATE_CORPUS_CHECKED_INPUT],
    corpusIds: [],
    aggregateCounts: emptyAggregateCounts(),
    engineReadinessBins: emptyEngineBins(),
    entries: [],
  };
  assertNoSecrets(artifact);
  return artifact;
}
