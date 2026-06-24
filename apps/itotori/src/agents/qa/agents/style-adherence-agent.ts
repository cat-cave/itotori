// ITOTORI-021 — Style-adherence focused QA agent.
//
// Lane: voice / register mismatches against the style guide, protected-span
// preservation issues, redaction policy hits, and prohibited-language hits.
// Anything semantic (mistranslation, glossary, terminology) is OUT of lane
// — those belong to the semantic-drift, unresolved-terminology, or
// tone-register agents respectively.

import type { QaFindingCategory } from "@itotori/localization-bridge-schema";
import type { QaAgent } from "../agent.js";
import { FocusedQaAgent, type FocusedQaAgentDescriptor } from "./focused-agent.js";

export const STYLE_ADHERENCE_QA_PROMPT_VERSION = "itotori-qa-agent.style-adherence.v1" as const;

const STYLE_ADHERENCE_DIRECTIVE = [
  "FOCUSED AGENT: style-adherence.",
  "Only emit findings for: voice register mismatches against the active style guide,",
  "protected-span violations (placeholders, markup, source-unit refs not preserved),",
  "redaction policy hits (drafts that leak material the redaction policy forbids),",
  "or prohibited-language hits (drafts that contain language the style guide bans).",
  "Categories permitted: 'tone' (style register only), 'protected-span-violation',",
  "'redaction', 'other' (only when no other lane applies).",
  "DO NOT emit findings for mistranslation, semantic drift, glossary conflicts,",
  "terminology drift, or context mismatch — those are owned by other focused agents.",
].join(" ");

const STYLE_ADHERENCE_ALLOWED_CATEGORIES: ReadonlyArray<QaFindingCategory> = [
  "tone",
  "protected-span-violation",
  "redaction",
  "other",
];

export const STYLE_ADHERENCE_AGENT_DESCRIPTOR: FocusedQaAgentDescriptor = {
  name: "style-adherence",
  qaPromptVersion: STYLE_ADHERENCE_QA_PROMPT_VERSION,
  scopeDirective: STYLE_ADHERENCE_DIRECTIVE,
  allowedCategories: STYLE_ADHERENCE_ALLOWED_CATEGORIES,
};

export class StyleAdherenceQaAgent extends FocusedQaAgent {
  constructor(qaAgent: QaAgent) {
    super(qaAgent, STYLE_ADHERENCE_AGENT_DESCRIPTOR);
  }
}
