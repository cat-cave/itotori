import { ItotoriLlmCallMemoRepository } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/llm/dispatch.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  STEP_HASH_A,
  STEP_HASH_B,
  TEST_MODEL_PROFILE,
  TestMemoCipher,
  decodedUnitsTool,
  dispatchHarness,
  httpProviderResponse,
  physicalCallSpec,
  rawStructuredProviderResponse,
  structuredProviderResponse,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("physical attempt policy", () => {
  it("retries a 429 with bounded jitter three times and reports exhausted retries", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const delays: number[] = [];
    try {
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: "Return a verdict after a synthetic rate limit.",
        responses: [
          httpProviderResponse(429),
          httpProviderResponse(429),
          httpProviderResponse(429),
        ],
        retry: {
          random: () => 0.5,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      });

      const result = await dispatch(
        physicalCallSpec("Return a verdict after a synthetic rate limit."),
        harness.runtime,
      );

      expect(result).toMatchObject({ status: "failure", failureKind: "retries-exhausted" });
      expect(harness.transportCalls()).toBe(3);
      expect(delays).toEqual([500, 1_000]);
      const attempts = await context.pool.query<{
        attempt_ordinal: number;
        attempt_status: string;
        failure_class: string;
        http_status: number;
      }>(`
        select attempt_ordinal, attempt_status, failure_class, http_status
        from itotori_llm_http_attempts order by attempt_ordinal
      `);
      expect(attempts.rows).toEqual([
        {
          attempt_ordinal: 1,
          attempt_status: "http-error",
          failure_class: "transient",
          http_status: 429,
        },
        {
          attempt_ordinal: 2,
          attempt_status: "http-error",
          failure_class: "transient",
          http_status: 429,
        },
        {
          attempt_ordinal: 3,
          attempt_status: "http-error",
          failure_class: "transient",
          http_status: 429,
        },
      ]);
      const restarted = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: "Return a verdict after a synthetic rate limit.",
        responses: [],
      });
      expect(
        await dispatch(
          physicalCallSpec("Return a verdict after a synthetic rate limit."),
          restarted.runtime,
        ),
      ).toMatchObject({ status: "failure", failureKind: "retries-exhausted" });
      expect(restarted.transportCalls()).toBe(0);
      const report = await new ItotoriLlmCallMemoRepository(context.pool, cipher, {
        requireContentRead: async () => undefined,
      }).readSpendExposure("test:llm-step");
      expect(report).toMatchObject({
        billingUnknownAttemptCount: 3,
        boundedInFlightExposureUsd: "0",
        exhaustedRetryStepCount: 1,
      });
    } finally {
      await context.close();
    }
  });

  it("does not retry a completed schema-invalid response", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt = "Return a verdict with invalid schema.";
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [rawStructuredProviderResponse("{}")],
        retry: { sleep: async () => expect.unreachable("schema failure must not retry") },
      });

      expect(await dispatch(physicalCallSpec(prompt), harness.runtime)).toMatchObject({
        status: "failure",
        failureKind: "schema-failure",
      });
      expect(harness.transportCalls()).toBe(1);
      const persisted = await context.pool.query<{ attempts: number; memos: number }>(`
        select
          (select count(*)::integer from itotori_llm_http_attempts) as attempts,
          (select count(*)::integer from itotori_llm_call_memos) as memos
      `);
      expect(persisted.rows[0]).toEqual({ attempts: 1, memos: 1 });
    } finally {
      await context.close();
    }
  });

  it("applies the selected measured normal or deep profile deadline to every attempt", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const profile = {
      ...TEST_MODEL_PROFILE,
      deadlines: { normalMs: 5, deepMs: 100 },
    };
    try {
      const normalPrompt = "Return after the normal deadline.";
      const normal = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: normalPrompt,
        responses: [1, 2, 3].map(() => delayedResponse(25)),
        profile,
        retry: { sleep: async () => undefined },
      });
      expect(await dispatch(physicalCallSpec(normalPrompt), normal.runtime)).toMatchObject({
        status: "failure",
        failureKind: "retries-exhausted",
      });
      expect(normal.transportCalls()).toBe(3);

      const deepPrompt = "Return within the deep deadline.";
      const deep = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: deepPrompt,
        responses: [delayedResponse(25)],
        profile,
      });
      expect(
        await dispatch(
          physicalCallSpec(deepPrompt, {
            sampleId: "sample:deep-deadline",
            limits: { ...physicalCallSpec(deepPrompt).limits, timeoutClass: "deep" },
          }),
          deep.runtime,
        ),
      ).toMatchObject({ status: "success" });
      expect(deep.transportCalls()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("preserves a completed memo when cancellation blocks the next model call", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const cancellation = new AbortController();
    const prompt = "Use one local tool, then return a verdict.";
    try {
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [toolProviderResponse(1)],
        tools: [decodedUnitsTool(() => cancellation.abort())],
        signal: cancellation.signal,
      });

      const result = await dispatch(toolLoopSpec(prompt), harness.runtime);

      expect(result).toMatchObject({
        status: "failure",
        failureKind: "cancelled",
        responseEventId: expect.stringMatching(/^sha256:/u),
      });
      expect(harness.transportCalls()).toBe(1);
      const persisted = await context.pool.query<{ attempts: number; memos: number }>(`
        select
          (select count(*)::integer from itotori_llm_http_attempts) as attempts,
          (select count(*)::integer from itotori_llm_call_memos) as memos
      `);
      expect(persisted.rows[0]).toEqual({ attempts: 1, memos: 1 });
    } finally {
      await context.close();
    }
  });

  it("reports confirmed, unknown, and bounded in-flight exposure without reservation rows", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const repository = new ItotoriLlmCallMemoRepository(context.pool, cipher, {
      requireContentRead: async () => undefined,
    });
    const scope = "test:exposure";
    const confirmedCostUsd = "0.25"; // itotori-225-audit-allow: synthetic reconciled-cost fact for the admission report test
    let announceStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => (announceStarted = resolve));
    const released = new Promise<void>((resolve) => (releaseResponse = resolve));
    try {
      await insertConfirmedAttempt(context.pool, scope, confirmedCostUsd);
      const unknownPrompt = "Return one billing-unknown result.";
      const unknown = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: unknownPrompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
        admission: { scope, confirmedCostCapUsd: "10" }, // itotori-225-audit-allow: synthetic report-test admission cap, not a billed model cost
      });
      expect(
        await dispatch(
          physicalCallSpec(unknownPrompt, { sampleId: "sample:unknown-exposure" }),
          unknown.runtime,
        ),
      ).toMatchObject({ status: "success" });

      const inFlightPrompt = "Wait while exposure is observed.";
      const inFlight = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: inFlightPrompt,
        responses: [
          async () => {
            announceStarted();
            await released;
            return structuredProviderResponse(reviewVerdictExample);
          },
        ],
        admission: { scope, confirmedCostCapUsd: "10" }, // itotori-225-audit-allow: synthetic report-test admission cap, not a billed model cost
      });
      const pending = dispatch(
        physicalCallSpec(inFlightPrompt, { sampleId: "sample:in-flight-exposure" }),
        inFlight.runtime,
      );
      await started;

      expect(await repository.readSpendExposure(scope)).toEqual({
        admissionScope: scope,
        confirmedCostUsd,
        billingUnknownAttemptCount: 1,
        boundedInFlightExposureUsd: "1", // itotori-225-audit-allow: synthetic profile ceiling asserted as exposure, not billed cost
        inFlightAttemptCount: 1,
        exhaustedRetryStepCount: 0,
      });

      const deniedPrompt = "Do not dispatch past the confirmed cap.";
      const denied = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt: deniedPrompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
        admission: { scope, confirmedCostCapUsd: confirmedCostUsd },
      });
      expect(
        await dispatch(
          physicalCallSpec(deniedPrompt, { sampleId: "sample:admission-denied" }),
          denied.runtime,
        ),
      ).toMatchObject({ status: "failure", failureKind: "spend-admission" });
      expect(denied.transportCalls()).toBe(0);

      const ownershipResidue = await context.pool.query<{
        table_name: string;
        column_name: string;
      }>(`
        select table_name, column_name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name in ('itotori_llm_call_memos', 'itotori_llm_http_attempts')
          and (table_name || '.' || column_name) ~ '(reservation|lease|fence|run_owner)'
      `);
      expect(ownershipResidue.rows).toEqual([]);

      releaseResponse();
      await expect(pending).resolves.toMatchObject({ status: "success" });
    } finally {
      releaseResponse?.();
      await context.close();
    }
  });
});

function delayedResponse(delayMs: number): (signal: AbortSignal) => Promise<Response> {
  return (signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(structuredProviderResponse(reviewVerdictExample)),
        delayMs,
      );
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
}

async function insertConfirmedAttempt(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
  scope: string,
  costUsd: string,
): Promise<void> {
  await pool.query(
    `
      insert into itotori_llm_http_attempts (
        attempt_id, memo_key, attempt_ordinal, admission_scope,
        request_ciphertext, request_key_ref, request_content_hash, request_hash,
        attempt_status, failure_class, http_status, generation_id,
        served_pair_status, served_model, served_provider, verification_status,
        router_attempts,
        billing_state, cost_usd, max_exposure_usd,
        started_at, deadline_at, completed_at, retention_deadline
      ) values (
        'attempt:confirmed', $1, 1, $2,
        decode('01', 'hex'), 'test-key', $3, $4,
        'transport-error', 'transient', null, 'generation:reconciled',
        'unknown', null, null, 'quarantined', '[]'::jsonb,
        'confirmed', $5, 0, now(), now(), now(), now() + interval '1 day'
      )
    `,
    [STEP_HASH_A, scope, STEP_HASH_A, STEP_HASH_B, costUsd],
  );
}
