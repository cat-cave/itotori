// The field/claim-scoped invalidation surface.
//
// Given the prior and next body of one upstream object, this plans the minimal
// downstream work an editor must do: it diffs the two bodies, resolves the exact
// fine-grained consumption edges of that upstream object from the store, and
// intersects them into a content-addressed impact set. It is strictly READ-ONLY
// and model-free — it never writes a row and never calls inference, so an
// unrelated object, memo, accepted unit, or patch is provably untouched. A
// human-touched consumer surfaces as a protected reviewer target, an enhance,
// never an erase.
//
// Self-contained: it composes the wiki dependency-edge query and its own pure
// diff/impact modules, and imports no legacy execution surface.

import type { ItotoriLlmWikiRepository } from "@itotori/db";

import { computeImpactSet, type ImpactSet } from "./impact-set.js";
import { diffUpstreamObject, type JsonValue } from "./structured-diff.js";

export interface ScopedInvalidationDeps {
  readonly wiki: ItotoriLlmWikiRepository;
}

export interface InvalidationRequest {
  readonly priorObjectJson: JsonValue;
  readonly nextObjectJson: JsonValue;
}

export class ScopedInvalidationService {
  constructor(private readonly deps: ScopedInvalidationDeps) {}

  /**
   * Plan the downstream impact of advancing one upstream object from its prior
   * to its next body. Deterministic and read-only: the change set is a pure
   * function of the two bodies, and the consumers are exactly those whose
   * recorded edges cite a changed claim/field within an overlapping scope.
   */
  async planInvalidation(request: InvalidationRequest): Promise<ImpactSet> {
    const changeSet = diffUpstreamObject(request.priorObjectJson, request.nextObjectJson);
    const edges = await this.deps.wiki.queryDependents({
      upstreamObjectId: changeSet.upstreamObjectId,
    });
    return computeImpactSet(changeSet, edges);
  }
}
