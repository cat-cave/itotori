// ITOTORI-021 — Semantic-drift focused QA agent.
//
// Lane: meaning preservation. Flags additions (draft says something the
// source did not), omissions (draft drops a source clause), substitutions
// (draft changes a referent), and context mismatches where the draft
// resolves an ambiguous source against the wrong contextual cue.

import type { QaFindingCategory } from "@itotori/localization-bridge-schema";
import type { QaAgent } from "../agent.js";
import { FocusedQaAgent, type FocusedQaAgentDescriptor } from "./focused-agent.js";

export const SEMANTIC_DRIFT_QA_PROMPT_VERSION = "itotori-qa-agent.semantic-drift.v1" as const;

const SEMANTIC_DRIFT_DIRECTIVE = [
  "FOCUSED AGENT: semantic-drift.",
  "Only emit findings where the draft's meaning diverges from the source:",
  "additions (information present in the draft but absent in the source),",
  "omissions (information present in the source but dropped in the draft),",
  "substitutions or referent changes that alter who/what is being described,",
  "or context-resolution errors (ambiguous source resolved against incorrect context).",
  "Categories permitted: 'mistranslation', 'context-mismatch', 'other'.",
  "DO NOT emit findings for tone, register, glossary conflicts, terminology drift,",
  "protected-span violations, or redaction — those are owned by other focused agents.",
].join(" ");

const SEMANTIC_DRIFT_ALLOWED_CATEGORIES: ReadonlyArray<QaFindingCategory> = [
  "mistranslation",
  "context-mismatch",
  "other",
];

export const SEMANTIC_DRIFT_AGENT_DESCRIPTOR: FocusedQaAgentDescriptor = {
  name: "semantic-drift",
  qaPromptVersion: SEMANTIC_DRIFT_QA_PROMPT_VERSION,
  scopeDirective: SEMANTIC_DRIFT_DIRECTIVE,
  allowedCategories: SEMANTIC_DRIFT_ALLOWED_CATEGORIES,
};

export class SemanticDriftQaAgent extends FocusedQaAgent {
  constructor(qaAgent: QaAgent) {
    super(qaAgent, SEMANTIC_DRIFT_AGENT_DESCRIPTOR);
  }
}
