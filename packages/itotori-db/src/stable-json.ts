/**
 * Produces a deterministic JSON representation for identity hashes and
 * persisted proof keys. Object keys use locale-aware lexical ordering; array
 * order remains meaningful.
 */
export function stableJsonStringify(input: unknown): string {
  if (input === undefined) {
    return "undefined";
  }
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input) ?? "undefined";
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  }
  const entries = Object.entries(input).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${stableJsonStringify(value)}`)
    .join(",")}}`;
}
