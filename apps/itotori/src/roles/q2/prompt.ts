// Assemble the voice-continuity prompt for the Voice Reviewer.
//
// The system contract states the ONE rubric — VOICE and REGISTER CONTINUITY
// against the localized voice bible and the speaker's accepted target history at
// the exact position — and rules out meaning and every engine/render fault, which
// are other lanes' jobs. The user message presents the speaker, the DECODE-DERIVED
// position (counterpart/route/play), which reviewable slice this is, the bible
// rules that APPLY at the position, and the accepted history the candidate must
// stay continuous with. Applicability and history are pre-computed from the
// position, so the reviewer judges only against what actually holds where the
// line occurs.

import { specialistFor } from "../../roster/index.js";
import {
  applicableBibleRules,
  assertPositionDecodeDerived,
  historyAtPosition,
  type Q2ReviewInput,
} from "./inputs.js";

export const Q2_PROMPT_VERSION = "itotori.role.Q2.prompt.v1" as const;

/** The rubric boundary, stated so a removal of the guarantee is a visible diff:
 * voice/register continuity against the bible and accepted history only; meaning
 * and every engine/render fault belong to other lanes. */
const VOICE_ONLY_RUBRIC = [
  "You judge VOICE and REGISTER CONTINUITY only: whether the candidate keeps the",
  "speaker's voice continuous with the localized voice BIBLE and the speaker's",
  "ACCEPTED TARGET HISTORY at the exact counterpart, route, and play position.",
  "Out of your scope entirely: meaning preservation, terminology rulings, cross-",
  "scene continuity, and every engine, glyph, layout, or render fault — those",
  "belong to other lanes and deterministic gates. Do not fail a candidate for",
  "anything outside voice and register.",
  "The position is a decoded fact; judge only against the bible rules that apply",
  "there and the accepted history at that position — both are given to you.",
  "Emit exactly one verdict: PASS, FAIL, or CANNOT_ASSESS. A CANNOT_ASSESS names",
  "the evidence you still need; it is never a pass. A FAIL names a voice category,",
  "localises the span, CITES the applicable bible rule AND the accepted history",
  "line it violated, and constrains the repair.",
].join(" ");

/** The system prompt = the specialist's own instructions plus the rubric wall. */
export function q2SystemPrompt(): string {
  return `${specialistFor("Q2").instructions}\n\n${VOICE_ONLY_RUBRIC}`;
}

function renderPosition(input: Q2ReviewInput): string {
  const counterpart = input.position.counterpartId ?? "(none — base register)";
  return [
    `counterpart: ${counterpart}`,
    `route: ${input.position.routeId}`,
    `play-order: ${input.position.playOrder}`,
    `derivation: ${input.position.derivation}`,
  ].join(", ");
}

function renderApplicableRules(input: Q2ReviewInput): string {
  const rules = applicableBibleRules(input);
  if (rules.length === 0) return "(none applicable at this position)";
  return rules.map((rule) => `- (${rule.ruleId}) [${rule.scope}] ${rule.register}`).join("\n");
}

function renderHistory(input: Q2ReviewInput): string {
  const history = historyAtPosition(input);
  if (history.length === 0) return "(no accepted history yet at this position)";
  return history
    .map((line) => `- (${line.historyId}) @${line.playOrder} (${line.unitId}) ${line.text}`)
    .join("\n");
}

/** Build the voice-continuity user message. Runs `assertPositionDecodeDerived` as
 * a last gate: the reviewer never assembles a prompt for a position that is not a
 * decoded fact. */
export function q2UserPrompt(input: Q2ReviewInput): string {
  assertPositionDecodeDerived(input);
  return [
    `UNIT: ${input.unitId}`,
    `SPEAKER: ${input.speakerId}`,
    `SAMPLE: ${input.sampleKind}`,
    "",
    `DECODE-DERIVED POSITION: ${renderPosition(input)}`,
    "",
    "CANDIDATE TARGET:",
    input.candidateTarget,
    "",
    "APPLICABLE VOICE BIBLE RULES (localized; judge continuity against these):",
    renderApplicableRules(input),
    "",
    "ACCEPTED TARGET HISTORY AT THIS POSITION (stay continuous with these):",
    renderHistory(input),
  ].join("\n");
}

export interface Q2Messages {
  readonly system: string;
  readonly user: string;
}

/** Assemble the full voice-continuity message pair. */
export function assembleQ2Messages(input: Q2ReviewInput): Q2Messages {
  return { system: q2SystemPrompt(), user: q2UserPrompt(input) };
}
