// Assemble + validate the A4 route-arc WikiObject.
//
// The model proposes an arc summary and continuity links; this module turns the
// RESOLVED links and deltas into a strict source-language `route-arc` object.
// Two invariants are enforced HERE, not trusted from the model:
//
//   1. Citations are INDEX-DERIVED. Every endpoint a link pairs is cited, and
//      the citation's hash, subject, and play order are copied from the snapshot
//      evidence index — never from the model. A cited id outside the visible
//      snapshot yields an unresolvable citation and the claim gate throws, so a
//      pair the model could not ground can never be sealed as resolved.
//   2. Both endpoints of every callback / foreshadow are PAIRED and cited. A
//      link is a single claim carrying two supporting citations; there is no
//      shape in which one endpoint is emitted without the other.

import {
  WikiObjectSchema,
  type Citation,
  type Claim,
  type DependencyRef,
  type RouteScope,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../../wiki/evidence-index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import { A4_ROLE_ID, A4_ROUTE_ARC_KIND, type A4Context, type A4UnresolvedEdge } from "./types.js";
import { routeIdOf } from "./spine.js";

const UNRESOLVABLE_HASH = `sha256:${"0".repeat(64)}` as `sha256:${string}`;

/** One continuity link whose two endpoints both resolved in the snapshot, with
 * the DETERMINISTIC play order of each endpoint carried alongside. */
export interface ResolvedLink {
  readonly linkId: string;
  readonly description: string;
  readonly originEvidenceId: string;
  readonly destinationEvidenceId: string;
  readonly originPlayOrder: number;
  readonly destinationPlayOrder: number;
  readonly confidence: "low" | "medium" | "high";
}

/** One relationship delta whose bounding endpoints both resolved, with the
 * chronology STAMPED from the decode (from = earlier endpoint, to = later). */
export interface ResolvedDelta {
  readonly counterpartId: string;
  readonly before: string;
  readonly after: string;
  readonly fromEvidenceId: string;
  readonly toEvidenceId: string;
  readonly fromPlayOrder: number;
  readonly toPlayOrder: number;
  readonly confidence: "low" | "medium" | "high";
}

/** The complete, resolved arc the assembler seals into one route-arc object. */
export interface ResolvedArc {
  readonly arcSummary: string;
  readonly callbacks: readonly ResolvedLink[];
  readonly foreshadows: readonly ResolvedLink[];
  readonly relationshipDeltas: readonly ResolvedDelta[];
  readonly revealHorizon: number;
}

/** The immutable upstream story dependency: its final cited evidence becomes the
 * route-level arc claim's anchor rather than a model-invented summary citation. */
export interface RouteArcSpineDependency {
  readonly objectId: string;
  readonly version: number;
  readonly evidenceIds: readonly string[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The persisted cross-kind continuity reveal order. Link arrays stay grouped by
 * kind for consumers, while this order records how the route exposes them in
 * deterministic decoded play order rather than model emission order. */
export function revealOrderFor(
  callbacks: readonly ResolvedLink[],
  foreshadows: readonly ResolvedLink[],
): readonly string[] {
  return [...callbacks, ...foreshadows]
    .sort(
      (left, right) =>
        left.originPlayOrder - right.originPlayOrder ||
        left.destinationPlayOrder - right.destinationPlayOrder ||
        compare(left.linkId, right.linkId),
    )
    .map((link) => link.linkId);
}

/** Build one citation for a resolved endpoint id. Every dimension a citation is
 * checked on — hash, subject, play order — is copied from the snapshot evidence
 * index when the id resolves. When it does NOT, the citation is deliberately
 * left unresolvable so the claim gate rejects it: a pair that could not be
 * grounded cannot masquerade as resolved. */
function citationFor(
  index: EvidenceIndex,
  snapshotId: string,
  unitId: string,
  role: Citation["role"],
): Citation {
  const record = index.get(unitId);
  if (!record) {
    return {
      evidenceId: unitId,
      evidenceHash: UNRESOLVABLE_HASH,
      snapshotId: snapshotId as `sha256:${string}`,
      subject: { kind: "unit", id: unitId },
      role,
      playOrderIndex: 0,
    };
  }
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash as `sha256:${string}`,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role,
    playOrderIndex: record.fromPlayOrder,
  };
}

function linkClaim(
  index: EvidenceIndex,
  snapshotId: string,
  scope: RouteScope,
  routeId: string,
  kind: "callback" | "foreshadow",
  link: ResolvedLink,
  ordinal: number,
): Claim {
  const originRole = kind === "callback" ? "establishes" : "first-mention";
  return {
    claimId: `route-arc:${routeId}:${kind}:${ordinal}`,
    statement: link.description,
    scope,
    kind,
    confidence: link.confidence,
    citations: [
      citationFor(index, snapshotId, link.originEvidenceId, originRole),
      citationFor(index, snapshotId, link.destinationEvidenceId, "reveal"),
    ],
  };
}

/** The route summary is itself a provisional `arc` claim. Its evidence comes
 * from the adopted final story-so-far and is resolved again through the current
 * snapshot, so the summary cannot become uncited prose. */
function arcClaim(
  index: EvidenceIndex,
  snapshotId: string,
  scope: RouteScope,
  routeId: string,
  arc: ResolvedArc,
  evidenceIds: readonly string[],
): Claim {
  return {
    claimId: `route-arc:${routeId}:arc`,
    statement: arc.arcSummary,
    scope,
    kind: "arc",
    confidence: "medium",
    citations: evidenceIds.map((evidenceId) =>
      citationFor(index, snapshotId, evidenceId, "supports"),
    ),
  };
}

function deltaClaim(
  index: EvidenceIndex,
  snapshotId: string,
  scope: RouteScope,
  routeId: string,
  delta: ResolvedDelta,
  ordinal: number,
): Claim {
  return {
    claimId: `route-arc:${routeId}:relationship:${ordinal}`,
    statement: `${delta.counterpartId}: ${delta.before} → ${delta.after}`,
    scope,
    kind: "relationship",
    confidence: delta.confidence,
    citations: [
      citationFor(index, snapshotId, delta.fromEvidenceId, "establishes"),
      citationFor(index, snapshotId, delta.toEvidenceId, "supports"),
    ],
  };
}

function provenance(model: ReadModel, context: A4Context) {
  return {
    snapshotKind: "context" as const,
    contextSnapshotId: model.snapshotId,
    contextScope: context.contextScope,
    runMode: context.runMode,
    authorRoleId: A4_ROLE_ID,
  };
}

/** Parse the candidate through the strict WikiObject write gate, then prove every
 * claim against the snapshot. Returns the immutable, provable object. */
function seal(candidate: unknown, model: ReadModel): WikiObject {
  const object = WikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}

/**
 * Assemble the source-language `route-arc` for one route. The body carries the
 * arc summary, the paired callback / foreshadow links, and the fact-stamped
 * relationship deltas; the object DEPENDS on the adopted spine, so the
 * reconciliation is a provable edge back to the story-so-far it reasoned over.
 * Every claim cites index-resolved endpoints or the object fails to validate.
 */
export function assembleRouteArc(
  model: ReadModel,
  context: A4Context,
  scope: RouteScope,
  arc: ResolvedArc,
  spine: RouteArcSpineDependency,
  unresolvedEdges: readonly A4UnresolvedEdge[] = [],
): WikiObject {
  const index = buildEvidenceIndex(model);
  const routeId = routeIdOf(scope);
  const claims: Claim[] = [
    arcClaim(index, model.snapshotId, scope, routeId, arc, spine.evidenceIds),
    ...arc.callbacks.map((link, ordinal) =>
      linkClaim(index, model.snapshotId, scope, routeId, "callback", link, ordinal),
    ),
    ...arc.foreshadows.map((link, ordinal) =>
      linkClaim(index, model.snapshotId, scope, routeId, "foreshadow", link, ordinal),
    ),
    ...arc.relationshipDeltas.map((delta, ordinal) =>
      deltaClaim(index, model.snapshotId, scope, routeId, delta, ordinal),
    ),
  ];
  const dependencies: DependencyRef[] = [
    {
      upstreamObjectId: spine.objectId,
      upstreamVersion: spine.version,
      claimId: null,
      fieldPath: ["summary"],
      renderingId: null,
      scope,
      fromPlayOrder: null,
      throughPlayOrder: null,
    },
  ];
  return seal(
    {
      schemaVersion: "itotori.wiki-object.v1",
      objectId: `route-arc:${routeId}`,
      version: 1,
      lang: model.sourceLanguage,
      subject: { kind: "route", id: routeId },
      scope,
      claims,
      media: [],
      dependencies,
      // This is analyst interpretation over facts, never a replacement fact.
      // It stays revisable until the Wiki acceptance workflow promotes it.
      provisional: true,
      kind: A4_ROUTE_ARC_KIND,
      body: {
        routeId,
        arcSummary: arc.arcSummary,
        callbacks: arc.callbacks.map((link) => ({
          linkId: link.linkId,
          originEvidenceId: link.originEvidenceId,
          destinationEvidenceId: link.destinationEvidenceId,
          description: link.description,
        })),
        foreshadows: arc.foreshadows.map((link) => ({
          linkId: link.linkId,
          originEvidenceId: link.originEvidenceId,
          destinationEvidenceId: link.destinationEvidenceId,
          description: link.description,
        })),
        relationshipDeltas: arc.relationshipDeltas.map((delta) => ({
          counterpartId: delta.counterpartId,
          fromPlayOrder: delta.fromPlayOrder,
          toPlayOrder: delta.toPlayOrder,
          before: delta.before,
          after: delta.after,
        })),
        revealOrder: revealOrderFor(arc.callbacks, arc.foreshadows),
        unresolvedEdges: unresolvedEdges.map((edge) => ({ ...edge })),
        revealHorizon: arc.revealHorizon,
      },
      provenance: provenance(model, context),
    },
    model,
  );
}
