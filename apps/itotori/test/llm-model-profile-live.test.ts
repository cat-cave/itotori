import { writeFileSync } from "node:fs";
import { ItotoriLlmCallMemoRepository } from "@itotori/db";
import { expect, it } from "vitest";
import type { CallSpec } from "../src/contracts/index.js";
import { dispatch } from "../src/llm/dispatch.js";
import {
  certifyLiveModelProfile,
  type ConformanceStepObservation,
} from "../src/llm/model-profile-conformance.js";
import type { ReasoningDetailsContinuityEvidence } from "../src/llm/reasoning-details-continuity.js";
import {
  deepSeekV4FlashProfile,
  uncertifiedRoleModelProfileCandidateForProbe,
} from "../src/llm/role-model-profiles.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  STEP_HASH_A,
  STEP_HASH_B,
  STEP_HASH_C,
  STEP_HASH_D,
  TestMemoCipher,
  decodedUnitsTool,
  toolLoopSpec,
} from "./llm-step-test-support.js";

const liveEnabled =
  process.env.ITOTORI_LIVE_MODEL_PROFILE === "1" &&
  Boolean(process.env.OPENROUTER_API_KEY) &&
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1" &&
  process.env.OPENROUTER_ZDR_GUARDRAIL_ASSERTED === "1" &&
  Boolean(process.env.DATABASE_URL);

(liveEnabled ? it : it.skip)(
  "certifies the live DeepSeek Flash profile through the real dispatcher",
  async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const candidate = uncertifiedRoleModelProfileCandidateForProbe("Q1");
    const prompt = [
      "This is a synthetic conformance probe.",
      "First call decode_get_units exactly once with an empty object.",
      "After the tool result, return exactly this JSON as the strict structured review verdict:",
      JSON.stringify(reviewVerdictExample),
    ].join("\n");
    let toolExecutionCount = 0;
    const generationLookupAttempts = 0;
    let reasoning: ReasoningDetailsContinuityEvidence | null = null;
    let providerError: ProviderErrorObservation | null = null;
    try {
      const result = await dispatch(conformanceSpec(prompt), {
        env: process.env,
        fetcher: async (input, init) => {
          const response = await fetch(input, init);
          if (!response.ok) providerError = await observeProviderError(response);
          return response;
        },
        tools: [decodedUnitsTool(() => (toolExecutionCount += 1))],
        contentAccess: { requireContentRead: async () => undefined },
        readPayload: async () => prompt,
        onReasoningDetailsContinuity: (evidence) => {
          reasoning = evidence;
        },
        memo: {
          store: new ItotoriLlmCallMemoRepository(context.pool, cipher, {
            requireContentRead: async () => undefined,
          }),
          profile: {
            name: candidate.modelProfile,
            version: candidate.version,
            deadlines: { normalMs: 300_000, deepMs: 600_000 },
            maxAttemptExposureUsd: "1",
          },
          admission: {
            scope: "probe:model-profile:deepseek-v4-flash",
            confirmedCostCapUsd: "1",
          },
          snapshots: {
            decodeRevisionHash: STEP_HASH_A,
            glossaryRevisionHash: STEP_HASH_B,
            styleRevisionHash: STEP_HASH_C,
            acceptedOutputHeadHash: STEP_HASH_D,
          },
        },
      });
      const steps = await readStepObservations(context.pool);
      const attempts = await readAttemptObservations(context.pool);
      if (reasoning === null) throw new Error("dispatcher omitted reasoning continuity evidence");
      const probedAt = new Date().toISOString();
      let certificate;
      try {
        certificate = certifyLiveModelProfile(deepSeekV4FlashProfile, {
          probedAt,
          result,
          steps,
          toolExecutionCount,
          reasoning,
          generationLookupAttempts,
        });
      } catch (error: unknown) {
        writeProbeOutput({
          probeStatus: "failed",
          probedAt,
          failure: error instanceof Error ? error.message : "unknown conformance failure",
          result: {
            status: result.status,
            ...(result.status === "failure" ? { failureKind: result.failureKind } : {}),
            verification: result.verification,
            generationId: result.generationId,
            served: result.served,
            usage: result.usage,
            billing: result.billing,
            events: result.events,
          },
          steps,
          attempts,
          providerError,
          toolExecutionCount,
          reasoning,
          generationLookupAttempts,
        });
        throw error;
      }

      expect(certificate.certificateStatus).toBe("valid");
      writeProbeOutput(certificate);
    } finally {
      await context.close();
    }
  },
  360_000,
);

function conformanceSpec(prompt: string): CallSpec {
  const candidate = uncertifiedRoleModelProfileCandidateForProbe("Q1");
  const base = toolLoopSpec(prompt);
  return {
    ...base,
    modelProfile: candidate.modelProfile,
    modelProfileVersion: candidate.version,
    requestedModel: candidate.model,
    providerPolicy: candidate.providerPolicy,
    reasoning: { effort: "low" },
    limits: {
      ...base.limits,
      maxSteps: 3,
      maxToolCalls: 1,
      maxParallelTools: 1,
      maxOutputTokens: 2_048,
    },
    sampleId: "sample:model-profile-conformance",
    runMode: "test-dev",
  };
}

interface ProviderErrorObservation {
  readonly httpStatus: number;
  readonly code: string | number | null;
  readonly providerName: string | null;
}

async function observeProviderError(response: Response): Promise<ProviderErrorObservation> {
  let error: Record<string, unknown> = {};
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    error = asRecord(body.error);
  } catch {
    // Status alone remains useful and cannot expose a provider response body.
  }
  const metadata = asRecord(error.metadata);
  return {
    httpStatus: response.status,
    code: typeof error.code === "number" ? error.code : safeIdentifier(error.code),
    providerName: safeIdentifier(metadata.provider_name),
  };
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._ -]{1,64}$/u.test(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function writeProbeOutput(value: unknown): void {
  const outputPath = process.env.ITOTORI_MODEL_PROFILE_PROBE_OUTPUT;
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readStepObservations(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
): Promise<ConformanceStepObservation[]> {
  const rows = await pool.query<{
    outcome_kind: ConformanceStepObservation["outcomeKind"];
    prompt_token_count: number | null;
    completion_token_count: number | null;
    reasoning_token_count: number | null;
    cached_token_count: number | null;
    billing_state: ConformanceStepObservation["billingState"];
    cost_usd: string | null;
  }>(`
    select outcome_kind, prompt_token_count, completion_token_count,
      reasoning_token_count, cached_token_count, billing_state, cost_usd
    from itotori_llm_call_memos order by completed_at, memo_key
  `);
  return rows.rows.map((row) => ({
    outcomeKind: row.outcome_kind,
    promptTokens: row.prompt_token_count,
    completionTokens: row.completion_token_count,
    reasoningTokens: row.reasoning_token_count,
    cachedTokens: row.cached_token_count,
    billingState: row.billing_state,
    billedUsd: row.cost_usd,
  }));
}

async function readAttemptObservations(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
) {
  const rows = await pool.query<{
    attempt_ordinal: number;
    attempt_status: string;
    failure_class: string | null;
    http_status: number | null;
    billing_state: string;
  }>(`
    select attempt_ordinal, attempt_status, failure_class, http_status, billing_state
    from itotori_llm_http_attempts order by started_at, attempt_ordinal
  `);
  return rows.rows.map((row) => ({
    attemptOrdinal: row.attempt_ordinal,
    attemptStatus: row.attempt_status,
    failureClass: row.failure_class,
    httpStatus: row.http_status,
    billingState: row.billing_state,
  }));
}
