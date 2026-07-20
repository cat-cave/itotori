// The draft assembler — the deterministic `DraftDeps` that projects a scene's
// decode facts into the P1 `localizeScene` input.
//
// The draft port (see ../../workflow-ports.ts) hands the driver's light
// `WorkflowScene` (unit identities + realization mode + per-unit bible rendering
// ids). P1 needs the COMPLETE scene's source `UnitFact`s (masking skeletons +
// protected placeholders), the flat wiki-first rendering-id basis, the run
// snapshot ids, and the realization budget. This module builds exactly that from
// the injected fact source + run config; the sole ZDR boundary is the injected
// `LocalizerRuntimeBase`, carried through untouched. Zero model calls here.

import type { LocalizeSceneInput, LocalizerRuntimeBase } from "../../../roles/p1/index.js";
import type { UnitBibleBinding } from "../../../localized-wiki/ground-truth/index.js";
import type { DraftDeps } from "../../deps.js";
import type { DraftMode, WorkflowScene } from "../../../workflow/index.js";
import type { BibleBasis } from "../../../run-policy/index.js";
import { projectSceneUnitFacts, type DecodeFactSource, type RunScopeConfig } from "./substrate.js";

/** The measured P1 realization budget: the whole-scene byte budget and the
 * overlap window used when a scene is realized in overlapping chunks. */
export interface DraftRealizationConfig {
  readonly budgetBytes: number;
  readonly overlapUnits: number;
}

/** Flatten the per-unit rendering-id map into the scene's de-duplicated,
 * stably-ordered wiki-first basis — exactly the ids the drafts must cite. */
function sceneBibleRenderingIds(
  bibleRenderingIdsByUnit: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const ids = new Set<string>();
  for (const renderingIds of bibleRenderingIdsByUnit.values()) {
    for (const id of renderingIds) ids.add(id);
  }
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Build the P1 `LocalizeSceneInput` for a scene under the chosen realization
 * mode. Deterministic projection of the decode fact source + run config. */
export function buildLocalizeSceneInput(input: {
  readonly scene: WorkflowScene;
  readonly mode: DraftMode;
  readonly bibleBasis?: BibleBasis;
  readonly bibleRenderingIdsByUnit: ReadonlyMap<string, readonly string[]>;
  readonly bibleBindingsByUnit?: ReadonlyMap<string, UnitBibleBinding>;
  readonly facts: DecodeFactSource;
  readonly config: RunScopeConfig;
  readonly budget: DraftRealizationConfig;
}): LocalizeSceneInput {
  const unitIds = input.scene.units.map((unit) => unit.unitId);
  return {
    units: projectSceneUnitFacts(unitIds, input.facts),
    bibleBasis: input.bibleBasis ?? "wiki-first",
    bibleRenderingIds: sceneBibleRenderingIds(input.bibleRenderingIdsByUnit),
    ...(input.bibleBindingsByUnit === undefined
      ? {}
      : {
          unitBible: unitIds.flatMap((unitId) => {
            const binding = input.bibleBindingsByUnit!.get(unitId);
            return binding === undefined ? [] : [{ unitId, renderings: binding.renderings }];
          }),
        }),
    contextSnapshotId: input.config.contextSnapshotId,
    localizationSnapshotId: input.config.localizationSnapshotId,
    schemaHash: input.config.schemaHash,
    budgetBytes: input.budget.budgetBytes,
    overlapUnits: input.budget.overlapUnits,
    runMode: input.config.runMode,
    contextScope: input.config.contextScope,
  };
}

/** Build the draft seam: the deterministic input assembler plus the injected P1
 * ZDR runtime the draft port dispatches through. */
export function createDraftDeps(input: {
  readonly facts: DecodeFactSource;
  readonly config: RunScopeConfig;
  readonly budget: DraftRealizationConfig;
  readonly runtime: LocalizerRuntimeBase;
}): DraftDeps {
  return {
    buildInput: (portInput) =>
      buildLocalizeSceneInput({
        scene: portInput.scene,
        mode: portInput.mode,
        bibleBasis: portInput.bibleBasis,
        bibleRenderingIdsByUnit: portInput.bibleRenderingIdsByUnit,
        ...(portInput.bibleBindingsByUnit === undefined
          ? {}
          : { bibleBindingsByUnit: portInput.bibleBindingsByUnit }),
        facts: input.facts,
        config: input.config,
        budget: input.budget,
      }),
    runtime: input.runtime,
  };
}
