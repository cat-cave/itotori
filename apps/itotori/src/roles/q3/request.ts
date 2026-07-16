// Build the dispatch request for the Terminology Auditor.
//
// The auditor calls exactly one model — the certified deepseek-v4-flash reviewer
// profile — through the single ZDR dispatch boundary. This module names NO
// provider and pins NO model: it RESOLVES the role's certified profile
// (capability + ZDR + automatic fallback) and stamps the CallSpec from it.
//
// `assertCertifiedReviewerRoute` re-proves that binding at the PUBLIC dispatch
// entry in EVERY run mode — including test-dev. A run mode is not an escape
// hatch: a spec whose route drifts from the certified reviewer profile is
// refused before a byte leaves, whatever the mode.
//
// The auditor's terminology tool grant is DERIVED from the read-tool permission
// table (never hardcoded) and is asserted to exclude every egress and screen
// surface — an engine or render fault is not the terminology lane's job.

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
import { assembleQ3Messages, Q3_PROMPT_VERSION } from "./prompt.js";
import { assertExactGateCleared, type Q3ReviewInput } from "./inputs.js";

/** The reviewer role this module configures. Data, not an auth decision. */
const Q3_ROLE = "Q3" as const;

/** Tool surfaces that judge the SCREEN or leave the ZDR envelope. None belongs to
 * a terminology judgement, so the terminology grant must never include them. */
const NON_TERMINOLOGY_TOOLS: readonly ToolName[] = [
  "render_and_ocr",
  "web_search",
  "back_translate",
];

/** The auditor's terminology local read grant, derived from the permission table.
 * `glossary_lookup` is central here; no screen or egress surface is present. */
export function q3TerminologyToolGrant(): readonly ToolName[] {
  return toolsForRole(Q3_ROLE);
}

/** Thrown if the derived grant ever includes a screen or egress surface. */
export class Q3RubricScopeError extends Error {
  constructor(tool: ToolName) {
    super(`terminology auditor must not be granted the non-terminology tool ${tool}`);
    this.name = "Q3RubricScopeError";
  }
}

/** Prove the terminology grant stays inside the terminology rubric. */
export function assertTerminologyOnlyToolGrant(): void {
  const grant = new Set(q3TerminologyToolGrant());
  for (const tool of NON_TERMINOLOGY_TOOLS) {
    if (grant.has(tool)) throw new Q3RubricScopeError(tool);
  }
}

/** Thrown when a spec's route is not the certified deepseek-v4-flash reviewer
 * profile — in ANY run mode. */
export class Q3RouteError extends Error {
  constructor() {
    super("terminology dispatch route is not the certified deepseek-v4-flash reviewer profile");
    this.name = "Q3RouteError";
  }
}

/** Re-prove the certified route at the public dispatch entry, unconditionally.
 * Unlike a mode-gated check, this NEVER early-returns on test-dev: the certified
 * deepseek-v4-flash reviewer binding is asserted in every mode. */
export function assertCertifiedReviewerRoute(spec: CallSpec): void {
  const resolved = resolveRoleModelProfile(Q3_ROLE);
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
  if (spec.roleId !== Q3_ROLE || canonicalJson(selected) !== canonicalJson(certified)) {
    throw new Q3RouteError();
  }
}

/** Everything the orchestrator supplies that the auditor does not itself own. */
type Sha256Hash = `sha256:${string}`;

export interface Q3DispatchRefs {
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

/** Assemble the terminology-audit CallSpec, routed to the certified reviewer
 * profile through the ZDR boundary. The exact-gate precondition, rubric scope,
 * and certified route are all asserted before a single byte is sealed. */
export function buildQ3CallSpec(input: Q3ReviewInput, refs: Q3DispatchRefs): CallSpec {
  assertExactGateCleared(input);
  assertTerminologyOnlyToolGrant();

  const profile = resolveRoleModelProfile(Q3_ROLE);
  const limits = specialistFor(Q3_ROLE).limits;
  const messages = assembleQ3Messages(input);
  const runMode = refs.runMode ?? "production";

  const spec = CallSpecSchema.parse({
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "review",
    roleId: Q3_ROLE,
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
    // Context is pre-assembled; the auditor needs no mid-call fan out, which keeps
    // the physical step cleanly memoizable.
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: REVIEW_VERDICT_SCHEMA_HASH,
    },
    promptVersion: Q3_PROMPT_VERSION,
    reasoning: { effort: specialistFor(Q3_ROLE).reasoning.effort },
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
