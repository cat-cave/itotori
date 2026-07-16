// Assemble the terminology-audit prompt for the Terminology Auditor.
//
// The system contract states the ONE rubric — contextual sense and register of
// ALREADY-APPROVED forms, plus genuinely new ambiguous coinages — and rules out
// exact matching, which the deterministic gate upstream already owns. The user
// message presents the candidate, the exact-gate outcome (always cleared here,
// so the auditor never re-checks the surface), the approved forms it grounds
// against, the ruling references, and neighbor windows. The auditor may REFER a
// cited source candidate back to the ruling lane; it must never invent or approve
// a target form.

import { specialistFor } from "../../roster/index.js";
import { assertExactGateCleared, EXACT_GATE, type Q3ReviewInput } from "./inputs.js";

export const Q3_PROMPT_VERSION = "itotori.role.Q3.prompt.v1" as const;

/** The rubric boundary, stated so a removal of the guarantee is a visible diff:
 * sense and register of approved forms and new coinages only; exact matching is
 * the deterministic gate's, and no target form may be invented or approved. */
const TERMINOLOGY_ONLY_RUBRIC = [
  "You run ONLY AFTER the exact glossary and name gate has cleared this unit.",
  "You judge the CONTEXTUAL SENSE and REGISTER of forms the glossary has ALREADY",
  "approved, or flag a genuinely NEW ambiguous coinage that has no ruling yet.",
  "Exact matching is NOT yours: a surface that mismatches an approved form is a",
  `deterministic ${EXACT_GATE} defect, never your verdict.`,
  "You may REFER a cited source candidate back to the ruling lane for a decision,",
  "but you must never invent or approve a target form, and never contradict an",
  "already-approved glossary form — route it back, do not overwrite it.",
  "Emit exactly one verdict: PASS, FAIL, or CANNOT_ASSESS. A CANNOT_ASSESS names",
  "the evidence you still need; it is never a pass. A FAIL localises the term,",
  "names a terminology category, cites visible evidence, and constrains the repair.",
].join(" ");

/** The system prompt = the specialist's own instructions plus the rubric wall. */
export function q3SystemPrompt(): string {
  return `${specialistFor("Q3").instructions}\n\n${TERMINOLOGY_ONLY_RUBRIC}`;
}

function renderApprovedTerms(input: Q3ReviewInput): string {
  if (input.approvedTerms.length === 0) return "(none in this unit)";
  return input.approvedTerms
    .map((term) => `- (${term.termId}) ${term.sourceForm} → ${term.approvedTargetForm}`)
    .join("\n");
}

function renderRulingRefs(input: Q3ReviewInput): string {
  return input.termRulingIds.length === 0 ? "(none)" : input.termRulingIds.join(", ");
}

function renderNeighbors(input: Q3ReviewInput): string {
  if (input.neighbors.length === 0) return "(none)";
  return input.neighbors
    .map((window) => `- [${window.surface}] (${window.unitId}) ${window.text}`)
    .join("\n");
}

/** Build the terminology-audit user message. Runs `assertExactGateCleared` as a
 * last gate: the auditor never assembles a prompt for a unit the exact gate has
 * not cleared. */
export function q3UserPrompt(input: Q3ReviewInput): string {
  assertExactGateCleared(input);
  return [
    `UNIT: ${input.unitId}`,
    "",
    `EXACT GATE (${input.exactGate.gate}): ${input.exactGate.status} — surfaces already verified.`,
    "",
    "CANDIDATE TARGET:",
    input.candidateTarget,
    "",
    "APPROVED GLOSSARY FORMS (authoritative; judge their sense, do not re-decide them):",
    renderApprovedTerms(input),
    "",
    `TERM RULING REFERENCES: ${renderRulingRefs(input)}`,
    "",
    "NEIGHBOR WINDOWS:",
    renderNeighbors(input),
  ].join("\n");
}

export interface Q3Messages {
  readonly system: string;
  readonly user: string;
}

/** Assemble the full terminology-audit message pair. */
export function assembleQ3Messages(input: Q3ReviewInput): Q3Messages {
  return { system: q3SystemPrompt(), user: q3UserPrompt(input) };
}
