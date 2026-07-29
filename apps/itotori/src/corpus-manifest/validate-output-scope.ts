import type { AnyCorpusValidationAdapter } from "./corpus-validation-registry.js";
import {
  sha256Bytes,
  stableJson,
  type CorpusEvidence,
  type CorpusOutputScope,
  type OrdinalRange,
} from "./manifest.js";
import {
  assertExactOrdinals,
  ordinalCount,
  validateFingerprint,
  validateUnit,
} from "./validate-units.js";
import {
  array,
  assertExactKeys,
  metadataString,
  nonNegativeInteger,
  positiveInteger,
  record,
  sha256,
  sourceInputFingerprint,
  type JsonRecord,
} from "./validate-primitives.js";

export function validateOutputScope(
  value: JsonRecord,
  corpus: CorpusEvidence,
  adapter: AnyCorpusValidationAdapter,
): CorpusOutputScope {
  assertExactKeys(
    value,
    ["scopeId", "sceneId", "ordinalRange", "bridge", "units"],
    "manifest.outputScope",
  );
  const sceneId = nonNegativeInteger(value.sceneId, "manifest.outputScope.sceneId");
  if (sceneId !== corpus.fullGame.utsushiStructure.scopedScene.sceneId) {
    throw new Error("private corpus scope and structure scene identities disagree");
  }
  const ordinalRange = validateOrdinalRange(
    record(value.ordinalRange, "manifest.outputScope.ordinalRange"),
  );
  const bridge = record(value.bridge, "manifest.outputScope.bridge");
  assertExactKeys(
    bridge,
    [
      "schemaVersion",
      "bridgeExport",
      "sourceBundleHash",
      "decompile",
      "unitCount",
      "uniqueBridgeUnitIdCount",
      "uniqueSourceHashCount",
      "unitsProjectionSha256",
    ],
    "manifest.outputScope.bridge",
  );
  const decompile = record(bridge.decompile, "manifest.outputScope.bridge.decompile");
  assertExactKeys(
    decompile,
    [
      "schemaVersion",
      "sceneId",
      "totalOpcodes",
      "recognizedOpcodes",
      "unknownOpcodes",
      "sourceSeenSha256",
    ],
    "manifest.outputScope.bridge.decompile",
  );
  const unitCount = positiveInteger(bridge.unitCount, "manifest.outputScope.bridge.unitCount");
  if (unitCount !== ordinalCount(ordinalRange)) {
    throw new Error("private corpus scoped unit count does not match its ordinal range");
  }
  const decodedBridge = {
    schemaVersion: metadataString(
      bridge.schemaVersion,
      "manifest.outputScope.bridge.schemaVersion",
    ),
    bridgeExport: validateFingerprint(
      record(bridge.bridgeExport, "manifest.outputScope.bridge.bridgeExport"),
      "manifest.outputScope.bridge.bridgeExport",
    ),
    sourceBundleHash: sha256(
      bridge.sourceBundleHash,
      "manifest.outputScope.bridge.sourceBundleHash",
    ),
    decompile: {
      schemaVersion: metadataString(
        decompile.schemaVersion,
        "manifest.outputScope.bridge.decompile.schemaVersion",
      ),
      sceneId: nonNegativeInteger(
        decompile.sceneId,
        "manifest.outputScope.bridge.decompile.sceneId",
      ),
      totalOpcodes: positiveInteger(
        decompile.totalOpcodes,
        "manifest.outputScope.bridge.decompile.totalOpcodes",
      ),
      recognizedOpcodes: positiveInteger(
        decompile.recognizedOpcodes,
        "manifest.outputScope.bridge.decompile.recognizedOpcodes",
      ),
      unknownOpcodes: nonNegativeInteger(
        decompile.unknownOpcodes,
        "manifest.outputScope.bridge.decompile.unknownOpcodes",
      ),
      sourceSeenSha256: sha256(
        decompile.sourceSeenSha256,
        "manifest.outputScope.bridge.decompile.sourceSeenSha256",
      ),
    },
    unitCount,
    uniqueBridgeUnitIdCount: positiveInteger(
      bridge.uniqueBridgeUnitIdCount,
      "manifest.outputScope.bridge.uniqueBridgeUnitIdCount",
    ),
    uniqueSourceHashCount: positiveInteger(
      bridge.uniqueSourceHashCount,
      "manifest.outputScope.bridge.uniqueSourceHashCount",
    ),
    unitsProjectionSha256: sha256(
      bridge.unitsProjectionSha256,
      "manifest.outputScope.bridge.unitsProjectionSha256",
    ),
  };
  if (
    decodedBridge.decompile.sceneId !== sceneId ||
    decodedBridge.decompile.unknownOpcodes !== 0 ||
    decodedBridge.decompile.totalOpcodes !== decodedBridge.decompile.recognizedOpcodes ||
    decodedBridge.decompile.sourceSeenSha256 !==
      sourceInputFingerprint(corpus.inputs, adapter).sha256
  ) {
    throw new Error("private corpus scoped decoder evidence is inconsistent");
  }

  const units = array(value.units, "manifest.outputScope.units").map((unit, index) =>
    validateUnit(
      record(unit, `manifest.outputScope.units[${index}]`),
      `manifest.outputScope.units[${index}]`,
      sceneId,
      ordinalRange,
      corpus.fullGame.utsushiStructure.scopedScene.dispatchIndex,
      adapter.evidence,
    ),
  );
  if (units.length !== unitCount) {
    throw new Error("private corpus scoped unit list has the wrong length");
  }
  const ids = new Set(units.map((unit) => unit.bridgeUnitId));
  const hashes = new Set(units.map((unit) => unit.sourceHash));
  if (
    ids.size !== unitCount ||
    hashes.size !== unitCount ||
    decodedBridge.uniqueBridgeUnitIdCount !== unitCount ||
    decodedBridge.uniqueSourceHashCount !== unitCount
  ) {
    throw new Error("private corpus scoped units have duplicate identities");
  }
  assertExactOrdinals(units, ordinalRange, adapter.evidence);
  if (units.some((unit) => unit.sourceRevision.value !== decodedBridge.sourceBundleHash)) {
    throw new Error("private corpus unit source revisions are not pinned to the scoped bridge");
  }
  if (sha256Bytes(stableJson(units)) !== decodedBridge.unitsProjectionSha256) {
    throw new Error("private corpus scoped unit projection hash drifted");
  }
  return {
    scopeId: metadataString(value.scopeId, "manifest.outputScope.scopeId"),
    sceneId,
    ordinalRange,
    bridge: decodedBridge,
    units,
  };
}

function validateOrdinalRange(value: JsonRecord): OrdinalRange {
  assertExactKeys(value, ["start", "end", "width"], "manifest.outputScope.ordinalRange");
  const range = {
    start: nonNegativeInteger(value.start, "manifest.outputScope.ordinalRange.start"),
    end: nonNegativeInteger(value.end, "manifest.outputScope.ordinalRange.end"),
    width: positiveInteger(value.width, "manifest.outputScope.ordinalRange.width"),
  };
  if (range.end < range.start || range.width > 12) {
    throw new Error("private corpus source ordinal range is invalid");
  }
  return range;
}
