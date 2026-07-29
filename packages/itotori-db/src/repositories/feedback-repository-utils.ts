import { createHash } from "node:crypto";
import type { ManualFeedbackLineReference } from "./feedback-repository-types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringFromRecord(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

export function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "") {
      continue;
    }
    if (Array.isArray(entry) && entry.length === 0) {
      continue;
    }
    if (isRecord(entry)) {
      const nested = compactRecord(entry);
      if (Object.keys(nested).length === 0) {
        continue;
      }
      compacted[key] = nested;
      continue;
    }
    compacted[key] = entry;
  }
  return compacted;
}

export function normalizeLineReference(
  lineReference: ManualFeedbackLineReference | undefined,
): Record<string, unknown> | null {
  if (!lineReference) {
    return null;
  }
  const normalized = compactRecord(lineReference);
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function hasUsableLineReferenceSignal(signal: Record<string, unknown>): boolean {
  return hasAnySignalField(signal, [
    "bridgeUnitId",
    "sourceUnitKey",
    "sourceHash",
    "assetId",
    "path",
    "line",
    "sourceLocation",
    "quotedText",
  ]);
}

export function hasAnySignalField(signal: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => hasMeaningfulSignalValue(signal[field]));
}

function hasMeaningfulSignalValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return true;
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
