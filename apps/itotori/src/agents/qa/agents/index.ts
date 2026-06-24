// ITOTORI-021 — Focused QA agent registry surface.
//
// Re-exports the four focused agents plus the base class + shared error
// types so callers consume a single import path. The `QaAgentSet`
// aggregate is provided here so the scored-finding workflow can be
// constructed in one place without coupling each call site to the
// individual class shapes.

import type { QaAgent } from "../agent.js";
import { SemanticDriftQaAgent } from "./semantic-drift-agent.js";
import { StyleAdherenceQaAgent } from "./style-adherence-agent.js";
import { ToneRegisterQaAgent } from "./tone-register-agent.js";
import { UnresolvedTerminologyQaAgent } from "./unresolved-terminology-agent.js";

export {
  FOCUSED_QA_AGENT_NAMES,
  FocusedQaAgent,
  QaCategoryLaneError,
  QaFocusedPromptVersionMismatchError,
  type FocusedQaAgentDescriptor,
  type FocusedQaAgentName,
  type FocusedQaInvocationInput,
  type FocusedQaInvocationResult,
} from "./focused-agent.js";

export {
  StyleAdherenceQaAgent,
  STYLE_ADHERENCE_AGENT_DESCRIPTOR,
  STYLE_ADHERENCE_QA_PROMPT_VERSION,
} from "./style-adherence-agent.js";

export {
  SemanticDriftQaAgent,
  SEMANTIC_DRIFT_AGENT_DESCRIPTOR,
  SEMANTIC_DRIFT_QA_PROMPT_VERSION,
} from "./semantic-drift-agent.js";

export {
  ToneRegisterQaAgent,
  TONE_REGISTER_AGENT_DESCRIPTOR,
  TONE_REGISTER_QA_PROMPT_VERSION,
} from "./tone-register-agent.js";

export {
  UnresolvedTerminologyQaAgent,
  UNRESOLVED_TERMINOLOGY_AGENT_DESCRIPTOR,
  UNRESOLVED_TERMINOLOGY_QA_PROMPT_VERSION,
} from "./unresolved-terminology-agent.js";

/**
 * Bundle of the four focused QA agents, all pointing at (potentially
 * distinct) underlying `QaAgent` invocation seams. The workflow uses this
 * type to iterate the agents without each call site re-declaring the
 * set's shape.
 */
export type QaAgentSet = {
  styleAdherence: StyleAdherenceQaAgent;
  semanticDrift: SemanticDriftQaAgent;
  toneRegister: ToneRegisterQaAgent;
  unresolvedTerminology: UnresolvedTerminologyQaAgent;
};

/**
 * Default factory: build the four focused agents from a single base
 * `QaAgent`. Production callers wanting agent-per-provider can construct
 * the set manually with different `QaAgent` instances per agent.
 */
export function makeFocusedQaAgentSet(baseQaAgent: QaAgent): QaAgentSet {
  return {
    styleAdherence: new StyleAdherenceQaAgent(baseQaAgent),
    semanticDrift: new SemanticDriftQaAgent(baseQaAgent),
    toneRegister: new ToneRegisterQaAgent(baseQaAgent),
    unresolvedTerminology: new UnresolvedTerminologyQaAgent(baseQaAgent),
  };
}
