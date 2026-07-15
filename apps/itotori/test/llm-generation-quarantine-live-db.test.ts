import { createHash } from "node:crypto";
import {
  ItotoriLlmAcceptedOutputRepository,
  ItotoriLlmCallMemoRepository,
  ItotoriLlmRetentionRepository,
  LlmQuarantinedResponseError,
} from "@itotori/db";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/llm/dispatch.js";
import {
  UNKNOWN_GENERATION_METADATA,
  reconcileGenerationMetadata,
  type GenerationMetadataSource,
} from "../src/llm/generation-metadata.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  confirmedGenerationMetadataSource,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("generation quarantine persistence", () => {
  it("persists an unknown served pair and invokes generation lookup exactly once", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    let lookups = 0;
    const source: GenerationMetadataSource = {
      async lookup() {
        lookups += 1;
        return UNKNOWN_GENERATION_METADATA;
      },
    };
    try {
      const prompt = "Return a synthetic verdict for quarantine proof.";
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
        generationMetadataSource: source,
      });

      const result = await dispatch(physicalCallSpec(prompt), harness.runtime);

      expect(lookups).toBe(1);
      expect(result).toMatchObject({
        status: "failure",
        failureKind: "quarantined",
        generationId: null,
        served: { status: "unknown" },
      });
      const persisted = await context.pool.query<{
        requested_model: string;
        provider_policy: { order: string[] };
        served_pair_status: string;
        served_model: string | null;
        served_provider: string | null;
        verification_status: string;
        generation_id: string | null;
      }>(`
        select requested_model, provider_policy, served_pair_status, served_model,
          served_provider, verification_status, generation_id
        from itotori_llm_call_memos
      `);
      expect(persisted.rows).toEqual([
        {
          requested_model: "deepseek/deepseek-v4-flash",
          provider_policy: expect.objectContaining({ order: ["provider:primary"] }),
          served_pair_status: "unknown",
          served_model: null,
          served_provider: null,
          verification_status: "quarantined",
          generation_id: null,
        },
      ]);
    } finally {
      await context.close();
    }
  });

  it("quarantines an unknown flat RUN_FINISHED served model without throwing", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const persisted = await persistFinishedMetadata(context, cipher, "illegal-flat-pair", {
        generationId: "generation:inline:illegal-flat-pair",
        servedModel: "unknown",
        servedProvider: "provider:inline",
      });

      expect(persisted.metadata).toMatchObject({
        generationId: "generation:inline:illegal-flat-pair",
        served: { status: "unknown" },
      });
      expect(persisted.result).toMatchObject({ kind: "completed", memoHit: false });
      expect(await persistedServedRows(context, persisted.memoKey)).toEqual({
        memo: {
          verification_status: "quarantined",
          generation_id: "generation:inline:illegal-flat-pair",
          served_pair_status: "unknown",
          served_model: null,
          served_provider: null,
        },
        attempt: {
          verification_status: "quarantined",
          generation_id: "generation:inline:illegal-flat-pair",
          served_pair_status: "unknown",
          served_model: null,
          served_provider: null,
        },
      });
    } finally {
      await context.close();
    }
  });

  it("persists a stream-attested pair as unknown when generation id is absent", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const persisted = await persistFinishedMetadata(context, cipher, "missing-generation", {
        servedModel: "served/model:inline",
        servedProvider: "provider:inline",
      });

      expect(persisted.metadata).toMatchObject({
        generationId: null,
        served: {
          status: "confirmed",
          model: "served/model:inline",
          provider: "provider:inline",
        },
      });
      expect(persisted.result).toMatchObject({ kind: "completed", memoHit: false });
      expect(await persistedServedRows(context, persisted.memoKey)).toEqual({
        memo: {
          verification_status: "quarantined",
          generation_id: null,
          served_pair_status: "unknown",
          served_model: null,
          served_provider: null,
        },
        attempt: {
          verification_status: "quarantined",
          generation_id: null,
          served_pair_status: "unknown",
          served_model: null,
          served_provider: null,
        },
      });
    } finally {
      await context.close();
    }
  });

  it("persists confirmed served metadata distinctly from the requested route and retains evidence", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    let lookups = 0;
    try {
      const prompt = "Return a synthetic verdict with confirmed route evidence.";
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample, 0.00000425)],
        generationMetadataSource: confirmedGenerationMetadataSource(() => {
          lookups += 1;
        }),
      });

      const result = await dispatch(physicalCallSpec(prompt), harness.runtime);

      expect(lookups).toBe(1);
      expect(result).toMatchObject({
        status: "success",
        generationId: "generation:lookup:1",
        served: {
          status: "confirmed",
          model: "served/model:fixture",
          provider: "provider:served-fixture",
        },
        billing: { status: "confirmed", costUsd: "0.00000425" },
      });
      const memo = await context.pool.query<{
        requested_model: string;
        provider_policy: { order: string[] };
        served_pair_status: string;
        served_model: string;
        served_provider: string;
        verification_status: string;
        generation_id: string;
      }>(`
        select requested_model, provider_policy, served_pair_status, served_model,
          served_provider, verification_status, generation_id
        from itotori_llm_call_memos
      `);
      expect(memo.rows[0]).toEqual({
        requested_model: "deepseek/deepseek-v4-flash",
        provider_policy: expect.objectContaining({ order: ["provider:primary"] }),
        served_pair_status: "confirmed",
        served_model: "served/model:fixture",
        served_provider: "provider:served-fixture",
        verification_status: "verified",
        generation_id: "generation:lookup:1",
      });
      expect(memo.rows[0]?.requested_model).not.toBe(memo.rows[0]?.served_model);
      expect(memo.rows[0]?.provider_policy.order).not.toContain(memo.rows[0]?.served_provider);

      const attempt = await context.pool.query<{
        served_pair_status: string;
        router_attempts: unknown;
        prompt_token_count: number;
        completion_token_count: number;
        reasoning_token_count: number;
        cached_token_count: number;
        billing_state: string;
        cost_usd: string;
        reported_cost_usd: string;
      }>(`
        select served_pair_status, router_attempts, prompt_token_count,
          completion_token_count, reasoning_token_count, cached_token_count,
          billing_state, cost_usd::text, reported_cost_usd::text
        from itotori_llm_http_attempts
      `);
      expect(attempt.rows[0]).toEqual({
        served_pair_status: "confirmed",
        router_attempts: [
          {
            ordinal: 1,
            model: "served/model:fixture",
            provider: "provider:served-fixture",
            httpStatus: 200,
          },
        ],
        prompt_token_count: 11,
        completion_token_count: 7,
        reasoning_token_count: 3,
        cached_token_count: 2,
        billing_state: "confirmed",
        cost_usd: "0.000004250000",
        reported_cost_usd: "0.000004250000",
      });

      const repository = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const candidate = acceptedCandidate(result.memoKey);
      const accepted = await repository.acceptAndAdvance(candidate);
      expect(await repository.readHead(headIdentity(candidate))).toEqual(accepted);
    } finally {
      await context.close();
    }
  });

  it("blocks a quarantined memo at the insert trigger when the repository check is bypassed", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const candidate = await quarantinedCandidate(context, cipher, "repository-bypassed");
      await expect(directAcceptedInsert(context.pool, candidate)).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await context.close();
    }
  });

  it("blocks a quarantined memo at the repository and CAS when the insert trigger is removed", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const repository = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const candidate = await quarantinedCandidate(context, cipher, "insert-trigger-removed");

      await context.pool.query(`
        alter table itotori_llm_accepted_outputs
        disable trigger itotori_llm_accepted_output_quarantine
      `);
      try {
        await expect(repository.acceptAndAdvance(candidate)).rejects.toBeInstanceOf(
          LlmQuarantinedResponseError,
        );
        await directAcceptedInsert(context.pool, candidate);
      } finally {
        await context.pool.query(`
          alter table itotori_llm_accepted_outputs
          enable trigger itotori_llm_accepted_output_quarantine
        `);
      }
      await expect(directHeadInsert(context.pool, candidate)).rejects.toThrow(
        "CAS head target is invalid",
      );
      expect(await repository.readHead(headIdentity(candidate))).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("blocks a quarantined memo at the remaining guards when the CAS trigger is removed", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const repository = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const seeded = await quarantinedCandidate(context, cipher, "cas-trigger-seed");
      await context.pool.query(`
        alter table itotori_llm_accepted_outputs
        disable trigger itotori_llm_accepted_output_quarantine
      `);
      try {
        await directAcceptedInsert(context.pool, seeded);
      } finally {
        await context.pool.query(`
          alter table itotori_llm_accepted_outputs
          enable trigger itotori_llm_accepted_output_quarantine
        `);
      }

      await context.pool.query(`
        alter table itotori_llm_cas_heads disable trigger itotori_llm_cas_heads_advance
      `);
      try {
        const appCandidate = acceptedCandidate(seeded.memoKeys[0]!, "cas-app-guard");
        await expect(repository.acceptAndAdvance(appCandidate)).rejects.toBeInstanceOf(
          LlmQuarantinedResponseError,
        );
        const triggerCandidate = acceptedCandidate(seeded.memoKeys[0]!, "cas-insert-guard");
        await expect(directAcceptedInsert(context.pool, triggerCandidate)).rejects.toMatchObject({
          code: "23514",
        });
        await directHeadInsert(context.pool, seeded);
        expect(await repository.readHead(headIdentity(seeded))).toBeNull();
      } finally {
        await context.pool.query(`
          alter table itotori_llm_cas_heads enable trigger itotori_llm_cas_heads_advance
        `);
      }
    } finally {
      await context.close();
    }
  });

  it("rejects a retention-deleted verified memo from acceptance and head reads", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt = "Return a synthetic verdict whose source memo will expire.";
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
        generationMetadataSource: confirmedGenerationMetadataSource(),
      });
      const result = await dispatch(physicalCallSpec(prompt), harness.runtime);
      expect(result).toMatchObject({ status: "success", verification: "verified" });

      const repository = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const acceptedCandidateInput = acceptedCandidate(result.memoKey, "retention-live-head");
      const accepted = await repository.acceptAndAdvance(acceptedCandidateInput);
      expect(await repository.readHead(headIdentity(acceptedCandidateInput))).toEqual(accepted);

      const retention = new ItotoriLlmRetentionRepository(context.pool, cipher);
      const cutoff = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000);
      const deletion = await retention.deleteExpired(cutoff);
      expect(deletion.tables.itotori_llm_call_memos).toBe(1);
      expect(deletion.destroyedKeyRefs).toBeGreaterThan(0);
      const tombstone = await context.pool.query<{
        deletion_state: string;
        request_ciphertext: Buffer | null;
        response_ciphertext: Buffer | null;
        outcome_ciphertext: Buffer | null;
      }>(
        `select deletion_state, request_ciphertext, response_ciphertext, outcome_ciphertext
         from itotori_llm_call_memos where memo_key = $1`,
        [result.memoKey],
      );
      expect(tombstone.rows[0]).toEqual({
        deletion_state: "deleted",
        request_ciphertext: null,
        response_ciphertext: null,
        outcome_ciphertext: null,
      });

      const appCandidate = acceptedCandidate(result.memoKey, "retention-app-reject");
      await expect(repository.acceptAndAdvance(appCandidate)).rejects.toBeInstanceOf(
        LlmQuarantinedResponseError,
      );
      const triggerCandidate = acceptedCandidate(result.memoKey, "retention-trigger-reject");
      await expect(directAcceptedInsert(context.pool, triggerCandidate)).rejects.toMatchObject({
        code: "23514",
      });
      const casCandidate = acceptedCandidate(result.memoKey, "retention-cas-reject");
      await context.pool.query(`
        alter table itotori_llm_accepted_outputs
        disable trigger itotori_llm_accepted_output_quarantine
      `);
      try {
        await directAcceptedInsert(context.pool, casCandidate);
      } finally {
        await context.pool.query(`
          alter table itotori_llm_accepted_outputs
          enable trigger itotori_llm_accepted_output_quarantine
        `);
      }
      await expect(directHeadInsert(context.pool, casCandidate)).rejects.toThrow(
        "CAS head target is invalid",
      );
      expect(await repository.readHead(headIdentity(acceptedCandidateInput))).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("records completed-response transport loss as billing_unknown rather than zero", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt = "Return a verdict before the synthetic transport is lost.";
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [transportLossAfterResponseBytes(reviewVerdictExample)],
        generationMetadataSource: null,
      });

      expect(await dispatch(physicalCallSpec(prompt), harness.runtime)).toMatchObject({
        status: "failure",
        failureKind: "transport",
        billing: { status: "billing-unknown" },
      });
      const attempt = await context.pool.query<{
        attempt_status: string;
        billing_state: string;
        cost_usd: string | null;
        reported_cost_usd: string | null;
        prompt_token_count: number | null;
        completion_token_count: number | null;
      }>(`
        select attempt_status, billing_state, cost_usd::text, reported_cost_usd::text,
          prompt_token_count, completion_token_count
        from itotori_llm_http_attempts
      `);
      expect(attempt.rows).toEqual([
        {
          attempt_status: "completed",
          billing_state: "billing_unknown",
          cost_usd: null,
          reported_cost_usd: null,
          prompt_token_count: null,
          completion_token_count: null,
        },
      ]);
    } finally {
      await context.close();
    }
  });
});

async function persistFinishedMetadata(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
  identity: string,
  routeMetadata: Readonly<Record<string, unknown>>,
) {
  const memoKey = hash(`memo:${identity}`);
  const metadata = await reconcileGenerationMetadata([finishedMetadataChunk(routeMetadata)], {
    async lookup() {
      return UNKNOWN_GENERATION_METADATA;
    },
  });
  const repository = new ItotoriLlmCallMemoRepository(context.pool, cipher, {
    requireContentRead: async () => undefined,
  });
  const result = await repository.singleflight({
    memoKey,
    semanticHash: hash(`semantic:${identity}`),
    schemaVersion: "itotori.physical-step-memo.v2",
    requestJson: JSON.stringify({ identity }),
    admission: {
      scope: `test:generation-metadata:${identity}`,
      confirmedCostCapUsd: "10",
      maxAttemptExposureUsd: "1",
      deadlineMs: 300_000,
    },
    async execute() {
      const completedAt = new Date().toISOString();
      return {
        kind: "completed",
        responseJson: JSON.stringify({ type: EventType.RUN_FINISHED, ...routeMetadata }),
        outcomeJson: JSON.stringify({ kind: "terminal", identity }),
        outcomeKind: "terminal",
        generationId: metadata.generationId,
        requestedModel: "requested/model:fixture",
        providerPolicy: { order: ["provider:requested-fixture"] },
        served: metadata.served,
        routerAttempts: metadata.routerAttempts,
        usage: metadata.usage,
        billing: metadata.billing,
        reportedCostUsd: metadata.reportedCostUsd,
        completedAt,
        responseEvent: {
          eventId: hash(`event:${identity}`),
          schemaVersion: "itotori.conversation-event.v1",
          parentEventIds: [hash(`parent:${identity}`)],
          snapshotKind: "localization",
          snapshotId: `snapshot:${identity}`,
          actorRole: "Q1",
          bodyJson: JSON.stringify({ identity }),
        },
      };
    },
  });
  return { memoKey, metadata, result };
}

async function persistedServedRows(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  memoKey: string,
) {
  type Row = {
    verification_status: string;
    generation_id: string | null;
    served_pair_status: string;
    served_model: string | null;
    served_provider: string | null;
  };
  const memo = await context.pool.query<Row>(
    `select verification_status, generation_id, served_pair_status, served_model, served_provider
     from itotori_llm_call_memos where memo_key = $1`,
    [memoKey],
  );
  const attempt = await context.pool.query<Row>(
    `select verification_status, generation_id, served_pair_status, served_model, served_provider
     from itotori_llm_http_attempts where memo_key = $1`,
    [memoKey],
  );
  return { memo: memo.rows[0], attempt: attempt.rows[0] };
}

function finishedMetadataChunk(metadata: Readonly<Record<string, unknown>>): StreamChunk {
  return {
    type: EventType.RUN_FINISHED,
    runId: "run:generation-metadata",
    threadId: "thread:generation-metadata",
    finishReason: "stop",
    ...metadata,
  } as StreamChunk;
}

async function quarantinedCandidate(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
  identity: string,
) {
  const prompt = `Return an artifact candidate that remains quarantined: ${identity}.`;
  const harness = dispatchHarness({
    pool: context.pool,
    cipher,
    prompt,
    responses: [structuredProviderResponse(reviewVerdictExample)],
    generationMetadataSource: null,
  });
  const result = await dispatch(physicalCallSpec(prompt), harness.runtime);
  expect(result).toMatchObject({ status: "failure", failureKind: "quarantined" });
  return acceptedCandidate(result.memoKey, identity);
}

function acceptedCandidate(memoKey: string, identity = "quarantine-proof") {
  return {
    outputId: `output:${identity}`,
    semanticKey: hash(`accepted:${identity}`),
    schemaVersion: "itotori.accepted-output.v1",
    outputVersion: 1,
    supersedesOutputId: null,
    parentOutputIds: [],
    memoKeys: [memoKey],
    snapshotKind: "localization" as const,
    snapshotId: `snapshot:localization:${identity}`,
    subjectType: "unit" as const,
    subjectId: `unit:${identity}`,
    stage: "final",
    sourceHash: hash(`source:${identity}`),
    outputJson: JSON.stringify({ status: "candidate" }),
    acceptedAt: new Date().toISOString(),
    expectedHead: null,
  };
}

function headIdentity(candidate: ReturnType<typeof acceptedCandidate>) {
  return {
    snapshotId: candidate.snapshotId,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    stage: candidate.stage,
  };
}

async function directAcceptedInsert(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
  candidate: ReturnType<typeof acceptedCandidate>,
) {
  return pool.query(
    `
      insert into itotori_llm_accepted_outputs (
        output_id, semantic_key, schema_version, output_version, parent_output_ids,
        memo_keys, snapshot_kind, snapshot_id, subject_type, subject_id, stage,
        source_hash, output_ciphertext, output_key_ref, output_content_hash,
        accepted_at, retention_deadline
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, decode('01', 'hex'), 'test-key', $13,
        $14::timestamptz, $14::timestamptz + interval '1 day'
      )
    `,
    [
      candidate.outputId,
      candidate.semanticKey,
      candidate.schemaVersion,
      candidate.outputVersion,
      candidate.parentOutputIds,
      candidate.memoKeys,
      candidate.snapshotKind,
      candidate.snapshotId,
      candidate.subjectType,
      candidate.subjectId,
      candidate.stage,
      candidate.sourceHash,
      hash(candidate.outputJson),
      candidate.acceptedAt,
    ],
  );
}

async function directHeadInsert(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
  candidate: ReturnType<typeof acceptedCandidate>,
) {
  return pool.query(
    `
      insert into itotori_llm_cas_heads (
        head_namespace, snapshot_id, subject_type, subject_id, head_stage,
        head_id, head_version, head_content_hash, updated_at
      ) values ('accepted-output', $1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
    `,
    [
      candidate.snapshotId,
      candidate.subjectType,
      candidate.subjectId,
      candidate.stage,
      candidate.outputId,
      candidate.outputVersion,
      hash(candidate.outputJson),
      candidate.acceptedAt,
    ],
  );
}

function transportLossAfterResponseBytes(value: unknown): Response {
  const encoder = new TextEncoder();
  let emitted = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted) {
        controller.error(new Error("synthetic transport loss after response bytes"));
        return;
      }
      emitted = true;
      const chunk = {
        id: "generation:transport-loss",
        created: 1,
        model: "served/model:unconfirmed",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: JSON.stringify(value) },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          cost: 0.000009, // itotori-225-audit-allow: synthetic transport-loss evidence, not model pricing
        },
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
