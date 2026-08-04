import { sha256 } from "./canonical-json.js";

const COHORT_ID_PREFIX = "localize-cohort:";

export interface LocalizeProviderBudgetCohortMemberIdentity {
  readonly projectId: string;
  readonly runId: string;
  readonly runScope: string;
}

/** The profile-scoped identity and immutable member snapshot used for durable
 * spend admission. */
export interface LocalizeProviderBudgetAdmissionIdentity {
  readonly runScope: string;
  readonly cohortId: string;
  readonly members: readonly LocalizeProviderBudgetCohortMemberIdentity[];
}

export interface LocalizeProviderBudgetCohortAdmission extends Omit<
  LocalizeProviderBudgetAdmissionIdentity,
  "members"
> {
  readonly cohort: {
    readonly profileScope: string;
    readonly profileCostCapUsd: string;
    readonly cohortId: string;
    readonly members: readonly LocalizeProviderBudgetCohortMemberIdentity[];
  };
}

/** Derive the bounded, deterministic identities for one member of a declared
 * localization provider-budget cohort. This never divides or otherwise chooses
 * a provider budget; the durable cohort repository owns that allocation. */
export function localizeProviderBudgetAdmissionIdentity(input: {
  readonly profileScope: string;
  readonly projectId: string;
  readonly runId: string;
  readonly cohort: {
    readonly cohortId: string;
    readonly members: readonly {
      readonly projectId: string;
      readonly runId: string;
    }[];
  };
}): LocalizeProviderBudgetAdmissionIdentity {
  const profileScope = requiredIdentifier(input.profileScope, "profile scope");
  const projectId = requiredRunIdentity(input.projectId, "project ID");
  const runId = requiredRunIdentity(input.runId, "run ID");
  const members = normalizeMembers(input.cohort.members, profileScope);
  const cohortId = requiredIdentifier(input.cohort.cohortId, "cohort ID");
  if (cohortId !== localizeProviderBudgetCohortId(members)) {
    throw new Error("provider budget cohort ID does not match its member snapshot");
  }
  const runScope = runScopeFor(profileScope, projectId, runId);
  if (!members.some((member) => member.projectId === projectId && member.runId === runId)) {
    throw new Error("provider budget cohort does not contain the current project run");
  }
  return { runScope, cohortId, members };
}

/** Attach this run's immutable member snapshot to an attempt admission. The
 * database remains the sole provider-budget share authority. */
export function localizeProviderBudgetCohortAdmission(input: {
  readonly profileScope: string;
  readonly profileCostCapUsd: string;
  readonly projectId: string;
  readonly runId: string;
  readonly cohort: {
    readonly cohortId: string;
    readonly members: readonly {
      readonly projectId: string;
      readonly runId: string;
    }[];
  };
}): LocalizeProviderBudgetCohortAdmission {
  const identity = localizeProviderBudgetAdmissionIdentity(input);
  return {
    runScope: identity.runScope,
    cohortId: identity.cohortId,
    cohort: {
      profileScope: requiredIdentifier(input.profileScope, "profile scope"),
      profileCostCapUsd: input.profileCostCapUsd,
      cohortId: identity.cohortId,
      members: identity.members,
    },
  };
}

/** Hash the complete canonical member snapshot into a bounded cohort ID. */
export function localizeProviderBudgetCohortId(
  members: readonly { readonly projectId: string; readonly runId: string }[],
): string {
  const normalized = normalizeMemberPairs(members);
  return `${COHORT_ID_PREFIX}${sha256({ members: normalized }).slice("sha256:".length)}`;
}

function normalizeMembers(
  members: readonly { readonly projectId: string; readonly runId: string }[],
  profileScope: string,
): readonly LocalizeProviderBudgetCohortMemberIdentity[] {
  return normalizeMemberPairs(members).map(({ projectId, runId }) => ({
    projectId,
    runId,
    runScope: runScopeFor(profileScope, projectId, runId),
  }));
}

function normalizeMemberPairs(
  members: readonly { readonly projectId: string; readonly runId: string }[],
): readonly { readonly projectId: string; readonly runId: string }[] {
  if (members.length === 0) throw new Error("provider budget cohort requires a member");
  const normalized = members
    .map((member) => {
      const projectId = requiredRunIdentity(member.projectId, "project ID");
      const runId = requiredRunIdentity(member.runId, "run ID");
      return { projectId, runId };
    })
    .toSorted(compareMemberPairs);
  if (normalized.some((member, index) => index > 0 && sameMember(member, normalized[index - 1]!))) {
    throw new Error("provider budget cohort has duplicate run membership");
  }
  return normalized;
}

function runScopeFor(profileScope: string, projectId: string, runId: string): string {
  return `localize-run:${sha256({ profileScope, projectId, runId }).slice("sha256:".length)}`;
}

function compareMemberPairs(
  left: { readonly projectId: string; readonly runId: string },
  right: { readonly projectId: string; readonly runId: string },
): number {
  const projectOrder = left.projectId.localeCompare(right.projectId);
  return projectOrder === 0 ? left.runId.localeCompare(right.runId) : projectOrder;
}

function sameMember(
  left: { readonly projectId: string; readonly runId: string },
  right: { readonly projectId: string; readonly runId: string },
): boolean {
  return left.projectId === right.projectId && left.runId === right.runId;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error(`provider budget cohort requires a valid ${label}`);
  }
  return normalized;
}

/** Project/run inputs are hashed before they become durable admission scopes,
 * so their raw length does not determine the bounded storage identifier. */
function requiredRunIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`provider budget cohort requires a valid ${label}`);
  }
  return normalized;
}
