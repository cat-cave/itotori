// Build the dispatch request for the Meaning Reviewer.
//
// The reviewer calls exactly one model — the certified deepseek-v4-flash
// reviewer profile — through the single ZDR dispatch boundary. This module
// names NO provider and pins NO model: it RESOLVES the role's certified profile
// (capability + ZDR + automatic fallback) and stamps the CallSpec from it, so a
// route that drifts from the certified binding cannot be constructed here.
//
// The reviewer's meaning-only tool grant is DERIVED from the read-tool
// permission table (never hardcoded), and is asserted to exclude every egress
// and render surface — an engine/render fault is not the meaning lane's job.

import {
  CALL_SPEC_SCHEMA_VERSION,
  CallSpecSchema,
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallSpec,
  type EncryptedPayloadRef,
  type ToolName,
} from "../../contracts/index.js";
import { sha256 } from "../../llm/canonical-json.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";
import { specialistFor, toolsForRole } from "../../roster/index.js";
import { assembleQ1Messages, Q1_PROMPT_VERSION } from "./prompt.js";
import { assertBlinded, type Q1ReviewInput } from "./inputs.js";

/** The reviewer role this module configures. Data, not an auth decision. */
const Q1_ROLE = "Q1" as const;

/** Tool surfaces that judge the SCREEN or leave the ZDR envelope. None of them
 * belong to a meaning judgement, so the meaning grant must never include them. */
const NON_MEANING_TOOLS: readonly ToolName[] = ["render_and_ocr", "web_search", "back_translate"];

/** The reviewer's meaning-only local read grant, derived from the permission
 * table. `back_translate` is NOT here — the back-translation reaches the
 * reviewer as a pre-computed signal, never as a tool it drives itself. */
export function q1MeaningToolGrant(): readonly ToolName[] {
  return toolsForRole(Q1_ROLE);
}

/** Thrown if the derived grant ever includes a screen/egress surface. */
export class Q1RubricScopeError extends Error {
  constructor(tool: ToolName) {
    super(`meaning reviewer must not be granted the non-meaning tool ${tool}`);
    this.name = "Q1RubricScopeError";
  }
}

/** Prove the meaning grant stays inside the meaning rubric. */
export function assertMeaningOnlyToolGrant(): void {
  const grant = new Set(q1MeaningToolGrant());
  for (const tool of NON_MEANING_TOOLS) {
    if (grant.has(tool)) throw new Q1RubricScopeError(tool);
  }
}

/** Everything the orchestrator supplies that the reviewer does not itself own:
 * the snapshot the batch is pinned to, the parent event, and the seam that
 * seals a plaintext into an operator-managed encrypted payload reference. */
type Sha256Hash = `sha256:${string}`;

export interface Q1DispatchRefs {
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

/** Assemble the meaning-review CallSpec, routed to the certified reviewer
 * profile through the ZDR boundary. Blinding and rubric scope are asserted
 * before a single byte is sealed. */
export function buildQ1CallSpec(input: Q1ReviewInput, refs: Q1DispatchRefs): CallSpec {
  assertBlinded(input);
  assertMeaningOnlyToolGrant();

  const profile = resolveRoleModelProfile(Q1_ROLE);
  const limits = specialistFor(Q1_ROLE).limits;
  const messages = assembleQ1Messages(input);
  const runMode = refs.runMode ?? "production";

  const spec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "review",
    roleId: Q1_ROLE,
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
        eventId: sha256({ role: "system", text: messages.system }),
        role: "system",
        contentEncrypted: refs.sealPayload(messages.system),
      },
      {
        kind: "text",
        eventId: sha256({ role: "user", text: messages.user }),
        role: "user",
        contentEncrypted: refs.sealPayload(messages.user),
      },
    ],
    // Context is pre-assembled and blinded; the reviewer needs no mid-call fan
    // out, which keeps the physical step cleanly memoizable.
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: REVIEW_VERDICT_SCHEMA_HASH,
    },
    promptVersion: Q1_PROMPT_VERSION,
    reasoning: { effort: specialistFor(Q1_ROLE).reasoning.effort },
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
  };

  return CallSpecSchema.parse(spec);
}
