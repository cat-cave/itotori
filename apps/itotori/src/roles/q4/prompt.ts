// Assemble the route-bound, continuity-only prompt for the Continuity Reviewer.
//
// The system contract states the ONE rubric — callback / foreshadow /
// relationship / route-arc consistency — and rules out everything else: meaning,
// voice, and engine faults belong to other reviewers and the deterministic
// gates, never to this judgement. The user message presents the unit under
// review, its localized line, the route the review is bound to, the localized
// bible, and the accepted origin translations it may cite. A contradiction must
// cite BOTH endpoints, and the reviewer is told the origin's precedence in play
// order and the endpoints' route membership are proven deterministically — it
// may not assert them.

import { specialistFor } from "../../roster/index.js";
import { type RouteScope } from "../../contracts/index.js";
import { type Q4ReviewInput } from "./inputs.js";

export const Q4_PROMPT_VERSION = "itotori.role.Q4.prompt.v1" as const;

/** The rubric boundary, stated so a removal of the guarantee is a visible diff:
 * continuity only; a contradiction cites both endpoints; precedence and route
 * membership are decided by the decode, not by the reviewer. */
const CONTINUITY_ONLY_RUBRIC = [
  "You judge CONTINUITY only: callback, foreshadow, relationship, and route-arc",
  "consistency of the localized line against the localized route and character",
  "bible and the accepted origin translations.",
  "Out of your scope entirely: meaning fidelity, character voice and register,",
  "terminology, and any engine, glyph, layout, or render fault. Those belong to",
  "the other reviewers and the deterministic gates — never fail a line for them.",
  "A contradiction finding MUST cite BOTH endpoints: the ORIGIN unit that",
  "established the fact and the USE unit under review. The origin must play BEFORE",
  "the use; play order is decided deterministically from the decode, so cite the",
  "real origin unit and do not assert its timing yourself.",
  "Every endpoint you cite must lie ON the route this review is bound to. A",
  "continuity claim that crosses into another route is rejected.",
  "Emit exactly one verdict: PASS, FAIL, or CANNOT_ASSESS. A CANNOT_ASSESS names",
  "the evidence you still need; it is never a pass. A FAIL names the continuity",
  "category, cites both endpoints, and constrains the repair.",
].join(" ");

/** The system prompt = the specialist's own instructions plus the rubric wall. */
export function q4SystemPrompt(): string {
  return `${specialistFor("Q4").instructions}\n\n${CONTINUITY_ONLY_RUBRIC}`;
}

/** Render the route the review is bound to, so it appears verbatim on the wire. */
export function renderReviewScope(scope: RouteScope): string {
  if (scope.kind === "global") return "global (whole-game)";
  if (scope.kind === "route") return `route ${scope.routeId}`;
  return `route-set ${scope.routeIds.join(", ")}`;
}

function renderOriginTranslations(input: Q4ReviewInput): string {
  if (input.originTranslations.length === 0) return "(none)";
  return input.originTranslations
    .map((origin) => `- ${origin.unitId}: ${origin.acceptedTarget}`)
    .join("\n");
}

function renderBibleRefs(input: Q4ReviewInput): string {
  return input.bibleRenderingIds.length === 0 ? "(none)" : input.bibleRenderingIds.join(", ");
}

/** Build the route-bound continuity user message. */
export function q4UserPrompt(input: Q4ReviewInput): string {
  return [
    `UNIT UNDER REVIEW (the USE site): ${input.unitId}`,
    `REVIEW ROUTE SCOPE: ${renderReviewScope(input.reviewScope)}`,
    "",
    "LOCALIZED LINE:",
    input.currentTarget,
    "",
    `LOCALIZED BIBLE RENDERINGS: ${renderBibleRefs(input)}`,
    "",
    "ACCEPTED ORIGIN TRANSLATIONS (candidate continuity endpoints):",
    renderOriginTranslations(input),
  ].join("\n");
}

export interface Q4Messages {
  readonly system: string;
  readonly user: string;
}

/** Assemble the full route-bound, continuity message pair. */
export function assembleQ4Messages(input: Q4ReviewInput): Q4Messages {
  return { system: q4SystemPrompt(), user: q4UserPrompt(input) };
}
