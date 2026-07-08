// The closed status vocabulary + its derived three-tone mapping.
// Source: docs/design/itotori-design-system.md §Voice.
//
// Status is a CLOSED lowercase vocabulary rendered as badges; tone is DERIVED
// from the status string (never sentence-cased, never free-text). Downstream UI
// nodes must map every product status through `statusTone` rather than picking a
// colour by hand — that keeps the badge palette a single source of truth.

export const STATUS_VOCABULARY = [
  "pending",
  "in_review",
  "drafting",
  "proven",
  "succeeded",
  "running",
  "failed",
  "stale",
  "accepted",
  "rejected",
  "blocker",
  "warning",
  "captured",
  "runtime-faithful",
] as const;

export type Status = (typeof STATUS_VOCABULARY)[number];

/** The three badge tones the design language allows. */
export type StatusTone = "neutral" | "ok" | "critical";

const OK_STATUSES = new Set<string>([
  "proven",
  "succeeded",
  "accepted",
  "captured",
  "runtime-faithful",
]);

const CRITICAL_STATUSES = new Set<string>(["failed", "rejected", "blocker"]);

/**
 * Derive the badge tone from a status string. Mint "ok" for evidence/success
 * states, coral "critical" for failure/rejection/blocker, neutral for the rest
 * (pending / in_review / drafting / running / stale / warning). Unknown strings
 * fall through to neutral so a new product status never renders as an error.
 */
export function statusTone(status: string): StatusTone {
  if (CRITICAL_STATUSES.has(status)) return "critical";
  if (OK_STATUSES.has(status)) return "ok";
  return "neutral";
}

/** Whether a string is part of the closed, agreed status vocabulary. */
export function isKnownStatus(status: string): status is Status {
  return (STATUS_VOCABULARY as readonly string[]).includes(status);
}
