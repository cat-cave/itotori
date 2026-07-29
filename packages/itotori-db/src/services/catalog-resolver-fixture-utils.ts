import { stringValue } from "./catalog-resolver-fixture-normalization-result.js";

export function hasDateLikeValue(value: unknown): boolean {
  return value instanceof Date || stringValue(value) !== null;
}

export function isEnumValue<T extends Record<string, string>>(
  value: unknown,
  enumValues: T,
): value is T[keyof T] {
  return typeof value === "string" && Object.values(enumValues).includes(value);
}

export function arraysEqual(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
