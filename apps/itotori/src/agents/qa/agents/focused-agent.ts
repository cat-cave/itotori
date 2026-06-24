// ITOTORI-021 — Focused QA agent base.
//
// Each of the four specialized QA agents (style-adherence, semantic-drift,
// tone-register, unresolved-terminology) wraps the generic `QaAgent` with:
//
//   1. A specialized prompt suffix declaring the agent's narrow scope.
//   2. A dedicated `qaPromptVersion` so recorded bundles never alias
//      between focused agents.
//   3. A closed-enum list of categories the agent is allowed to emit. A
//      finding outside the agent's lane is a hard refusal — never silently
//      dropped or relabelled — surfaced as `QaCategoryLaneError`.
//
// The base class therefore owns one responsibility: route input through
// the underlying `QaAgent` while assembling the focused prompt and
// enforcing the category lane on the way back.

import type { AuthorizationActor } from "@itotori/db";
import type { QaFinding, QaFindingCategory } from "@itotori/localization-bridge-schema";
import { QaAgent } from "../agent.js";
import type { QaInvocationInput, QaInvocationResult } from "../shapes.js";

/**
 * The four focused-agent identifiers. Each maps to exactly one prompt
 * template version + category-lane set.
 */
export const FOCUSED_QA_AGENT_NAMES = [
  "style-adherence",
  "semantic-drift",
  "tone-register",
  "unresolved-terminology",
] as const;
export type FocusedQaAgentName = (typeof FOCUSED_QA_AGENT_NAMES)[number];

/**
 * Static descriptor of a focused agent: its name, its prompt template
 * version, the system-prompt suffix that narrows its scope, and the
 * closed-enum category lane it must stay within.
 */
export type FocusedQaAgentDescriptor = {
  name: FocusedQaAgentName;
  qaPromptVersion: string;
  /**
   * System-prompt addendum appended to the focused prompt. Owns the
   * agent's domain language — what to look for and what to ignore.
   */
  scopeDirective: string;
  /**
   * Closed set of categories the agent is permitted to emit. A finding
   * with any other `category` is a hard refusal.
   */
  allowedCategories: ReadonlyArray<QaFindingCategory>;
};

/**
 * Thrown when a focused agent emits a finding whose `category` is not in
 * its declared lane. The agent NEVER coerces the finding into a different
 * lane or drops it silently — both are policy violations the spec
 * (ITOTORI-021) forbids.
 */
export class QaCategoryLaneError extends Error {
  constructor(
    public readonly agentName: FocusedQaAgentName,
    public readonly findingId: string,
    public readonly observedCategory: QaFindingCategory,
    public readonly allowedCategories: ReadonlyArray<QaFindingCategory>,
  ) {
    super(
      `focused QA agent ${agentName} refused: finding ${findingId} has category '${observedCategory}' outside the agent's lane [${allowedCategories.join(", ")}]`,
    );
    this.name = "QaCategoryLaneError";
  }
}

/**
 * Input to a focused agent's `invoke`. We accept the same shape as the
 * base `QaAgent.invokeQa` but the focused agent OWNS the `qaPromptVersion`
 * — callers MUST pass it through `input` matching the descriptor's
 * version. Mismatches throw `QaFocusedPromptVersionMismatchError` so a
 * caller can never silently invoke a focused agent on the wrong prompt
 * version (which would invalidate the recorded bundle).
 */
export type FocusedQaInvocationInput = QaInvocationInput;

export class QaFocusedPromptVersionMismatchError extends Error {
  constructor(
    public readonly agentName: FocusedQaAgentName,
    public readonly expected: string,
    public readonly observed: string,
  ) {
    super(
      `focused QA agent ${agentName} refused: qaPromptVersion '${observed}' does not match agent version '${expected}'`,
    );
    this.name = "QaFocusedPromptVersionMismatchError";
  }
}

/**
 * Result of a focused agent. Same fields as `QaInvocationResult` plus the
 * `agentName` tag so downstream aggregation can score per-agent without
 * relying on prompt-version string parsing.
 */
export type FocusedQaInvocationResult = QaInvocationResult & {
  agentName: FocusedQaAgentName;
};

/**
 * Base class shared by the four focused QA agents.
 *
 * Construction binds:
 *   - a `QaAgent` instance (the generic invocation seam) — owned by the
 *     caller so dependency injection of the underlying provider stays a
 *     concern of the workflow, NOT the focused-agent registry; and
 *   - a `FocusedQaAgentDescriptor` describing the focused lane.
 *
 * The descriptor's `scopeDirective` is injected into the input by way of
 * a synthetic style guide rule so the prompt-template renderer surfaces
 * it deterministically without changing the base prompt-template format.
 * That keeps the QA prompt template (ITOTORI-078) the single source of
 * truth for how prompts render.
 */
export abstract class FocusedQaAgent {
  constructor(
    protected readonly qaAgent: QaAgent,
    public readonly descriptor: FocusedQaAgentDescriptor,
  ) {}

  /**
   * Invoke the focused agent on the input. Returns the typed result with
   * findings constrained to the agent's category lane. Throws
   * `QaCategoryLaneError` if the underlying agent returns any
   * out-of-lane finding.
   */
  async invoke(
    actor: AuthorizationActor,
    input: FocusedQaInvocationInput,
  ): Promise<FocusedQaInvocationResult> {
    if (input.qaPromptVersion !== this.descriptor.qaPromptVersion) {
      throw new QaFocusedPromptVersionMismatchError(
        this.descriptor.name,
        this.descriptor.qaPromptVersion,
        input.qaPromptVersion,
      );
    }
    const focusedInput = this.applyScopeDirective(input);
    const baseResult = await this.qaAgent.invokeQa(actor, focusedInput);
    this.assertFindingsInLane(baseResult.findings);
    const result: FocusedQaInvocationResult = {
      ...baseResult,
      agentName: this.descriptor.name,
    };
    return result;
  }

  /**
   * Inject the focused agent's scope directive into the input by prepending
   * a synthetic style guide rule. The prompt template (ITOTORI-078) sorts
   * style guide rules deterministically by section + ruleId, so the
   * synthetic rule lands in a stable spot.
   */
  private applyScopeDirective(input: FocusedQaInvocationInput): FocusedQaInvocationInput {
    const focusRule = {
      // Section `formatting` is chosen because the synthetic rule is
      // really a meta-instruction (which categories the agent may emit),
      // not a content-style rule. Sorting by section keeps it grouped
      // away from real content rules.
      ruleId: `${this.descriptor.name}-focus-directive`,
      section: "formatting" as const,
      guidance: this.descriptor.scopeDirective,
    };
    const merged = [...input.styleGuide, focusRule];
    return { ...input, styleGuide: merged };
  }

  private assertFindingsInLane(findings: ReadonlyArray<QaFinding>): void {
    const allowed = new Set<QaFindingCategory>(this.descriptor.allowedCategories);
    for (const finding of findings) {
      if (!allowed.has(finding.category)) {
        throw new QaCategoryLaneError(
          this.descriptor.name,
          finding.findingId,
          finding.category,
          this.descriptor.allowedCategories,
        );
      }
    }
  }
}
