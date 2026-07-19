// Build a strict PatchExportV02 from bound accepted targets + the source bridge.
//
// PatchExportV02 is the ONLY structure the apply path consumes — the accepted
// target bodies are carried here, source-hash-anchored, never re-derived from a
// journal. The source identity (game, bundle hash + revision, bridge id) is the
// bridge's own, and the bundle hash is asserted equal to the snapshot's, so a
// stale apply-time bridge fails loud before a single byte is spliced. The result
// is validated with `assertPatchExportV02`, so a malformed export can never reach
// Kaifuu.

import {
  assertBridgeBundleV02,
  assertPatchExportV02,
  type BridgeBundleV02,
  type BridgeSpanV02,
  type LocalizationUnitV02,
  type PatchExportEntryV02,
  type PatchExportV02,
} from "@itotori/localization-bridge-schema";

import type { BoundScopedTarget, NativePatchbackInput } from "./types.js";
import { deterministicUuid7 } from "./uuid7.js";

/** Raised when the apply-time bridge does not match the snapshot it must patch,
 * or a bound unit is absent from that bridge. Fatal — never a silent skip. */
export class PatchExportBuildError extends Error {
  constructor(message: string) {
    super(`native patch export refused: ${message}`);
    this.name = "PatchExportBuildError";
  }
}

/** Index a validated bridge's units by their bridge unit id. */
function indexBridgeUnits(bridge: BridgeBundleV02): ReadonlyMap<string, LocalizationUnitV02> {
  const byId = new Map<string, LocalizationUnitV02>();
  for (const unit of bridge.units) {
    byId.set(unit.bridgeUnitId, unit);
  }
  return byId;
}

/**
 * Project the honest protected-span mappings for one entry: every source span
 * whose raw bytes reappear verbatim in the accepted target text. Out-of-band
 * control markup (e.g. reallive.kidoku) is stripped before the target ever
 * carries it and is re-emitted structurally by the patchback, so it legitimately
 * has no target position and is omitted. Each mapping keeps its source identity
 * (`sourceSpanId`, byte range) so the strict validator's uniqueness rule holds.
 */
function protectedSpanMappings(
  spans: readonly BridgeSpanV02[],
  targetText: string,
  bridgeUnitId: string,
): PatchExportEntryV02["protectedSpanMappings"] {
  const mappings: PatchExportEntryV02["protectedSpanMappings"] = [];
  let searchFrom = 0;
  for (const span of spans) {
    if (span.outOfBand === true) continue;
    if (span.raw.length === 0) continue;
    // Search in source-span order. This keeps repeated protected strings as
    // distinct occurrences instead of mapping every source span to the first
    // occurrence in the accepted target.
    const targetStart = targetText.indexOf(span.raw, searchFrom);
    if (targetStart < 0) {
      throw new PatchExportBuildError(
        `accepted target for bridge unit ${bridgeUnitId} drops or reorders protected span ${span.spanId}`,
      );
    }
    searchFrom = targetStart + span.raw.length;
    mappings.push({
      raw: span.raw,
      sourceSpanId: span.spanId,
      sourceStartByte: span.startByte,
      sourceEndByte: span.endByte,
      targetStart,
      targetEnd: targetStart + span.raw.length,
    });
  }
  return mappings;
}

/**
 * Build the strict PatchExportV02 that the native apply consumes. The entries
 * are ordered by `sourceUnitKey` (deterministic). The source identity is copied
 * verbatim from the validated bridge; the export refuses if that bridge's
 * `sourceBundleHash` differs from the snapshot the targets were bound against.
 */
export function buildPatchExportV02(
  input: NativePatchbackInput,
  bound: readonly BoundScopedTarget[],
): PatchExportV02 {
  assertBridgeBundleV02(input.rawBridge);
  const bridge = input.rawBridge;

  if (input.sourceLocale !== bridge.sourceLocale) {
    throw new PatchExportBuildError(
      `requested sourceLocale ${input.sourceLocale} does not match bridge sourceLocale ${bridge.sourceLocale}`,
    );
  }
  if (bridge.sourceBundleHash !== input.snapshot.source.sourceBundleHash) {
    throw new PatchExportBuildError(
      `apply-time bridge sourceBundleHash ${bridge.sourceBundleHash} does not match snapshot ${input.snapshot.source.sourceBundleHash} (stale bridge)`,
    );
  }

  const unitsById = indexBridgeUnits(bridge);
  const patchExportId = deterministicUuid7(
    `${bridge.bridgeId}|${input.sourceLocale}|${input.targetLocale}|patch-export-v02`,
  );

  const entries: PatchExportEntryV02[] = [];
  for (const target of bound) {
    const unit = unitsById.get(target.fact.bridgeUnitId);
    if (unit === undefined) {
      throw new PatchExportBuildError(
        `bound unit ${target.fact.bridgeUnitId} (fact ${target.fact.factId}) is absent from the apply-time bridge`,
      );
    }
    if (unit.sourceHash !== target.fact.sourceHash) {
      throw new PatchExportBuildError(
        `bridge unit ${unit.bridgeUnitId} sourceHash ${unit.sourceHash} differs from snapshot fact sourceHash ${target.fact.sourceHash}`,
      );
    }
    entries.push({
      entryId: deterministicUuid7(`${patchExportId}|${unit.bridgeUnitId}|${unit.sourceUnitKey}`),
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sourceHash: unit.sourceHash,
      sourceRevision: unit.sourceRevision,
      targetText: target.targetText,
      protectedSpanMappings: protectedSpanMappings(
        unit.spans,
        target.targetText,
        unit.bridgeUnitId,
      ),
    });
  }
  entries.sort((a, b) =>
    a.sourceUnitKey < b.sourceUnitKey ? -1 : a.sourceUnitKey > b.sourceUnitKey ? 1 : 0,
  );

  const patchExport: PatchExportV02 = {
    schemaVersion: bridge.schemaVersion,
    patchExportId,
    sourceBridgeId: bridge.bridgeId,
    sourceGame: bridge.sourceGame,
    sourceBundleHash: bridge.sourceBundleHash,
    sourceBundleRevision: bridge.sourceBundleRevision,
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    hashStrategy: bridge.hashStrategy,
    entries,
  };
  assertPatchExportV02(patchExport);
  return patchExport;
}
