// Build the dispatch request for the Continuity Reviewer.
//
// The reviewer calls exactly one model — the certified deepseek-v4-flash
// reviewer profile — through the single ZDR dispatch boundary. This module
// names NO provider and pins NO model: it RESOLVES the role's certified profile
// (capability + ZDR + automatic fallback) and stamps the CallSpec from it, so a
// route that drifts from the certified binding cannot be constructed here.
//
// The build is ROUTE-BOUND in every run mode: `reviewScope` is a required part
// of the input, so a continuity call can never be assembled without the route it
// is scoped to. The reviewer's continuity tool grant is DERIVED from the read
// -tool permission table (never hardcoded) and asserted to exclude every egress
// and render surface — an engine/render fault is not the continuity lane's job.

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
import { assembleQ4Messages, Q4_PROMPT_VERSION } from "./prompt.js";
import { parseQ4ReviewInput, type Q4ReviewInput } from "./inputs.js";

/** The reviewer role this module configures. Data, not an auth decision. */
const Q4_ROLE = "Q4" as const;

/** Tool surfaces that judge the SCREEN or leave the ZDR envelope. None of them
 * belong to a continuity judgement, so the grant must never include them. */
const NON_CONTINUITY_TOOLS: readonly ToolName[] = [
  "render_and_ocr",
  "web_search",
  "back_translate",
];

/** The reviewer's continuity-only local read grant, derived from the permission
 * table. It reads the decoded units, glossary, and accepted outputs — never a
 * render or egress surface it would drive itself. */
export function q4ContinuityToolGrant(): readonly ToolName[] {
  return toolsForRole(Q4_ROLE);
}

/** Thrown if the derived grant ever includes a screen/egress surface. */
export class Q4RubricScopeError extends Error {
  constructor(tool: ToolName) {
    super(`continuity reviewer must not be granted the non-continuity tool ${tool}`);
    this.name = "Q4RubricScopeError";
  }
}

/** Prove the continuity grant stays inside the continuity rubric. */
export function assertContinuityOnlyToolGrant(): void {
  const grant = new Set(q4ContinuityToolGrant());
  for (const tool of NON_CONTINUITY_TOOLS) {
    if (grant.has(tool)) throw new Q4RubricScopeError(tool);
  }
}

/** Thrown when a Q4 call drifts from its RB-019 reviewer profile. Test-dev is
 * intentionally not an escape hatch: the certified route is required before
 * every physical continuity-review call. */
export class Q4RouteError extends Error {
  constructor() {
    super("continuity dispatch route is not the certified deepseek-v4-flash reviewer profile");
    this.name = "Q4RouteError";
  }
}

/** Re-prove Q4's certified model/profile/ZDR policy at the public boundary.
 * Constructing from the profile is necessary but not sufficient: callers may
 * invoke this guard around a CallSpec in any run mode before dispatching it. */
export function assertCertifiedContinuityRoute(spec: CallSpec): void {
  const resolved = resolveRoleModelProfile(Q4_ROLE);
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
  if (spec.roleId !== Q4_ROLE || canonicalJson(selected) !== canonicalJson(certified)) {
    throw new Q4RouteError();
  }
}

/** Everything the orchestrator supplies that the reviewer does not itself own:
 * the snapshot the batch is pinned to, the parent event, and the seam that
 * seals a plaintext into an operator-managed encrypted payload reference. */
type Sha256Hash = `sha256:${string}`;

export interface Q4DispatchRefs {
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

/** Assemble the continuity-review CallSpec, routed to the certified reviewer
 * profile through the ZDR boundary. Route binding and rubric scope are asserted
 * before a single byte is sealed. Works identically in every run mode. */
export function buildQ4CallSpec(input: Q4ReviewInput, refs: Q4DispatchRefs): CallSpec {
  // Strictly parse the declared input so the spec can never be assembled from an
  // ill-shaped or route-less input (reviewScope is required by the schema).
  const parsed = parseQ4ReviewInput(input);
  assertContinuityOnlyToolGrant();

  const profile = resolveRoleModelProfile(Q4_ROLE);
  const limits = specialistFor(Q4_ROLE).limits;
  const messages = assembleQ4Messages(parsed);
  const runMode = refs.runMode ?? "production";

  const spec = CallSpecSchema.parse({
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "review",
    roleId: Q4_ROLE,
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
    // Context is pre-assembled and route-bound; the reviewer needs no mid-call
    // fan out, which keeps the physical step cleanly memoizable.
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: REVIEW_VERDICT_SCHEMA_HASH,
    },
    promptVersion: Q4_PROMPT_VERSION,
    reasoning: { effort: specialistFor(Q4_ROLE).reasoning.effort },
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
  // Do not make certified routing an implicit property of construction. The
  // public request seam proves it explicitly in production, pilot, and test-dev.
  assertCertifiedContinuityRoute(spec);
  return spec;
}
