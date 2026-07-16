// The strict write-boundary guard.
//
// A write against an existing wiki object may carry a caller-declared assertion
// of the object's category, source provenance, or route scope — the kind of
// value a stale or hostile client can forge. This guard NEVER trusts the
// declared value: it resolves the object's authoritative category / provenance /
// scope from the trusted substrate (the persisted head) and REJECTS the write
// when the declaration diverges. The write only proceeds when every asserted
// dimension matches the substrate exactly.

import type { WikiObject } from "../../contracts/index.js";
import type { WikiRouteScope } from "./read-model.js";

/** The forgeable dimensions a caller may assert about the object it is editing.
 * Every field is optional; each present field is checked against the substrate. */
export interface WikiWriteAssertion {
  /** The category (WikiObject kind) the caller believes the object has. */
  readonly category?: string;
  /** The source context snapshot the caller believes the object was built on. */
  readonly contextSnapshotId?: string;
  /** The route scope the caller believes the object is visible under. */
  readonly routeScope?: WikiRouteScope;
}

/** The dimension a forged assertion was caught on. */
export type ForgedDimension = "category" | "provenance" | "route-scope";

/** Raised when a caller-declared category / provenance / scope does not match the
 * authoritative object resolved from the substrate. The write is refused. */
export class ForgedWikiAssertionError extends Error {
  constructor(
    readonly dimension: ForgedDimension,
    readonly declared: string,
    readonly authoritative: string,
  ) {
    super(
      `wiki write rejected: forged ${dimension} — declared ${declared}, ` +
        `authoritative ${authoritative}`,
    );
    this.name = "ForgedWikiAssertionError";
  }
}

/**
 * Reject a write whose asserted category / provenance / scope is forged. The
 * `authoritative` object is the head resolved from the substrate, never a
 * caller-supplied value. A missing assertion field is not checked; a present one
 * must match exactly.
 */
export function guardWriteAssertion(
  authoritative: WikiObject,
  assertion: WikiWriteAssertion | undefined,
): void {
  if (assertion === undefined) return;
  if (assertion.category !== undefined && assertion.category !== authoritative.kind) {
    throw new ForgedWikiAssertionError("category", assertion.category, authoritative.kind);
  }
  if (
    assertion.contextSnapshotId !== undefined &&
    assertion.contextSnapshotId !== authoritative.provenance.contextSnapshotId
  ) {
    throw new ForgedWikiAssertionError(
      "provenance",
      assertion.contextSnapshotId,
      authoritative.provenance.contextSnapshotId,
    );
  }
  if (assertion.routeScope !== undefined) {
    const declared = scopeKey(assertion.routeScope);
    const authoritativeScope = scopeKey(authoritative.scope);
    if (declared !== authoritativeScope) {
      throw new ForgedWikiAssertionError("route-scope", declared, authoritativeScope);
    }
  }
}

/** A stable, order-independent key for a route scope, for exact comparison. */
function scopeKey(scope: WikiRouteScope): string {
  if (scope.kind === "route") return `route:${scope.routeId}`;
  if (scope.kind === "route-set") return `route-set:${[...scope.routeIds].sort().join(",")}`;
  return "global";
}
