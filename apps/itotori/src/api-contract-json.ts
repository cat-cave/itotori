export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Recursively sort object keys (arrays keep their order) so a serialized
 * document is byte-identical regardless of authoring/insertion order. This is
 * the determinism backbone: the emitter never depends on key order.
 */
export function sortJsonDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: JsonValue };
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortJsonDeep(record[key] as JsonValue);
    }
    return out;
  }
  return value;
}

/** Serialize a JSON document deterministically (sorted keys, 2-space, trailing newline). */
export function serializeJsonDocument(value: JsonValue): string {
  return `${JSON.stringify(sortJsonDeep(value), null, 2)}\n`;
}
