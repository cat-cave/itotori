import { createHash } from "node:crypto";

import type {
  CatalogCrawlerDateInput,
  CatalogCrawlerJsonRecord,
} from "./catalog-crawler-repository.js";

export function dateInput(input: CatalogCrawlerDateInput): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error("date input must be valid");
  return date;
}

export function optionalNonnegativeInteger(input: number | undefined, name: string): number | null {
  if (input === undefined) return null;
  if (!Number.isInteger(input) || input < 0)
    throw new Error(`${name} must be a nonnegative integer`);
  return input;
}

export function jsonRecord(input: unknown, name: string): CatalogCrawlerJsonRecord {
  if (!isJsonRecord(input)) throw new Error(`${name} must be a JSON object`);
  return input;
}

function isJsonRecord(input: unknown): input is CatalogCrawlerJsonRecord {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

export function hashJson(input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(input)).digest("hex")}`;
}

export function stableId(prefix: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${prefix}:${hash}`;
}

export function stableJsonStringify(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input))
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  return `{${Object.entries(input)
    .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${stableJsonStringify(value)}`)
    .join(",")}}`;
}
