import type { CallSpec } from "../contracts/index.js";
import type { EgressPolicy } from "../egress/index.js";

/** The largest allowed age for a live conformance capture at admission time. */
export const LIVE_CONFORMANCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const QUALIFYING_ADMISSION_ATTESTATIONS = [
  "account-zdr",
  "certified-route",
  "live-conformance",
  "private-wire",
  "content-free-telemetry",
  "web-egress-closed",
] as const;

export type QualifyingAdmissionAttestation = (typeof QUALIFYING_ADMISSION_ATTESTATIONS)[number];

/**
 * The route fields that must be captured from every planned qualifying call.
 * This is intentionally the route-bearing subset of CallSpec: payload refs,
 * prompts, and tool arguments cannot enter this admission boundary.
 */
export type QualifyingRouteCapture = Pick<
  CallSpec,
  "roleId" | "modelProfile" | "modelProfileVersion" | "requestedModel" | "providerPolicy"
>;

/**
 * Contract consumed by the content-free qualifying telemetry lineage. The
 * current branch has no lineage implementation to import, so callers supply
 * this closed capture until that producer lands. Its exact runtime validation
 * rejects any extra field, preventing text-bearing telemetry from entering.
 */
export interface ContentFreeTelemetryCapture {
  readonly captureKind: "qualifying-content-free";
  readonly contentFree: true;
  readonly promptTextPathEnabled: false;
  readonly sourceTextPathEnabled: false;
  readonly targetTextPathEnabled: false;
}

/** Everything the gate must inspect immediately before the run can begin. */
export interface QualifyingAdmissionRequest {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly routes: readonly QualifyingRouteCapture[];
  /** Current live conformance captures; no implicit certificate fallback exists. */
  readonly certificates: readonly unknown[];
  /** Captured outbound wire policy for the planned calls, or null when absent. */
  readonly wireCapture: unknown;
  /** Content-free telemetry lineage posture, or null when it was not captured. */
  readonly telemetryCapture: unknown;
  /** The actual web-egress posture that will be passed to the run. */
  readonly egressPolicy: EgressPolicy;
  /** Injected clock keeps admission deterministic and prevents hidden wall-clock reads. */
  readonly now: Date;
}

/** Immutable proof returned only after every qualifying attestation passes. */
export interface QualifyingAdmission {
  readonly admittedAt: string;
  readonly routeCount: number;
  readonly attestations: Readonly<Record<QualifyingAdmissionAttestation, "passed">>;
}

export class QualifyingAdmissionError extends Error {
  constructor(
    readonly attestation: QualifyingAdmissionAttestation,
    detail: string,
  ) {
    super(`qualifying admission rejected at ${attestation}: ${detail}`);
    this.name = "QualifyingAdmissionError";
  }
}
