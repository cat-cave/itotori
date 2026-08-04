import { describe, expect, it } from "vitest";
import { ItotoriLlmProviderBudgetCohortRepository } from "@itotori/db";

import { productionLocalizeDispatchConfig } from "../src/composition/live/factory.js";
import { localizeProviderBudgetAdmissionIdentity } from "../src/llm/localize-admission-budget.js";
import { createProductionLocalizationProviderBudget } from "../src/services/localization-provider-budget.js";
import {
  providerBudgetCohort,
  type LocalizationProviderBudgetCohort,
} from "../src/composition/provider-budget-cohort.js";
import { dispatch } from "../src/llm/dispatch.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  dispatchHarness,
  httpProviderResponse,
  physicalCallSpec,
} from "./llm-step-test-support.js";
import {
  admissionDiagnostic,
  cohortMembers,
  concurrentRound,
  dispatchRun,
  measuredProfile,
  profileTotals,
  requireLivePostgres,
  requiredCohort,
  requiredCohortId,
  requiredRunScope,
  runTotals,
} from "./production-provider-budget-live-db.support.js";

const PROFILE_CAP_USD = "0.000006";
const ATTEMPT_EXPOSURE_USD = "0.000001";
const THREE_RUN_SHARE_USD = "0.000002";

describe("provider budget fair share over live Postgres", () => {
  it("gives three concurrent runs stored fair shares under the profile cap", async () => {
    requireLivePostgres();
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
    const providerBudget = createProductionLocalizationProviderBudget({
      pool: context.pool,
      env: { OPENROUTER_API_KEY: "test-key" },
      config: () => ({
        maxAttemptExposureUsd: ATTEMPT_EXPOSURE_USD,
        confirmedCostCapUsd: PROFILE_CAP_USD,
      }),
    });
    const dispatchConfig = (runId: string, cohort: LocalizationProviderBudgetCohort) =>
      providerBudget.dispatchConfig({ projectRun: projectRun(runId), admissionCohort: cohort });
    const events: string[] = [];
    try {
      const failedCohort = cohortFor(["failed"]);
      const failedConfig = dispatchConfig("failed", failedCohort);
      const profileScope = failedConfig.admission.scope;
      await providerBudget.providerBudgetCohorts.activate(failedCohort);
      const failedHarness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: "Fail after this provider admission.",
        profile: measuredProfile(),
        admission: failedConfig.admission,
        responses: [httpProviderResponse(400)],
      });
      await expect(
        dispatch(
          physicalCallSpec("Fail after this provider admission.", { sampleId: "budget:failed" }),
          failedHarness.runtime,
        ),
      ).resolves.toMatchObject({ status: "failure", failureKind: "http" });
      expect(failedHarness.transportCalls()).toBe(1);
      const failedAttempt = await context.pool.query<{
        attempt_status: string;
        max_exposure_usd: string;
      }>(
        `
          select attempt_status, max_exposure_usd::text
          from itotori_llm_http_attempts
          where admission_run_scope = $1
        `,
        [requiredRunScope(failedConfig)],
      );
      expect(failedAttempt.rows).toEqual([
        { attempt_status: "http-error", max_exposure_usd: "0.000001000000" },
      ]);
      const releasedAfterFailure = await profileTotals(context.pool, profileScope);
      expect(releasedAfterFailure).toEqual({
        confirmedCostUsd: "0",
        reservedExposureUsd: "0",
        inFlightAttemptCount: 0,
      });
      await providerBudget.providerBudgetCohorts.release(failedCohort, {
        projectId: projectRun("failed").projectId,
        runId: projectRun("failed").runId,
      });
      expect(
        await cohortMembers(context.pool, profileScope, requiredCohortId(failedConfig)),
      ).toEqual([
        {
          projectId: projectRun("failed").projectId,
          runId: projectRun("failed").runId,
          runCostCapUsd: PROFILE_CAP_USD,
          memberState: "released",
        },
      ]);

      const runIds = ["amber", "birch", "cedar"] as const;
      // The portfolio declares the complete admission epoch before any of its
      // independently executing runs reaches the provider.
      const cohort = cohortFor(runIds);
      const dispatches = runIds.map((runId) => dispatchConfig(runId, cohort));
      const [amber, birch, cedar] = dispatches;
      if (amber === undefined || birch === undefined || cedar === undefined) {
        throw new Error("fair-share proof requires three run configs");
      }
      await providerBudget.providerBudgetCohorts.activate(cohort);

      const runScopes = dispatches.map(requiredRunScope);
      const [amberScope] = runScopes;
      if (amberScope === undefined) throw new Error("fair-share proof has no amber run scope");
      expect(new Set(dispatches.map((config) => config.admission.scope)).size).toBe(1);
      expect(new Set(runScopes).size).toBe(3);
      expect(new Set(dispatches.map(requiredCohortId))).toEqual(new Set([requiredCohortId(amber)]));
      const declaredMembers = runIds.map((runId, index) => {
        const config = dispatches[index];
        if (config === undefined) throw new Error("fair-share proof has an unexpected run config");
        return {
          projectId: projectRun(runId).projectId,
          runId: projectRun(runId).runId,
          runScope: requiredRunScope(config),
        };
      });
      for (const config of dispatches)
        expect(requiredCohort(config).members).toEqual(declaredMembers);
      expect(legacyDispatchConfig().admission).toEqual({
        scope: profileScope,
        confirmedCostCapUsd: PROFILE_CAP_USD,
      });
      const scopeFor = (projectId: string, runId: string) =>
        localizeProviderBudgetAdmissionIdentity({
          profileScope,
          projectId,
          runId,
          cohort: providerBudgetCohort([{ projectId, runId }]),
        }).runScope;
      expect(scopeFor("a:run:b", "c")).not.toBe(scopeFor("a", "b:run:c"));
      expect(scopeFor("run", "scope")).toBe(scopeFor(" run ", " scope "));
      expect(scopeFor("x".repeat(1_000), "y".repeat(1_000))).toHaveLength(77);

      const storedMembers = await cohortMembers(
        context.pool,
        profileScope,
        requiredCohortId(amber),
      );
      expect(storedMembers).toEqual(
        runIds.map((runId) => ({
          projectId: projectRun(runId).projectId,
          runId: projectRun(runId).runId,
          runCostCapUsd: THREE_RUN_SHARE_USD,
          memberState: "active",
        })),
      );
      const firstRound = await concurrentRound({
        pool: context.pool,
        cipher,
        dispatches,
        events,
        round: 1,
        profileScope,
        runIds,
      });
      expect(firstRound.activeTotals).toEqual({
        confirmedCostUsd: "0",
        reservedExposureUsd: "0.000003",
        inFlightAttemptCount: 3,
      });
      expect(firstRound.results.map((result) => result.status)).toEqual([
        "success",
        "success",
        "success",
      ]);
      expect(await runTotals(context.pool, runScopes)).toEqual(
        [...runScopes].sort().map((admissionRunScope) => ({
          admissionRunScope,
          confirmedAttemptCount: 1,
          confirmedCostUsd: ATTEMPT_EXPOSURE_USD,
          inFlightAttemptCount: 0,
        })),
      );

      const secondAmber = await dispatchRun({
        pool: context.pool,
        cipher,
        config: amber,
        runId: "amber",
        round: 2,
        events,
      });
      expect(secondAmber.result).toMatchObject({ status: "success" });
      const runShareDenied = await dispatchRun({
        pool: context.pool,
        cipher,
        config: amber,
        runId: "amber",
        round: 3,
        events,
      });
      expect(runShareDenied.providerCalls).toBe(0);
      expect(admissionDiagnostic(runShareDenied.result)).toEqual({
        reason: "run-share",
        scope: amberScope,
        capUsd: THREE_RUN_SHARE_USD,
        confirmedCostUsd: THREE_RUN_SHARE_USD,
        reservedExposureUsd: "0",
        requestedExposureUsd: ATTEMPT_EXPOSURE_USD,
      });

      const secondRound = await concurrentRound({
        pool: context.pool,
        cipher,
        dispatches: [birch, cedar],
        events,
        round: 2,
        profileScope,
        runIds: ["birch", "cedar"],
      });
      expect(secondRound.activeTotals).toEqual({
        confirmedCostUsd: "0.000004",
        reservedExposureUsd: "0.000002",
        inFlightAttemptCount: 2,
      });
      expect(secondRound.results.map((result) => result.status)).toEqual(["success", "success"]);
      const profileAtCap = await profileTotals(context.pool, profileScope);
      expect(profileAtCap).toEqual({
        confirmedCostUsd: PROFILE_CAP_USD,
        reservedExposureUsd: "0",
        inFlightAttemptCount: 0,
      });

      const profileCapDenied = await dispatchRun({
        pool: context.pool,
        cipher,
        config: birch,
        runId: "birch",
        round: 3,
        events,
      });
      expect(profileCapDenied.providerCalls).toBe(0);
      expect(admissionDiagnostic(profileCapDenied.result)).toEqual({
        reason: "profile-cap",
        scope: profileScope,
        capUsd: PROFILE_CAP_USD,
        confirmedCostUsd: PROFILE_CAP_USD,
        reservedExposureUsd: "0",
        requestedExposureUsd: ATTEMPT_EXPOSURE_USD,
      });

      const perRun = await runTotals(context.pool, runScopes);
      expect(perRun).toEqual(
        [...runScopes].sort().map((admissionRunScope) => ({
          admissionRunScope,
          confirmedAttemptCount: 2,
          confirmedCostUsd: THREE_RUN_SHARE_USD,
          inFlightAttemptCount: 0,
        })),
      );
      expect(events.filter((event) => event.startsWith("provider-start:"))).toHaveLength(6);
      await Promise.all(
        runIds.map(
          async (runId) =>
            await providerBudget.providerBudgetCohorts.release(cohort, {
              projectId: projectRun(runId).projectId,
              runId: projectRun(runId).runId,
            }),
        ),
      );
      expect(
        (await cohortMembers(context.pool, profileScope, requiredCohortId(amber))).map(
          ({ projectId, runId, memberState }) => ({ projectId, runId, memberState }),
        ),
      ).toEqual(
        runIds.map((runId) => ({
          projectId: projectRun(runId).projectId,
          runId: projectRun(runId).runId,
          memberState: "released",
        })),
      );
      console.log(
        JSON.stringify({
          providerBudgetFairShareProof: {
            database: "live-postgresql",
            profile: { scope: profileScope, capUsd: PROFILE_CAP_USD, atCap: profileAtCap },
            storedThreeRunShareUsd: THREE_RUN_SHARE_USD,
            atomicallyDeclaredMembers: declaredMembers,
            interleavedReservations: [firstRound.activeTotals, secondRound.activeTotals],
            interleavedProviderStarts: events.filter((event) =>
              event.startsWith("provider-start:"),
            ),
            perRun,
            failedReservation: {
              terminalAttempt: failedAttempt.rows[0],
              released: releasedAfterFailure,
            },
            denials: {
              runShare: admissionDiagnostic(runShareDenied.result),
              profileCap: admissionDiagnostic(profileCapDenied.result),
            },
          },
        }),
      );
    } finally {
      await context.close();
    }
  }, 120_000);

  it("keeps a singleton durable run at its full profile cap", async () => {
    requireLivePostgres();
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const repository = new ItotoriLlmProviderBudgetCohortRepository(context.pool);
    const providerBudget = createProductionLocalizationProviderBudget({
      pool: context.pool,
      env: { OPENROUTER_API_KEY: "test-key" },
      config: () => ({
        maxAttemptExposureUsd: ATTEMPT_EXPOSURE_USD,
        confirmedCostCapUsd: PROFILE_CAP_USD,
      }),
    });
    try {
      const cohort = cohortFor(["singleton"]);
      const config = providerBudget.dispatchConfig({
        projectRun: projectRun("singleton"),
        admissionCohort: cohort,
      });
      await providerBudget.providerBudgetCohorts.activate(cohort);
      const member = await repository.activeMember({
        profileScope: config.admission.scope,
        cohortId: requiredCohortId(config),
        runScope: requiredRunScope(config),
      });
      expect(member.runCostCapUsd).toBe(PROFILE_CAP_USD);
      const outcomes = await Promise.all(
        [1, 2, 3].map(
          async (round) =>
            await dispatchRun({
              pool: context.pool,
              cipher,
              config,
              runId: "singleton",
              round,
              events: [],
            }),
        ),
      );
      expect(outcomes.map((outcome) => outcome.result.status)).toEqual([
        "success",
        "success",
        "success",
      ]);
      expect(outcomes.map((outcome) => outcome.providerCalls)).toEqual([1, 1, 1]);
      expect(await runTotals(context.pool, [requiredRunScope(config)])).toEqual([
        {
          admissionRunScope: requiredRunScope(config),
          confirmedAttemptCount: 3,
          confirmedCostUsd: "0.000003",
          inFlightAttemptCount: 0,
        },
      ]);
      await providerBudget.providerBudgetCohorts.release(cohort, {
        projectId: projectRun("singleton").projectId,
        runId: projectRun("singleton").runId,
      });
    } finally {
      await context.close();
    }
  }, 120_000);
});

function cohortFor(runIds: readonly string[]): LocalizationProviderBudgetCohort {
  return providerBudgetCohort(runIds.map((runId) => projectRun(runId)));
}

function projectRun(runId: string) {
  return {
    projectId: `budget-project-${runId}`,
    runId: `budget-run-${runId}`,
    localeBranchId: `budget-branch-${runId}`,
    leaseOwnerId: `budget-owner-${runId}`,
  };
}

function legacyDispatchConfig() {
  return productionLocalizeDispatchConfig({
    env: { OPENROUTER_API_KEY: "test-key" },
    maxAttemptExposureUsd: ATTEMPT_EXPOSURE_USD,
    confirmedCostCapUsd: PROFILE_CAP_USD,
  });
}
