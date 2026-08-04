import type { LocalizationPerRunInput } from "../localize-entrypoint.js";
import { providerBudgetCohort } from "../provider-budget-cohort.js";
import { localizeProviderBudgetCohortAdmission } from "../../llm/localize-admission-budget.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";
import type { LiveDispatchRuntimeConfig } from "./dispatch-runtime.js";
import { LiveWorkflowFactoryError } from "./factory-finalizer.js";

/** Build the P1-measured live dispatch posture from operator-provided bounds. */
export function productionLocalizeDispatchConfig(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly maxAttemptExposureUsd: string;
  readonly confirmedCostCapUsd: string;
  readonly projectRun?: LocalizationPerRunInput["projectRun"];
  readonly admissionCohort?: LocalizationPerRunInput["admissionCohort"];
  /** A deterministic HTTP transport is an integration-proof seam only; normal
   * production composition omits it and uses the platform fetch boundary. */
  readonly fetcher?: LiveDispatchRuntimeConfig["fetcher"];
}): Omit<LiveDispatchRuntimeConfig, "memoStore" | "contentAccess" | "snapshots"> {
  const apiKey = input.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new LiveWorkflowFactoryError("OPENROUTER_API_KEY is required for a live localize run");
  }
  const draftProfile = resolveRoleModelProfile("P1");
  const scope = `localize:${draftProfile.profileId}`;
  if (input.admissionCohort !== undefined && input.projectRun === undefined) {
    throw new LiveWorkflowFactoryError("provider budget cohort requires a durable project run");
  }
  const admissionCohort =
    input.admissionCohort ??
    (input.projectRun === undefined
      ? undefined
      : providerBudgetCohort([
          { projectId: input.projectRun.projectId, runId: input.projectRun.runId },
        ]));
  const runAdmission =
    input.projectRun === undefined
      ? {}
      : localizeProviderBudgetCohortAdmission({
          profileScope: scope,
          profileCostCapUsd: input.confirmedCostCapUsd,
          projectId: input.projectRun.projectId,
          runId: input.projectRun.runId,
          // A direct durable run carries an immutable singleton cohort snapshot.
          cohort: admissionCohort!,
        });
  return {
    profile: {
      name: draftProfile.modelProfile,
      version: draftProfile.version,
      deadlines: { normalMs: 30_000, deepMs: 300_000 },
      maxAttemptExposureUsd: input.maxAttemptExposureUsd,
    },
    admission: { scope, confirmedCostCapUsd: input.confirmedCostCapUsd, ...runAdmission },
    env: input.env,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  };
}
