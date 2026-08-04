import type { LlmProviderBudgetCohortActivation } from "./llm-provider-budget-cohort-repository.js";

export interface LlmProviderBudgetRunAdmission {
  readonly scope: string;
  readonly cohortId: string;
}

export function resolveProviderBudgetRunAdmission(
  scope: string | undefined,
  cohortId: string | undefined,
): LlmProviderBudgetRunAdmission | undefined {
  if (scope === undefined && cohortId === undefined) return undefined;
  if (scope === undefined || cohortId === undefined) {
    throw new Error("run admission scope and cohort ID must be provided together");
  }
  assertScope(scope);
  assertScope(cohortId);
  return { scope, cohortId };
}

export function assertProviderBudgetCohortAdmission(
  profileScope: string,
  profileCostCapUsd: string,
  runAdmission: LlmProviderBudgetRunAdmission | undefined,
  cohort: LlmProviderBudgetCohortActivation | undefined,
): void {
  if (!cohort) return;
  if (!runAdmission)
    throw new Error("preactivated provider-budget cohort admission requires a run member");
  if (
    cohort.profileScope !== profileScope ||
    normalizeDecimal(cohort.profileCostCapUsd) !== normalizeDecimal(profileCostCapUsd) ||
    cohort.cohortId !== runAdmission.cohortId
  ) {
    throw new Error("preactivated provider-budget cohort does not match spend admission metadata");
  }
}

function assertScope(value: string): void {
  if (value.length < 1 || value.length > 256) throw new Error("admission scope is invalid");
}

function normalizeDecimal(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(?<fraction>\.\d*?)0+$/u, "$<fraction>");
}
