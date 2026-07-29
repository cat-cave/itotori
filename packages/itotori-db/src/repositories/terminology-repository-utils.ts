import type { TerminologyJsonRecord } from "./terminology-repository-types.js";

export function normalizeTerm(value: string, label: string): string {
  return requiredString(value, label).normalize("NFKC").trim().toLocaleLowerCase();
}

export function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ),
  ];
}

export function tokenOverlap(queryTokens: string[], documentTokens: string[]): number {
  if (queryTokens.length === 0 || documentTokens.length === 0) {
    return 0;
  }
  const document = new Set(documentTokens);
  return queryTokens.filter((token) => document.has(token)).length * 10;
}

export function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = key(value);
    const existing = grouped.get(group) ?? [];
    existing.push(value);
    grouped.set(group, existing);
  }
  return grouped;
}

export function enumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function requiredString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalNonEmpty(value: string | undefined, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty when provided`);
  }
  return value.trim();
}

export function jsonRecord(value: TerminologyJsonRecord, label: string): TerminologyJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function metadataString(metadata: TerminologyJsonRecord, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function spanRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberValue(value: unknown): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}

export function nonNullable<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
