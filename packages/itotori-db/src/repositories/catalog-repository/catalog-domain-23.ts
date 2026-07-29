export function assertEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  fieldName: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${fieldName} must be one of ${allowed.join(", ")}`);
  }
}
