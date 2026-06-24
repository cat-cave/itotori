// ITOTORI-021 — Tone/register focused QA agent.
//
// Lane: tone-register and character-voice violations. Distinct from
// style-adherence in that this agent is specifically focused on
// inter-unit register drift (e.g. unit 1 uses keigo, unit 2 switches to
// casual mid-scene) and character-voice mismatches (a character speaks
// in a way that contradicts their established voice). Both surface as
// `category: 'tone'`.

import type { QaFindingCategory } from "@itotori/localization-bridge-schema";
import type { QaAgent } from "../agent.js";
import { FocusedQaAgent, type FocusedQaAgentDescriptor } from "./focused-agent.js";

export const TONE_REGISTER_QA_PROMPT_VERSION = "itotori-qa-agent.tone-register.v1" as const;

const TONE_REGISTER_DIRECTIVE = [
  "FOCUSED AGENT: tone-register.",
  "Only emit findings about register / formality shifts and character voice:",
  "intra-scene register drift (formal -> casual mid-scene),",
  "speaker-voice violations (a character speaks in a way that contradicts the",
  "voice established for that speaker in earlier units),",
  "or register clashes against the style guide's required register.",
  "Categories permitted: 'tone' (only).",
  "DO NOT emit findings for mistranslation, glossary conflicts, terminology",
  "drift, protected-span violations, redaction, or context-mismatch.",
].join(" ");

const TONE_REGISTER_ALLOWED_CATEGORIES: ReadonlyArray<QaFindingCategory> = ["tone"];

export const TONE_REGISTER_AGENT_DESCRIPTOR: FocusedQaAgentDescriptor = {
  name: "tone-register",
  qaPromptVersion: TONE_REGISTER_QA_PROMPT_VERSION,
  scopeDirective: TONE_REGISTER_DIRECTIVE,
  allowedCategories: TONE_REGISTER_ALLOWED_CATEGORIES,
};

export class ToneRegisterQaAgent extends FocusedQaAgent {
  constructor(qaAgent: QaAgent) {
    super(qaAgent, TONE_REGISTER_AGENT_DESCRIPTOR);
  }
}
