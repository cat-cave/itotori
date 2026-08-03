import type { PhysicalAttemptCostObserver } from "../llm/physical-attempt-policy.js";

export function reservationIdFor(memoKey: string, ordinal: number): string {
  return `llm:${memoKey}:${ordinal}`;
}

/** Reject fractional micros rather than inventing a rounded billed amount. */
export function exactMicrosUsd(value: string, label: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null || (match[2]?.length ?? 0) > 6) {
    throw new Error(`${label} is not representable in whole micros-USD`);
  }
  const whole = Number(match[1]);
  const fraction = `${match[2] ?? ""}${"0".repeat(6 - (match[2]?.length ?? 0))}`;
  const micros = whole * 1_000_000 + Number(fraction);
  if (!Number.isSafeInteger(micros)) throw new Error(`${label} is outside the project-run range`);
  return micros;
}

export function ceilingMicrosUsd(value: string, label: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null || (match[2]?.length ?? 0) > 18) {
    throw new Error(`${label} must be a non-negative decimal USD value`);
  }
  const whole = Number(match[1]);
  const fraction = match[2] ?? "";
  const micros =
    whole * 1_000_000 +
    Number(`${fraction.slice(0, 6)}${"0".repeat(Math.max(0, 6 - fraction.length))}`);
  if (!Number.isSafeInteger(micros)) throw new Error(`${label} is outside the project-run range`);
  return micros + (Number(fraction.slice(6) || "0") === 0 ? 0 : 1);
}

/** Spread one shared physical-call charge deterministically across its units. */
export function allocateMicros(
  amount: number,
  unitIds: readonly string[],
): ReadonlyMap<string, number> {
  const ids = [...new Set(unitIds)].sort();
  if (ids.length === 0 || amount === 0) return new Map();
  const each = Math.floor(amount / ids.length);
  const remainder = amount % ids.length;
  return new Map(ids.map((unitId, index) => [unitId, each + (index < remainder ? 1 : 0)]));
}

/** The privacy-safe progress projection of durable physical-attempt facts. */
export function terminalAttemptBlocker(
  execution: Parameters<PhysicalAttemptCostObserver["onAttemptCompleted"]>[0]["execution"],
): string {
  if (execution.kind === "completed") return "draft-failed:billing-unknown";
  const status =
    execution.failure.httpStatus === null ? "unknown" : String(execution.failure.httpStatus);
  return `draft-failed:${execution.failure.kind}:http-status:${status}:billing-unknown`;
}
