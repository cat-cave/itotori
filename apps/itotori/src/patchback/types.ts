// Inputs + typed errors for the native patchback / translated-byte replay path.
//
// This module is the rehomed native apply + whole-game replay seam. It consumes
// the immutable fact snapshot (deterministic pre-pass) and the ACCEPTED OUTPUTS
// (the content-addressed accepted target per unit) — never a journal/attempt
// outcome — and drives the byte-surgical Kaifuu apply + the Utsushi replay that
// observes the translated bytes. Every input is data; there is no model call, no
// network, and no clock. Same inputs => same PatchExportV02 => same patched bytes.

import type { AcceptedOutput } from "../contracts/index.js";
import type { FactSnapshot, OrderedUnitFact } from "../prepass/index.js";

/** The unit-subject accepted output — the only accepted-output kind the
 * patchback splices (a translated target for one ordered unit). Mirrors the
 * gate module's narrowing so the patchback stays independent of `../gates`. */
export type AcceptedUnitOutput = Extract<AcceptedOutput, { subjectType: "unit" }>;

/** The set of unit fact ids the scoped localization must cover. The patchback
 * REJECTS partial coverage: every scoped id must bind to exactly one accepted,
 * source-hash-matched target, or the whole apply fails loud (no partial-flag). */
export type PatchbackWorkScope = {
  inScopeUnitFactIds: readonly string[];
};

/** The full input to the native patchback. `rawBridge` is the source-side v0.2
 * BridgeBundle the snapshot was materialized from; its `sourceBundleHash` MUST
 * equal `snapshot.source.sourceBundleHash` (apply-time integrity), else the
 * export refuses. */
export type NativePatchbackInput = {
  snapshot: FactSnapshot;
  accepted: readonly AcceptedUnitOutput[];
  rawBridge: unknown;
  workScope: PatchbackWorkScope;
  sourceLocale: string;
  targetLocale: string;
};

/** One scoped unit bound to its single accepted, source-hash-matched target. */
export type BoundScopedTarget = {
  fact: OrderedUnitFact;
  accepted: AcceptedUnitOutput;
  /** The accepted translated target text (`value.targetSkeleton`). */
  targetText: string;
};

/** Every way the accepted-output <-> scoped-unit binding can be inconsistent.
 * Each is fatal — the patchback never silently drops, substitutes, or partials. */
export type PatchbackBindingCode =
  /** A scoped unit fact id is absent from the snapshot. */
  | "unknown-scoped-unit"
  /** A scoped unit has no accepted target (partial coverage — rejected). */
  | "no-accepted-target"
  /** Two accepted outputs claim the same unit. */
  | "duplicate-accepted-target"
  /** An accepted output's source hash differs from the snapshot fact's. */
  | "source-hash-mismatch"
  /** An accepted output names a subject absent from the snapshot. */
  | "accepted-subject-not-in-snapshot"
  /** The declared work scope is empty. */
  | "empty-scope";

/** Raised when accepted outputs and the scoped snapshot units do not reconcile
 * into exactly one source-hash-matched target per scoped unit. */
export class PatchbackBindingError extends Error {
  constructor(
    public readonly code: PatchbackBindingCode,
    public readonly unitFactIds: readonly string[],
    detail: string,
  ) {
    super(
      `native patchback binding refused (${code}): ${detail}; units: ${[...unitFactIds].sort().join(", ")}`,
    );
    this.name = "PatchbackBindingError";
  }
}
