/**
 * Canonical selected-target-text invariants shared by the active draft and
 * patch-export contracts. This deliberately has no loop or provider surface.
 */
export type NonBlankTargetText = string & { readonly __brand: "NonBlank" };

export function isLocaleTaggedSourceEcho(value: string): boolean {
  return /^\[[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*\]/u.test(value);
}

export function assertNonBlankTargetText(
  value: unknown,
  label = "targetText",
): asserts value is NonBlankTargetText {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  if (isLocaleTaggedSourceEcho(value)) {
    throw new Error(`${label} must not use a locale-tagged source replay`);
  }
}

export function asNonBlankTargetText(value: string): NonBlankTargetText {
  assertNonBlankTargetText(value);
  return value;
}
