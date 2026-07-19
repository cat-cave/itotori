// Assemble the blinded, meaning-only prompt for the Meaning Reviewer.
//
// The system contract states the ONE rubric (meaning preservation) and rules
// out everything else: voice, terminology, continuity, and every engine/render
// fault are another lane's job. The user message presents only the blinded
// record. The back-translation, when present, appears under an explicit SIGNAL
// heading that tells the reviewer to interpret it and never treat it as the
// verdict. Author identity never appears because `assertBlinded` runs first.

import { specialistFor } from "../../roster/index.js";
import { assertBlinded, type Q1ReviewInput } from "./inputs.js";

export const Q1_PROMPT_VERSION = "itotori.role.Q1.prompt.v1" as const;

/** The rubric boundary, stated so a removal of the guarantee is a visible diff:
 * meaning only; engine, render, voice, terminology, and continuity are elsewhere. */
const MEANING_ONLY_RUBRIC = [
  "You judge MEANING PRESERVATION only: mistranslation, dropped or added content,",
  "wrong referent, and register-inappropriate meaning.",
  "Out of your scope entirely: character voice, terminology rulings, cross-scene",
  "continuity, and every engine, glyph, layout, or render fault. Do not fail a",
  "candidate for anything outside meaning; those belong to other lanes and gates.",
  "You are blinded to who authored the candidate; judge the text, not the source.",
  "Emit exactly one verdict: PASS, FAIL, or CANNOT_ASSESS. A CANNOT_ASSESS names",
  "the evidence you still need; it is never a pass. A FAIL localises the defect,",
  "names a meaning category, cites visible evidence, and constrains the repair.",
].join(" ");

/** The system prompt = the specialist's own instructions plus the rubric wall. */
export function q1SystemPrompt(): string {
  return `${specialistFor("Q1").instructions}\n\n${MEANING_ONLY_RUBRIC}`;
}

function renderSourceFacts(input: Q1ReviewInput): string {
  return input.sourceFacts
    .map((fact) => `- (${fact.factId}) ${fact.field}: ${fact.text}`)
    .join("\n");
}

function renderNeighbors(input: Q1ReviewInput): string {
  if (input.neighbors.length === 0) return "(none)";
  return input.neighbors
    .map((window) => `- [${window.surface}] (${window.unitId}) ${window.text}`)
    .join("\n");
}

function renderLocalizedBible(input: Q1ReviewInput): string {
  return input.localizedBible.map((entry) => `- (${entry.renderingId}) ${entry.text}`).join("\n");
}

/** The back-translation section is ALWAYS labelled a signal. When absent the
 * heading still records that no signal was provided, so the reviewer never
 * confuses silence with a passing tripwire. */
function renderBackTranslationSignal(input: Q1ReviewInput): string {
  const signal = input.backTranslationSignal;
  if (signal === null) {
    return "BACK-TRANSLATION SIGNAL (interpret, never a verdict): none provided.";
  }
  return [
    "BACK-TRANSLATION SIGNAL (interpret, never a verdict):",
    `note: ${signal.note}`,
    signal.text,
  ].join("\n");
}

/** Build the blinded user message. Runs `assertBlinded` again on the parsed
 * input as a last gate before any identity could reach the wire. */
export function q1UserPrompt(input: Q1ReviewInput): string {
  assertBlinded(input);
  return [
    `UNIT: ${input.unitId}`,
    "",
    "AUTHORITATIVE SOURCE FACTS:",
    renderSourceFacts(input),
    "",
    "CANDIDATE TARGET (reviewer blinded):",
    input.candidateTarget,
    "",
    "LOCALIZED BIBLE RENDERINGS:",
    renderLocalizedBible(input),
    "",
    "NEIGHBOR WINDOWS:",
    renderNeighbors(input),
    "",
    renderBackTranslationSignal(input),
  ].join("\n");
}

export interface Q1Messages {
  readonly system: string;
  readonly user: string;
}

/** Assemble the full blinded, meaning-only message pair. */
export function assembleQ1Messages(input: Q1ReviewInput): Q1Messages {
  return { system: q1SystemPrompt(), user: q1UserPrompt(input) };
}
