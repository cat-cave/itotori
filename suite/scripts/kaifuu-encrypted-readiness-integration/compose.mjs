#!/usr/bin/env node
/*
 * KAIFUU-042 — Alpha encrypted-readiness evidence integration core.
 *
 * Pure, deterministic core for the `kaifuu:encrypted-readiness` workflow. It
 * COMPOSES the already-generated encrypted-readiness EVIDENCE of the
 * prerequisite slices (KAIFUU-103 packed-engine readiness surface +
 * KAIFUU-104 alpha-encrypted readiness evidence) into an alpha-readiness
 * composed-evidence artifact, and produces a deterministic REDACTED no-corpus
 * artifact when no PRIVATE encrypted corpus is configured.
 *
 * IT DOES NOT RE-OWN PREREQUISITE SLICES. It never re-derives readiness
 * postures, never re-runs an adapter, and never re-implements the KAIFUU-104
 * generator. It reads the committed prerequisite manifest, aggregates the
 * committed prerequisite proof artifacts by content HASH, and cross-checks that
 * each artifact still declares the source node the manifest names. Any missing,
 * tampered, mismatched, or UNSUPPORTED prerequisite is a structured SEMANTIC
 * DIAGNOSTIC — never a hidden success.
 *
 * COPYRIGHT / STRICT-PROOF LAW (this module is the enforcement point):
 *   - The composer reads ONLY the committed prerequisite manifest + the public
 *     synthetic fixture artifacts it names, plus (optionally) an operator's
 *     ALREADY-REDACTED private-encrypted-corpus manifest. It never reads raw
 *     keys, raw encrypted bytes, decrypted text, or retail assets, and never
 *     shells out.
 *   - Every value that reaches an emitted artifact is scanned for secrets
 *     (absolute local paths, raw key/hex material, `local-secret:` refs, PEM
 *     blocks). A leak throws BEFORE anything is written.
 *   - Output is byte-deterministic (sorted keys, no timestamps, no absolute
 *     paths), so the committed examples and the no-corpus artifact are stable.
 */
"use strict";

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "itotori.kaifuu-encrypted-readiness-integration.v0.1";
export const PRIVATE_MANIFEST_SCHEMA_VERSION =
  "itotori.kaifuu-encrypted-readiness-private-corpus-manifest.v0.1";
export const PREREQUISITES_MANIFEST_SCHEMA_VERSION =
  "itotori.kaifuu-encrypted-readiness-prerequisites.v0.1";
export const GENERATOR_PATH = "suite/scripts/kaifuu-encrypted-readiness-integration/run.mjs";

// Canonical redacted command strings. The real argv is NEVER recorded because
// it can carry local absolute paths; the mode maps to a fixed logical command.
export const COMMANDS = {
  noCorpus: "vp run kaifuu:encrypted-readiness -- --no-corpus",
  privateManifest:
    "vp run kaifuu:encrypted-readiness -- --private-manifest <private-encrypted-corpus-manifest>",
};

// The redacted logical id used for the no-corpus artifact's checked inputs — a
// logical id, never a local path.
export const PRIVATE_CORPUS_CHECKED_INPUT = "private-encrypted-corpus-root";

// Packed / encrypted engine families the encrypted-readiness lane tracks. Order
// is fixed so per-engine bin objects serialize deterministically. These mirror
// the private-local triage engine set so the readiness ecosystem stays uniform.
export const ENGINES = [
  "rpg-maker-mv",
  "rpg-maker-mz",
  "kirikiri-xp3",
  "siglus",
  "wolf",
  "rgss3-vx-ace",
];

export const READINESS_BINS = [
  "ready",
  "helper_required",
  "key_missing",
  "unsupported_variant",
  "detector_unknown",
  "blocked",
];

// Prerequisite adapter engine families are declared in the packed-engine schema
// vocabulary (`engineFamily` field of the KAIFUU-103 profile fixtures). Any
// prerequisite whose engine family is NOT recognized is a semantic diagnostic.
export const SUPPORTED_PREREQUISITE_ENGINE_FAMILIES = [
  "kirikiri_xp3",
  "siglus",
  "rpg_maker_mv_mz_media",
];

// Prerequisite artifact kinds the composer knows how to aggregate.
export const PREREQUISITE_ARTIFACT_KINDS = ["readiness_profile", "readiness_patch_evidence"];

const AGGREGATE_COUNT_KEYS = [
  "corpora",
  "entries",
  "encryptedArchives",
  "encryptedAssets",
  "keyProfiles",
  "helperProfiles",
];

const LOGICAL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;

// --- Secret scanners (identical policy to the private-local triage slices) ---
const ABSOLUTE_PATH_RE =
  /(?:^|[\s"'=(:,[])(?:\/(?:home|Users|root|mnt|scratch|media|opt|srv|var|Volumes)\/|[A-Za-z]:[\\/])/u;
const LOCAL_SECRET_RE = /local-secret:/iu;
const PEM_RE = /-----BEGIN[ A-Z]*(?:PRIVATE KEY|PGP)/u;
const HEX_RUN_RE = /[0-9a-fA-F]{24,}/gu;

function isAllowedHexRun(text, matchIndex) {
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
export function stableStringify(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

// Canonical hash of a parsed JSON value: sha256 over its sorted-key, no-trailing
// -whitespace serialization. Formatter-independent (parses first), so a
// reformat of a prerequisite fixture never changes its aggregated proof hash —
// only a real content change does (the boundary regression signal).
export function canonicalHash(parsed) {
  const canonical = JSON.stringify(sortValue(parsed));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
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
  const counts = {};
  for (const key of AGGREGATE_COUNT_KEYS) {
    counts[key] = 0;
  }
  return counts;
}

function finding(code, field, message) {
  return { code, field, message };
}

// --- Prerequisite composition -------------------------------------------------

// Compose the prerequisite manifest into the `composes` evidence block by
// aggregating the committed proof artifacts by content HASH. `readArtifact`
// maps a manifest artifact path to its parsed JSON (or throws / returns null
// when unreadable). Never re-derives readiness; only reflects + hashes the
// committed prerequisite proofs. Returns { composes, composedEvidenceHash,
// findings }.
export function composePrerequisites(manifest, readArtifact) {
  const findings = [];

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("prerequisites manifest must be an object");
  }
  if (manifest.schemaVersion !== PREREQUISITES_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `prerequisites manifest schemaVersion must be ${PREREQUISITES_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(manifest.schemaVersion)}`,
    );
  }

  const surfaces = normalizeNamedList(manifest.surfaces, "surfaces", ["id", "sourceNodeId"]);
  const adapters = normalizeNamedList(manifest.adapters, "adapters", ["id", "engineFamily"]);
  const commandEvidence = normalizeNamedList(manifest.commandEvidence, "commandEvidence", [
    "id",
    "command",
  ]);

  // Every declared adapter engine family MUST be supported — an unsupported
  // adapter is a semantic diagnostic, never a silent success.
  for (const adapter of adapters) {
    if (!SUPPORTED_PREREQUISITE_ENGINE_FAMILIES.includes(adapter.engineFamily)) {
      findings.push(
        finding(
          "kaifuu.encrypted_readiness.unsupported_adapter",
          "adapters",
          `adapter ${adapter.id} declares unsupported engine family ${adapter.engineFamily}`,
        ),
      );
    }
  }

  const artifactList = Array.isArray(manifest.artifacts) ? manifest.artifacts : null;
  if (artifactList === null) {
    throw new Error("prerequisites manifest: artifacts must be an array");
  }

  const artifacts = [];
  for (const declared of artifactList) {
    const artifactId = requireLogicalId("artifacts[].id", declared?.id);
    const kind = declared?.kind;
    if (!PREREQUISITE_ARTIFACT_KINDS.includes(kind)) {
      findings.push(
        finding(
          "kaifuu.encrypted_readiness.unsupported_artifact_kind",
          "artifacts",
          `prerequisite ${artifactId} declares unsupported kind ${JSON.stringify(kind)}`,
        ),
      );
      continue;
    }
    const declaredSourceNodeId = declared?.sourceNodeId;

    let parsed;
    try {
      parsed = readArtifact(declared.path);
    } catch {
      parsed = null;
    }
    if (parsed === null || parsed === undefined) {
      findings.push(
        finding(
          "kaifuu.encrypted_readiness.prerequisite_missing",
          "artifacts",
          `prerequisite proof ${artifactId} could not be read`,
        ),
      );
      continue;
    }

    // Cross-check: the committed artifact must still declare the source node the
    // manifest names (proves we aggregated the RIGHT prerequisite proof).
    if (parsed.sourceNodeId !== declaredSourceNodeId) {
      findings.push(
        finding(
          "kaifuu.encrypted_readiness.source_node_mismatch",
          "artifacts",
          `prerequisite ${artifactId} declares sourceNodeId ${JSON.stringify(parsed.sourceNodeId)} but manifest names ${JSON.stringify(declaredSourceNodeId)}`,
        ),
      );
      continue;
    }

    const engineFamily =
      kind === "readiness_profile" && typeof parsed.engineFamily === "string"
        ? parsed.engineFamily
        : null;
    if (engineFamily !== null && !SUPPORTED_PREREQUISITE_ENGINE_FAMILIES.includes(engineFamily)) {
      findings.push(
        finding(
          "kaifuu.encrypted_readiness.unsupported_prerequisite_engine",
          "artifacts",
          `prerequisite ${artifactId} declares unsupported engine family ${engineFamily}`,
        ),
      );
      continue;
    }

    artifacts.push({
      artifactId,
      kind,
      sourceNodeId: declaredSourceNodeId,
      engineFamily,
      contentHash: canonicalHash(parsed),
    });
  }

  artifacts.sort((a, b) =>
    a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0,
  );

  const composes = {
    surfaces,
    adapters,
    commandEvidence,
    artifacts,
    prerequisiteCounts: {
      surfaces: surfaces.length,
      adapters: adapters.length,
      commandEvidence: commandEvidence.length,
      readinessProfiles: artifacts.filter((a) => a.kind === "readiness_profile").length,
      patchEvidence: artifacts.filter((a) => a.kind === "readiness_patch_evidence").length,
      coveredSourceNodes: [...new Set(artifacts.map((a) => a.sourceNodeId))].sort().length,
      coveredEngineFamilies: [
        ...new Set(artifacts.map((a) => a.engineFamily).filter((f) => f !== null)),
      ].sort().length,
    },
  };

  // The composed proof: a hash over the (artifactId, contentHash) pairs — the
  // single value that changes iff a prerequisite proof changes.
  const composedEvidenceHash = canonicalHash(
    artifacts.map((a) => ({ artifactId: a.artifactId, contentHash: a.contentHash })),
  );

  return { composes, composedEvidenceHash, findings };
}

function normalizeNamedList(raw, field, requiredKeys) {
  if (!Array.isArray(raw)) {
    throw new Error(`prerequisites manifest: ${field} must be an array`);
  }
  const out = raw.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`prerequisites manifest: ${field} entries must be objects`);
    }
    const normalized = {};
    for (const key of requiredKeys) {
      if (typeof item[key] !== "string" || item[key].length === 0) {
        throw new Error(`prerequisites manifest: ${field} entry missing string ${key}`);
      }
      normalized[key] = item[key];
    }
    return normalized;
  });
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

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
