/** Lossless arithmetic for non-negative decimal USD values.
 *
 * This belongs to the provider-neutral LLM boundary: callers operate on
 * canonical decimal strings without importing a retired provider client or its
 * response types.
 */
export function canonicalDecimalUsd(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+(\.\d+)?$/u.test(trimmed)) {
    throw new Error(`USD value ${JSON.stringify(value)} must be a non-negative plain decimal`);
  }
  const [wholeRaw = "0", fractionalRaw = ""] = trimmed.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/u, "");
  const fractional = fractionalRaw.replace(/0+$/u, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : whole;
}

/** Add two decimal USD values without floating-point rounding. */
export function addDecimalUsd(left: string, right: string): string {
  const [leftWhole, leftFraction = ""] = canonicalDecimalUsd(left).split(".");
  const [rightWhole, rightFraction = ""] = canonicalDecimalUsd(right).split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const sum =
    BigInt(leftWhole + leftFraction.padEnd(scale, "0")) +
    BigInt(rightWhole + rightFraction.padEnd(scale, "0"));
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, "0");
  return canonicalDecimalUsd(`${digits.slice(0, -scale)}.${digits.slice(-scale)}`);
}

/** Compare two decimal USD values without converting them to JavaScript numbers. */
export function compareDecimalUsd(left: string, right: string): -1 | 0 | 1 {
  const [leftWhole, leftFraction = ""] = canonicalDecimalUsd(left).split(".");
  const [rightWhole, rightFraction = ""] = canonicalDecimalUsd(right).split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftScaled = BigInt(leftWhole + leftFraction.padEnd(scale, "0"));
  const rightScaled = BigInt(rightWhole + rightFraction.padEnd(scale, "0"));
  if (leftScaled === rightScaled) return 0;
  return leftScaled < rightScaled ? -1 : 1;
}
