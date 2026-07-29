import { BRIDGE_SCHEMA_VERSION_V02, RuntimeVerificationReport } from "./schema-domain-01.js";
import { LocalizationUnitV02 } from "./schema-domain-04.js";
import {
  PatchExportEntryV02,
  PatchSourceCompatibilityReportV02,
  UnitSourceCompatibilityV02,
} from "./schema-domain-07.js";
import { assertBridgeBundleV02 } from "./schema-domain-08.js";
import { assertPatchExportV02 } from "./schema-domain-09.js";
import { asRecord, assertArray, assertString } from "./schema-domain-21.js";
import { assertEqual } from "./schema-domain-22.js";

export function evaluatePatchExportCompatibilityV02(
  patchExport: unknown,
  bridgeBundle: unknown,
): PatchSourceCompatibilityReportV02 {
  assertPatchExportV02(patchExport);
  assertBridgeBundleV02(bridgeBundle);

  const unitsByKey = new Map<string, LocalizationUnitV02>();
  const duplicateKeys = new Set<string>();
  for (const unit of bridgeBundle.units) {
    if (unitsByKey.has(unit.sourceUnitKey)) {
      duplicateKeys.add(unit.sourceUnitKey);
      continue;
    }
    unitsByKey.set(unit.sourceUnitKey, unit);
  }

  const compatibleUnits: UnitSourceCompatibilityV02[] = [];
  const incompatibleUnits: UnitSourceCompatibilityV02[] = [];

  for (const entry of patchExport.entries) {
    const base: Omit<UnitSourceCompatibilityV02, "status"> = {
      entryId: entry.entryId,
      bridgeUnitId: entry.bridgeUnitId,
      sourceUnitKey: entry.sourceUnitKey,
      expectedSourceHash: entry.sourceHash,
    };
    if (duplicateKeys.has(entry.sourceUnitKey)) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        reason: "duplicate_source_unit_key",
      });
      continue;
    }

    const currentUnit = unitsByKey.get(entry.sourceUnitKey);
    if (currentUnit === undefined) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        reason: "missing_source_unit",
      });
      continue;
    }

    if (currentUnit.bridgeUnitId !== entry.bridgeUnitId) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        actualBridgeUnitId: currentUnit.bridgeUnitId,
        actualSourceHash: currentUnit.sourceHash,
        reason: "bridge_unit_id_mismatch",
      });
      continue;
    }

    if (currentUnit.sourceHash !== entry.sourceHash) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        actualSourceHash: currentUnit.sourceHash,
        reason: "source_hash_mismatch",
      });
      continue;
    }

    if (!patchEntrySpanMappingsCompatible(entry, currentUnit)) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        actualSourceHash: currentUnit.sourceHash,
        reason: "protected_span_mapping_mismatch",
      });
      continue;
    }

    compatibleUnits.push({
      ...base,
      status: "compatible",
      actualSourceHash: currentUnit.sourceHash,
    });
  }

  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    patchExportId: patchExport.patchExportId,
    sourceBridgeId: patchExport.sourceBridgeId,
    status: incompatibleUnits.length === 0 ? "compatible" : "incompatible",
    expectedSourceBundleHash: patchExport.sourceBundleHash,
    actualSourceBundleHash: bridgeBundle.sourceBundleHash,
    sourceBundleHashMatches: patchExport.sourceBundleHash === bridgeBundle.sourceBundleHash,
    compatibleUnits,
    incompatibleUnits,
  };
}

export function patchEntrySpanMappingsCompatible(
  entry: PatchExportEntryV02,
  unit: LocalizationUnitV02,
): boolean {
  const requiredCounts = new Map<string, number>();
  for (const span of unit.spans) {
    requiredCounts.set(span.raw, (requiredCounts.get(span.raw) ?? 0) + 1);
  }

  const targetRangesByRaw = new Map<string, Set<string>>();
  const explicitSourceKeys = new Set<string>();
  for (const mapping of entry.protectedSpanMappings) {
    if (
      !targetByteRangeMatchesRaw(
        entry.targetText,
        mapping.raw,
        mapping.targetStart,
        mapping.targetEnd,
      )
    ) {
      return false;
    }

    const hasSourceIdentity =
      mapping.sourceSpanId !== undefined ||
      mapping.sourceStartByte !== undefined ||
      mapping.sourceEndByte !== undefined;
    if ((requiredCounts.get(mapping.raw) ?? 0) > 1 && !hasSourceIdentity) {
      return false;
    }
    if (hasSourceIdentity) {
      const sourceSpan = unit.spans.find(
        (span) =>
          span.raw === mapping.raw &&
          (mapping.sourceSpanId === undefined || span.spanId === mapping.sourceSpanId) &&
          (mapping.sourceStartByte === undefined || span.startByte === mapping.sourceStartByte) &&
          (mapping.sourceEndByte === undefined || span.endByte === mapping.sourceEndByte),
      );
      if (sourceSpan === undefined) {
        return false;
      }
      const sourceKey = `${sourceSpan.spanId}:${sourceSpan.startByte}:${sourceSpan.endByte}`;
      if (explicitSourceKeys.has(sourceKey)) {
        return false;
      }
      explicitSourceKeys.add(sourceKey);
    }

    if (requiredCounts.has(mapping.raw)) {
      const ranges = targetRangesByRaw.get(mapping.raw) ?? new Set<string>();
      ranges.add(`${mapping.targetStart}:${mapping.targetEnd}`);
      targetRangesByRaw.set(mapping.raw, ranges);
    }
  }

  for (const [raw, requiredCount] of requiredCounts) {
    if ((targetRangesByRaw.get(raw)?.size ?? 0) < requiredCount) {
      return false;
    }
  }
  return true;
}

export function targetByteRangeMatchesRaw(
  targetText: string,
  raw: string,
  targetStart: number,
  targetEnd: number,
): boolean {
  const targetBytes = Buffer.from(targetText, "utf8");
  if (targetEnd > targetBytes.length) {
    return false;
  }
  return targetBytes.subarray(targetStart, targetEnd).toString("utf8") === raw;
}

export function assertRuntimeVerificationReport(
  value: unknown,
): asserts value is RuntimeVerificationReport {
  const report = asRecord(value, "RuntimeVerificationReport");
  assertEqual(report.schemaVersion, "0.1.0", "RuntimeVerificationReport.schemaVersion");
  assertString(report.runtimeReportId, "RuntimeVerificationReport.runtimeReportId");
  assertArray(report.textEvents, "RuntimeVerificationReport.textEvents");
  assertArray(report.frameCaptures, "RuntimeVerificationReport.frameCaptures");
}
