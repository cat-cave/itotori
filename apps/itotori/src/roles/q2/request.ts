// Build the dispatch request for the Voice Reviewer.
//
// The reviewer calls exactly one model — the certified deepseek-v4-flash reviewer
// profile — through the single ZDR dispatch boundary. This module names NO
// provider and pins NO model: it RESOLVES the role's certified profile
// (capability + ZDR + automatic fallback) and stamps the CallSpec from it.
//
// `assertCertifiedReviewerRoute` re-proves that binding at the PUBLIC dispatch
// entry in EVERY run mode — including test-dev. A run mode is not an escape
// hatch: a spec whose route drifts from the certified reviewer profile is refused
// before a byte leaves, whatever the mode.
//
// The reviewer's voice tool grant is DERIVED from the read-tool permission table
// (never hardcoded) and is asserted to exclude every egress and screen surface —
// a meaning judgement or an engine/render fault is not the voice lane's job.

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
import { assembleQ2Messages, Q2_PROMPT_VERSION } from "./prompt.js";
import { assertPositionDecodeDerived, type Q2ReviewInput } from "./inputs.js";

/** The reviewer role this module configures. Data, not an auth decision. */
const Q2_ROLE = "Q2" as const;

/** Tool surfaces that judge the SCREEN or leave the ZDR envelope. None belongs to
 * a voice judgement, so the voice grant must never include them. */
const NON_VOICE_TOOLS: readonly ToolName[] = ["render_and_ocr", "web_search", "back_translate"];

/** The reviewer's voice local read grant, derived from the permission table. The
 * decoded character occurrences and accepted outputs that ground voice continuity
 * are central here; no screen or egress surface is present. */
export function q2VoiceToolGrant(): readonly ToolName[] {
  return toolsForRole(Q2_ROLE);
}

/** Thrown if the derived grant ever includes a screen or egress surface. */
export class Q2RubricScopeError extends Error {
  constructor(tool: ToolName) {
    super(`voice reviewer must not be granted the non-voice tool ${tool}`);
    this.name = "Q2RubricScopeError";
  }
}

/** Prove the voice grant stays inside the voice rubric. */
export function assertVoiceOnlyToolGrant(): void {
  const grant = new Set(q2VoiceToolGrant());
  for (const tool of NON_VOICE_TOOLS) {
    if (grant.has(tool)) throw new Q2RubricScopeError(tool);
  }
}

/** Thrown when a spec's route is not the certified deepseek-v4-flash reviewer
 * profile — in ANY run mode. */
export class Q2RouteError extends Error {
  constructor() {
    super("voice dispatch route is not the certified deepseek-v4-flash reviewer profile");
    this.name = "Q2RouteError";
  }
}

/** Re-prove the certified route at the public dispatch entry, unconditionally.
 * Unlike a mode-gated check, this NEVER early-returns on test-dev: the certified
 * deepseek-v4-flash reviewer binding is asserted in every mode. */
export function assertCertifiedReviewerRoute(spec: CallSpec): void {
  const resolved = resolveRoleModelProfile(Q2_ROLE);
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
  if (spec.roleId !== Q2_ROLE || canonicalJson(selected) !== canonicalJson(certified)) {
    throw new Q2RouteError();
  }
}

/** Everything the orchestrator supplies that the reviewer does not itself own. */
type Sha256Hash = `sha256:${string}`;

export interface Q2DispatchRefs {
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

/** Assemble the voice-continuity CallSpec, routed to the certified reviewer
 * profile through the ZDR boundary. The decode-derived position, rubric scope,
 * and certified route are all asserted before a single byte is sealed. */
export function buildQ2CallSpec(input: Q2ReviewInput, refs: Q2DispatchRefs): CallSpec {
  assertPositionDecodeDerived(input);
  assertVoiceOnlyToolGrant();

  const profile = resolveRoleModelProfile(Q2_ROLE);
  const limits = specialistFor(Q2_ROLE).limits;
  const messages = assembleQ2Messages(input);
  const runMode = refs.runMode ?? "production";

  const spec = CallSpecSchema.parse({
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "review",
    roleId: Q2_ROLE,
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
    // Context is pre-assembled; the reviewer needs no mid-call fan out, which
    // keeps the physical step cleanly memoizable.
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: REVIEW_VERDICT_SCHEMA_HASH,
    },
    promptVersion: Q2_PROMPT_VERSION,
    reasoning: { effort: specialistFor(Q2_ROLE).reasoning.effort },
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
  assertCertifiedReviewerRoute(spec);
  return spec;
}
