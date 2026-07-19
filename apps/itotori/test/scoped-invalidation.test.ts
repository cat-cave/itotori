// Pure structured-diff edge cases for field/claim-scoped invalidation.
//
// The live-Postgres proof covers persisted edges and memo/accepted hashes. These
// total-function cases pin the two cases where a broad fallback would silently
// break minimality: nullable field removal and a claim moving between routes.

import type { LlmDependentEdge } from "@itotori/db";
import { describe, expect, it } from "vitest";

import {
  computeImpactSet,
  diffUpstreamObject,
  type JsonValue,
} from "../src/wiki/scoped-invalidation/index.js";

describe("structured field/claim invalidation", () => {
  it("treats removing a nullable field as a field-scoped change", () => {
    const prior: JsonValue = {
      objectId: "wiki:voice:1",
      version: 1,
      scope: { kind: "global" },
      body: { optionalVoiceNote: null },
      claims: [],
    };
    const next: JsonValue = {
      objectId: "wiki:voice:1",
      version: 2,
      scope: { kind: "global" },
      body: {},
      claims: [],
    };

    expect(diffUpstreamObject(prior, next).fieldChanges).toEqual([
      { fieldPath: ["body", "optionalVoiceNote"], scope: { kind: "global" } },
    ]);
  });

  it("reaches exactly readers in either route when a claim moves route scope", () => {
    const prior: JsonValue = {
      objectId: "wiki:voice:1",
      version: 1,
      scope: { kind: "global" },
      body: {},
      claims: [claim("route:r1")],
    };
    const next: JsonValue = {
      objectId: "wiki:voice:1",
      version: 2,
      scope: { kind: "global" },
      body: {},
      claims: [claim("route:r2")],
    };

    const changeSet = diffUpstreamObject(prior, next);
    expect(changeSet.claimChanges).toEqual([
      {
        claimId: "claim:voice:1",
        changeKind: "modified",
        scope: { kind: "route-set", routeIds: ["route:r1", "route:r2"] },
        fromPlayOrder: 3,
        throughPlayOrder: 3,
      },
    ]);

    const impact = computeImpactSet(changeSet, [
      claimEdge("wiki:consumer:r1", "route:r1"),
      claimEdge("wiki:consumer:r2", "route:r2"),
      claimEdge("wiki:consumer:r3", "route:r3"),
    ]);
    expect(impact.consumers.map((consumer) => consumer.downstreamObjectId)).toEqual([
      "wiki:consumer:r1",
      "wiki:consumer:r2",
    ]);
  });
});

function claim(routeId: string): JsonValue {
  return {
    claimId: "claim:voice:1",
    statement: "The character uses an intimate register.",
    scope: { kind: "route", routeId },
    citations: [{ playOrderIndex: 3 }],
  };
}

function claimEdge(objectId: string, routeId: string): LlmDependentEdge {
  return {
    edgeId: `edge:${objectId}`,
    downstreamWikiVersionId: `version:${objectId}:1`,
    downstreamWikiKind: "source-object",
    downstreamObjectId: objectId,
    downstreamVersion: 1,
    upstreamObjectId: "wiki:voice:1",
    upstreamVersion: 1,
    claimId: "claim:voice:1",
    fieldPath: [],
    renderingId: null,
    scope: { kind: "route", routeId },
    fromPlayOrder: 3,
    throughPlayOrder: 3,
    downstreamEditedBy: "agent",
    downstreamProvisional: true,
  };
}
