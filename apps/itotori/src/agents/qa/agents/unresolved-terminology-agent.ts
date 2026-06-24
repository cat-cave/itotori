// ITOTORI-021 — Unresolved-terminology focused QA agent.
//
// Lane: glossary conflicts and ad-hoc translations of terms the glossary
// already pins. Flags drafts that translate a glossary-listed source form
// in a way that contradicts the preferred target form (or its policy
// action), and drafts that introduce ad-hoc translations of terms that
// SHOULD be glossary-registered.

import type { QaFindingCategory } from "@itotori/localization-bridge-schema";
import type { QaAgent } from "../agent.js";
import { FocusedQaAgent, type FocusedQaAgentDescriptor } from "./focused-agent.js";

export const UNRESOLVED_TERMINOLOGY_QA_PROMPT_VERSION =
  "itotori-qa-agent.unresolved-terminology.v1" as const;

const UNRESOLVED_TERMINOLOGY_DIRECTIVE = [
  "FOCUSED AGENT: unresolved-terminology.",
  "Only emit findings about glossary / terminology coverage:",
  "glossary conflicts (draft renders a glossary-listed source form with a target",
  "form that contradicts the glossary's preferredTargetForm or policyAction),",
  "and terminology drift (draft translates a recurring term ad-hoc when the",
  "term is glossary-registered earlier in the corpus or SHOULD be).",
  "Categories permitted: 'glossary-conflict', 'terminology-drift'.",
  "DO NOT emit findings for mistranslation, tone, protected-span violations,",
  "redaction, context-mismatch, or 'other'.",
].join(" ");

const UNRESOLVED_TERMINOLOGY_ALLOWED_CATEGORIES: ReadonlyArray<QaFindingCategory> = [
  "glossary-conflict",
  "terminology-drift",
];

export const UNRESOLVED_TERMINOLOGY_AGENT_DESCRIPTOR: FocusedQaAgentDescriptor = {
  name: "unresolved-terminology",
  qaPromptVersion: UNRESOLVED_TERMINOLOGY_QA_PROMPT_VERSION,
  scopeDirective: UNRESOLVED_TERMINOLOGY_DIRECTIVE,
  allowedCategories: UNRESOLVED_TERMINOLOGY_ALLOWED_CATEGORIES,
};

export class UnresolvedTerminologyQaAgent extends FocusedQaAgent {
  constructor(qaAgent: QaAgent) {
    super(qaAgent, UNRESOLVED_TERMINOLOGY_AGENT_DESCRIPTOR);
  }
}
