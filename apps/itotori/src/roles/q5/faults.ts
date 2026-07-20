// Route render/OCR faults to the deterministic build gates that own them.
//
// The governing guarantee of this lane: an engine, render, missing-glyph,
// charset, overflow, layout, or replay fault is a BUILD fault, not a translation
// defect. Such a fault is detected DETERMINISTICALLY off the frame observations
// — no model is consulted — and routed to the deterministic gate that owns it.
// It is NEVER charged to translation quality. This module is the deterministic
// classifier; the verdict interpreter pre-empts a translation judgement whenever
// it reports a blocking fault, so a glyph or overflow fault can never be
// laundered into a Q5 translation-quality FAIL (or silently passed off).

import { DeterministicGateSchema } from "../../contracts/index.js";
import type { Q5RenderFaultKind, Q5RenderFrame, Q5RenderObservation } from "./inputs.js";

/** A render/OCR fault kind mapped to the deterministic gate that owns it. Each
 * target is validated against the real deterministic-gate vocabulary at module
 * load, so a typo cannot invent a gate that does not exist. */
const FAULT_KIND_GATES = {
  overflow: "byte-box",
  "missing-glyph": "render-ocr",
  charset: "encoding-policy",
  layout: "render-ocr",
  "ocr-mismatch": "render-ocr",
  "replay-coverage": "render-ocr",
} as const satisfies Record<Q5RenderFaultKind, string>;

export type DeterministicGate = (typeof FAULT_KIND_GATES)[Q5RenderFaultKind];

// Prove every routed gate is a real deterministic build gate, once, at load.
for (const gate of Object.values(FAULT_KIND_GATES)) {
  DeterministicGateSchema.parse(gate);
}

/** The deterministic gate that owns a given render/OCR fault kind. */
export function gateForFaultKind(kind: Q5RenderFaultKind): DeterministicGate {
  return FAULT_KIND_GATES[kind];
}

/** One render/OCR fault, routed to the deterministic gate that owns it. It is a
 * build fault by construction — it carries no translation-quality claim. */
export interface RoutedFault {
  readonly observationId: string;
  readonly faultKind: Q5RenderFaultKind;
  readonly unitId: string;
  readonly gate: DeterministicGate;
  readonly detail: string;
}

function routeObservation(observation: Q5RenderObservation): RoutedFault {
  return {
    observationId: observation.observationId,
    faultKind: observation.kind,
    unitId: observation.unitId,
    gate: gateForFaultKind(observation.kind),
    detail: observation.detail,
  };
}

/** Every FAIL observation on the frame, routed to its deterministic gate. A PASS
 * observation is a clean fact and is not a fault. Deterministic and total: the
 * result depends only on the frame, never on any model output. */
export function deterministicFaults(frame: Q5RenderFrame): readonly RoutedFault[] {
  return frame.observations
    .filter((observation) => observation.status === "FAIL")
    .map(routeObservation);
}

/** True when the frame carries at least one render/OCR fault — i.e. the on-screen
 * surface is not a clean canvas on which residual translation quality can be
 * judged, and the unit must route to the deterministic gates instead. */
export function frameHasBlockingFault(frame: Q5RenderFrame): boolean {
  return frame.observations.some((observation) => observation.status === "FAIL");
}
