// RealLive-only evidence projection.
//
// The shared NarrativeStructure graph deliberately treats `engineEvidence` as
// opaque. This module is the one place that knows the provider's byte-addressed
// evidence vocabulary needed to verify a RealLive bridge binding.

import type { ByteRangeV02 } from "@itotori/localization-bridge-schema";

import type { NarrativeEngineEvidence } from "./types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Extract the RealLive byte range without exposing it on the common model. */
export function realliveByteRange(
  evidence: NarrativeEngineEvidence | undefined,
): ByteRangeV02 | undefined {
  const provider = record(evidence?.reallive);
  if (!provider) return undefined;
  const startByte = provider.byteOffsetInScene;
  const byteLength = provider.byteLength;
  if (
    typeof startByte !== "number" ||
    !Number.isInteger(startByte) ||
    startByte < 0 ||
    typeof byteLength !== "number" ||
    !Number.isInteger(byteLength) ||
    byteLength < 0
  ) {
    return undefined;
  }
  return { startByte, endByte: startByte + byteLength };
}
