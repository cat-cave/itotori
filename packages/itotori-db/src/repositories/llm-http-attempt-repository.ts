import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import type {
  LlmMemoCipher,
  LlmMemoSingleflightInput,
  LlmStepExecution,
} from "./llm-call-memo-repository.js";

export interface LlmSpendExposureReport {
  admissionScope: string;
  confirmedCostUsd: string;
  billingUnknownAttemptCount: number;
  boundedInFlightExposureUsd: string;
  inFlightAttemptCount: number;
  exhaustedRetryStepCount: number;
}

export class LlmRetriesExhaustedError extends Error {
  constructor(
    readonly memoKey: string,
    readonly attemptCount = 3,
  ) {
    super(`physical model step exhausted ${attemptCount} attempts for ${memoKey}`);
    this.name = "LlmRetriesExhaustedError";
  }
}

export class LlmPhysicalStepFailedError extends Error {
  constructor(
    readonly memoKey: string,
    readonly failureClass: "permanent" | "in-flight",
    readonly attemptStatus: string,
    readonly httpStatus: number | null,
  ) {
    super(`physical model step ${failureClass} failure prevents dispatch for ${memoKey}`);
    this.name = "LlmPhysicalStepFailedError";
  }
}

export class LlmSpendAdmissionDeniedError extends Error {
  constructor(readonly report: LlmSpendExposureReport) {
    super(`confirmed spend reached the admission cap for ${report.admissionScope}`);
    this.name = "LlmSpendAdmissionDeniedError";
  }
}

type Queryable = Pick<DatabaseContext["pool"], "query">;

export class ItotoriLlmHttpAttemptRepository {
  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
  ) {}

  async readSpendExposure(
    admissionScope: string,
    queryable: Queryable = this.pool,
  ): Promise<LlmSpendExposureReport> {
    assertScope(admissionScope);
    const exposure = await queryable.query<ExposureRow>(
      `
        with scoped as (
          select * from itotori_llm_http_attempts where admission_scope = $1
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
    if (!Number.isSafeInteger(admission.deadlineMs) || admission.deadlineMs <= 0) {
      throw new Error("physical attempt deadline must be a positive safe integer");
    }
    const request = await this.cipher.seal(input.requestJson);
    const deadlineAt = new Date(Date.parse(attempt.startedAt) + admission.deadlineMs).toISOString();
    await client.query("begin");
    try {
      const report = await this.readSpendExposure(admission.scope, client);
      const denied = await client.query<{ denied: boolean }>(
        "select $1::numeric >= $2::numeric as denied",
        [report.confirmedCostUsd, admission.confirmedCostCapUsd],
      );
      if (denied.rows[0]?.denied) throw new LlmSpendAdmissionDeniedError(report);
      await client.query(
        `
          insert into itotori_llm_http_attempts (
            attempt_id, memo_key, attempt_ordinal, admission_scope,
            request_ciphertext, request_key_ref, request_content_hash, request_hash,
            attempt_status, failure_class, http_status, generation_id,
            billing_state, cost_usd, max_exposure_usd,
            started_at, deadline_at, completed_at, retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8,
            'in-flight', null, null, null, 'billing_unknown', null, $9,
            $10::timestamptz, $11::timestamptz, null,
            $10::timestamptz + interval '7 days'
          )
        `,
        [
          attemptId(input.memoKey, attempt.ordinal),
          input.memoKey,
          attempt.ordinal,
          admission.scope,
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
    const write = () =>
      client.query(
        `
          update itotori_llm_http_attempts
          set response_ciphertext = $1, response_key_ref = $2, response_content_hash = $3,
              attempt_status = $4, failure_class = $5, http_status = $6,
              generation_id = $7, billing_state = $8, cost_usd = $9,
              completed_at = $10::timestamptz
          where attempt_id = $11 and attempt_status = 'in-flight' and completed_at is null
        `,
        [
          response?.ciphertext ?? null,
          response?.keyRef ?? null,
          attempt.execution.responseJson ? hash(attempt.execution.responseJson) : null,
          status,
          failureClass,
          httpStatus,
          attempt.execution.generationId,
          billing.status,
          billing.status === "confirmed" ? billing.costUsd : null,
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
