// A1's representative source-language evidence comes from the strict local
// read-tool surface. The dispatch order is a deterministic fact that selects
// the sample; the decoded text itself is read through `decode_get_units` so the
// model reasons over snapshot-pinned, citeable source surfaces rather than an
// ad hoc projection of the bridge bundle.

import { decodeGetUnits, type ReadModel, type ReadToolCaller } from "../../read-tools/index.js";

import type { StyleLeadSlice } from "./spec.js";

const MAX_ROWS = 100_000;
const MAX_BYTES = 8_388_608;
const REPRESENTATIVE_SCENE_LIMIT = 3;

/** A1 reads the whole-game source context and never needs a locale branch. */
export function a1ReadToolCaller(): ReadToolCaller {
  return {
    roleId: "A1",
    routeVisibility: { kind: "global" },
    localeBranchId: null,
  };
}

/**
 * Read the first dispatched scenes that contain citeable units. The decoded
 * dispatch order remains authoritative for which scenes are representative;
 * `decode_get_units` supplies the source surfaces and fact ids A1 may cite.
 */
export function readRepresentativeStyleSlice(model: ReadModel): readonly StyleLeadSlice[] {
  const slice: StyleLeadSlice[] = [];
  const caller = a1ReadToolCaller();

  for (const sceneId of model.factSnapshot.routeTopology.sceneDispatchOrder) {
    const result = decodeGetUnits(model, caller, {
      selector: { kind: "scene", sceneId },
      maxRows: MAX_ROWS,
      maxBytes: MAX_BYTES,
    });
    if (result.facts.length === 0) continue;

    slice.push({
      sceneId: String(sceneId),
      units: result.facts.map((fact) => ({
        factId: fact.factId,
        text: fact.value.sourceSurface,
      })),
    });
    if (slice.length === REPRESENTATIVE_SCENE_LIMIT) break;
  }

  return slice;
}
