import { readFileSync } from "node:fs";
import type { AnyCorpusValidationAdapter } from "./corpus-validation-registry.js";
import type { CorpusEvidence, FileFingerprint, Sha256 } from "./manifest.js";

export type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function sourceInputFingerprint(
  inputs: CorpusEvidence["inputs"],
  adapter: AnyCorpusValidationAdapter,
): FileFingerprint {
  const fingerprint = inputs[adapter.sourceInputName];
  if (fingerprint === undefined) {
    throw new Error("private corpus validation adapter source input is missing from the manifest");
  }
  return fingerprint;
}

export function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`private corpus ${label} output is not readable JSON`);
  }
}

export function assertExactKeys(value: JsonRecord, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`private corpus manifest shape drift at ${label}`);
  }
}

export function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`private corpus expected an object at ${label}`);
  }
  return value as JsonRecord;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`private corpus expected an array at ${label}`);
  return value;
}

/** Metadata strings are printable ASCII only; source text cannot enter a manifest field. */
export function metadataString(value: unknown, label: string): string {
  const result = nativeString(value, label);
  if (/[^\x20-\x7e]/u.test(result)) {
    throw new Error(`private corpus manifest privacy violation at ${label}`);
  }
  return result;
}

/** Native decode values may be non-ASCII but are never inserted into errors. */
export function nativeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`private corpus expected a non-empty string at ${label}`);
  }
  return value;
}

export function nullableNativeString(value: unknown, label: string): string | null {
  return value === null ? null : nativeString(value, label);
}

export function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`private corpus expected a finite number at ${label}`);
  }
  return value;
}

export function integer(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isInteger(result)) throw new Error(`private corpus expected an integer at ${label}`);
  return result;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 0) throw new Error(`private corpus expected a non-negative integer at ${label}`);
  return result;
}

export function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

export function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw new Error(`private corpus expected a positive integer at ${label}`);
  return result;
}

export function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

export function sha256(value: unknown, label: string): Sha256 {
  const result = metadataString(value, label);
  if (!SHA256_PATTERN.test(result))
    throw new Error(`private corpus expected sha256 metadata at ${label}`);
  return result as Sha256;
}
