// Output-scope classification — deliberately separate from context scope.
//
// Context tells a run what it may READ; this table tells it which decoded text
// surfaces it may WRITE. The tiers are cumulative, and a surface omitted by a
// tier is not an error or a context reduction: it remains available to the
// source Wiki and bible but is excluded from drafting/finalization.

import type { OutputScope } from "./types.js";

const DIALOGUE_SURFACES = ["dialogue", "narration"] as const;
const CHOICE_SURFACES = [...DIALOGUE_SURFACES, "choice_label"] as const;
const UI_SURFACES = [
  ...CHOICE_SURFACES,
  "speaker_name",
  "ui_label",
  "tutorial_text",
  "database_entry",
  "metadata_text",
] as const;

/** The concrete decoded surfaces each bounded output tier may finalize. `all`
 * deliberately accepts every supported surface, including asset text. */
export const OUTPUT_SCOPE_SURFACES: Readonly<
  Record<Exclude<OutputScope, "all">, readonly string[]>
> = Object.freeze({
  "dialogue-only": DIALOGUE_SURFACES,
  "dialogue-and-choices": CHOICE_SURFACES,
  "dialogue-choices-ui": UI_SURFACES,
});

/** Whether a decoded surface belongs to the requested output tier. Unknown
 * surfaces fail closed for every bounded tier; only an explicit `all` may carry
 * them through. */
export function outputScopeIncludesSurface(outputScope: OutputScope, surfaceKind: string): boolean {
  if (outputScope === "all") return true;
  return OUTPUT_SCOPE_SURFACES[outputScope].includes(surfaceKind);
}
