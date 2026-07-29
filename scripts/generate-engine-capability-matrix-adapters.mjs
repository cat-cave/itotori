import {
  adapterReports,
  capabilityStatusMap,
  cell,
  levelsFromCapabilities,
  makeRow,
  requireInput,
} from "./generate-engine-capability-matrix-core.mjs";
import { MatrixGenerationError } from "./generate-engine-capability-matrix-inputs.mjs";

export function buildFixturePositiveAdapterRow(inputs) {
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
export function buildSoftpalRow(inputs) {
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

export function buildRealliveReadinessRow(inputs) {
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
export function buildReallivePatchbackProduceRow(inputs) {
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
    v.realBytes?.strictLane === "just test real-bytes" &&
    v.realBytes?.minimumDistinctGames >= 2 &&
    ["private inventory row", "private inventory row"].every((name) =>
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

export function buildXp3Row(inputs, sourceId, scenario) {
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
    realBytes.strictLane !== "just test real-bytes" ||
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

export function buildProductionPlainXp3Row(inputs) {
  const sourceId = PRODUCTION_PROOF_SOURCE_ID;
  const expected = {
    engineFamily: "kiri_kiri_xp3",
    adapterId: "kaifuu.kirikiri-xp3.plain-writer",
    scenario: "xp3-plain-extract-patch",
    tupleKind: "plain_xp3_writer",
    corpusEnvironment: ["private inventory archive"],
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

export function buildProductionRpgMakerRow(inputs) {
  const sourceId = PRODUCTION_PROOF_SOURCE_ID;
  const expected = {
    engineFamily: "rpg_maker_mv_mz",
    adapterId: "kaifuu.rpg-maker-mv-mz",
    scenario: "json-text-extract-patch",
    tupleKind: "mv_mz_json_text",
    corpusEnvironment: ["private inventory row", "private inventory row"],
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
