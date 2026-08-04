// Provider-neutral byte-range evidence projection.
//
// Structure providers keep their evidence opaque in the common graph, but a
// bridge-linked unit must still prove the exact source bytes it names. New
// providers use `sourceRange`; compatibility providers retain their own
// namespaced evidence projection.

import type { ByteRangeV02 } from "@itotori/localization-bridge-schema";

import type { NarrativeEngineEvidence } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sourceRangeByteRange(
  evidence: NarrativeEngineEvidence | undefined,
): ByteRangeV02 | undefined {
  const range = evidence?.sourceRange;
  if (!isRecord(range)) return undefined;
  const { startByte, endByte } = range;
  if (
    typeof startByte !== "number" ||
    !Number.isInteger(startByte) ||
    startByte < 0 ||
    typeof endByte !== "number" ||
    !Number.isInteger(endByte) ||
    endByte < startByte
  ) {
    return undefined;
  }
  return { startByte, endByte };
}
