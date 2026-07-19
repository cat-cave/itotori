// A specialist is IMMUTABLE DATA — a casting of one of the three shapes.
//
// It carries everything the workflow needs to run it and nothing more: its
// role id, its shape, versioned instructions, the shape's strict input/output
// schemas and semantic validator, its tool allowlist, its granularity, its DAG
// position, the WikiObject kind it authors (or, for a reviewer, the kind it
// judges), its model-profile key, and its limits. It constructs NO providers,
// owns NO retries, writes NO database, and selects NO successor. It is a tuple,
// not a class.
//
// Permission-not-role. A specialist does not HARDCODE a permission set: its
// tool allowlist is DERIVED from the read-tool permission table (the single source
// of truth), and its model route is DERIVED from the certified per-role profile.
// A role therefore cannot smuggle in a provider or a private model list. The
// construction guards below fail LOUD if a declaration:
//   - names a shape that is not one of the three executable shapes;
//   - is cast onto the wrong shape for its role family (a P-role as analyst);
//   - names a provider in its model-profile key, or a key that does not resolve
//     to the certified deepseek-v4-flash profile;
//   - binds a call tier the shape does not permit.

import {
  RoleIdSchema,
  ToolNameSchema,
  WikiObjectKindSchema,
  assertProfileIdNamesNoProvider,
  type RoleId,
  type ToolName,
} from "../contracts/index.js";
import { TOOL_ROLE_ALLOWLIST } from "../read-tools/access.js";
import {
  deepSeekV4FlashProfile,
  uncertifiedRoleModelProfileCandidateForProbe,
} from "../llm/role-model-profiles.js";
import {
  shapeContract,
  type CallLimits,
  type ProfileShape,
  type ReasoningPolicy,
  type ShapeContract,
  type ValidationIssue,
} from "./shapes.js";
import type { z } from "zod";

type ModelProfileTier = "draft" | "reasoning" | "reviewer" | "judge";
type WikiObjectKind = z.infer<typeof WikiObjectKindSchema>;

/** The only work-item fan-outs a specialist declaration may name. */
export const GRANULARITIES = [
  "per-game",
  "per-route",
  "per-scene",
  "per-character",
  "per-character-pair",
  "per-character-route",
  "per-unit",
  "per-term",
  "per-batch",
  "per-contested-unit",
] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The fixed workflow stages. Specialists declare a position; they do not own
 * or choose the workflow itself. */
export const DAG_STAGES = ["pre-production", "production", "qa"] as const;
export type DagStage = (typeof DAG_STAGES)[number];

export interface DagPosition {
  readonly stage: DagStage;
  readonly upstream: readonly RoleId[];
  readonly downstream: readonly RoleId[];
}

/** The hand-authored part of a specialist. Everything else is DERIVED. */
export interface SpecialistDeclaration {
  readonly roleId: RoleId;
  readonly shape: ProfileShape;
  readonly version: string;
  readonly instructions: string;
  readonly granularity: Granularity;
  readonly wikiObjectKind: WikiObjectKind;
  /** Model-profile KEY only — never a provider, never a model list. */
  readonly modelProfileKey: string;
  readonly dagPosition: DagPosition;
  readonly reasoning?: ReasoningPolicy;
  readonly limits?: CallLimits;
}

export interface Specialist {
  readonly roleId: RoleId;
  readonly shape: ProfileShape;
  readonly version: string;
  readonly instructions: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly tools: readonly ToolName[];
  readonly granularity: Granularity;
  readonly dagPosition: DagPosition;
  readonly wikiObjectKind: WikiObjectKind;
  readonly modelProfileKey: string;
  /** The certified call tier this role binds (draft/reasoning/reviewer/judge). */
  readonly modelProfile: ModelProfileTier;
  /** The exact versioned model every role resolves to — deepseek/deepseek-v4-flash. */
  readonly resolvedModel: string;
  readonly reasoning: ReasoningPolicy;
  readonly limits: CallLimits;
  readonly validate: (output: unknown) => readonly ValidationIssue[];
}

/** The shape a role family is cast onto — DATA, not a class hierarchy. */
export function expectedShapeForRole(roleId: RoleId): ProfileShape {
  const family = roleId.charAt(0);
  if (family === "A") return "analyst";
  if (family === "P") return "localizer";
  return "reviewer";
}

/** The tool allowlist for a role, derived from the read-tool permission table.
 * Deterministically ordered by the tool enum. */
export function toolsForRole(roleId: RoleId): readonly ToolName[] {
  return ToolNameSchema.options.filter((tool) => TOOL_ROLE_ALLOWLIST[tool].includes(roleId));
}

/**
 * Construct an immutable specialist, or throw. All four acceptance guarantees
 * are enforced here at CONSTRUCTION:
 *  - only the three shapes are executable (`shapeContract` rejects a fourth);
 *  - the shape matches the role family;
 *  - the model-profile key names no provider and resolves to the certified
 *    deepseek-v4-flash profile (a provider-named or wrong-model key throws);
 *  - the resolved call tier is one the shape permits.
 */
export function defineSpecialist(declaration: SpecialistDeclaration): Specialist {
  const roleId = RoleIdSchema.parse(declaration.roleId);
  const wikiObjectKind = WikiObjectKindSchema.parse(declaration.wikiObjectKind);
  const contract: ShapeContract = shapeContract(declaration.shape);

  const expectedShape = expectedShapeForRole(roleId);
  if (contract.shape !== expectedShape) {
    throw new Error(
      `role ${roleId} must be cast onto the ${expectedShape} shape, not ${contract.shape}`,
    );
  }

  // NO provider ownership in a role.
  assertProfileIdNamesNoProvider(declaration.modelProfileKey);

  // Resolve the role's model route through the certified config (single source of
  // truth). A key that does not match, or a model other than the certified
  // deepseek-v4-flash profile, is a wrong-model role and is rejected here.
  const resolved = uncertifiedRoleModelProfileCandidateForProbe(roleId);
  if (resolved.profileId !== declaration.modelProfileKey) {
    throw new Error(
      `role ${roleId} model-profile key '${declaration.modelProfileKey}' does not match its certified binding '${resolved.profileId}'`,
    );
  }
  if (resolved.model !== deepSeekV4FlashProfile.model) {
    throw new Error(
      `role ${roleId} must resolve to ${deepSeekV4FlashProfile.model}, not ${resolved.model}`,
    );
  }
  if (!contract.callProfiles.includes(resolved.modelProfile)) {
    throw new Error(
      `role ${roleId} binds call tier '${resolved.modelProfile}', which the ${contract.shape} shape does not permit`,
    );
  }

  const specialist: Specialist = {
    roleId,
    shape: contract.shape,
    version: declaration.version,
    instructions: declaration.instructions,
    input: contract.input,
    output: contract.output,
    tools: Object.freeze([...toolsForRole(roleId)]),
    granularity: declaration.granularity,
    dagPosition: Object.freeze({
      stage: declaration.dagPosition.stage,
      upstream: Object.freeze([...declaration.dagPosition.upstream]),
      downstream: Object.freeze([...declaration.dagPosition.downstream]),
    }),
    wikiObjectKind,
    modelProfileKey: declaration.modelProfileKey,
    modelProfile: resolved.modelProfile,
    resolvedModel: resolved.model,
    // The outer specialist record is frozen below; freeze these copied nested
    // data records too so no caller can silently alter a role's call posture.
    reasoning: Object.freeze({ ...(declaration.reasoning ?? contract.reasoning) }),
    limits: Object.freeze({ ...(declaration.limits ?? contract.limits) }),
    validate: contract.validate,
  };
  return Object.freeze(specialist);
}
