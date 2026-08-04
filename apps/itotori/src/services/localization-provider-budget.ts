import {
  ItotoriLlmProviderBudgetCohortRepository,
  type LlmProviderBudgetCohortActivation,
} from "@itotori/db";

import {
  localizeProviderBudgetAdmissionIdentity,
  type LocalizeProviderBudgetCohortMemberIdentity,
} from "../llm/localize-admission-budget.js";
import { resolveRoleModelProfile } from "../llm/role-model-profiles.js";
import type { LocalizationPerRunInput } from "../composition/localize-entrypoint.js";
import type {
  LocalizationProviderBudgetCohort,
  LocalizationProviderBudgetCohortMember,
  LocalizationProviderBudgetCohorts,
} from "../composition/provider-budget-cohort.js";
import {
  productionLocalizeDispatchConfig,
  type LiveDispatchRuntimeConfig,
} from "../composition/live/index.js";

type LocalizationProviderBudgetConfig = {
  readonly maxAttemptExposureUsd: string;
  readonly confirmedCostCapUsd: string;
};

/** Own the profile-bound provider-budget controls shared by localize commands,
 * detached passes, and the live dispatch factory. */
export function createProductionLocalizationProviderBudget(input: {
  readonly pool: ConstructorParameters<typeof ItotoriLlmProviderBudgetCohortRepository>[0];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: () => LocalizationProviderBudgetConfig;
  readonly fetcher?: LiveDispatchRuntimeConfig["fetcher"];
}): {
  readonly dispatchConfig: (
    perRun?: Pick<LocalizationPerRunInput, "projectRun" | "admissionCohort">,
  ) => ReturnType<typeof productionLocalizeDispatchConfig>;
  readonly providerBudgetCohorts: LocalizationProviderBudgetCohorts;
} {
  const profileScope = `localize:${resolveRoleModelProfile("P1").profileId}`;
  const cohorts = new ItotoriLlmProviderBudgetCohortRepository(input.pool);
  return {
    dispatchConfig(perRun) {
      const config = input.config();
      return productionLocalizeDispatchConfig({
        env: input.env,
        maxAttemptExposureUsd: config.maxAttemptExposureUsd,
        confirmedCostCapUsd: config.confirmedCostCapUsd,
        ...(perRun?.projectRun === undefined ? {} : { projectRun: perRun.projectRun }),
        ...(perRun?.admissionCohort === undefined
          ? {}
          : { admissionCohort: perRun.admissionCohort }),
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      });
    },
    providerBudgetCohorts: {
      async activate(cohort) {
        const config = input.config();
        await cohorts.activate(
          cohortActivation({
            profileScope,
            profileCostCapUsd: config.confirmedCostCapUsd,
            cohort,
          }),
        );
      },
      async release(cohort, member) {
        const identity = memberIdentity(profileScope, cohort, member);
        const declaredMember = identity.members.find(
          (candidate) => candidate.runScope === identity.runScope,
        );
        if (declaredMember === undefined) {
          throw new Error("provider budget cohort does not contain the released member");
        }
        await cohorts.release({
          profileScope,
          cohortId: identity.cohortId,
          projectId: declaredMember.projectId,
          runId: declaredMember.runId,
        });
      },
    },
  };
}

function cohortActivation(input: {
  readonly profileScope: string;
  readonly profileCostCapUsd: string;
  readonly cohort: LocalizationProviderBudgetCohort;
}): LlmProviderBudgetCohortActivation {
  const first = input.cohort.members[0];
  if (first === undefined) throw new Error("provider budget cohort requires a member");
  const identity = memberIdentity(input.profileScope, input.cohort, first);
  return {
    profileScope: input.profileScope,
    profileCostCapUsd: input.profileCostCapUsd,
    cohortId: identity.cohortId,
    members: identity.members,
  };
}

function memberIdentity(
  profileScope: string,
  cohort: LocalizationProviderBudgetCohort,
  member: LocalizationProviderBudgetCohortMember,
): {
  readonly runScope: string;
  readonly cohortId: string;
  readonly members: readonly LocalizeProviderBudgetCohortMemberIdentity[];
} {
  return localizeProviderBudgetAdmissionIdentity({
    profileScope,
    projectId: member.projectId,
    runId: member.runId,
    cohort,
  });
}
