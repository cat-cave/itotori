// The route-arc reconciliation.
//
// A4 adopts the route spine, hands the model the deterministic manifest, and
// settles every continuity link the model proposes against the decode:
//
//   - Origins PRECEDE callbacks. Both endpoints are resolved to their decoded
//     play order, and an origin that does not play strictly before its use is a
//     loud failure — the chronology cannot be reversed.
//   - Facts SETTLE contradictions. A relationship delta's timeline is stamped
//     from the two endpoints' decoded play order (earlier → later), so a model
//     that asserts a reversed or fabricated timeline is overwritten by the fact.
//   - Reveal order is DETERMINISTIC. Resolved links are ordered by play order,
//     never by the order the model happened to emit them.
//   - Unknown edges stay EXPLICIT. A link missing an endpoint, or citing one
//     that does not resolve, is surfaced as an unresolved edge — never completed
//     by inventing the missing id, never sealed as a resolved pair.

import type { ReadModel } from "../../read-tools/index.js";
import type { RouteScope, WikiObject } from "../../contracts/index.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../../wiki/evidence-index.js";

import {
  assembleRouteArc,
  revealOrderFor,
  type ResolvedArc,
  type ResolvedDelta,
  type ResolvedLink,
} from "./assemble.js";
import { adoptSpine, routeIdOf } from "./spine.js";
import {
  A4RoleError,
  type A4ArcDraft,
  type A4Context,
  type A4DeltaDraft,
  type A4LinkDraft,
  type A4ModelCaller,
  type A4RouteSpine,
  type A4UnresolvedEdge,
} from "./types.js";

/** The whole reconciliation over one adopted route spine. */
export interface A4RouteResult {
  /** The sealed, claim-validated route-arc object. */
  readonly routeArc: WikiObject;
  /** The route scope inherited from the spine — every claim carries it. */
  readonly routeScope: RouteScope;
  /** The adopted spine object id — the provable edge back to the story-so-far. */
  readonly spineObjectId: string;
  /** Every resolved link id in DETERMINISTIC reveal order (by play order). */
  readonly revealOrder: readonly string[];
  /** Edges the model proposed that could not be paired — kept EXPLICIT, never
   * invented into the arc. */
  readonly unresolvedEdges: readonly A4UnresolvedEdge[];
}

/** A resolved link before its reveal-ordered id is stamped. */
interface CandidateLink {
  readonly description: string;
  readonly originEvidenceId: string;
  readonly destinationEvidenceId: string;
  readonly originPlayOrder: number;
  readonly destinationPlayOrder: number;
  readonly confidence: "low" | "medium" | "high";
}

const DEFAULT_CONFIDENCE = "medium" as const;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The deterministic reveal-order key for a resolved link: earliest origin, then
 * earliest destination, then the endpoint ids — never the model's emission order. */
function byRevealOrder(a: CandidateLink, b: CandidateLink): number {
  return (
    a.originPlayOrder - b.originPlayOrder ||
    a.destinationPlayOrder - b.destinationPlayOrder ||
    compare(a.originEvidenceId, b.originEvidenceId) ||
    compare(a.destinationEvidenceId, b.destinationEvidenceId)
  );
}

/** Resolve one proposed link's two endpoints, or record why it cannot be paired.
 * A missing endpoint or an unresolvable id is surfaced EXPLICITLY; the missing
 * side is never invented. Returns `null` when the edge is unresolved. */
function resolveLink(
  index: EvidenceIndex,
  draft: A4LinkDraft,
  kind: "callback" | "foreshadow",
  unresolved: A4UnresolvedEdge[],
): CandidateLink | null {
  if (draft.originEvidenceId === null || draft.destinationEvidenceId === null) {
    unresolved.push({
      linkKind: kind,
      description: draft.description,
      originEvidenceId: draft.originEvidenceId,
      destinationEvidenceId: draft.destinationEvidenceId,
      gap: "missing-endpoint",
    });
    return null;
  }
  const origin = index.get(draft.originEvidenceId);
  const destination = index.get(draft.destinationEvidenceId);
  if (!origin || !destination) {
    unresolved.push({
      linkKind: kind,
      description: draft.description,
      originEvidenceId: draft.originEvidenceId,
      destinationEvidenceId: draft.destinationEvidenceId,
      gap: "unresolvable-endpoint",
    });
    return null;
  }
  return {
    description: draft.description,
    originEvidenceId: draft.originEvidenceId,
    destinationEvidenceId: draft.destinationEvidenceId,
    originPlayOrder: origin.fromPlayOrder,
    destinationPlayOrder: destination.fromPlayOrder,
    confidence: draft.confidence ?? DEFAULT_CONFIDENCE,
  };
}

/** Resolve, order, and stamp the ids for one kind of link. Enforces that every
 * emitted link's origin plays STRICTLY before its use. */
function resolveLinks(
  index: EvidenceIndex,
  drafts: readonly A4LinkDraft[],
  kind: "callback" | "foreshadow",
  routeId: string,
  unresolved: A4UnresolvedEdge[],
): ResolvedLink[] {
  const candidates: CandidateLink[] = [];
  for (const draft of drafts) {
    const resolved = resolveLink(index, draft, kind, unresolved);
    if (resolved) candidates.push(resolved);
  }
  for (const candidate of candidates) {
    if (candidate.originPlayOrder >= candidate.destinationPlayOrder) {
      throw new A4RoleError(
        "origin-not-before-callback",
        `${kind} origin ${candidate.originEvidenceId} (play ${candidate.originPlayOrder}) ` +
          `does not precede ${candidate.destinationEvidenceId} (play ${candidate.destinationPlayOrder})`,
      );
    }
  }
  candidates.sort(byRevealOrder);
  return candidates.map((candidate, ordinal) => ({
    linkId: `${kind}:${routeId}:${ordinal}`,
    description: candidate.description,
    originEvidenceId: candidate.originEvidenceId,
    destinationEvidenceId: candidate.destinationEvidenceId,
    originPlayOrder: candidate.originPlayOrder,
    destinationPlayOrder: candidate.destinationPlayOrder,
    confidence: candidate.confidence,
  }));
}

/** Stamp one relationship delta's chronology from the decode. The two endpoints'
 * decoded play orders settle the timeline — earlier endpoint is the start, later
 * is the end — so a model's asserted (reversed or fabricated) timeline is
 * dominated by the fact. Unresolved endpoints fall through to the claim gate. */
function resolveDelta(index: EvidenceIndex, draft: A4DeltaDraft): ResolvedDelta {
  const from = index.get(draft.fromEvidenceId);
  const to = index.get(draft.toEvidenceId);
  const fromPlay = from?.fromPlayOrder ?? 0;
  const toPlay = to?.fromPlayOrder ?? 0;
  return {
    counterpartId: draft.counterpartId,
    before: draft.before,
    after: draft.after,
    fromEvidenceId: draft.fromEvidenceId,
    toEvidenceId: draft.toEvidenceId,
    fromPlayOrder: Math.min(fromPlay, toPlay),
    toPlayOrder: Math.max(fromPlay, toPlay),
    confidence: draft.confidence ?? DEFAULT_CONFIDENCE,
  };
}

/** Relationship deltas are claims too: their body/claim ordinals must not vary
 * with the order an untrusted model happened to emit them. */
function byDeltaRevealOrder(left: ResolvedDelta, right: ResolvedDelta): number {
  return (
    left.fromPlayOrder - right.fromPlayOrder ||
    left.toPlayOrder - right.toPlayOrder ||
    compare(left.counterpartId, right.counterpartId) ||
    compare(left.fromEvidenceId, right.fromEvidenceId) ||
    compare(left.toEvidenceId, right.toEvidenceId)
  );
}

function revealHorizonOf(
  callbacks: readonly ResolvedLink[],
  foreshadows: readonly ResolvedLink[],
  deltas: readonly ResolvedDelta[],
): number {
  let horizon = 0;
  for (const link of [...callbacks, ...foreshadows]) {
    horizon = Math.max(horizon, link.originPlayOrder, link.destinationPlayOrder);
  }
  for (const delta of deltas) {
    horizon = Math.max(horizon, delta.fromPlayOrder, delta.toPlayOrder);
  }
  return horizon;
}

/**
 * Reconcile one route's continuity into a sealed, claim-validated route-arc. The
 * spine is ADOPTED (its coverage is proven against the decode's dispatch order),
 * the model proposes the arc, and the decode settles every timeline, ordering,
 * and pairing before the object is sealed.
 */
export async function reconcileRoute(
  model: ReadModel,
  context: A4Context,
  spine: A4RouteSpine,
  modelCaller: A4ModelCaller,
): Promise<A4RouteResult> {
  const adopted = adoptSpine(model, spine);
  const draft: A4ArcDraft = await modelCaller({
    spine,
    routeScope: adopted.routeScope,
    sourceLanguage: model.sourceLanguage,
  });
  const index = buildEvidenceIndex(model);
  const routeId = routeIdOf(adopted.routeScope);
  const unresolvedEdges: A4UnresolvedEdge[] = [];
  const callbacks = resolveLinks(index, draft.callbacks, "callback", routeId, unresolvedEdges);
  const foreshadows = resolveLinks(
    index,
    draft.foreshadows,
    "foreshadow",
    routeId,
    unresolvedEdges,
  );
  const relationshipDeltas = draft.relationshipDeltas
    .map((delta) => resolveDelta(index, delta))
    .sort(byDeltaRevealOrder);
  const arc: ResolvedArc = {
    arcSummary: draft.arcSummary,
    callbacks,
    foreshadows,
    relationshipDeltas,
    revealHorizon: revealHorizonOf(callbacks, foreshadows, relationshipDeltas),
  };
  const routeArc = assembleRouteArc(
    model,
    context,
    adopted.routeScope,
    arc,
    {
      objectId: adopted.spineObjectId,
      version: adopted.spineVersion,
      evidenceIds: adopted.evidenceIds,
    },
    unresolvedEdges,
  );
  const revealOrder = revealOrderFor(callbacks, foreshadows);
  return {
    routeArc,
    routeScope: adopted.routeScope,
    spineObjectId: adopted.spineObjectId,
    revealOrder,
    unresolvedEdges,
  };
}
