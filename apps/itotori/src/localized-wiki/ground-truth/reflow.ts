// Precisely reflow ONLY the lines that cited a changed bible entry.
//
// When the bible legitimately changes (through the non-blocking edit /
// enhancement path), the downstream work is not "re-draft everything". This
// diffs the changed entry, resolves the exact recorded consumers through the
// scoped-invalidation impact set (the same content-addressed intersection the
// wiki invalidation uses), and partitions the units into the minimal reflow set
// and the preserved set. Applying the reflow re-drafts only the reflow set;
// every unrelated line is copied BYTE-IDENTICAL. A unit that never recorded a
// dependency on the changed entry is provably untouched — remove the scoping and
// an unrelated line changes, which is what the reflow proof falsifies.

import { llmSha256, type LlmDependentEdge } from "@itotori/db";

import type { LocalizedRendering } from "../../contracts/index.js";
import {
  computeImpactSet,
  diffUpstreamObject,
  type ImpactSet,
  type JsonValue,
} from "../../wiki/scoped-invalidation/index.js";
import type { UnitBibleBinding } from "./types.js";

/** One accepted line's content address — what a reflow must preserve for an
 * unrelated unit and may change for an impacted one. */
export interface UnitLineOutput {
  readonly unitId: string;
  readonly targetHash: string;
}

/** The partition of a work-scope into the minimal reflow set + the preserved
 * set, carrying the content-addressed impact set it was derived from. */
export interface BibleReflowPlan {
  readonly impactSet: ImpactSet;
  readonly reflowUnitIds: readonly string[];
  readonly preservedUnitIds: readonly string[];
}

/** Project a bible rendering into the diff body the structured diff consumes:
 * the stable object id (the rendering id), its version, scope, and the body
 * whose fields the consumers depend on. */
export function bibleEntryDiffBody(rendering: LocalizedRendering): JsonValue {
  return {
    objectId: rendering.renderingId,
    version: rendering.version,
    scope: rendering.scope as unknown as JsonValue,
    body: rendering.body as unknown as JsonValue,
  };
}

/** Flatten each unit binding's recorded dependencies into the fine-grained
 * dependent edges the impact set intersects — exactly what the store would
 * return for these consumers. `humanTouched` marks a unit whose consumer version
 * is human-authored, so it surfaces as a protected reviewer target. */
export function bindingsToEdges(
  bindings: readonly UnitBibleBinding[],
  humanTouched: ReadonlySet<string> = new Set(),
): LlmDependentEdge[] {
  const edges: LlmDependentEdge[] = [];
  for (const binding of bindings) {
    for (const dependency of binding.dependencies) {
      edges.push({
        edgeId: llmSha256({
          downstreamVersionId: binding.downstreamVersionId,
          upstreamObjectId: dependency.upstreamObjectId,
          upstreamVersion: dependency.upstreamVersion,
          claimId: dependency.claimId,
          fieldPath: [...dependency.fieldPath],
          renderingId: dependency.renderingId,
          fromPlayOrder: dependency.fromPlayOrder,
          throughPlayOrder: dependency.throughPlayOrder,
        }),
        downstreamWikiVersionId: binding.downstreamVersionId,
        downstreamWikiKind: "translation-object",
        downstreamObjectId: binding.downstreamObjectId,
        downstreamVersion: binding.downstreamVersion,
        upstreamObjectId: dependency.upstreamObjectId,
        upstreamVersion: dependency.upstreamVersion,
        claimId: dependency.claimId,
        fieldPath: dependency.fieldPath,
        renderingId: dependency.renderingId,
        scope: dependency.scope,
        fromPlayOrder: dependency.fromPlayOrder,
        throughPlayOrder: dependency.throughPlayOrder,
        downstreamEditedBy: humanTouched.has(binding.unitId) ? "human" : null,
        downstreamProvisional: false,
      });
    }
  }
  return edges;
}

/** Compute the impact set of advancing one bible entry from its prior to its
 * next body. Mirrors the invalidation service: the edges are pre-scoped to the
 * changed entry's object id before the content-addressed intersection runs. */
export function planBibleReflow(input: {
  readonly prior: JsonValue;
  readonly next: JsonValue;
  readonly edges: readonly LlmDependentEdge[];
}): ImpactSet {
  const changeSet = diffUpstreamObject(input.prior, input.next);
  const scopedEdges = input.edges.filter(
    (edge) => edge.upstreamObjectId === changeSet.upstreamObjectId,
  );
  return computeImpactSet(changeSet, scopedEdges);
}

/** Partition a work-scope's bindings into the reflow set (their downstream
 * object is an impacted consumer) and the preserved set (everything else). */
export function reflowPlanFor(
  impactSet: ImpactSet,
  bindings: readonly UnitBibleBinding[],
): BibleReflowPlan {
  const impacted = new Set(impactSet.consumers.map((consumer) => consumer.downstreamObjectId));
  const reflowUnitIds: string[] = [];
  const preservedUnitIds: string[] = [];
  for (const binding of bindings) {
    if (impacted.has(binding.downstreamObjectId)) reflowUnitIds.push(binding.unitId);
    else preservedUnitIds.push(binding.unitId);
  }
  return {
    impactSet,
    reflowUnitIds: reflowUnitIds.sort(),
    preservedUnitIds: preservedUnitIds.sort(),
  };
}

/** Apply a reflow: re-draft the reflow set (via `redraft`) and copy every
 * preserved line BYTE-IDENTICAL. The preserved outputs are the same objects,
 * so an unrelated line is provably unchanged. */
export function applyReflowedOutputs(
  priorOutputs: readonly UnitLineOutput[],
  plan: BibleReflowPlan,
  redraft: (unitId: string) => string,
): readonly UnitLineOutput[] {
  const reflow = new Set(plan.reflowUnitIds);
  return priorOutputs.map((output) =>
    reflow.has(output.unitId)
      ? { unitId: output.unitId, targetHash: redraft(output.unitId) }
      : output,
  );
}
