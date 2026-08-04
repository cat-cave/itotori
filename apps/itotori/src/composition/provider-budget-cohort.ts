import { localizeProviderBudgetCohortId } from "../llm/localize-admission-budget.js";

export interface LocalizationProviderBudgetCohortMember {
  readonly projectId: string;
  readonly runId: string;
}

/** An immutable durable member snapshot sharing one provider-budget cohort. */
export interface LocalizationProviderBudgetCohort {
  readonly cohortId: string;
  readonly members: readonly LocalizationProviderBudgetCohortMember[];
}

/** The command-side lifecycle port for a declared provider-budget cohort. */
export interface LocalizationProviderBudgetCohorts {
  activate(cohort: LocalizationProviderBudgetCohort): Promise<void>;
  release(
    cohort: LocalizationProviderBudgetCohort,
    member: LocalizationProviderBudgetCohortMember,
  ): Promise<void>;
}

/** Canonicalize durable members before their immutable cohort activation. */
export function providerBudgetCohort(
  members: readonly LocalizationProviderBudgetCohortMember[],
): LocalizationProviderBudgetCohort {
  const normalized = members
    .map((member) => ({
      projectId: requiredText(member.projectId, "project ID"),
      runId: requiredText(member.runId, "run ID"),
    }))
    .toSorted((left, right) => {
      const projectOrder = left.projectId.localeCompare(right.projectId);
      return projectOrder === 0 ? left.runId.localeCompare(right.runId) : projectOrder;
    });
  if (normalized.length === 0) throw new Error("provider budget cohort requires a member");
  const identities = new Set(normalized.map(({ projectId, runId }) => `${projectId}\0${runId}`));
  if (identities.size !== normalized.length) {
    throw new Error("provider budget cohort has duplicate run membership");
  }
  return {
    cohortId: localizeProviderBudgetCohortId(normalized),
    members: normalized,
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`provider budget cohort requires a ${label}`);
  return normalized;
}
