import type { CatalogJsonRecord } from "../repositories/catalog-repository.js";

import { type CatalogPlatformLanguageConflictEvidence } from "./catalog-platform-language-conflicts-01.js";

export function sourceLabel(evidence: CatalogPlatformLanguageConflictEvidence): string {
  return `${evidence.catalogSource} ${evidence.sourceId}`;
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function compactJson<T extends CatalogJsonRecord>(record: T): T {
  const compacted: CatalogJsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted as T;
}
