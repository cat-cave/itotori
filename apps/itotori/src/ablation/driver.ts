// The pure-MTL ablation driver — the stripped control flow on the SAME substrate.
//
// It composes the EXACT pieces the real workflow driver does — the run-policy
// gate, the P1 draft port (the sole ZDR dispatch boundary), the deterministic
// gate port, the per-unit CAS finalize, and native patchback — but it SKIPS the
// wiki/bible/review machinery. In order, for a run:
//   1. resolve the ablation policy FIRST (null-Wiki basis, test-dev, non-shippable);
//   2. per scene (independent scenes in parallel):
//      a. restart-query the missing units (SAME durability substrate);
//      b. draft the whole scene in ONE direct P1 call with an EMPTY bible map —
//         null Wiki, no bible renderings, no readiness gate;
//      c. run the SAME deterministic gates (defects are REPORTED, never model-
//         repaired — ~zero model QA);
//      d. finalize each unit independently into the CAS, gated by the policy;
//   3. export the finalized units to a patch (SAME native patchback).
// There is deliberately NO readiness port call, NO stratified review, NO P2/P3
// correction, NO Q6 adjudication, and NO downstream Q5 Build-LQA: those are the
// agentic layer this baseline ablates away.

import { stableDigest } from "../gates/index.js";
import type { ResolvedRunPolicy } from "../run-policy/index.js";
import {
  finalizeUnits,
  missingStageUnits,
  type DraftedScene,
  type FinalizedUnit,
  type WorkflowPorts,
} from "../workflow/index.js";
import { lineageClassOf, resolveAblationPolicy } from "./policy.js";
import type {
  AblationRunReport,
  AblationRunRequest,
  AblationScene,
  AblationSceneOutcome,
} from "./types.js";

/** The null Wiki, made concrete: an EMPTY bible-rendering map handed to every
 * direct draft. No unit carries a bible rendering id, because no bible was built.
 * Shared, frozen, and empty — the physical shape of "no source-wiki grounding". */
const NULL_WIKI_BIBLE: ReadonlyMap<string, readonly string[]> = new Map();

/** A stable content hash for a finalized unit — deterministic, no clock. Mirrors
 * the real driver's finalize hashing so the CAS heads are addressed identically. */
function stableSha(...parts: readonly string[]): `sha256:${string}` {
  return `sha256:${stableDigest("unit-final", ...parts)}`;
}

/** Drive one scene through the stripped path: restart-query → direct draft →
 * deterministic gates → per-unit finalize. Produces ONLY the not-yet-final units. */
async function processAblationScene(
  scene: AblationScene,
  policy: ResolvedRunPolicy,
  ports: WorkflowPorts,
): Promise<AblationSceneOutcome> {
  const allUnitIds = scene.units.map((unit) => unit.unitId);
  // (a) Restart-query the SAME CAS substrate: produce only the missing units.
  const missing = await missingStageUnits(ports.store, allUnitIds, "final");
  const missingSet = new Set(missing);
  const skippedUnitIds = allUnitIds.filter((unitId) => !missingSet.has(unitId));
  if (missing.length === 0) {
    return {
      sceneId: scene.sceneId,
      drafted: false,
      draftedUnitIds: [],
      skippedUnitIds,
      gateDefects: [],
      finalized: [],
    };
  }

  const subScene: AblationScene = {
    sceneId: scene.sceneId,
    units: scene.units.filter((unit) => missingSet.has(unit.unitId)),
  };

  // (b) Direct translation: ONE whole-scene P1 call, null Wiki (empty bible map),
  // routed through the SAME memoized physical step so every attempt is counted in
  // the lineage. There is no readiness gate — the source unit goes near-directly
  // to a single translate call.
  const draftKey = stableDigest("ablation-draft", scene.sceneId, "whole-scene", missing);
  const draftStep = await ports.store.runMemoizedStep(draftKey, () =>
    ports.draft.draftScene({
      scene: subScene,
      mode: "whole-scene",
      bibleRenderingIdsByUnit: NULL_WIKI_BIBLE,
    }),
  );
  const drafted: DraftedScene = draftStep.value;

  // (c) The SAME deterministic gates. Defects are REPORTED for the benchmark, not
  // routed to any model reviewer / repairer — the ablation runs ~zero model QA.
  const gateReport = await ports.gates.evaluate(drafted);

  // (d) Independent per-unit CAS finalize — gated by the (non-shippable) policy.
  const { finalized } = await finalizeUnits(
    ports.store,
    policy,
    drafted.units.map((unit) => ({
      unitId: unit.unitId,
      contentHash: stableSha(scene.sceneId, unit.unitId, unit.draft.targetSkeleton),
    })),
  );

  return {
    sceneId: scene.sceneId,
    drafted: true,
    draftedUnitIds: drafted.units.map((unit) => unit.unitId),
    skippedUnitIds,
    gateDefects: gateReport.defects,
    finalized,
  };
}

/**
 * Run the pure-MTL ablation over a set of scenes. The ablation policy is resolved
 * first (the legality gate — null Wiki, test-dev, never shippable); scenes are
 * driven concurrently (independent work stays parallel); the finalized units flow
 * to native patchback. The returned report's lineage is tagged `ablation` and is
 * isolated from every qualifying run's metrics (see `./lineage.ts`).
 *
 * The `ports` are the EXACT `WorkflowPorts` the real pipeline builds
 * (`buildAblationPorts` === the production `buildLocalizationPorts`), so the P1
 * dispatch boundary, the deterministic gates, the CAS store, and native patchback
 * are the same substrate — this is a configuration of the real pipeline, not a
 * fork of it. The ablation simply never invokes the readiness / review / repair /
 * adjudicate ports.
 */
export async function runPureMtlAblation(
  request: AblationRunRequest,
  scenes: readonly AblationScene[],
  ports: WorkflowPorts,
): Promise<AblationRunReport> {
  // Gate: resolve the ablation policy FIRST. An illegal run never reaches a scene.
  const policy = resolveAblationPolicy(request);

  const sceneOutcomes = await Promise.all(
    scenes.map((scene) => processAblationScene(scene, policy, ports)),
  );

  const finalized: readonly FinalizedUnit[] = sceneOutcomes.flatMap((outcome) => outcome.finalized);

  // Native patchback — the SAME patch-export the real pipeline uses. No downstream
  // Q5 Build-LQA: that is a model QA pass the ablation deliberately omits.
  let patchId: string | null = null;
  if (finalized.length > 0) {
    const exported = await ports.patchback.exportPatch({ finalized });
    patchId = exported.patchId;
  }

  return {
    policy,
    lineageClass: lineageClassOf(policy),
    bibleBasis: policy.bibleBasis,
    runMode: policy.runMode,
    scenes: sceneOutcomes,
    finalized,
    patchId,
    attemptLineage: ports.store.attemptLineage(),
  };
}
