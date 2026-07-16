// Deterministic route + play-order overlap between a change and a consumer.
//
// A consumer is only reached by an upstream change when BOTH windows overlap:
// the route scope the consumer read the content under must intersect the route
// scope the change lives in, AND the play-order window the consumer consumed
// under must intersect the change's play window. Both tests are pure set/interval
// math — a route-set intersection and an interval overlap with unbounded ends —
// so the same inputs always decide the same way.

import type { LlmWikiScope } from "@itotori/db";

/** True when two route scopes share any route. Global overlaps everything; a
 * route overlaps an equal route or a set containing it; two sets overlap when
 * their route ids intersect. */
export function routeScopesOverlap(left: LlmWikiScope, right: LlmWikiScope): boolean {
  if (left.kind === "global" || right.kind === "global") return true;
  const leftRoutes = routeIdsOf(left);
  const rightRoutes = routeIdsOf(right);
  for (const routeId of leftRoutes) {
    if (rightRoutes.has(routeId)) return true;
  }
  return false;
}

/** True when two play-order windows intersect. A `null` bound is unbounded
 * (`from = -inf`, `through = +inf`), so a field change (no play window) reaches
 * every consumer whose route overlaps. */
export function playWindowsOverlap(
  leftFrom: number | null,
  leftThrough: number | null,
  rightFrom: number | null,
  rightThrough: number | null,
): boolean {
  const lFrom = leftFrom ?? Number.NEGATIVE_INFINITY;
  const lThrough = leftThrough ?? Number.POSITIVE_INFINITY;
  const rFrom = rightFrom ?? Number.NEGATIVE_INFINITY;
  const rThrough = rightThrough ?? Number.POSITIVE_INFINITY;
  return lFrom <= rThrough && rFrom <= lThrough;
}

function routeIdsOf(scope: Exclude<LlmWikiScope, { kind: "global" }>): ReadonlySet<string> {
  return scope.kind === "route" ? new Set([scope.routeId]) : new Set(scope.routeIds);
}
