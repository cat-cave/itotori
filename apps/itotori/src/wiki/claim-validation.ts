// Claim validation — every factual claim must be PROVABLE from the snapshot.
//
// A WikiObject's claims are model hypotheses; they are only admissible if each
// carries at least one same-snapshot evidence citation whose hash, visibility,
// route scope, play order, support role, and subject ALL resolve against the
// immutable snapshot. Any unresolved dimension is a loud FAILURE — never a
// silent pass, never a fabricated resolution. A claim with no citation, an
// unsupported claim (every citation contradicts it), an out-of-route citation,
// or a citation beyond the reveal horizon cannot be accepted. This is the gate
// the accept path runs before an object enters the Wiki.

import { routeScopeVisible, withinHorizon } from "../read-tools/access.js";
import type { ReadModel } from "../read-tools/model.js";
import type {
  Citation,
  Claim,
  EntityRef,
  LocalizedRendering,
  WikiObject,
} from "../contracts/index.js";

import { buildEvidenceIndex, type EvidenceIndex } from "./evidence-index.js";

/** Each distinct way a claim fails to resolve. Every code maps to a removed
 * guarantee: the proof suite falsifies each one independently. */
export type ClaimFailureCode =
  | "missing-citation"
  | "unsupported-claim"
  | "wrong-visibility"
  | "evidence-unresolvable"
  | "hash-mismatch"
  | "subject-mismatch"
  | "out-of-route"
  | "beyond-play-order"
  | "play-order-mismatch";

/** A loud, typed claim-validation failure. A claim that cannot be resolved
 * throws one of these rather than being admitted. */
export class ClaimValidationError extends Error {
  constructor(
    readonly code: ClaimFailureCode,
    readonly claimId: string,
    readonly evidenceId: string | null,
    detail: string,
  ) {
    super(`claim ${claimId} ${code}: ${detail}`);
    this.name = "ClaimValidationError";
  }
}

/** A citation whose role is evidence FOR the claim. A `contradicts`-only claim
 * has no support and cannot be admitted. */
const SUPPORTING_ROLES: ReadonlySet<Citation["role"]> = new Set([
  "establishes",
  "supports",
  "first-mention",
  "reveal",
]);

function entityRefEquals(left: EntityRef, right: EntityRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/** Resolve one citation against the snapshot, throwing the precise failure for
 * the first dimension that does not resolve. */
function resolveCitation(
  claim: Claim,
  citation: Citation,
  index: EvidenceIndex,
  model: ReadModel,
): void {
  // Visibility: the citation must be to THIS snapshot's evidence.
  if (citation.snapshotId !== model.snapshotId) {
    throw new ClaimValidationError(
      "wrong-visibility",
      claim.claimId,
      citation.evidenceId,
      `citation snapshot ${citation.snapshotId} is not the claim's snapshot ${model.snapshotId}`,
    );
  }
  const record = index.get(citation.evidenceId);
  if (!record) {
    throw new ClaimValidationError(
      "evidence-unresolvable",
      claim.claimId,
      citation.evidenceId,
      "no such evidence in this snapshot",
    );
  }
  // Hash: the cited evidence content must be exactly the snapshot's.
  if (record.hash !== citation.evidenceHash) {
    throw new ClaimValidationError(
      "hash-mismatch",
      claim.claimId,
      citation.evidenceId,
      `citation hash ${citation.evidenceHash} != evidence hash ${record.hash}`,
    );
  }
  // Subject: the evidence must be ABOUT the subject the citation claims.
  if (!entityRefEquals(record.subject, citation.subject)) {
    throw new ClaimValidationError(
      "subject-mismatch",
      claim.claimId,
      citation.evidenceId,
      `citation subject ${citation.subject.kind}:${citation.subject.id} != evidence subject ${record.subject.kind}:${record.subject.id}`,
    );
  }
  // Route scope: the evidence must be visible within the claim's route scope.
  if (!routeScopeVisible(record.routeScope, claim.scope)) {
    throw new ClaimValidationError(
      "out-of-route",
      claim.claimId,
      citation.evidenceId,
      "evidence is outside the claim's route scope",
    );
  }
  // Play order: the declared position must match the evidence's actual position.
  if (citation.playOrderIndex !== record.fromPlayOrder) {
    throw new ClaimValidationError(
      "play-order-mismatch",
      claim.claimId,
      citation.evidenceId,
      `citation play order ${citation.playOrderIndex} != evidence play order ${record.fromPlayOrder}`,
    );
  }
  // Reveal horizon: the evidence cannot be beyond the snapshot's reveal horizon.
  if (!withinHorizon(record.fromPlayOrder, model.revealHorizon)) {
    throw new ClaimValidationError(
      "beyond-play-order",
      claim.claimId,
      citation.evidenceId,
      "evidence is beyond the snapshot's reveal horizon",
    );
  }
}

/** Validate one claim: it must carry ≥1 citation, every citation must resolve,
 * and at least one must actually support it. */
export function validateClaim(claim: Claim, index: EvidenceIndex, model: ReadModel): void {
  if (claim.citations.length === 0) {
    throw new ClaimValidationError(
      "missing-citation",
      claim.claimId,
      null,
      "a factual claim must carry at least one evidence citation",
    );
  }
  let supported = false;
  for (const citation of claim.citations) {
    resolveCitation(claim, citation, index, model);
    if (SUPPORTING_ROLES.has(citation.role)) supported = true;
  }
  if (!supported) {
    throw new ClaimValidationError(
      "unsupported-claim",
      claim.claimId,
      null,
      "no citation supports the claim (every citation contradicts it)",
    );
  }
}

/** Validate every claim on a source WikiObject against its snapshot. Throws the
 * first {@link ClaimValidationError}; returns normally only when every claim is
 * fully provable. */
export function validateWikiObjectClaims(object: WikiObject, model: ReadModel): void {
  const index = buildEvidenceIndex(model);
  for (const claim of object.claims) validateClaim(claim, index, model);
}

/** A localized rendering carries no factual claims of its own — it renders the
 * source object's claims. Validating its claims means validating that every
 * rendered claim id belongs to a claim the source object proved. */
export function validateRenderingClaims(
  rendering: LocalizedRendering,
  sourceClaimIds: ReadonlySet<string>,
): void {
  for (const claimRendering of rendering.claimRenderings) {
    if (!sourceClaimIds.has(claimRendering.claimId)) {
      throw new ClaimValidationError(
        "evidence-unresolvable",
        claimRendering.claimId,
        null,
        "rendered claim does not exist on the source object",
      );
    }
  }
}
