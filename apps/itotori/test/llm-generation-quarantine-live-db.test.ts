import { createHash } from "node:crypto";
import { ItotoriLlmAcceptedOutputRepository, LlmQuarantinedResponseError } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/llm/dispatch.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  decodedUnitsTool,
  dispatchHarness,
  physicalCallSpec,
  rawStructuredProviderResponse,
  structuredProviderResponse,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("response quarantine and explicit-unknown persistence", () => {
  it("quarantines schema-invalid response content before it can be accepted", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const result = await dispatch(
        physicalCallSpec("Return a syntactically valid but schema-invalid verdict."),
        dispatchHarness({
          pool: context.pool,
          cipher,
          prompt: "Return a syntactically valid but schema-invalid verdict.",
          responses: [structuredProviderResponse({})],
        }).runtime,
      );

      expect(result).toMatchObject({
        status: "failure",
        failureKind: "schema-failure",
        verification: "quarantined",
      });
      await expectMemoVerification(context.pool, result.memoKey, "quarantined");
    } finally {
      await context.close();
    }
  });

  it("quarantines malformed terminal content before it can be accepted", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt = "Return malformed terminal content for quarantine proof.";
      const result = await dispatch(
        physicalCallSpec(prompt),
        dispatchHarness({
          pool: context.pool,
          cipher,
          prompt,
          responses: [rawStructuredProviderResponse("not JSON")],
        }).runtime,
      );

      expect(result).toMatchObject({
        status: "failure",
        failureKind: "invalid-json",
        verification: "quarantined",
      });
      await expectMemoVerification(context.pool, result.memoKey, "quarantined");
    } finally {
      await context.close();
    }
  });

  it("accepts a schema-valid response with an explicit-unknown served pair", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt = "Return a schema-valid verdict with unavailable served metadata.";
      const result = await dispatch(
        physicalCallSpec(prompt),
        dispatchHarness({
          pool: context.pool,
          cipher,
          prompt,
          responses: [structuredProviderResponse(reviewVerdictExample, 0.00000425)],
        }).runtime,
      );

      expect(result).toMatchObject({
        status: "success",
        generationId: null,
        served: { status: "unknown" },
        verification: "explicit-unknown",
        billing: { status: "confirmed", costUsd: "0.00000425" },
      });
      await expectMemoVerification(context.pool, result.memoKey, "explicit-unknown");

      const accepted = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const candidate = acceptedCandidate(result.memoKey, "explicit-unknown");
      const head = await accepted.acceptAndAdvance(candidate);
      expect(await accepted.readHead(headIdentity(candidate))).toEqual(head);
    } finally {
      await context.close();
    }
  });

  it("certifies and projects a repaired terminal after a quarantined tool-loop intermediate", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt =
        "Use the decoded-unit tool, correct an invalid tool call, then return a verdict.";
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [
          toolProviderResponse(1),
          toolProviderResponse(2, "not_an_allowed_tool"),
          structuredProviderResponse(reviewVerdictExample),
        ],
        tools: [decodedUnitsTool()],
      });

      const result = await dispatch(toolLoopSpec(prompt), harness.runtime);

      expect(result).toMatchObject({ status: "success", verification: "explicit-unknown" });
      expect(harness.transportCalls()).toBe(3);
      await expectMemoVerification(context.pool, result.memoKey, "explicit-unknown");
      await expect(expectMemoOutcomes(context.pool)).resolves.toEqual(
        expect.arrayContaining([
          { outcomeKind: "tool-calls", verificationStatus: "explicit-unknown" },
          { outcomeKind: "invalid", verificationStatus: "quarantined" },
          { outcomeKind: "terminal", verificationStatus: "explicit-unknown" },
        ]),
      );

      const accepted = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const candidate = acceptedCandidate(result.memoKey, "repaired-terminal");
      const head = await accepted.acceptAndAdvance(candidate);
      expect(await accepted.readHead(headIdentity(candidate))).toEqual(head);
    } finally {
      await context.close();
    }
  });

  it("records completed-response transport loss as billing_unknown rather than zero", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt = "Return a verdict before a synthetic transport loss.";
      const result = await dispatch(
        physicalCallSpec(prompt),
        dispatchHarness({
          pool: context.pool,
          cipher,
          prompt,
          responses: [transportLossAfterResponseBytes(reviewVerdictExample)],
        }).runtime,
      );

      expect(result).toMatchObject({
        status: "failure",
        failureKind: "transport",
        billing: { status: "billing-unknown" },
      });
      const attempt = await context.pool.query<{
        billing_state: string;
        cost_usd: string | null;
        reported_cost_usd: string | null;
      }>(`
        select billing_state, cost_usd::text, reported_cost_usd::text
        from itotori_llm_http_attempts
      `);
      expect(attempt.rows).toEqual([
        { billing_state: "billing_unknown", cost_usd: null, reported_cost_usd: null },
      ]);
    } finally {
      await context.close();
    }
  });

  it("makes a quarantined memo impossible to project through both repository and trigger guards", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const prompt = "Return malformed content that cannot become an artifact.";
      const result = await dispatch(
        physicalCallSpec(prompt),
        dispatchHarness({
          pool: context.pool,
          cipher,
          prompt,
          responses: [rawStructuredProviderResponse("not JSON")],
        }).runtime,
      );
      expect(result).toMatchObject({ status: "failure", verification: "quarantined" });
      const candidate = acceptedCandidate(result.memoKey, "quarantined-projection");
      const repository = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);

      await expect(repository.acceptAndAdvance(candidate)).rejects.toBeInstanceOf(
        LlmQuarantinedResponseError,
      );
      await expect(directAcceptedInsert(context.pool, candidate)).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await context.close();
    }
  });
});

async function expectMemoVerification(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
  memoKey: string,
  verificationStatus: string,
) {
  await expect(
    pool.query<{
      verification_status: string;
      served_pair_status: string;
      generation_id: string | null;
    }>(
      `select verification_status, served_pair_status, generation_id
       from itotori_llm_call_memos where memo_key = $1`,
      [memoKey],
    ),
  ).resolves.toMatchObject({
    rows: [
      expect.objectContaining({
        verification_status: verificationStatus,
      }),
    ],
  });
}

async function expectMemoOutcomes(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
) {
  const result = await pool.query<{ outcome_kind: string; verification_status: string }>(`
    select outcome_kind, verification_status
    from itotori_llm_call_memos
  `);
  return result.rows.map((row) => ({
    outcomeKind: row.outcome_kind,
    verificationStatus: row.verification_status,
  }));
}

function acceptedCandidate(memoKey: string, identity: string) {
  return {
    outputId: `output:${identity}`,
    semanticKey: hash(`accepted:${identity}`),
    schemaVersion: "itotori.accepted-output.v1",
    outputVersion: 1,
    supersedesOutputId: null,
    parentOutputIds: [],
    memoKeys: [memoKey],
    snapshotKind: "localization" as const,
    snapshotId: hash(`snapshot:localization:${identity}`),
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
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
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
          })}\n\n`,
        ),
      );
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
