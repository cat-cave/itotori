import {
  CAPABILITY_LEVELS,
  INPUT_SOURCES,
  LEVEL_STATUSES,
  MatrixGenerationError,
} from "./generate-engine-capability-matrix-inputs.mjs";

export function requireInput(inputs, sourceId) {
  const value = inputs[sourceId];
  if (value === undefined) {
    throw new MatrixGenerationError(`required input "${sourceId}" was not loaded`);
  }
  return value;
}

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

export function capabilityStatusMap(capabilities) {
  const map = {};
  for (const entry of capabilities ?? []) {
    map[entry.capability] = entry.status;
  }
  return map;
}

export function cell(status, derivedFrom, note) {
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

export function levelsFromCapabilities(capabilities, { sourceId, crypto, signals }) {
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

export function makeRow({
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

export function adapterReports(capabilitiesDoc, adapterId) {
  const entry = (capabilitiesDoc ?? []).find((a) => a.adapterId === adapterId);
  if (!entry) {
    throw new MatrixGenerationError(
      `adapter ${adapterId} not found in claimed-support tuples input`,
    );
  }
  return entry.reports ?? [];
}
