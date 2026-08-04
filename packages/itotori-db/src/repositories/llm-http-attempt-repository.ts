import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import type {
  LlmMemoCipher,
  LlmMemoSingleflightInput,
  LlmStepExecution,
} from "./llm-call-memo-repository.js";
import {
  ItotoriLlmProviderBudgetCohortRepository,
  lockLlmProviderBudgetProfile,
  LlmProviderBudgetCohortMemberUnavailableError,
} from "./llm-provider-budget-cohort-repository.js";
import {
  assertProviderBudgetCohortAdmission,
  resolveProviderBudgetRunAdmission,
  type LlmProviderBudgetRunAdmission,
} from "./llm-provider-budget-admission.js";
import {
  LlmPhysicalStepFailedError,
  LlmRetriesExhaustedError,
  LlmSpendAdmissionDeniedError,
  type LlmSpendAdmissionDiagnostic,
  type LlmSpendAdmissionDenyReason,
  type LlmSpendExposureReport,
} from "./llm-http-attempt-errors.js";

export {
  LlmPhysicalStepFailedError,
  LlmRetriesExhaustedError,
  LlmSpendAdmissionDeniedError,
} from "./llm-http-attempt-errors.js";
export type {
  LlmSpendAdmissionDiagnostic,
  LlmSpendAdmissionDenyReason,
  LlmSpendExposureReport,
} from "./llm-http-attempt-errors.js";

type Queryable = Pick<DatabaseContext["pool"], "query">;
type AdmissionScopeColumn = "admission_scope" | "admission_run_scope";

export class ItotoriLlmHttpAttemptRepository {
  readonly #cohorts: ItotoriLlmProviderBudgetCohortRepository;

  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
  ) {
    this.#cohorts = new ItotoriLlmProviderBudgetCohortRepository(pool);
  }

  async readSpendExposure(
    admissionScope: string,
    queryable: Queryable = this.pool,
  ): Promise<LlmSpendExposureReport> {
    return await this.readSpendExposureForColumn(admissionScope, "admission_scope", queryable);
  }

  private async readSpendExposureForColumn(
    admissionScope: string,
    scopeColumn: AdmissionScopeColumn,
    queryable: Queryable,
  ): Promise<LlmSpendExposureReport> {
    assertScope(admissionScope);
    const exposure = await queryable.query<ExposureRow>(
      `
        with scoped as (
          select * from itotori_llm_http_attempts where ${scopeColumn} = $1
        ), exhausted as (
          select attempt.memo_key
          from scoped attempt
          where not exists (
            select 1 from itotori_llm_call_memos memo where memo.memo_key = attempt.memo_key
          )
          group by attempt.memo_key
          having count(*) = 3 and (
            array_agg(
              coalesce(
                attempt.failure_class,
                case
                  when attempt.attempt_status = 'in-flight' and attempt.deadline_at <= now()
                    then 'transient'
                  else null
                end
              )
              order by attempt.attempt_ordinal desc
            )
          )[1] = 'transient'
        )
        select
          coalesce(sum(cost_usd) filter (where billing_state = 'confirmed'), 0)::text
            as confirmed_cost_usd,
          count(*) filter (
            where billing_state = 'billing_unknown'
              and (attempt_status <> 'in-flight' or deadline_at <= now())
          )::integer as billing_unknown_attempt_count,
          coalesce(sum(max_exposure_usd) filter (
            where attempt_status = 'in-flight' and deadline_at > now()
          ), 0)::text as bounded_in_flight_exposure_usd,
          count(*) filter (
            where attempt_status = 'in-flight' and deadline_at > now()
          )::integer as in_flight_attempt_count,
          (select count(*)::integer from exhausted) as exhausted_retry_step_count
        from scoped
      `,
      [admissionScope],
    );
    const row = exposure.rows[0];
    return {
      admissionScope,
      confirmedCostUsd: normalizeDecimal(row?.confirmed_cost_usd ?? "0"),
      billingUnknownAttemptCount: row?.billing_unknown_attempt_count ?? 0,
      boundedInFlightExposureUsd: normalizeDecimal(row?.bounded_in_flight_exposure_usd ?? "0"),
      inFlightAttemptCount: row?.in_flight_attempt_count ?? 0,
      exhaustedRetryStepCount: row?.exhausted_retry_step_count ?? 0,
    };
  }

  async nextOrdinal(memoKey: string, client: PoolClient): Promise<number> {
    const attempts = await client.query<AttemptStateRow>(
      `
        select attempt_ordinal, attempt_status, failure_class, http_status,
               deadline_at <= now() as expired
        from itotori_llm_http_attempts
        where memo_key = $1
        order by attempt_ordinal desc
      `,
      [memoKey],
    );
    const latest = attempts.rows[0];
    if (!latest) return 1;
    if (latest.failure_class === "permanent") {
      throw new LlmPhysicalStepFailedError(
        memoKey,
        "permanent",
        latest.attempt_status,
        latest.http_status,
      );
    }
    if (latest.attempt_status === "in-flight" && !latest.expired) {
      throw new LlmPhysicalStepFailedError(memoKey, "in-flight", "in-flight", null);
    }
    if (attempts.rows.length >= 3) {
      throw new LlmRetriesExhaustedError(memoKey, attempts.rows.length);
    }
    return latest.attempt_ordinal + 1;
  }

  async admitAndStart(
    client: PoolClient,
    input: LlmMemoSingleflightInput,
    attempt: { ordinal: number; startedAt: string },
  ): Promise<void> {
    const { admission } = input;
    assertDecimal(admission.confirmedCostCapUsd, "confirmed cost cap");
    assertDecimal(admission.maxAttemptExposureUsd, "attempt exposure ceiling");
    assertScope(admission.scope);
    const runAdmission = resolveProviderBudgetRunAdmission(admission.runScope, admission.cohortId);
    assertProviderBudgetCohortAdmission(
      admission.scope,
      admission.confirmedCostCapUsd,
      runAdmission,
      admission.cohort,
    );
    if (!Number.isSafeInteger(admission.deadlineMs) || admission.deadlineMs <= 0) {
      throw new Error("physical attempt deadline must be a positive safe integer");
    }
    const request = await this.cipher.seal(input.requestJson);
    const deadlineAt = new Date(Date.parse(attempt.startedAt) + admission.deadlineMs).toISOString();
    await client.query("begin");
    try {
      await lockLlmProviderBudgetProfile(client, admission.scope);
      await this.denyStrictCap({
        client,
        scope: admission.scope,
        scopeColumn: "admission_scope",
        capUsd: admission.confirmedCostCapUsd,
        requestedExposureUsd: admission.maxAttemptExposureUsd,
        reason: "profile-cap",
      });
      await this.admitRunShare(client, admission, runAdmission);
      await client.query(
        `
          insert into itotori_llm_http_attempts (
            attempt_id, memo_key, attempt_ordinal,
            admission_scope, admission_run_scope, admission_cohort_id,
            request_ciphertext, request_key_ref, request_content_hash, request_hash,
            attempt_status, failure_class, http_status, generation_id,
            served_pair_status, served_model, served_provider, verification_status,
            router_attempts, prompt_token_count, completion_token_count,
            reasoning_token_count, cached_token_count,
            billing_state, cost_usd, reported_cost_usd, max_exposure_usd,
            started_at, deadline_at, completed_at, retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            'in-flight', null, null, null,
            'unknown', null, null, 'pending', '[]'::jsonb, null, null, null, null,
            'billing_unknown', null, null, $11,
            $12::timestamptz, $13::timestamptz, null,
            $12::timestamptz + interval '7 days'
          )
        `,
        [
          attemptId(input.memoKey, attempt.ordinal),
          input.memoKey,
          attempt.ordinal,
          admission.scope,
          runAdmission?.scope ?? admission.scope,
          runAdmission?.cohortId ?? null,
          request.ciphertext,
          request.keyRef,
          hash(input.requestJson),
          input.semanticHash,
          admission.maxAttemptExposureUsd,
          attempt.startedAt,
          deadlineAt,
        ],
      );
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback");
      throw error;
    }
  }

  private async admitRunShare(
    client: PoolClient,
    admission: LlmMemoSingleflightInput["admission"],
    runAdmission: LlmProviderBudgetRunAdmission | undefined,
  ): Promise<void> {
    try {
      if (runAdmission === undefined) return;
      const member = await this.#cohorts.activeMember(
        {
          profileScope: admission.scope,
          cohortId: runAdmission.cohortId,
          runScope: runAdmission.scope,
        },
        client,
      );
      await this.denyStrictCap({
        client,
        scope: runAdmission.scope,
        scopeColumn: "admission_run_scope",
        capUsd: member.runCostCapUsd,
        requestedExposureUsd: admission.maxAttemptExposureUsd,
        reason: "run-share",
      });
    } catch (error: unknown) {
      if (error instanceof LlmProviderBudgetCohortMemberUnavailableError) {
        await this.denyUnavailableCohort(client, admission);
      }
      throw error;
    }
  }

  private async denyUnavailableCohort(
    client: PoolClient,
    admission: LlmMemoSingleflightInput["admission"],
  ): Promise<never> {
    const totals = await this.readAdmissionTotals(admission.scope, "admission_scope", client);
    const report = await this.readSpendExposureForColumn(
      admission.scope,
      "admission_scope",
      client,
    );
    throw new LlmSpendAdmissionDeniedError(
      {
        reason: "profile-cohort-busy",
        scope: admission.scope,
        capUsd: admission.confirmedCostCapUsd,
        ...totals,
        requestedExposureUsd: admission.maxAttemptExposureUsd,
      },
      report,
    );
  }

  private async denyStrictCap(input: {
    readonly client: PoolClient;
    readonly scope: string;
    readonly scopeColumn: AdmissionScopeColumn;
    readonly capUsd: string;
    readonly requestedExposureUsd: string;
    readonly reason: LlmSpendAdmissionDenyReason;
  }): Promise<void> {
    const totals = await this.readAdmissionTotals(input.scope, input.scopeColumn, input.client);
    const denied = await input.client.query<{ denied: boolean }>(
      "select $1::numeric + $2::numeric + $3::numeric > $4::numeric as denied",
      [
        totals.confirmedCostUsd,
        totals.reservedExposureUsd,
        input.requestedExposureUsd,
        input.capUsd,
      ],
    );
    if (!denied.rows[0]?.denied) return;
    const report = await this.readSpendExposureForColumn(
      input.scope,
      input.scopeColumn,
      input.client,
    );
    throw new LlmSpendAdmissionDeniedError(
      {
        reason: input.reason,
        scope: input.scope,
        capUsd: input.capUsd,
        ...totals,
        requestedExposureUsd: input.requestedExposureUsd,
      },
      report,
    );
  }

  private async readAdmissionTotals(
    scope: string,
    scopeColumn: AdmissionScopeColumn,
    queryable: Queryable,
  ): Promise<AdmissionTotals> {
    const totals = await queryable.query<AdmissionTotalsRow>(
      `
        select
          coalesce(sum(cost_usd) filter (where billing_state = 'confirmed'), 0)::text
            as confirmed_cost_usd,
          coalesce(sum(max_exposure_usd) filter (where attempt_status = 'in-flight'), 0)::text
            as reserved_exposure_usd
        from itotori_llm_http_attempts
        where ${scopeColumn} = $1
      `,
      [scope],
    );
    const row = totals.rows[0];
    return {
      confirmedCostUsd: normalizeDecimal(row?.confirmed_cost_usd ?? "0"),
      reservedExposureUsd: normalizeDecimal(row?.reserved_exposure_usd ?? "0"),
    };
  }

  async finish(
    client: PoolClient,
    input: LlmMemoSingleflightInput,
    attempt: { ordinal: number; execution: LlmStepExecution },
    transactional = true,
  ): Promise<void> {
    const response = attempt.execution.responseJson
      ? await this.cipher.seal(attempt.execution.responseJson)
      : null;
    const status =
      attempt.execution.kind === "completed" ? "completed" : attempt.execution.attemptStatus;
    const failureClass =
      attempt.execution.kind === "completed" ? null : attempt.execution.failure.classification;
    const httpStatus = attempt.execution.kind === "completed" ? 200 : attempt.execution.httpStatus;
    const billing = attempt.execution.billing;
    const served = attempt.execution.served;
    const usage = attempt.execution.usage;
    const confirmedServedPair =
      attempt.execution.generationId !== null && served.status === "confirmed" ? served : null;
    const verificationStatus = responseVerificationStatus(attempt.execution);
    const write = () =>
      client.query(
        `
          update itotori_llm_http_attempts
          set response_ciphertext = $1, response_key_ref = $2, response_content_hash = $3,
              attempt_status = $4, failure_class = $5, http_status = $6,
              generation_id = $7, served_pair_status = $8,
              served_model = $9, served_provider = $10, verification_status = $11,
              router_attempts = $12::jsonb,
              prompt_token_count = $13, completion_token_count = $14,
              reasoning_token_count = $15, cached_token_count = $16,
              billing_state = $17, cost_usd = $18, reported_cost_usd = $19,
              completed_at = $20::timestamptz
          where attempt_id = $21 and attempt_status = 'in-flight' and completed_at is null
        `,
        [
          response?.ciphertext ?? null,
          response?.keyRef ?? null,
          attempt.execution.responseJson ? hash(attempt.execution.responseJson) : null,
          status,
          failureClass,
          httpStatus,
          attempt.execution.generationId,
          confirmedServedPair ? "confirmed" : "unknown",
          confirmedServedPair?.model ?? null,
          confirmedServedPair?.provider ?? null,
          verificationStatus,
          JSON.stringify(attempt.execution.routerAttempts),
          usage?.promptTokens ?? null,
          usage?.completionTokens ?? null,
          usage?.reasoningTokens ?? null,
          usage?.cachedTokens ?? null,
          billing.status,
          billing.status === "confirmed" ? billing.costUsd : null,
          attempt.execution.reportedCostUsd,
          attempt.execution.completedAt,
          attemptId(input.memoKey, attempt.ordinal),
        ],
      );
    if (!transactional) {
      const result = await write();
      if (result.rowCount !== 1)
        throw new Error("physical attempt finalization lost its start row");
      return;
    }
    await client.query("begin");
    try {
      const result = await write();
      if (result.rowCount !== 1)
        throw new Error("physical attempt finalization lost its start row");
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback");
      throw error;
    }
  }
}

function responseVerificationStatus(
  execution: LlmStepExecution,
): "pending" | "verified" | "explicit-unknown" | "quarantined" {
  if (execution.kind === "incomplete") return "quarantined";
  if (
    execution.outcomeKind === "invalid" ||
    execution.outcomeKind === "refusal" ||
    execution.outcomeKind === "truncation"
  ) {
    return "quarantined";
  }
  return execution.generationId !== null && execution.served.status === "confirmed"
    ? "verified"
    : "explicit-unknown";
}

type ExposureRow = {
  confirmed_cost_usd: string;
  billing_unknown_attempt_count: number;
  bounded_in_flight_exposure_usd: string;
  in_flight_attempt_count: number;
  exhausted_retry_step_count: number;
};

type AttemptStateRow = {
  attempt_ordinal: number;
  attempt_status: string;
  failure_class: string | null;
  http_status: number | null;
  expired: boolean;
};

type AdmissionTotals = { readonly confirmedCostUsd: string; readonly reservedExposureUsd: string };
type AdmissionTotalsRow = { confirmed_cost_usd: string; reserved_exposure_usd: string };

function attemptId(memoKey: string, ordinal: number): string {
  return hash({ memoKey, ordinal });
}

function assertScope(value: string): void {
  if (value.length < 1 || value.length > 256) throw new Error("admission scope is invalid");
}

function assertDecimal(value: string, label: string): void {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u.test(value)) {
    throw new Error(`${label} must be an exact nonnegative decimal`);
  }
}

function normalizeDecimal(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(?<fraction>\.\d*?)0+$/u, "$<fraction>");
}

function hash(value: unknown): `sha256:${string}` {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
