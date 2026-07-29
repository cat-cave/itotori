import {
  cell,
  levelsFromCapabilities,
  makeRow,
  requireInput,
} from "./generate-engine-capability-matrix-core.mjs";
import { MatrixGenerationError } from "./generate-engine-capability-matrix-inputs.mjs";

export function buildSiglusDetectorReadinessRow(inputs) {
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

export function buildSiglusKnownKeyRow(inputs) {
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

export function buildRpgMakerEncryptedMediaRow(inputs) {
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

export function buildDetectionSummaryReadinessRow(inputs, { engineFamily, rowId, scenario }) {
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

export function buildTyranoScriptRow(inputs) {
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
