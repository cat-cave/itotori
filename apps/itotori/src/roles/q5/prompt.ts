// Assemble the on-screen, build-LQA prompt for the Build-LQA Reviewer.
//
// The system contract states the ONE rubric (residual translation quality as it
// appears ON SCREEN) and rules out everything else: engine, glyph, charset,
// overflow, layout, and replay faults belong to the deterministic build gates,
// not to this judgement. The user message presents the OCR-read English target
// off the real patched-byte frame — never a decoded source line — alongside the
// expected accepted target, the bible renderings, and the deterministic render
// facts. `assertFrameObserved` runs first, so no decoded-channel observation of
// the English target can reach the wire.

import { specialistFor } from "../../roster/index.js";
import { assertFrameObserved, type Q5ReviewInput, type Q5RenderFrame } from "./inputs.js";

export const Q5_PROMPT_VERSION = "itotori.role.Q5.prompt.v1" as const;

/** The rubric boundary, stated so a removal of the guarantee is a visible diff:
 * on-screen translation quality only; every render/build fault is elsewhere. */
const BUILD_LQA_ONLY_RUBRIC = [
  "You judge RESIDUAL TRANSLATION QUALITY AS IT APPEARS ON SCREEN only: whether",
  "the English the player actually reads faithfully and readably renders the",
  "expected accepted target under the bible.",
  "You observe the English target through the render/OCR frame ONLY — the OCR",
  "text read back off the real patched bytes. Never judge the English from a",
  "decoded source text line; that channel cannot even carry it.",
  "Out of your scope entirely: engine, glyph, missing-glyph, charset, overflow,",
  "layout, and replay faults. Those are deterministic build-gate findings, never",
  "a translation defect. Do not fail a candidate for a render or build fault, and",
  "never charge such a fault to translation quality.",
  "Emit exactly one verdict: PASS, FAIL, or CANNOT_ASSESS. A CANNOT_ASSESS names",
  "the evidence you still need; it is never a pass. A FAIL localises the on-screen",
  "defect, cites the OCR evidence and the bible rule, and constrains the repair.",
].join(" ");

/** The system prompt = the specialist's own instructions plus the rubric wall. */
export function q5SystemPrompt(): string {
  return `${specialistFor("Q5").instructions}\n\n${BUILD_LQA_ONLY_RUBRIC}`;
}

function renderObservations(frame: Q5RenderFrame): string {
  if (frame.observations.length === 0) return "(none)";
  return frame.observations
    .map(
      (observation) =>
        `- [${observation.status}] ${observation.kind} (${observation.observationId}` +
        ` @ ${observation.unitId}): ${observation.detail}`,
    )
    .join("\n");
}

function renderBibleRefs(input: Q5ReviewInput): string {
  return input.bibleRenderingIds.length === 0 ? "(none)" : input.bibleRenderingIds.join(", ");
}

function renderOcrText(frame: Q5RenderFrame): string {
  return frame.ocrText.trim().length === 0 ? "(no on-screen text observed)" : frame.ocrText;
}

/** Build the on-screen user message. Runs `assertFrameObserved` again on the
 * parsed input as a last gate before any decoded-channel observation of the
 * English target could reach the wire. */
export function q5UserPrompt(input: Q5ReviewInput): string {
  assertFrameObserved(input);
  const { frame } = input;
  return [
    `UNIT: ${input.unitId}`,
    `FRAME: ${frame.frameId} (patched-bytes ${frame.patchedBytesHash})`,
    "",
    "EXPECTED ACCEPTED TARGET:",
    input.expectedTarget,
    "",
    "ON-SCREEN ENGLISH (render/OCR of the real patched bytes):",
    renderOcrText(frame),
    "",
    `LOCALIZED BIBLE RENDERINGS: ${renderBibleRefs(input)}`,
    "",
    "DETERMINISTIC RENDER/OCR FACTS (build-gate owned; not your defect):",
    renderObservations(frame),
  ].join("\n");
}

export interface Q5Messages {
  readonly system: string;
  readonly user: string;
}

/** Assemble the full on-screen, build-LQA message pair. */
export function assembleQ5Messages(input: Q5ReviewInput): Q5Messages {
  return { system: q5SystemPrompt(), user: q5UserPrompt(input) };
}
