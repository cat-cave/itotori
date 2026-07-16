// Assemble the blinded adjudication prompt for one presentation order.
//
// The system contract states the ONE rubric (resolve one genuine subjective
// conflict after facts have settled) and the order-debias discipline: the same
// two positions will be judged in both A/B and B/A order; this prompt is one
// of those two presentations. The user message labels positions FIRST and
// SECOND only (never by author/model), and presents each claim with its real
// cited evidence. The model must emit exactly one binding choice as a review
// verdict, citing evidence that resolves to the supplied contest record.

import { specialistFor } from "../../roster/index.js";
import {
  assertBlinded,
  assertContestEligible,
  type Q6ContestedPosition,
  type Q6PositionLabel,
  type Q6ReviewInput,
} from "./inputs.js";

export const Q6_PROMPT_VERSION = "itotori.role.Q6.prompt.v1" as const;

/** Presentation order of the two blinded positions. */
export type Q6PresentationOrder = "A-then-B" | "B-then-A";

/** The rubric boundary: one subjective adjudication, order-debiased, bounded. */
const ADJUDICATION_RUBRIC = [
  "You adjudicate ONE genuine subjective conflict after deterministic facts and",
  "factual reviewers have already settled factual issues. You never re-litigate",
  "settled facts or low-impact cosmetic disputes.",
  "You are BLINDED: you see two contested positions and their cited evidence,",
  "never which reviewer or model produced either. Judge the claims, not the source.",
  "This call is ONE ordered presentation of the two positions (FIRST then SECOND).",
  "A separate call will present them in the reverse order; your job here is to",
  "emit a single stable judgement for THIS order only.",
  "Emit exactly one review verdict for the unit:",
  "- PASS when the unit should stand (cite evidence that supports accepting it);",
  "- FAIL with category subjective-conflict when a position's claim must bind as",
  "  a defect (localise the span, cite that position's evidence, constrain repair);",
  "- CANNOT_ASSESS when the evidence is insufficient to decide (request evidence;",
  "  never silently pass).",
  "Cite ONLY evidence ids supplied with the positions. Prefer citing evidence from",
  "exactly one position so the winning side is observable. Do not invent evidence.",
].join(" ");

/** The system prompt = the specialist's own instructions plus the rubric wall. */
export function q6SystemPrompt(): string {
  return `${specialistFor("Q6").instructions}\n\n${ADJUDICATION_RUBRIC}`;
}

/** Ordered pair of position labels for a presentation order. */
export function labelsForOrder(
  order: Q6PresentationOrder,
): readonly [Q6PositionLabel, Q6PositionLabel] {
  return order === "A-then-B" ? ["A", "B"] : ["B", "A"];
}

function renderEvidence(position: Q6ContestedPosition): string {
  return position.evidence.map((item) => `  - (${item.evidenceId}) ${item.text}`).join("\n");
}

function renderPosition(slot: "FIRST" | "SECOND", position: Q6ContestedPosition): string {
  const span =
    position.span === null
      ? "none"
      : `${position.span.spanId} @ ${position.span.surface}: ${position.span.text}`;
  return [
    `${slot} POSITION (blinded label ${position.label}):`,
    `claim: ${position.claimSummary}`,
    `asserted-verdict: ${position.verdict}`,
    `severity: ${position.severity}`,
    `category: ${position.category ?? "none"}`,
    `span: ${span}`,
    `repair-constraint: ${position.repairConstraint ?? "none"}`,
    "cited evidence:",
    renderEvidence(position),
  ].join("\n");
}

function positionOf(input: Q6ReviewInput, label: Q6PositionLabel): Q6ContestedPosition {
  const found = input.positions.find((position) => position.label === label);
  if (!found) throw new Error(`position ${label} missing from contest input`);
  return found;
}

/** Build the blinded user message for one presentation order. Eligibility and
 * blinding are re-asserted so a non-eligible or leaky contest never reaches the
 * wire. */
export function q6UserPrompt(input: Q6ReviewInput, order: Q6PresentationOrder): string {
  assertBlinded(input);
  assertContestEligible(input);
  const [firstLabel, secondLabel] = labelsForOrder(order);
  const first = positionOf(input, firstLabel);
  const second = positionOf(input, secondLabel);
  const bible =
    input.bibleRenderingIds.length === 0 ? "(none)" : input.bibleRenderingIds.join(", ");
  return [
    `UNIT: ${input.unitId}`,
    `PRESENTATION ORDER: ${order} (FIRST=${firstLabel}, SECOND=${secondLabel})`,
    `LOCALIZED BIBLE RENDERINGS: ${bible}`,
    "",
    "CONTEST (subjective, high-impact, facts settled):",
    "Judge which claim should bind. Cite real evidence only.",
    "",
    renderPosition("FIRST", first),
    "",
    renderPosition("SECOND", second),
  ].join("\n");
}

export interface Q6Messages {
  readonly system: string;
  readonly user: string;
  readonly order: Q6PresentationOrder;
}

/** Assemble the full blinded message pair for one ordered presentation. */
export function assembleQ6Messages(input: Q6ReviewInput, order: Q6PresentationOrder): Q6Messages {
  return { system: q6SystemPrompt(), user: q6UserPrompt(input, order), order };
}
