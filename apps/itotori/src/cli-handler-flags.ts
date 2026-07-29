export function parseBooleanFlag(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
