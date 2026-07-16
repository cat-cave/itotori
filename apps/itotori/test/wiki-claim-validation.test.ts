// Claim validation — mutation-falsifiable proofs over REAL decoded bytes.
//
// A claim is admissible only when each citation resolves against the immutable
// snapshot on every dimension: same-snapshot visibility, content hash, subject,
// route scope, play order, and support role. Each test below removes exactly one
// of those guarantees and asserts a loud, precisely-coded FAILURE — so deleting
// any check makes a test fail. The positive case proves a fully-resolving claim
// is admitted.

import { describe, expect, it } from "vitest";

import type { Citation, Claim, RouteScope, WikiObject } from "../src/contracts/index.js";
import {
  ClaimValidationError,
  validateClaim,
  validateWikiObjectClaims,
  type ClaimFailureCode,
} from "../src/wiki/claim-validation.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../src/wiki/evidence-index.js";
import { buildClaimFixture, unitFactIdAt } from "./support/claim-fixture.js";

const OTHER_SNAPSHOT = `sha256:${"e".repeat(64)}` as `sha256:${string}`;
const OTHER_HASH = `sha256:${"a".repeat(64)}` as `sha256:${string}`;

/** A citation that resolves against `factId` in the index, with optional
 * single-field mutations to falsify one dimension at a time. */
function citationFor(
  index: EvidenceIndex,
  factId: string,
  overrides: Partial<Citation> = {},
): Citation {
  const record = index.get(factId);
  if (!record) throw new Error(`fixture has no evidence ${factId}`);
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role: "supports",
    playOrderIndex: record.fromPlayOrder,
    ...overrides,
  };
}

function claimWith(citations: Citation[], scope: RouteScope): Claim {
  return {
    claimId: "claim:1",
    statement: "The source uses a direct register.",
    scope,
    kind: "beat",
    confidence: "high",
    citations,
  };
}

const GLOBAL: RouteScope = { kind: "global" };

function expectFailure(fn: () => void, code: ClaimFailureCode): void {
  try {
    fn();
    throw new Error(`expected a ${code} failure but validation passed`);
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimValidationError);
    expect((error as ClaimValidationError).code).toBe(code);
  }
}

describe("claim validation — every dimension must resolve", () => {
  it("PROOF: a claim with a resolving same-snapshot supporting citation is admitted", () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const factId = unitFactIdAt(snapshot, 0);
    const claim = claimWith([citationFor(index, factId)], GLOBAL);
    expect(() => validateClaim(claim, index, model)).not.toThrow();

    // The object-level entry point admits the same claim.
    const object = { claims: [claim] } as unknown as WikiObject;
    expect(() => validateWikiObjectClaims(object, model)).not.toThrow();
  });

  it("PROOF: a claim with NO citation FAILS (missing-citation)", () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    void snapshot;
    expectFailure(() => validateClaim(claimWith([], GLOBAL), index, model), "missing-citation");
  });

  it("PROOF: an unresolvable evidence hash FAILS (hash-mismatch)", () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const factId = unitFactIdAt(snapshot, 0);
    const claim = claimWith([citationFor(index, factId, { evidenceHash: OTHER_HASH })], GLOBAL);
    expectFailure(() => validateClaim(claim, index, model), "hash-mismatch");
  });

  it("PROOF: a citation to another snapshot FAILS (wrong-visibility)", () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const factId = unitFactIdAt(snapshot, 0);
    const claim = claimWith([citationFor(index, factId, { snapshotId: OTHER_SNAPSHOT })], GLOBAL);
    expectFailure(() => validateClaim(claim, index, model), "wrong-visibility");
  });

  it("PROOF: a citation to a nonexistent fact FAILS (evidence-unresolvable)", () => {
    const { model } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const record = index.get(unitFactIdAt(buildClaimFixture().snapshot, 0))!;
    const claim = claimWith(
      [
        {
          evidenceId: "unit:does-not-exist",
          evidenceHash: record.hash,
          snapshotId: record.snapshotId as `sha256:${string}`,
          subject: { kind: "unit", id: "does-not-exist" },
          role: "supports",
          playOrderIndex: 0,
        },
      ],
      GLOBAL,
    );
    expectFailure(() => validateClaim(claim, index, model), "evidence-unresolvable");
  });

  it("PROOF: a citation whose subject is wrong FAILS (subject-mismatch)", () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const factId = unitFactIdAt(snapshot, 0);
    const claim = claimWith(
      [citationFor(index, factId, { subject: { kind: "character", id: "nam-99" } })],
      GLOBAL,
    );
    expectFailure(() => validateClaim(claim, index, model), "subject-mismatch");
  });

  it("PROOF: an out-of-route citation FAILS (out-of-route)", () => {
    const { model, snapshot } = buildClaimFixture({ scene2Routes: ["route-b"] });
    const index = buildEvidenceIndex(model);
    const s2FactId = unitFactIdAt(snapshot, 3);
    const record = index.get(s2FactId)!;
    // The scene-2 evidence is route-scoped; a claim on a disjoint route cannot cite it.
    expect(record.routeScope.kind).not.toBe("global");
    const claim = claimWith([citationFor(index, s2FactId)], { kind: "route", routeId: "route-z" });
    expectFailure(() => validateClaim(claim, index, model), "out-of-route");
  });

  it("PROOF: a citation beyond the reveal horizon FAILS (beyond-play-order)", () => {
    const { model, snapshot } = buildClaimFixture({
      revealHorizon: { kind: "through-play-order", playOrderIndex: 0 },
    });
    const index = buildEvidenceIndex(model);
    const laterFactId = unitFactIdAt(snapshot, 3);
    const claim = claimWith([citationFor(index, laterFactId)], GLOBAL);
    expectFailure(() => validateClaim(claim, index, model), "beyond-play-order");
  });

  it("PROOF: a citation misdeclaring its play order FAILS (play-order-mismatch)", () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const factId = unitFactIdAt(snapshot, 3);
    const claim = claimWith([citationFor(index, factId, { playOrderIndex: 0 })], GLOBAL);
    expectFailure(() => validateClaim(claim, index, model), "play-order-mismatch");
  });

  it("PROOF: a claim with only a contradicting citation FAILS (unsupported-claim)", () => {
    const { model, snapshot } = buildClaimFixture();
    const index = buildEvidenceIndex(model);
    const factId = unitFactIdAt(snapshot, 0);
    // The citation resolves on every dimension, but its role is evidence AGAINST.
    const claim = claimWith([citationFor(index, factId, { role: "contradicts" })], GLOBAL);
    expectFailure(() => validateClaim(claim, index, model), "unsupported-claim");
  });
});
