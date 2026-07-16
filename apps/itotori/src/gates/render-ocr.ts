// Gate: render / OCR facts before vision (`render-ocr`; categories `render`,
// `ocr`).
//
// After the translated bytes are patched and replayed, the deterministic render
// observations must all pass BEFORE any model vision review. This gate turns a
// `render_and_ocr` tool result into facts: a failed observation is a defect
// (`ocr-mismatch` → `ocr`, everything else → `render`), and any accepted unit
// whose decoded runtime expectation demands a trace/screenshot that no observed
// frame covered is a missing-evidence `render` defect. It never interprets
// pixels — that is the downstream vision reviewer's job.

import type { Defect, RenderAndOcrResult } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import { bindAccepted, indexUnitsByFactId } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

const RUNTIME_KINDS_REQUIRING_FRAME = new Set(["trace_text", "screenshot_region", "layout_probe"]);

export function renderOcrGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  render: RenderAndOcrResult,
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const byFactId = indexUnitsByFactId(snapshot);
  const observedUnitIds = new Set<string>();
  const defects: Defect[] = [];

  for (const frame of render.frames) {
    for (const unitId of frame.observedUnitIds) {
      observedUnitIds.add(unitId);
    }
    for (const observation of frame.observations) {
      if (observation.status === "FAIL") {
        const category = observation.kind === "ocr-mismatch" ? "ocr" : "render";
        const basis = byFactId.has(observation.unitId) ? observation.unitId : snapshot.snapshotId;
        defects.push(
          buildDefect({
            unitId: observation.unitId,
            category,
            detail: `render observation ${observation.kind} failed: ${observation.detail}`,
            basisFactIds: [basis],
          }),
        );
      }
    }
  }

  for (const { fact } of bound.values()) {
    if (
      RUNTIME_KINDS_REQUIRING_FRAME.has(fact.runtimeExpectation.expectationKind) &&
      !observedUnitIds.has(fact.factId) &&
      !observedUnitIds.has(fact.bridgeUnitId)
    ) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "render",
          detail: `unit ${fact.factId} expects runtime evidence (${fact.runtimeExpectation.expectationKind}) but no rendered frame observed it`,
          basisFactIds: [fact.factId],
        }),
      );
    }
  }
  return defects;
}
