import type { CallResult } from "../src/contracts/index.js";
import { productionLocalizeDispatchConfig } from "../src/composition/live/factory.js";
import type { LocalizeProviderBudgetCohortAdmission } from "../src/llm/localize-admission-budget.js";
import { dispatch } from "../src/llm/dispatch.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { ItotoriLlmProviderBudgetCohortRepository } from "@itotori/db";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TEST_MODEL_PROFILE,
  TestMemoCipher,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

type DispatchConfig = ReturnType<typeof productionLocalizeDispatchConfig>;
type LivePool = Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"];

export function measuredProfile() {
  return { ...TEST_MODEL_PROFILE, maxAttemptExposureUsd: "0.000001" };
}

export async function concurrentRound(input: {
  readonly pool: LivePool;
  readonly cipher: TestMemoCipher;
  readonly dispatches: readonly DispatchConfig[];
  readonly events: string[];
  readonly round: number;
  readonly profileScope: string;
  readonly runIds: readonly string[];
}): Promise<{
  readonly results: readonly CallResult[];
  readonly activeTotals: Awaited<ReturnType<typeof profileTotals>>;
}> {
  const started = countdown(input.dispatches.length);
  const releases = input.dispatches.map(() => deferred());
  const attempts = input.dispatches.map((config, index) =>
    dispatchRun({
      pool: input.pool,
      cipher: input.cipher,
      config,
      runId: input.runIds[index] ?? `run-${String(index + 1)}`,
      round: input.round,
      events: input.events,
      started,
      release: releases[index],
    }),
  );
  await started.promise;
  const activeTotals = await profileTotals(input.pool, input.profileScope);
  for (const release of releases) release.resolve();
  const settled = await Promise.all(attempts);
  return { results: settled.map((attempt) => attempt.result), activeTotals };
}

export async function dispatchRun(input: {
  readonly pool: LivePool;
  readonly cipher: TestMemoCipher;
  readonly config: DispatchConfig;
  readonly runId: string;
  readonly round: number;
  readonly events: string[];
  readonly started?: ReturnType<typeof countdown>;
  readonly release?: ReturnType<typeof deferred>;
}): Promise<{ readonly result: CallResult; readonly providerCalls: number }> {
  const prompt = `Budget proof ${input.runId} round ${input.round}.`;
  const harness = dispatchHarness({
    pool: input.pool,
    cipher: input.cipher,
    prompt,
    profile: measuredProfile(),
    admission: input.config.admission,
    responses: [
      async () => {
        input.events.push(`provider-start:${input.runId}:round-${input.round}`);
        input.started?.arrive();
        await input.release?.promise;
        return structuredProviderResponse(reviewVerdictExample, 0.000001);
      },
    ],
  });
  const result = await dispatch(
    physicalCallSpec(prompt, { sampleId: `budget:${input.runId}:${input.round}` }),
    harness.runtime,
  );
  input.events.push(`completed:${input.runId}:round-${input.round}`);
  return { result, providerCalls: harness.transportCalls() };
}

export function requiredCohort(
  config: DispatchConfig,
): LocalizeProviderBudgetCohortAdmission["cohort"] {
  const cohort = config.admission.cohort;
  if (cohort === undefined) throw new Error("durable provider-budget cohort is missing");
  return cohort;
}

export function requiredCohortId(config: DispatchConfig): string {
  const cohortId = config.admission.cohortId;
  if (cohortId === undefined) throw new Error("durable provider-budget cohort ID is missing");
  return cohortId;
}

export function requiredRunScope(config: DispatchConfig): string {
  const scope = config.admission.runScope;
  if (scope === undefined) throw new Error("fair-share dispatch has no run scope");
  return scope;
}

export async function releaseCohort(
  repository: ItotoriLlmProviderBudgetCohortRepository,
  cohort: LocalizeProviderBudgetCohortAdmission["cohort"],
): Promise<void> {
  await Promise.all(
    cohort.members.map(
      async (member) =>
        await repository.release({
          profileScope: cohort.profileScope,
          cohortId: cohort.cohortId,
          projectId: member.projectId,
          runId: member.runId,
        }),
    ),
  );
}

export function admissionDiagnostic(result: CallResult) {
  if (result.status === "failure" && result.failureKind === "spend-admission") {
    if (result.admission !== undefined) return result.admission;
  }
  throw new Error("expected an actionable spend-admission result");
}

export async function profileTotals(
  pool: LivePool,
  scope: string,
): Promise<{
  readonly confirmedCostUsd: string;
  readonly reservedExposureUsd: string;
  readonly inFlightAttemptCount: number;
}> {
  const result = await pool.query<{
    confirmed_cost_usd: string;
    reserved_exposure_usd: string;
    in_flight_attempt_count: number;
  }>(
    `
    select
      coalesce(sum(cost_usd) filter (where billing_state = 'confirmed'), 0)::text
        as confirmed_cost_usd,
      coalesce(sum(max_exposure_usd) filter (where attempt_status = 'in-flight'), 0)::text
        as reserved_exposure_usd,
      count(*) filter (where attempt_status = 'in-flight')::integer as in_flight_attempt_count
    from itotori_llm_http_attempts where admission_scope = $1
  `,
    [scope],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("profile totals query returned no row");
  return {
    confirmedCostUsd: normalizeDecimal(row.confirmed_cost_usd),
    reservedExposureUsd: normalizeDecimal(row.reserved_exposure_usd),
    inFlightAttemptCount: row.in_flight_attempt_count,
  };
}

export async function cohortMembers(pool: LivePool, profileScope: string, cohortId: string) {
  const result = await pool.query<{
    project_id: string;
    run_id: string;
    run_cost_cap_usd: string;
    member_state: string;
  }>(
    `
    select project_id, run_id, run_cost_cap_usd::text, member_state
    from itotori_llm_provider_budget_cohort_members
    where profile_scope = $1 and cohort_id = $2 order by project_id, run_id
  `,
    [profileScope, cohortId],
  );
  return result.rows.map((row) => ({
    projectId: row.project_id,
    runId: row.run_id,
    runCostCapUsd: normalizeDecimal(row.run_cost_cap_usd),
    memberState: row.member_state,
  }));
}

export async function runTotals(pool: LivePool, scopes: readonly string[]) {
  const result = await pool.query<{
    admission_run_scope: string;
    confirmed_attempt_count: number;
    confirmed_cost_usd: string;
    in_flight_attempt_count: number;
  }>(
    `
    select admission_run_scope,
      count(*) filter (where billing_state = 'confirmed')::integer as confirmed_attempt_count,
      coalesce(sum(cost_usd) filter (where billing_state = 'confirmed'), 0)::text as confirmed_cost_usd,
      count(*) filter (where attempt_status = 'in-flight')::integer as in_flight_attempt_count
    from itotori_llm_http_attempts where admission_run_scope = any($1::text[])
    group by admission_run_scope order by admission_run_scope
  `,
    [scopes],
  );
  return result.rows.map((row) => ({
    admissionRunScope: row.admission_run_scope,
    confirmedAttemptCount: row.confirmed_attempt_count,
    confirmedCostUsd: normalizeDecimal(row.confirmed_cost_usd),
    inFlightAttemptCount: row.in_flight_attempt_count,
  }));
}

export function requireLivePostgres(): void {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("provider budget fair-share proof requires DATABASE_URL");
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {
    throw new Error("deferred resolve was not initialized");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function countdown(count: number): {
  readonly promise: Promise<void>;
  readonly arrive: () => void;
} {
  const complete = deferred();
  let arrived = 0;
  return {
    promise: complete.promise,
    arrive: () => {
      arrived += 1;
      if (arrived === count) complete.resolve();
    },
  };
}

function normalizeDecimal(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(?<fraction>\.\d*?)0+$/u, "$<fraction>");
}
