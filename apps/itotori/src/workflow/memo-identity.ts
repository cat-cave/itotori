// Durable logical workflow memo identity.
//
// The physical LLM memo owns request-level identity. This module owns the
// larger workflow-step identity: a whole scene draft, one review lane, a
// correction, patch export, or Build-LQA result. Its scope is deliberately
// explicit so a durable step cache cannot replay work across projects, runs,
// branches, snapshots, policies, or model routes.

import type { ProviderPolicy } from "../contracts/index.js";
import { stableDigest } from "../gates/index.js";
import { resolveRoleModelProfile } from "../llm/role-model-profiles.js";
import type { ResolvedRunPolicy } from "../run-policy/index.js";

export const WORKFLOW_MEMO_IDENTITY_SCHEMA_VERSION = "itotori.workflow-memo-identity.v1" as const;
export const WORKFLOW_MEMO_KEY_SCHEMA_VERSION = "itotori.workflow-memo-key.v1" as const;
export const PURE_MTL_WORKFLOW_MEMO_PREFIX = "pure-mtl:";

/** Roles that can make a model-backed logical workflow step. */
export const WORKFLOW_MEMO_ROLE_IDS = [
  "P1",
  "P2",
  "P3",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "Q5",
  "Q6",
] as const;

export type WorkflowMemoRole = (typeof WORKFLOW_MEMO_ROLE_IDS)[number];

/** The certified route selected for a role. Provider policy is part of the
 * identity even when today's profiles share the same policy, because changing
 * it can change provider behavior and therefore the computed result. */
export interface WorkflowMemoRoleRoute {
  readonly roleId: WorkflowMemoRole;
  readonly profileId: string;
  readonly modelProfile: "draft" | "reasoning" | "reviewer" | "judge";
  readonly modelProfileVersion: string;
  readonly requestedModel: string;
  readonly providerPolicy: ProviderPolicy;
}

export type WorkflowMemoRoleRoutes = Readonly<Record<WorkflowMemoRole, WorkflowMemoRoleRoute>>;

/** The invocation-owned patched-build plan. These fields are only projected for
 * patchback and Q5: they do not affect drafting, but they do affect byte apply,
 * runtime evidence, and the screen review that follows it. */
export interface WorkflowMemoRenderPlan {
  readonly sourceRoot: string;
  readonly buildRoot: string;
  readonly patchScope: string;
  readonly runId: string;
  readonly backgroundAsset: string | null;
}

/** Immutable facts that scope every logical workflow step to one admitted run.
 * The lease owner is intentionally absent: a restart may acquire a different
 * lease owner while still being the same computation and must retain cache hits. */
export interface WorkflowMemoIdentity {
  readonly schemaVersion: typeof WORKFLOW_MEMO_IDENTITY_SCHEMA_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly targetLocale: string;
  readonly draftBudget: {
    readonly budgetBytes: number;
    readonly overlapUnits: number;
  };
  /** Qualifying runs bind their byte-apply/render plan so Q5 cannot replay
   * evidence produced against another source, build destination, or backdrop. */
  readonly renderPlan: WorkflowMemoRenderPlan | null;
  readonly roleRoutes: WorkflowMemoRoleRoutes;
}

export interface CreateWorkflowMemoIdentityInput {
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly targetLocale: string;
  readonly draftBudget: WorkflowMemoIdentity["draftBudget"];
  readonly renderPlan?: WorkflowMemoRenderPlan;
  readonly roleRoutes: WorkflowMemoRoleRoutes;
}

/** Construct a run-scoped identity. Callers must supply the project/run/branch
 * coordinates explicitly; there is no process-global or unscoped fallback. */
export function createWorkflowMemoIdentity(
  input: CreateWorkflowMemoIdentityInput,
): WorkflowMemoIdentity {
  return {
    schemaVersion: WORKFLOW_MEMO_IDENTITY_SCHEMA_VERSION,
    projectId: input.projectId,
    runId: input.runId,
    localeBranchId: input.localeBranchId,
    contextSnapshotId: input.contextSnapshotId,
    localizationSnapshotId: input.localizationSnapshotId,
    schemaHash: input.schemaHash,
    targetLocale: input.targetLocale,
    draftBudget: {
      budgetBytes: input.draftBudget.budgetBytes,
      overlapUnits: input.draftBudget.overlapUnits,
    },
    renderPlan:
      input.renderPlan === undefined
        ? null
        : {
            sourceRoot: input.renderPlan.sourceRoot,
            buildRoot: input.renderPlan.buildRoot,
            patchScope: input.renderPlan.patchScope,
            runId: input.renderPlan.runId,
            backgroundAsset: input.renderPlan.backgroundAsset,
          },
    roleRoutes: input.roleRoutes,
  };
}

/** Resolve the complete certified model routing table once when live ports are
 * composed. Keeping this table on the ports makes the route selection visible
 * and keeps every logical key tied to the exact role implementation. */
export function createWorkflowMemoRoleRoutes(): WorkflowMemoRoleRoutes {
  return {
    P1: roleRoute("P1"),
    P2: roleRoute("P2"),
    P3: roleRoute("P3"),
    Q1: roleRoute("Q1"),
    Q2: roleRoute("Q2"),
    Q3: roleRoute("Q3"),
    Q4: roleRoute("Q4"),
    Q5: roleRoute("Q5"),
    Q6: roleRoute("Q6"),
  };
}

function roleRoute(roleId: WorkflowMemoRole): WorkflowMemoRoleRoute {
  const profile = resolveRoleModelProfile(roleId);
  return {
    roleId,
    profileId: profile.profileId,
    modelProfile: profile.modelProfile,
    modelProfileVersion: profile.version,
    requestedModel: profile.model,
    providerPolicy: profile.providerPolicy,
  };
}

export type WorkflowMemoStep =
  | "draft"
  | "review"
  | "rerun-review"
  | "line-edit"
  | "semantic-repair"
  | "adjudicate"
  | "patchback"
  | "build-lqa";

export interface WorkflowMemoKeyInput {
  readonly identity: WorkflowMemoIdentity;
  readonly policy: ResolvedRunPolicy;
  readonly step: WorkflowMemoStep;
  /** `null` denotes a deterministic/native workflow step such as patch export. */
  readonly role: WorkflowMemoRole | null;
  readonly parts: readonly unknown[];
}

/** Derive the durable key for one logical workflow computation. This projects
 * only declared scope fields, so a transient lease owner can never partition a
 * restarted run's cache even if a caller carries it alongside this object. */
export function workflowMemoKeyFor(input: WorkflowMemoKeyInput): string {
  const key = stableDigest({
    schemaVersion: WORKFLOW_MEMO_KEY_SCHEMA_VERSION,
    identity: identityProjection(input.identity, input.step),
    policy: policyProjection(input.policy),
    step: input.step,
    route:
      input.role === null
        ? { kind: "deterministic" }
        : routeProjection(input.identity.roleRoutes[input.role]),
    parts: input.parts,
  });
  return input.policy.bibleBasis === "pure-mtl-ablation"
    ? `${PURE_MTL_WORKFLOW_MEMO_PREFIX}${key}`
    : key;
}

function identityProjection(identity: WorkflowMemoIdentity, step: WorkflowMemoStep) {
  return {
    schemaVersion: identity.schemaVersion,
    projectId: identity.projectId,
    runId: identity.runId,
    localeBranchId: identity.localeBranchId,
    contextSnapshotId: identity.contextSnapshotId,
    localizationSnapshotId: identity.localizationSnapshotId,
    schemaHash: identity.schemaHash,
    targetLocale: identity.targetLocale,
    draftBudget: {
      budgetBytes: identity.draftBudget.budgetBytes,
      overlapUnits: identity.draftBudget.overlapUnits,
    },
    // File locations and render assets are irrelevant to model text steps, but
    // they are part of the side-effect/evidence contract for native patchback
    // and Build-LQA. Keeping this projection step-specific preserves valid P1
    // cache hits when only a later render destination changes.
    renderPlan: step === "patchback" || step === "build-lqa" ? identity.renderPlan : null,
  };
}

function routeProjection(route: WorkflowMemoRoleRoute) {
  return {
    roleId: route.roleId,
    profileId: route.profileId,
    modelProfile: route.modelProfile,
    modelProfileVersion: route.modelProfileVersion,
    requestedModel: route.requestedModel,
    providerPolicy: {
      allowFallbacks: route.providerPolicy.allowFallbacks,
      zdr: route.providerPolicy.zdr,
      dataCollection: route.providerPolicy.dataCollection,
      requireParameters: route.providerPolicy.requireParameters,
    },
  };
}

function policyProjection(policy: ResolvedRunPolicy) {
  return {
    runMode: policy.runMode,
    localizationPosture: policy.localizationPosture,
    contextScope: policy.contextScope,
    contextProvenance: {
      scope: policy.contextProvenance.scope,
      coversWholeGame: policy.contextProvenance.coversWholeGame,
      narrowed: policy.contextProvenance.narrowed,
    },
    outputScope: policy.outputScope,
    roster: [...policy.roster],
    bibleBasis: policy.bibleBasis,
    requiresFullBible: policy.requiresFullBible,
    ablationBypass: policy.ablationBypass,
    shippable: policy.shippable,
  };
}
