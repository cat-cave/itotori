// Build the dispatch request for the Adjudicator.
//
// The adjudicator calls exactly one model — the certified deepseek-v4-flash
// judge profile — through the single ZDR dispatch boundary. This module names
// NO provider and pins NO model: it RESOLVES the role's certified profile
// (capability + ZDR + automatic fallback) and stamps the CallSpec from it.
//
// `assertCertifiedJudgeRoute` re-proves that binding at the PUBLIC dispatch
// entry in EVERY run mode — including test-dev. A run mode is not an escape
// hatch: a spec whose route drifts from the certified judge profile is refused
// before a byte leaves, whatever the mode.
//
// Order-debiasing builds TWO CallSpecs (A-then-B and B-then-A) for one contest.
// That is the entire adjudication budget — no further round-trips.

import {
  CALL_SPEC_SCHEMA_VERSION,
  CallSpecSchema,
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallSpec,
  type EncryptedPayloadRef,
  type ToolName,
} from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";
import { specialistFor, toolsForRole } from "../../roster/index.js";
import { assertBlinded, assertContestEligible, type Q6ReviewInput } from "./inputs.js";
import { assembleQ6Messages, Q6_PROMPT_VERSION, type Q6PresentationOrder } from "./prompt.js";

/** The adjudicator role this module configures. Data, not an auth decision. */
const Q6_ROLE = "Q6" as const;

/** Tool surfaces that drive the screen or leave the ZDR envelope. None belongs
 * to a pure adjudication judgement over pre-supplied contested evidence. */
const NON_ADJUDICATION_TOOLS: readonly ToolName[] = [
  "render_and_ocr",
  "web_search",
  "back_translate",
];

/** The adjudicator's local read grant, derived from the permission table. */
export function q6AdjudicationToolGrant(): readonly ToolName[] {
  return toolsForRole(Q6_ROLE);
}

/** Thrown if the derived grant ever includes a screen or egress surface. */
export class Q6RubricScopeError extends Error {
  constructor(tool: ToolName) {
    super(`adjudicator must not be granted the non-adjudication tool ${tool}`);
    this.name = "Q6RubricScopeError";
  }
}

/** Prove the adjudication grant stays inside the adjudication rubric. */
export function assertAdjudicationOnlyToolGrant(): void {
  const grant = new Set(q6AdjudicationToolGrant());
  for (const tool of NON_ADJUDICATION_TOOLS) {
    if (grant.has(tool)) throw new Q6RubricScopeError(tool);
  }
}

/** Thrown when a spec's route is not the certified deepseek-v4-flash judge
 * profile — in ANY run mode. */
export class Q6RouteError extends Error {
  constructor() {
    super("adjudication dispatch route is not the certified deepseek-v4-flash judge profile");
    this.name = "Q6RouteError";
  }
}

/** Re-prove the certified route at the public dispatch entry, unconditionally.
 * Unlike a mode-gated check, this NEVER early-returns on test-dev: the certified
 * deepseek-v4-flash judge binding is asserted in every mode. */
export function assertCertifiedJudgeRoute(spec: CallSpec): void {
  const resolved = resolveRoleModelProfile(Q6_ROLE);
  const selected = {
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  const certified = {
    modelProfile: resolved.modelProfile,
    modelProfileVersion: resolved.version,
    requestedModel: resolved.model,
    providerPolicy: resolved.providerPolicy,
  };
  if (spec.roleId !== Q6_ROLE || canonicalJson(selected) !== canonicalJson(certified)) {
    throw new Q6RouteError();
  }
}

/** Everything the orchestrator supplies that the adjudicator does not own. */
type Sha256Hash = `sha256:${string}`;

export interface Q6DispatchRefs {
  readonly parentEventId: Sha256Hash;
  readonly contextSnapshotId: Sha256Hash;
  readonly localizationSnapshotId: Sha256Hash;
  readonly sealPayload: (plaintext: string) => EncryptedPayloadRef;
  readonly sampleId?: string | null;
  readonly runMode?: "production" | "pilot" | "test-dev";
}

const REVIEW_VERDICT_SCHEMA_HASH = sha256({
  schema: "review-verdict",
  version: REVIEW_VERDICT_SCHEMA_VERSION,
});

/** Assemble one ordered-presentation CallSpec, routed to the certified judge
 * profile through the ZDR boundary. Eligibility, blinding, rubric scope, and
 * the certified route are all asserted before a single byte is sealed. */
export function buildQ6CallSpec(
  input: Q6ReviewInput,
  refs: Q6DispatchRefs,
  order: Q6PresentationOrder,
): CallSpec {
  assertBlinded(input);
  assertContestEligible(input);
  assertAdjudicationOnlyToolGrant();

  const profile = resolveRoleModelProfile(Q6_ROLE);
  const limits = specialistFor(Q6_ROLE).limits;
  const messages = assembleQ6Messages(input, order);
  const runMode = refs.runMode ?? "production";

  // Distinct event identities per order so A/B and B/A never share a memo key
  // purely by accident of identical sealing.
  const orderTag = order === "A-then-B" ? "ab" : "ba";

  const spec = CallSpecSchema.parse({
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "judge",
    roleId: Q6_ROLE,
    modelProfile: profile.modelProfile,
    modelProfileVersion: profile.version,
    requestedModel: profile.model,
    providerPolicy: profile.providerPolicy,
    parentEventId: refs.parentEventId,
    contextSnapshotId: refs.contextSnapshotId,
    localizationSnapshotId: refs.localizationSnapshotId,
    messages: [
      {
        kind: "text",
        eventId: sha256({ role: "system", order: orderTag, text: messages.system }),
        role: "system",
        contentEncrypted: refs.sealPayload(messages.system),
      },
      {
        kind: "text",
        eventId: sha256({ role: "user", order: orderTag, text: messages.user }),
        role: "user",
        contentEncrypted: refs.sealPayload(messages.user),
      },
    ],
    // Contest evidence is pre-assembled; no mid-call fan out.
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: REVIEW_VERDICT_SCHEMA_HASH,
    },
    promptVersion: Q6_PROMPT_VERSION,
    reasoning: { effort: specialistFor(Q6_ROLE).reasoning.effort },
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: {
      maxSteps: limits.maxSteps,
      maxToolCalls: limits.maxToolCalls,
      maxParallelTools: limits.maxParallelTools,
      maxOutputTokens: limits.maxOutputTokens,
      timeoutClass: limits.timeoutClass,
    },
    sampleId: refs.sampleId ?? null,
    runMode,
    contextScope: "whole-game",
  });

  // Re-prove the certified route on the assembled spec — in every mode.
  assertCertifiedJudgeRoute(spec);
  return spec;
}

/** The fixed dual-order budget for one contest: A-then-B then B-then-A. */
export const Q6_ORDER_BUDGET: readonly Q6PresentationOrder[] = ["A-then-B", "B-then-A"];

/** Build both order-debiased CallSpecs for one contest. Exactly two specs —
 * the entire adjudication budget, never more. */
export function buildQ6OrderCallSpecs(
  input: Q6ReviewInput,
  refs: Q6DispatchRefs,
): readonly { readonly order: Q6PresentationOrder; readonly spec: CallSpec }[] {
  return Q6_ORDER_BUDGET.map((order) => ({
    order,
    spec: buildQ6CallSpec(input, refs, order),
  }));
}
