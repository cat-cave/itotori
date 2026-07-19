// Build the dispatch request for the Build-LQA Reviewer.
//
// The reviewer calls exactly one model — the certified deepseek-v4-flash
// reviewer profile — through the single ZDR dispatch boundary. This module
// names NO provider and pins NO model: it RESOLVES the role's certified profile
// (capability + ZDR + automatic fallback), stamps the CallSpec from it, and
// re-proves the result in every run mode so route drift cannot be dispatched.
//
// The reviewer's build-LQA tool grant is DERIVED from the read-tool permission
// table (never hardcoded), and is asserted to exclude every egress and render
// surface. The frame reaches the reviewer as a PRE-COMPUTED deterministic render
// /OCR fact; the reviewer never drives the renderer itself.

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
import { assembleQ5Messages, Q5_PROMPT_VERSION } from "./prompt.js";
import { parseQ5ReviewInput, type Q5ReviewInput } from "./inputs.js";

/** The reviewer role this module configures. Data, not an auth decision. */
const Q5_ROLE = "Q5" as const;

/** Tool surfaces that DRIVE the screen or leave the ZDR envelope. The frame is
 * pre-computed off the deterministic render step, so the reviewer must never be
 * granted the renderer or any egress surface. */
const NON_BUILD_LQA_TOOLS: readonly ToolName[] = ["render_and_ocr", "web_search", "back_translate"];

/** The reviewer's build-LQA local read grant, derived from the permission table.
 * `render_and_ocr` is NOT here — the frame reaches the reviewer as a pre-computed
 * deterministic fact, never as a tool it drives itself. */
export function q5BuildLqaToolGrant(): readonly ToolName[] {
  return toolsForRole(Q5_ROLE);
}

/** Thrown if the derived grant ever includes a render/egress surface. */
export class Q5RubricScopeError extends Error {
  constructor(tool: ToolName) {
    super(`build-LQA reviewer must not be granted the driving tool ${tool}`);
    this.name = "Q5RubricScopeError";
  }
}

/** Prove the build-LQA grant never drives the screen or leaves the envelope. */
export function assertBuildLqaOnlyToolGrant(): void {
  const grant = new Set(q5BuildLqaToolGrant());
  for (const tool of NON_BUILD_LQA_TOOLS) {
    if (grant.has(tool)) throw new Q5RubricScopeError(tool);
  }
}

/** Thrown when a call attempts to leave Q5's RB-019 certified reviewer route. */
export class Q5RouteError extends Error {
  constructor() {
    super("build-LQA dispatch route is not the certified deepseek-v4-flash reviewer profile");
    this.name = "Q5RouteError";
  }
}

/** Re-prove the certified profile at Q5's public request boundary. This is
 * deliberately unconditional: `test-dev` and pilot runs remain inside the same
 * account-wide ZDR envelope and cannot introduce a provider-specific escape. */
export function assertCertifiedBuildLqaRoute(spec: CallSpec): void {
  const resolved = resolveRoleModelProfile(Q5_ROLE);
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
  if (spec.roleId !== Q5_ROLE || canonicalJson(selected) !== canonicalJson(certified)) {
    throw new Q5RouteError();
  }
}

/** Everything the orchestrator supplies that the reviewer does not itself own:
 * the snapshot the batch is pinned to, the parent event, and the seam that
 * seals a plaintext into an operator-managed encrypted payload reference. */
type Sha256Hash = `sha256:${string}`;

export interface Q5DispatchRefs {
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

/** Assemble the build-LQA CallSpec, routed to the certified reviewer profile
 * through the ZDR boundary. Frame-channel and rubric scope are asserted before a
 * single byte is sealed. */
export function buildQ5CallSpec(input: Q5ReviewInput, refs: Q5DispatchRefs): CallSpec {
  // Strictly parse the declared input (schema + deep scan) rather than only
  // deep-scanning: an unknown decoded-channel field on the frame fails closed
  // here too, so the spec can never be assembled from an ill-shaped input.
  const parsed = parseQ5ReviewInput(input);
  assertBuildLqaOnlyToolGrant();

  const profile = resolveRoleModelProfile(Q5_ROLE);
  const limits = specialistFor(Q5_ROLE).limits;
  const messages = assembleQ5Messages(parsed);
  const runMode = refs.runMode ?? "production";

  const spec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "review",
    roleId: Q5_ROLE,
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
    // The frame and facts are pre-assembled; the reviewer needs no mid-call fan
    // out, which keeps the physical step cleanly memoizable.
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: REVIEW_VERDICT_SCHEMA_HASH,
    },
    promptVersion: Q5_PROMPT_VERSION,
    reasoning: { effort: specialistFor(Q5_ROLE).reasoning.effort },
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

  const parsedSpec = CallSpecSchema.parse(spec);
  assertCertifiedBuildLqaRoute(parsedSpec);
  return parsedSpec;
}
