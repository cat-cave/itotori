import type { JsonValue } from "./api-contract-json.js";

export type Schema = { readonly [key: string]: JsonValue };
export type Ref = (name: string) => Schema;

export const str: Schema = { type: "string" };
export const nullableStr: Schema = { type: ["string", "null"] };
export const num: Schema = { type: "number" };
export const bool: Schema = { type: "boolean" };
export const arr: Schema = { type: "array" };
export const obj: Schema = { type: "object" };
export const any: Schema = {};

/**
 * Build an object schema. `required` keys are always present in `properties`
 * (defaulting to `any`) so `additionalProperties: false` never rejects a key it
 * simply forgot to list. `schemaVersion`, when supplied, is pinned as a `const`
 * (the SAME literal the guard asserts) and force-required.
 */
export function object(spec: {
  required: readonly string[];
  properties?: Readonly<Record<string, Schema>>;
  additionalProperties: boolean;
  schemaVersion?: string;
}): Schema {
  const properties: Record<string, JsonValue> = { ...spec.properties };
  const required = [...spec.required];
  if (spec.schemaVersion !== undefined) {
    properties.schemaVersion = { const: spec.schemaVersion };
    if (!required.includes("schemaVersion")) {
      required.push("schemaVersion");
    }
  }
  for (const key of required) {
    if (!(key in properties)) {
      properties[key] = any;
    }
  }
  return {
    type: "object",
    properties,
    required: [...required].sort(),
    additionalProperties: spec.additionalProperties,
  };
}
