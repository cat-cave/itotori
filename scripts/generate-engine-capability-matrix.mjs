#!/usr/bin/env node
// ALPHA-004: Alpha engine capability matrix generator.
//
// Generates a typed engine capability matrix that DERIVES breadth/readiness
// evidence from real inputs — adapter registry / claimed-support tuples,
// detector/profile fixture outputs, readiness profiles, and validation-run
// artifacts — instead of hand-written support claims. Every matrix cell
// traces to one of `INPUT_SOURCES`; a missing input artifact fails with a
// structured diagnostic naming it, never a silent blank cell.
//
// PROJECT LAW: evidence-first, no hand-waved claims, no optionality columns.
// Positive extraction/patch adapters and readiness-only (packed/encrypted)
// profiles are mechanically distinguished from the derived level statuses +
// the source kind, never hand-set. RenPy is NOT an alpha Japanese-opportunity
// driver; it is recorded as an explicit exclusion. KiriKiri breadth includes
// XP3 detector/profile readiness plus a separately bounded plain-container
// production writer proof; it never implies standalone script support.
//
// Usage:
//   node scripts/generate-engine-capability-matrix.mjs           # write artifacts
//   node scripts/generate-engine-capability-matrix.mjs --check   # fail on drift
//
// `--check` regenerates from inputs and fails (exit 1) if the committed JSON or
// markdown artifact has drifted — this is how stale or manually edited
// capability entries fail validation.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

export const MATRIX_SCHEMA_VERSION = "itotori.engine_capability_matrix.v0.1";
export const GENERATOR_PATH = "scripts/generate-engine-capability-matrix.mjs";

export const CAPABILITY_LEVELS = ["identify", "inventory", "extract", "patch", "helper", "runtime"];
export const LEVEL_STATUSES = ["supported", "partial", "unsupported", "not_applicable", "unknown"];
export const EVIDENCE_POSTURES = ["positive_adapter", "readiness_only"];

// Input categories the acceptance requires the matrix to consume. Matched only
// against evidence.category — never against evidence.kind (distinct namespaces).
export const REQUIRED_INPUT_CATEGORIES = [
  "fixture_output",
  "readiness_profile",
  "claimed_support_tuples",
  "validation_artifact",
];

// Input kinds the acceptance requires at least one row to consume. Matched only
// against evidence.kind — never against evidence.category.
export const REQUIRED_INPUT_KINDS = ["adapter_registry"];

export const OUTPUT_JSON_PATH =
  "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json";
export const OUTPUT_MD_PATH = "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.md";

// Input source registry. Each entry is a REAL artifact already in the repo (or
// a committed readiness fixture). `category` ties it to one of the acceptance
// input categories; `kind` drives mechanical posture classification.
export const INPUT_SOURCES = [
  {
    id: "reallive-detector-capabilities",
    path: "fixtures/public/reallive-detector/capabilities.json",
    category: "claimed_support_tuples",
    kind: "adapter_registry",
    role: "adapter registry mirror / per-capability claimed-support tuples",
  },
  {
    id: "xp3-plain-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/xp3-plain-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "KiriKiri XP3 plain-container detector profile",
  },
  {
    id: "xp3-compressed-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/xp3-compressed-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "KiriKiri XP3 compressed-container detector profile",
  },
  {
    id: "xp3-encrypted-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/xp3-encrypted-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "KiriKiri XP3 encrypted-container (crypt smoke) detector profile",
  },
  {
    id: "siglus-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "Siglus Scene.pck/Gameexe.dat detector profile",
  },
  {
    id: "siglus-known-key-parser-boundary-smoke",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json",
    category: "validation_artifact",
    kind: "validation_artifact",
    role: "Siglus known-key Scene/Gameexe parser-boundary smoke run",
  },
  {
    id: "rpg-maker-mv-mz-key-validation",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
    category: "validation_artifact",
    kind: "validation_artifact",
    role: "RPG Maker MV/MZ encrypted-media key validation run",
  },
  {
    id: "rpg-maker-mv-mz-readiness-merge",
    path: "fixtures/public/catalog-capability-evidence-mv-mz-merge/expected/readiness-merge-v0.1.json",
    category: "readiness_profile",
    kind: "readiness_profile",
    role: "RPG Maker MV/MZ readiness merge matrix",
  },
  {
    id: "production-extract-patch-proofs",
    path: "fixtures/kaifuu/production-capabilities/extract-patch-proofs.v0.1.json",
    category: "claimed_support_tuples",
    kind: "production_capability_tuple",
    role: "production extract/patch tuples bound to strict real-byte proof lanes",
  },
  {
    id: "reallive-patchback-produce",
    path: "fixtures/public/itotori-patchback-produce/expected/reallive-patchback-produce-capability-v0.1.json",
    category: "validation_artifact",
    kind: "validation_artifact",
    role: "RealLive accepted-output-native patched-build production (Studio download + itotori patch produce)",
  },
  {
    id: "rpg-maker-mv-mz-encrypted-suffixes-detection",
    path: "fixtures/public/kaifuu-rpg-maker-encrypted-suffixes/expected/detection-report-v0.1.json",
    category: "fixture_output",
    kind: "detection_report",
    role: "RPG Maker MV/MZ full encrypted-suffix surface detection run",
  },
  {
    id: "encrypted-matrix-detection-summary",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/detection-summary-v0.1.json",
    category: "readiness_profile",
    kind: "detection_summary",
    role: "Packed/encrypted engine-family detection summary (Wolf, BGI, ...)",
  },
  {
    id: "tyranoscript-null-key-readiness",
    path: "fixtures/kaifuu/tyranoscript/null-key-readiness-profile.json",
    category: "readiness_profile",
    kind: "detector_profile",
    role: "TyranoScript plaintext null-key readiness profile",
  },
];

// Engine families that are deliberately NOT presented as alpha Japanese
// localization-opportunity drivers. Recorded as explicit, evidence-anchored
// exclusions so the matrix can never silently over-weight them.
export const NON_DRIVER_EXCLUSIONS = [
  {
    engineFamily: "renpy",
    reason:
      "Ren'Py is not an alpha Japanese-localization opportunity driver: it is over-represented in catalog data by Western/English doujin output and already has high existing translation coverage. Per docs/research/japanese-engine-opportunity-analysis.md it is the easy, already-done reference engine, not a greenfield Japanese driver. It surfaces only as a packed-input detector row and is excluded from the capability breadth.",
    evidenceSourceIds: ["rpg-maker-mv-mz-encrypted-suffixes-detection"],
  },
  {
    engineFamily: "unknown",
    reason:
      "The unknown-archive-variant row is a non-engine triage bucket, not an engine family, and carries no capability claim.",
    evidenceSourceIds: ["encrypted-matrix-detection-summary"],
  },
];

export class MatrixGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MatrixGenerationError";
  }
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

export function loadInputs(root = repoRoot) {
  const inputs = {};
  for (const source of INPUT_SOURCES) {
    const absolute = resolve(root, source.path);
    let raw;
    try {
      raw = readFileSync(absolute, "utf8");
    } catch (error) {
      throw new MatrixGenerationError(
        `missing input artifact "${source.id}" at ${source.path}: ${
          error?.code ?? error?.message ?? "unreadable"
        }`,
      );
    }
    try {
      inputs[source.id] = JSON.parse(raw);
    } catch (error) {
      throw new MatrixGenerationError(
        `input artifact "${source.id}" at ${source.path} is not valid JSON: ${error?.message}`,
      );
    }
  }
  return inputs;
}

function requireInput(inputs, sourceId) {
  const value = inputs[sourceId];
  if (value === undefined) {
    throw new MatrixGenerationError(`required input "${sourceId}" was not loaded`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Capability-status → level-status mapping (mechanical, no hand-set cells)
// ---------------------------------------------------------------------------

function levelStatusFromCapabilityStatus(status) {
  switch (status) {
    case "supported":
      return "supported";
    case "limited":
    case "requires_user_input":
      return "partial";
    case "unsupported":
      return "unsupported";
    default:
      return "unknown";
  }
}

function worst(a, b) {
  const rank = { supported: 3, partial: 2, not_applicable: 1, unsupported: 0, unknown: -1 };
  return rank[a] <= rank[b] ? a : b;
}

function capabilityStatusMap(capabilities) {
  const map = {};
  for (const entry of capabilities ?? []) {
    map[entry.capability] = entry.status;
  }
  return map;
}

function cell(status, derivedFrom, note) {
  if (!LEVEL_STATUSES.includes(status)) {
    throw new MatrixGenerationError(`invalid level status "${status}" for ${derivedFrom}`);
  }
  const value = { status, derivedFrom };
  if (note) {
    value.note = note;
  }
  return value;
}

function helperCell(keyProfileStatus, crypto, signals, sourceId) {
  if (crypto === "null_key") {
    return cell(
      "not_applicable",
      `${sourceId}#crypto`,
      "plaintext null-key surface; no key material or helper is required",
    );
  }
  if (keyProfileStatus === "supported") {
    return cell("supported", `${sourceId}#capability:key_profile`);
  }
  if (keyProfileStatus === "requires_user_input" || (signals ?? []).includes("helper_required")) {
    return cell(
      "partial",
      `${sourceId}#capability:key_profile`,
      "key/helper requirement is named but not resolved by this readiness evidence",
    );
  }
  if (keyProfileStatus === "unsupported") {
    return cell(
      "unsupported",
      `${sourceId}#capability:key_profile`,
      "no key/helper handling is claimed",
    );
  }
  return cell("unknown", `${sourceId}#capability:key_profile`);
}

// Builds the six-level cell set from a detector-profile / claimed-support
// capabilities array.
function levelsFromCapabilities(capabilities, { sourceId, crypto, signals }) {
  const status = capabilityStatusMap(capabilities);
  const inventory = worst(
    levelStatusFromCapabilityStatus(status.asset_inventory ?? "unsupported"),
    levelStatusFromCapabilityStatus(status.asset_listing ?? "unsupported"),
  );
  const patch = worst(
    levelStatusFromCapabilityStatus(status.patching ?? "unsupported"),
    status.patch_back === undefined
      ? "supported"
      : levelStatusFromCapabilityStatus(status.patch_back),
  );
  return {
    identify: cell(
      levelStatusFromCapabilityStatus(status.detection ?? "unsupported"),
      `${sourceId}#capability:detection`,
    ),
    inventory: cell(inventory, `${sourceId}#capability:asset_inventory+asset_listing`),
    extract: cell(
      levelStatusFromCapabilityStatus(status.extraction ?? "unsupported"),
      `${sourceId}#capability:extraction`,
    ),
    patch: cell(patch, `${sourceId}#capability:patching+patch_back`),
    helper: helperCell(status.key_profile, crypto, signals, sourceId),
    runtime: cell(
      levelStatusFromCapabilityStatus(status.runtime_vm ?? "unsupported"),
      `${sourceId}#capability:runtime_vm`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Mechanical posture classification
// ---------------------------------------------------------------------------

// A row is a `positive_adapter` ONLY when it extracts or patches (supported or
// partial) AND that evidence comes from an adapter registry / claimed-support
// tuple / production tuple whose strict real-byte proof is validated by its row
// builder. Detector profiles, readiness profiles, detection summaries, and
// validation smokes can never become positive adapters here, even if a smoke
// parsed some text — they stay `readiness_only`. This is the mechanical
// distinction the acceptance demands; it is never hand-set.
function classifyPosture(levels, sourceKind) {
  const extractsOrPatches =
    ["supported", "partial"].includes(levels.extract.status) ||
    ["supported", "partial"].includes(levels.patch.status);
  const fromAdapterRegistry = [
    "adapter_registry",
    "claimed_support_tuples",
    "production_capability_tuple",
  ].includes(sourceKind);
  return extractsOrPatches && fromAdapterRegistry ? "positive_adapter" : "readiness_only";
}

function rowLimitations(levels) {
  const limitations = [];
  for (const level of CAPABILITY_LEVELS) {
    const c = levels[level];
    if (c.note && (c.status === "unsupported" || c.status === "partial")) {
      limitations.push(`${level}: ${c.note}`);
    }
  }
  return limitations;
}

function makeRow({
  rowId,
  engineFamily,
  scenario,
  adapterId,
  levels,
  sourceKind,
  evidenceSourceIds,
  extraLimitations,
}) {
  for (const level of CAPABILITY_LEVELS) {
    if (levels[level] === undefined) {
      throw new MatrixGenerationError(`row ${rowId} missing level ${level}`);
    }
  }
  return {
    rowId,
    engineFamily,
    scenario,
    adapterId: adapterId ?? null,
    evidencePosture: classifyPosture(levels, sourceKind),
    levels,
    evidence: evidenceSourceIds.map((id) => {
      const source = INPUT_SOURCES.find((s) => s.id === id);
      if (!source) {
        throw new MatrixGenerationError(`row ${rowId} cites unknown evidence source ${id}`);
      }
      return { sourceId: id, category: source.category, kind: source.kind };
    }),
    limitations: [...rowLimitations(levels), ...(extraLimitations ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Per-engine row builders
// ---------------------------------------------------------------------------

function adapterReports(capabilitiesDoc, adapterId) {
  const entry = (capabilitiesDoc ?? []).find((a) => a.adapterId === adapterId);
  if (!entry) {
    throw new MatrixGenerationError(
      `adapter ${adapterId} not found in claimed-support tuples input`,
    );
  }
  return entry.reports ?? [];
}

function buildFixturePositiveAdapterRow(inputs) {
  const capabilitiesDoc = requireInput(inputs, "reallive-detector-capabilities");
  const reports = adapterReports(capabilitiesDoc, "kaifuu.fixture");
  const levels = levelsFromCapabilities(reports, {
    sourceId: "reallive-detector-capabilities",
    crypto: "null_key",
  });
  return makeRow({
    rowId: "synthetic-fixture-plaintext-identity",
    engineFamily: "synthetic_fixture",
    scenario: "plaintext-identity-extract-patch",
    adapterId: "kaifuu.fixture",
    levels,
    sourceKind: "claimed_support_tuples",
    evidenceSourceIds: ["reallive-detector-capabilities"],
  });
}

// Softpal is a first-class positive EngineAdapter (unlike the RealLive registry
// adapter, which is detector-only): `kaifuu-cli extract/patch/verify --engine
// softpal` drive the real kaifuu-softpal PAC + TEXT.DAT + SCRIPT.SRC reader over
// real bytes. The row is derived MECHANICALLY from the adapter's real
// claimed-support tuples (`kaifuu-cli capabilities` -> kaifuu.softpal), never
// hand-set: extraction Supported -> extract supported; patching/patch_back
// Limited -> patch partial. Softpal resolves TEXT.DAT (de)cryption internally
// (crypto_access + encrypted_input Supported, NO key_profile capability), so the
// helper rung is not_applicable — again derived from the real crypto tuples.
function buildSoftpalRow(inputs) {
  const capabilitiesDoc = requireInput(inputs, "reallive-detector-capabilities");
  const reports = adapterReports(capabilitiesDoc, "kaifuu.softpal");
  const levels = levelsFromCapabilities(reports, {
    sourceId: "reallive-detector-capabilities",
  });
  const status = capabilityStatusMap(reports);
  if (
    status.crypto_access === "supported" &&
    status.encrypted_input === "supported" &&
    status.key_profile === undefined
  ) {
    levels.helper = cell(
      "not_applicable",
      "reallive-detector-capabilities#capability:crypto_access+encrypted_input",
      "TEXT.DAT (de)cryption is resolved internally by the adapter; no user-provided key or helper is required",
    );
  }
  return makeRow({
    rowId: "softpal-script-src-text-dat-extract-patch",
    engineFamily: "softpal",
    scenario: "script-src-text-dat-extract-patch",
    adapterId: "kaifuu.softpal",
    levels,
    sourceKind: "claimed_support_tuples",
    evidenceSourceIds: ["reallive-detector-capabilities"],
  });
}

function buildRealliveReadinessRow(inputs) {
  const capabilitiesDoc = requireInput(inputs, "reallive-detector-capabilities");
  const reports = adapterReports(capabilitiesDoc, "kaifuu.reallive");
  const levels = levelsFromCapabilities(reports, {
    sourceId: "reallive-detector-capabilities",
  });
  return makeRow({
    rowId: "reallive-seen-txt-detector-readiness",
    engineFamily: "reallive",
    scenario: "detector-profile-readiness",
    adapterId: "kaifuu.reallive",
    levels,
    sourceKind: "claimed_support_tuples",
    evidenceSourceIds: ["reallive-detector-capabilities"],
  });
}

// The accepted-output-native patched-build producer is intentionally distinct
// from the `kaifuu.reallive` detector row above. Its executable surface is
// `produceNativePatchbackBuild` (called by both POST /api/patchback/produce and
// `itotori patch produce`) which invokes the same real `kaifuu patch` seam.
// The evidence is an env-gated, two-corpus real-byte oracle, not an adapter
// registry tuple, so this remains a readiness/validation row with a PARTIAL
// patch claim rather than promoting the detector adapter to `positive_adapter`.
function buildReallivePatchbackProduceRow(inputs) {
  const v = requireInput(inputs, "reallive-patchback-produce");
  const sourceId = "reallive-patchback-produce";
  const exactArtifactKeys = ["patchApply", "patchExport", "patchTarget", "translatedBridge"];
  const passed =
    v.status === "passed" &&
    v.outcome === "accepted_output_native_patched_build" &&
    v.capabilityId === "itotori.patchback-produce.v1" &&
    v.nativeSeam === "produceNativePatchbackBuild" &&
    v.cliCommand === "itotori patch produce" &&
    v.deliverySurface === "POST /api/patchback/produce" &&
    v.engineFamily === "reallive" &&
    v.realBytes?.strictLane === "just ci-real-bytes" &&
    v.realBytes?.minimumDistinctGames >= 2 &&
    ["ITOTORI_REAL_GAME_ROOT", "ITOTORI_REAL_GAME_ROOT_2"].every((name) =>
      (v.realBytes?.corpusEnvironment ?? []).includes(name),
    ) &&
    JSON.stringify([...(v.artifactKeys ?? [])].sort()) === JSON.stringify(exactArtifactKeys);
  const levels = {
    identify: cell(
      passed ? "supported" : "unsupported",
      `${sourceId}#status`,
      "the accepted-output producer binds one validated RealLive bridge and fact snapshot before patching",
    ),
    inventory: cell(
      "not_applicable",
      `${sourceId}#outcome`,
      "patched-build production consumes an already extracted bridge; it is not a separate inventory surface",
    ),
    extract: cell(
      passed ? "partial" : "unsupported",
      `${sourceId}#outcome`,
      "the two-corpus proof derives the source bridge through real Kaifuu extraction, but production starts from that accepted-output input",
    ),
    patch: cell(
      passed ? "partial" : "unsupported",
      `${sourceId}#nativeSeam`,
      "produceNativePatchbackBuild drives the real kaifuu patch seam and records a hash-bound playable build; validation evidence is not an EngineAdapter registry claim",
    ),
    helper: cell(
      "not_applicable",
      `${sourceId}#realBytes`,
      "the demonstrated RealLive plaintext produce path uses no key helper",
    ),
    runtime: cell(
      "unsupported",
      `${sourceId}#supportBoundary`,
      "produce proves patched-build creation and delivery, not a runtime replay claim",
    ),
  };
  return makeRow({
    rowId: "reallive-accepted-output-patchback-produce",
    engineFamily: "reallive",
    scenario: "accepted-output-patched-build-produce",
    adapterId: v.adapterId ?? "kaifuu.reallive",
    levels,
    sourceKind: "validation_artifact",
    evidenceSourceIds: [sourceId],
    extraLimitations: [
      "patchback-produce is gate-enforced only while the strict two-corpus real-byte oracle and both production surfaces remain declared by its capability artifact",
    ],
  });
}

function buildXp3Row(inputs, sourceId, scenario) {
  const profile = requireInput(inputs, sourceId);
  const variant = (profile.archiveParameters ?? []).find((p) => p.kind === "variant")?.value;
  const crypto = variant === "encrypted" ? "key_profile" : undefined;
  const levels = levelsFromCapabilities(profile.capabilities, { sourceId, crypto });
  return makeRow({
    rowId: `kirikiri-xp3-${variant}-${scenario}`,
    engineFamily: "kiri_kiri_xp3",
    scenario: `xp3-${variant}-${scenario}`,
    adapterId: profile.engine?.adapterId ?? "kaifuu.kirikiri_xp3",
    levels,
    sourceKind: "detector_profile",
    evidenceSourceIds: [sourceId, "reallive-detector-capabilities"],
    extraLimitations: [
      "KiriKiri breadth is XP3 container/readiness evidence only; plaintext .ks/.tjs is not claimed as standalone extract/patch support",
    ],
  });
}

const PRODUCTION_PROOF_SOURCE_ID = "production-extract-patch-proofs";
const PRODUCTION_PROOF_SCHEMA = "kaifuu.production_extract_patch_proofs.v0.1";

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

/** Load one production claim and reject structural or capability-boundary drift
 * with the matrix generator's typed error. A claim may record a failed strict
 * run (which mechanically demotes its row), but it may not silently change the
 * contract that the row is intended to prove. */
function requireProductionProofClaim(inputs, claimId, expected) {
  const document = requireInput(inputs, PRODUCTION_PROOF_SOURCE_ID);
  if (document.schemaVersion !== PRODUCTION_PROOF_SCHEMA || !Array.isArray(document.claims)) {
    throw new MatrixGenerationError(
      `${PRODUCTION_PROOF_SOURCE_ID} must declare ${PRODUCTION_PROOF_SCHEMA} claims`,
    );
  }
  const claim = document.claims.find((candidate) => candidate?.claimId === claimId);
  if (!claim || typeof claim !== "object") {
    throw new MatrixGenerationError(`${PRODUCTION_PROOF_SOURCE_ID} is missing claim ${claimId}`);
  }
  const realBytes = claim.realBytes;
  if (
    claim.engineFamily !== expected.engineFamily ||
    claim.adapterId !== expected.adapterId ||
    claim.scenario !== expected.scenario ||
    claim.capabilityTuple?.kind !== expected.tupleKind ||
    !realBytes ||
    typeof realBytes !== "object" ||
    !["passed", "failed"].includes(realBytes.status) ||
    realBytes.strictLane !== "just ci-real-bytes" ||
    typeof realBytes.minimumDistinctCorpora !== "number" ||
    !Array.isArray(realBytes.corpusEnvironment) ||
    typeof claim.productionPath !== "object"
  ) {
    throw new MatrixGenerationError(
      `${PRODUCTION_PROOF_SOURCE_ID} claim ${claimId} has an invalid production-proof shape`,
    );
  }
  if (!sameStringSet(realBytes.corpusEnvironment, expected.corpusEnvironment)) {
    throw new MatrixGenerationError(
      `${PRODUCTION_PROOF_SOURCE_ID} claim ${claimId} names an unexpected real-byte corpus contract`,
    );
  }
  for (const [field, value] of Object.entries(expected.productionPath)) {
    if (claim.productionPath[field] !== value) {
      throw new MatrixGenerationError(
        `${PRODUCTION_PROOF_SOURCE_ID} claim ${claimId} has an unexpected production path for ${field}`,
      );
    }
  }
  return claim;
}

function productionProofPassed(claim, expected) {
  return (
    claim.realBytes.status === "passed" &&
    claim.realBytes.minimumDistinctCorpora >= expected.minimumDistinctCorpora &&
    claim.realBytes.outcome === expected.outcome
  );
}

function levelsFromProductionProof(passed, sourceId, helperNote, runtimeNote) {
  return {
    identify: cell(passed ? "supported" : "unsupported", `${sourceId}#realBytes.status`),
    inventory: cell(passed ? "supported" : "unsupported", `${sourceId}#capabilityTuple`),
    extract: cell(passed ? "supported" : "unsupported", `${sourceId}#productionPath`),
    patch: cell(passed ? "supported" : "unsupported", `${sourceId}#realBytes.outcome`),
    helper: cell("not_applicable", `${sourceId}#capabilityTuple`, helperNote),
    runtime: cell("unsupported", `${sourceId}#supportBoundary`, runtimeNote),
  };
}

function buildProductionPlainXp3Row(inputs) {
  const sourceId = PRODUCTION_PROOF_SOURCE_ID;
  const expected = {
    engineFamily: "kiri_kiri_xp3",
    adapterId: "kaifuu.kirikiri-xp3.plain-writer",
    scenario: "xp3-plain-extract-patch",
    tupleKind: "plain_xp3_writer",
    corpusEnvironment: ["KAIFUU_XP3_PROFILE_A_ARCHIVE"],
    minimumDistinctCorpora: 1,
    outcome: "byte_exact_archive_rebuild",
    productionPath: {
      nativeExtractCommand: "kaifuu xp3 unpack",
      nativePatchCommand: "kaifuu xp3 pack",
    },
  };
  const claim = requireProductionProofClaim(inputs, "kirikiri-xp3-plain-writer", expected);
  if (
    claim.capabilityTuple.variant !== "plain" ||
    claim.capabilityTuple.patchBackMode !== "archive_rebuild_plain"
  ) {
    throw new MatrixGenerationError(
      `${sourceId} claim kirikiri-xp3-plain-writer has an invalid plain XP3 capability tuple`,
    );
  }
  const passed = productionProofPassed(claim, expected);
  return makeRow({
    rowId: "kirikiri-xp3-plain-extract-patch",
    engineFamily: expected.engineFamily,
    scenario: expected.scenario,
    adapterId: expected.adapterId,
    levels: levelsFromProductionProof(
      passed,
      sourceId,
      "plain XP3 archive handling requires no key helper",
      "archive rebuild proof does not establish runtime compatibility",
    ),
    sourceKind: "production_capability_tuple",
    evidenceSourceIds: [sourceId],
    extraLimitations: [
      "positive extract/patch support is limited to plain XP3 archive rebuild; compressed-entry replacement, encrypted/protected variants, and standalone script support are not claimed",
    ],
  });
}

function buildSiglusDetectorReadinessRow(inputs) {
  const profile = requireInput(inputs, "siglus-detector-profile");
  const levels = levelsFromCapabilities(profile.capabilities, {
    sourceId: "siglus-detector-profile",
  });
  return makeRow({
    rowId: "siglus-scene-pck-detector-readiness",
    engineFamily: "siglus",
    scenario: "detector-profile-readiness",
    adapterId: profile.engine?.adapterId ?? "kaifuu.siglus",
    levels,
    sourceKind: "detector_profile",
    evidenceSourceIds: ["siglus-detector-profile"],
  });
}

function buildSiglusKnownKeyRow(inputs) {
  const smoke = requireInput(inputs, "siglus-known-key-parser-boundary-smoke");
  const sourceId = "siglus-known-key-parser-boundary-smoke";
  const passed = smoke.status === "passed" && smoke.outcome === "parser_boundary_success";
  const parsedText = Array.isArray(smoke.textSlots) && smoke.textSlots.length > 0;
  const hasKeyRef = Array.isArray(smoke.keyRefs) && smoke.keyRefs.length > 0;
  const levels = {
    identify: cell(
      passed ? "supported" : "unsupported",
      `${sourceId}#status`,
      passed ? undefined : "parser-boundary smoke did not pass",
    ),
    inventory: cell(
      parsedText ? "supported" : "unsupported",
      `${sourceId}#textSlots`,
      parsedText ? undefined : "no parsed text slots; inventory not demonstrated",
    ),
    extract: cell(
      parsedText ? "partial" : "unsupported",
      `${sourceId}#supportBoundary`,
      "parser-boundary smoke parses known-key text slots only; production extraction is not claimed",
    ),
    patch: cell(
      "unsupported",
      `${sourceId}#patchWriteAttempted`,
      "patch write was not attempted; Siglus patch-back/repack is not claimed",
    ),
    helper: cell(
      hasKeyRef ? "partial" : "unsupported",
      `${sourceId}#keyRefs`,
      "known-key reference plumbing is validated for fixture inputs only; no production key resolution is claimed",
    ),
    runtime: cell(
      "unsupported",
      `${sourceId}#supportBoundary`,
      "runtime compatibility is not claimed by the parser-boundary smoke",
    ),
  };
  return makeRow({
    rowId: "siglus-known-key-scene-gameexe-smoke",
    engineFamily: "siglus",
    scenario: "known-key-scene-gameexe",
    adapterId: "kaifuu.siglus",
    levels,
    sourceKind: "validation_artifact",
    evidenceSourceIds: ["siglus-known-key-parser-boundary-smoke", "siglus-detector-profile"],
  });
}

function buildRpgMakerEncryptedMediaRow(inputs) {
  const keyValidation = requireInput(inputs, "rpg-maker-mv-mz-key-validation");
  const merge = requireInput(inputs, "rpg-maker-mv-mz-readiness-merge");
  const detection = requireInput(inputs, "rpg-maker-mv-mz-encrypted-suffixes-detection");
  const matrix = merge.matrix ?? {};
  const detected = (detection.archiveDetection?.rows ?? []).some(
    (r) => r.engineFamily === "rpg_maker_mv_mz" && (r.signals ?? []).length > 0,
  );
  const keyPassed = keyValidation.status === "passed";
  const decryptClaimed = keyValidation.decryptOrPatchClaimed === true;
  const levels = {
    identify: cell(
      matrix.identify?.kind === "supported" && detected && keyPassed ? "supported" : "unsupported",
      "rpg-maker-mv-mz-readiness-merge#matrix.identify",
    ),
    inventory: cell(
      matrix.inventory?.kind === "supported" ? "supported" : "unsupported",
      "rpg-maker-mv-mz-readiness-merge#matrix.inventory",
      matrix.inventory?.kind === "supported"
        ? undefined
        : "MV/MZ readiness merge does not claim inventory support",
    ),
    extract: cell(
      decryptClaimed ? "partial" : "unsupported",
      "rpg-maker-mv-mz-key-validation#decryptOrPatchClaimed",
      "encrypted-media key validation matches key evidence only; it does not decrypt, extract, or replace media",
    ),
    patch: cell(
      decryptClaimed ? "partial" : "unsupported",
      "rpg-maker-mv-mz-key-validation#decryptOrPatchClaimed",
      "no decrypt/patch is claimed from media-key detection alone",
    ),
    helper: cell(
      keyPassed ? "partial" : "unsupported",
      "rpg-maker-mv-mz-key-validation#status",
      "key evidence is validated against System.json; no key material is resolved or decrypted",
    ),
    runtime: cell(
      "unsupported",
      "rpg-maker-mv-mz-readiness-merge#matrix",
      "no runtime evidence is claimed for MV/MZ readiness",
    ),
  };
  return makeRow({
    rowId: "rpg-maker-mv-mz-encrypted-media",
    engineFamily: "rpg_maker_mv_mz",
    scenario: "encrypted-media",
    adapterId: merge.adapterId ?? "kaifuu.rpg-maker-mv-mz",
    levels,
    sourceKind: "readiness_profile",
    evidenceSourceIds: [
      "rpg-maker-mv-mz-key-validation",
      "rpg-maker-mv-mz-readiness-merge",
      "rpg-maker-mv-mz-encrypted-suffixes-detection",
    ],
  });
}

function buildProductionRpgMakerRow(inputs) {
  const sourceId = PRODUCTION_PROOF_SOURCE_ID;
  const expected = {
    engineFamily: "rpg_maker_mv_mz",
    adapterId: "kaifuu.rpg-maker-mv-mz",
    scenario: "json-text-extract-patch",
    tupleKind: "mv_mz_json_text",
    corpusEnvironment: [
      "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ",
      "ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ_2",
    ],
    minimumDistinctCorpora: 2,
    outcome: "byte_surgical_extract_patch_delta_apply",
    productionPath: {
      appExtractRegistry: "itotori extract --engine rpg-maker",
      appPatchRegistry: "itotori patch",
      nativePatchCommand: "kaifuu patch --engine rpgmaker",
    },
  };
  const claim = requireProductionProofClaim(inputs, "rpg-maker-mv-mz-json-text", expected);
  if (
    claim.capabilityTuple.capability !== "patch" ||
    !sameStringSet(claim.capabilityTuple.coveredRoles, [
      "maps",
      "common_events",
      "database",
      "system",
      "terms",
    ])
  ) {
    throw new MatrixGenerationError(
      `${sourceId} claim rpg-maker-mv-mz-json-text has an invalid JSON-text capability tuple`,
    );
  }
  const passed = productionProofPassed(claim, expected);
  return makeRow({
    rowId: "rpg-maker-mv-mz-json-text-extract-patch",
    engineFamily: expected.engineFamily,
    scenario: expected.scenario,
    adapterId: expected.adapterId,
    levels: levelsFromProductionProof(
      passed,
      sourceId,
      "JSON text extraction and patchback require no key helper",
      "JSON text extract/patch proof does not establish runtime compatibility",
    ),
    sourceKind: "production_capability_tuple",
    evidenceSourceIds: [sourceId],
    extraLimitations: [
      "positive extract/patch support is limited to JSON text in maps, common events, database, system, and terms; plugin JavaScript and encrypted media are not claimed",
    ],
  });
}

function detectionSummaryHelperCell(signals, sourceId, engineFamily) {
  const has = (signal) => (signals ?? []).includes(signal);
  if (has("helper_required")) {
    return cell(
      "partial",
      `${sourceId}#row:${engineFamily}.signals`,
      "a key/helper requirement is named but not resolved by this readiness evidence",
    );
  }
  if (has("encrypted") || has("missing_key") || has("protected")) {
    return cell(
      "unsupported",
      `${sourceId}#row:${engineFamily}.signals`,
      "an encrypted/keyed surface is detected but no key or helper handling is claimed",
    );
  }
  return cell(
    "not_applicable",
    `${sourceId}#row:${engineFamily}.signals`,
    "no encrypted/keyed surface detected; no helper is required",
  );
}

function detectionSummaryRow(inputs, engineFamily) {
  const summary = requireInput(inputs, "encrypted-matrix-detection-summary");
  const row = (summary.expectedRows ?? []).find((r) => r.engineFamily === engineFamily);
  if (!row) {
    throw new MatrixGenerationError(
      `detection summary has no row for engine family ${engineFamily}`,
    );
  }
  return row;
}

function buildDetectionSummaryReadinessRow(inputs, { engineFamily, rowId, scenario }) {
  const row = detectionSummaryRow(inputs, engineFamily);
  const sourceId = "encrypted-matrix-detection-summary";
  const signals = row.signals ?? [];
  const levels = {
    identify: cell(
      row.detected ? "supported" : "unsupported",
      `${sourceId}#row:${engineFamily}.detected`,
    ),
    inventory: cell(
      "unsupported",
      `${sourceId}#row:${engineFamily}`,
      "detection summary provides identify-only readiness; no inventory parser is claimed",
    ),
    extract: cell(
      "unsupported",
      `${sourceId}#row:${engineFamily}`,
      "no extraction is claimed; detector/profile readiness evidence only",
    ),
    patch: cell(
      "unsupported",
      `${sourceId}#row:${engineFamily}`,
      "no parser or patch support is claimed",
    ),
    helper: detectionSummaryHelperCell(signals, sourceId, engineFamily),
    runtime: cell(
      "unsupported",
      `${sourceId}#row:${engineFamily}`,
      "no runtime evidence is claimed",
    ),
  };
  return makeRow({
    rowId,
    engineFamily,
    scenario,
    adapterId: null,
    levels,
    sourceKind: "detection_summary",
    evidenceSourceIds: [sourceId],
  });
}

function buildTyranoScriptRow(inputs) {
  const profile = requireInput(inputs, "tyranoscript-null-key-readiness");
  const levels = levelsFromCapabilities(profile.capabilities, {
    sourceId: "tyranoscript-null-key-readiness",
    crypto: profile.crypto,
  });
  return makeRow({
    rowId: "tyranoscript-null-key-readiness",
    engineFamily: "tyranoscript",
    scenario: "null-key-plaintext-readiness",
    adapterId: null,
    levels,
    sourceKind: "detector_profile",
    evidenceSourceIds: ["tyranoscript-null-key-readiness"],
  });
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

export function generateEngineCapabilityMatrix(inputs) {
  const rows = [
    buildFixturePositiveAdapterRow(inputs),
    buildTyranoScriptRow(inputs),
    buildXp3Row(inputs, "xp3-plain-detector-profile", "readiness"),
    buildXp3Row(inputs, "xp3-compressed-detector-profile", "readiness"),
    buildXp3Row(inputs, "xp3-encrypted-detector-profile", "crypt-smoke"),
    buildProductionPlainXp3Row(inputs),
    buildSiglusDetectorReadinessRow(inputs),
    buildSiglusKnownKeyRow(inputs),
    buildRpgMakerEncryptedMediaRow(inputs),
    buildProductionRpgMakerRow(inputs),
    buildDetectionSummaryReadinessRow(inputs, {
      engineFamily: "wolf_rpg_editor",
      rowId: "wolf-rpg-editor-encrypted-archive-smoke",
      scenario: "encrypted-archive-smoke",
    }),
    buildDetectionSummaryReadinessRow(inputs, {
      engineFamily: "bgi_ethornell",
      rowId: "bgi-ethornell-container-readiness",
      scenario: "detector-profile-readiness",
    }),
    buildRealliveReadinessRow(inputs),
    buildReallivePatchbackProduceRow(inputs),
    buildSoftpalRow(inputs),
  ];

  assertNoExcludedRows(rows);
  const consumed = collectConsumedNamespaces(rows);
  assertRequiredCoverage(consumed);

  const knownLimitations = collectKnownLimitations(rows);

  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    generatedBy: GENERATOR_PATH,
    doNotEdit:
      "GENERATED ARTIFACT — do not hand-edit. Regenerate with `node scripts/generate-engine-capability-matrix.mjs`. Manual edits fail `--check`.",
    capabilityLevels: CAPABILITY_LEVELS,
    levelStatuses: LEVEL_STATUSES,
    evidencePostures: EVIDENCE_POSTURES,
    inputCategoriesCovered: consumed.categories,
    inputKindsCovered: consumed.kinds,
    inputs: INPUT_SOURCES.map((s) => ({
      sourceId: s.id,
      path: s.path,
      category: s.category,
      kind: s.kind,
      role: s.role,
    })),
    rows,
    exclusions: NON_DRIVER_EXCLUSIONS.map((e) => ({
      engineFamily: e.engineFamily,
      reason: e.reason,
      evidenceSourceIds: e.evidenceSourceIds,
    })),
    knownLimitations,
  };
}

function assertNoExcludedRows(rows) {
  const excluded = new Set(NON_DRIVER_EXCLUSIONS.map((e) => e.engineFamily));
  for (const row of rows) {
    if (excluded.has(row.engineFamily)) {
      throw new MatrixGenerationError(
        `engine family ${row.engineFamily} is on the non-driver exclusion list and must not appear as a capability row`,
      );
    }
  }
}

/**
 * Collect consumed category and kind labels from row evidence.
 * Namespaces stay distinct: categories only from evidence.category, kinds only
 * from evidence.kind — never cross-mixed.
 */
export function collectConsumedNamespaces(rows) {
  const categories = new Set();
  const kinds = new Set();
  for (const row of rows) {
    for (const evidence of row.evidence ?? []) {
      if (typeof evidence.category === "string" && evidence.category.length > 0) {
        categories.add(evidence.category);
      }
      if (typeof evidence.kind === "string" && evidence.kind.length > 0) {
        kinds.add(evidence.kind);
      }
    }
  }
  return {
    categories: [...categories].sort(),
    kinds: [...kinds].sort(),
  };
}

/**
 * Assert required category/kind coverage with no cross-namespace matching.
 * A kind string never satisfies a required category (and vice versa).
 */
export function assertRequiredCoverage(consumed) {
  const categorySet = new Set(consumed.categories ?? []);
  const kindSet = new Set(consumed.kinds ?? []);
  const missingCategories = REQUIRED_INPUT_CATEGORIES.filter((c) => !categorySet.has(c));
  const missingKinds = REQUIRED_INPUT_KINDS.filter((k) => !kindSet.has(k));
  if (missingCategories.length > 0) {
    throw new MatrixGenerationError(
      `matrix is not generated from every required input category; missing: ${missingCategories.join(", ")}`,
    );
  }
  if (missingKinds.length > 0) {
    throw new MatrixGenerationError(
      `matrix is not generated from every required input kind; missing: ${missingKinds.join(", ")}`,
    );
  }
}

function collectKnownLimitations(rows) {
  const limitations = [];
  for (const row of rows) {
    for (const limitation of row.limitations) {
      limitations.push(`[${row.rowId}] ${limitation}`);
    }
  }
  for (const exclusion of NON_DRIVER_EXCLUSIONS) {
    limitations.push(`[exclusion:${exclusion.engineFamily}] ${exclusion.reason}`);
  }
  return limitations;
}

// ---------------------------------------------------------------------------
// Known-limitation + markdown renderers
// ---------------------------------------------------------------------------

const STATUS_GLYPH = {
  supported: "yes",
  partial: "partial",
  unsupported: "no",
  not_applicable: "n/a",
  unknown: "?",
};

export function renderKnownLimitations(matrix) {
  const lines = ["## Known limitations", ""];
  for (const limitation of matrix.knownLimitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderMatrixMarkdown(matrix) {
  const lines = [];
  lines.push("# Engine capability matrix (generated)");
  lines.push("");
  lines.push(`> ${matrix.doNotEdit}`);
  lines.push("");
  lines.push(`- Schema: \`${matrix.schemaVersion}\``);
  lines.push(`- Generator: \`${matrix.generatedBy}\``);
  lines.push(`- Capability levels: ${matrix.capabilityLevels.join(", ")}`);
  lines.push(`- Input categories covered: ${matrix.inputCategoriesCovered.join(", ")}`);
  lines.push(`- Input kinds covered: ${(matrix.inputKindsCovered ?? []).join(", ")}`);
  lines.push("");
  lines.push("## Capability rows");
  lines.push("");
  const header = ["Row", "Engine family", "Posture", ...matrix.capabilityLevels];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of matrix.rows) {
    const cells = matrix.capabilityLevels.map((level) => STATUS_GLYPH[row.levels[level].status]);
    lines.push(
      `| ${row.rowId} | ${row.engineFamily} | ${row.evidencePosture} | ${cells.join(" | ")} |`,
    );
  }
  lines.push("");
  lines.push("## Posture legend");
  lines.push("");
  lines.push(
    "- `positive_adapter`: a real adapter that extracts and/or patches, evidenced by an adapter-registry / claimed-support tuple.",
  );
  lines.push(
    "- `readiness_only`: detector/profile/readiness/validation evidence; identification and (sometimes) inventory only — no extract/patch adapter is claimed.",
  );
  lines.push("");
  lines.push("## Inputs");
  lines.push("");
  for (const input of matrix.inputs) {
    lines.push(`- \`${input.sourceId}\` (${input.category}/${input.kind}) — ${input.path}`);
  }
  lines.push("");
  lines.push("## Exclusions");
  lines.push("");
  for (const exclusion of matrix.exclusions) {
    lines.push(`- \`${exclusion.engineFamily}\`: ${exclusion.reason}`);
  }
  lines.push("");
  lines.push(renderKnownLimitations(matrix));
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function serializeJson(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

export function buildArtifacts(root = repoRoot) {
  const inputs = loadInputs(root);
  const matrix = generateEngineCapabilityMatrix(inputs);
  return { matrix, json: serializeJson(matrix), markdown: renderMatrixMarkdown(matrix) };
}

function readOrNull(absolute) {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function run(argv) {
  const check = argv.includes("--check");
  const { json, markdown } = buildArtifacts(repoRoot);
  const jsonPath = resolve(repoRoot, OUTPUT_JSON_PATH);
  const mdPath = resolve(repoRoot, OUTPUT_MD_PATH);

  if (check) {
    const drift = [];
    if (readOrNull(jsonPath) !== json) {
      drift.push(OUTPUT_JSON_PATH);
    }
    if (readOrNull(mdPath) !== markdown) {
      drift.push(OUTPUT_MD_PATH);
    }
    if (drift.length > 0) {
      console.error(
        `engine capability matrix is stale or hand-edited; regenerate with \`node ${GENERATOR_PATH}\`:\n  ${drift.join(
          "\n  ",
        )}`,
      );
      process.exit(1);
    }
    console.log("engine capability matrix is up to date");
    return;
  }

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, markdown);
  console.log(`wrote ${OUTPUT_JSON_PATH} and ${OUTPUT_MD_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof MatrixGenerationError) {
      console.error(`MatrixGenerationError: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
