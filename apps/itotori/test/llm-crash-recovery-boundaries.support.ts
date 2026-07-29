import { createHash } from "node:crypto";
import {
  ItotoriLlmAcceptedOutputRepository,
  LlmAcceptedOutputCasError,
  LlmDurabilityFaultError,
  type AcceptLlmOutputInput,
  type DatabaseContext,
  type LlmAcceptedOutputHead,
  type LlmDurabilityFaultBoundary,
  type LlmDurabilityFaultInjector,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  STEP_HASH_D,
  TestMemoCipher,
  decodedUnitsTool,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

export const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

export const verdict = () => structuredProviderResponse(reviewVerdictExample);

export function crashAt(boundary: LlmDurabilityFaultBoundary): LlmDurabilityFaultInjector {
  return {
    async killAt(actual) {
      if (actual === boundary) throw new LlmDurabilityFaultError(actual);
    },
  };
}

export async function recoverAcceptedUnit(
  accepted: ItotoriLlmAcceptedOutputRepository,
  candidate: AcceptLlmOutputInput,
  spec: ReturnType<typeof physicalCallSpec>,
  runtime: DispatchRuntime,
): Promise<LlmAcceptedOutputHead | null> {
  const existing = await accepted.readHead(headIdentity(candidate));
  if (existing) return existing;
  await dispatch(spec, runtime);
  return accepted.readHead(headIdentity(candidate));
}

export const ACCEPT_SNAPSHOT_ID = STEP_HASH_D;

export function unitOutput(
  memoKey: string,
  subjectId: string,
  version: number,
  expectedHead: LlmAcceptedOutputHead | null,
  variant = "",
): AcceptLlmOutputInput {
  const outputId = `${subjectId}:v${version}${variant ? `:${variant}` : ""}`;
  return {
    outputId,
    semanticKey: hash(`semantic:${outputId}`),
    schemaVersion: "itotori.accepted-output.v1",
    outputVersion: version,
    supersedesOutputId: expectedHead?.outputId ?? null,
    parentOutputIds: expectedHead ? [expectedHead.outputId] : [],
    memoKeys: [memoKey],
    snapshotKind: "localization",
    snapshotId: ACCEPT_SNAPSHOT_ID,
    subjectType: "unit",
    subjectId,
    // Identical content for every version so the accepted content hash is
    // deterministic and the concurrent race stays monotonic regardless of winner.
    stage: "final",
    sourceHash: hash(`source:${subjectId}`),
    outputJson: deterministicOutputJson(version),
    acceptedAt: `2026-01-01T00:0${version}:00.000Z`,
    expectedHead,
  };
}

export function deterministicOutputJson(version: number): string {
  return JSON.stringify({ target: `accepted-target:v${version}` });
}

export function deterministicOutputHash(version: number): `sha256:${string}` {
  return hash(deterministicOutputJson(version));
}

export function headIdentity(candidate: AcceptLlmOutputInput) {
  return {
    snapshotId: candidate.snapshotId,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    stage: candidate.stage,
  };
}

export async function countRows(pool: DatabaseContext["pool"], table: string): Promise<number> {
  if (!/^itotori_llm_[a-z_]+$/u.test(table)) throw new Error("unexpected table name");
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function memoKeys(pool: DatabaseContext["pool"]): Promise<string[]> {
  const result = await pool.query<{ memo_key: string }>(
    "select memo_key from itotori_llm_call_memos order by completed_at",
  );
  return result.rows.map((row) => row.memo_key);
}

export async function attemptStatuses(
  pool: DatabaseContext["pool"],
  memoKey: string,
): Promise<string[]> {
  const result = await pool.query<{ attempt_status: string }>(
    "select attempt_status from itotori_llm_http_attempts where memo_key = $1 order by attempt_ordinal",
    [memoKey],
  );
  return result.rows.map((row) => row.attempt_status);
}

export async function attemptAmbiguity(
  pool: DatabaseContext["pool"],
  memoKey: string,
): Promise<
  Array<{
    status: string;
    failureClass: string | null;
    billing: string;
    hasResponse: boolean;
  }>
> {
  const result = await pool.query<{
    attempt_status: string;
    failure_class: string | null;
    billing_state: string;
    has_response: boolean;
  }>(
    `
      select attempt_status, failure_class, billing_state,
             response_ciphertext is not null as has_response
      from itotori_llm_http_attempts
      where memo_key = $1
      order by attempt_ordinal
    `,
    [memoKey],
  );
  return result.rows.map((row) => ({
    status: row.attempt_status,
    failureClass: row.failure_class,
    billing: row.billing_state,
    hasResponse: row.has_response,
  }));
}

export async function outputRow(
  pool: DatabaseContext["pool"],
  outputId: string,
): Promise<{ version: number; contentHash: string; deletionState: string } | null> {
  const result = await pool.query<{
    output_version: number;
    output_content_hash: string;
    deletion_state: string;
  }>(
    "select output_version, output_content_hash, deletion_state from itotori_llm_accepted_outputs where output_id = $1",
    [outputId],
  );
  const row = result.rows[0];
  return row
    ? {
        version: row.output_version,
        contentHash: row.output_content_hash,
        deletionState: row.deletion_state,
      }
    : null;
}

export async function outputPayload(
  pool: DatabaseContext["pool"],
  cipher: TestMemoCipher,
  outputId: string,
): Promise<string | null> {
  const result = await pool.query<{ output_ciphertext: Uint8Array; output_key_ref: string }>(
    `
      select output_ciphertext, output_key_ref
      from itotori_llm_accepted_outputs
      where output_id = $1
    `,
    [outputId],
  );
  const row = result.rows[0];
  return row ? cipher.open(row.output_ciphertext, row.output_key_ref) : null;
}

export async function acceptedVersions(
  pool: DatabaseContext["pool"],
  subjectId: string,
): Promise<number[]> {
  const result = await pool.query<{ output_version: number }>(
    "select output_version from itotori_llm_accepted_outputs where subject_id = $1 order by output_version",
    [subjectId],
  );
  return result.rows.map((row) => row.output_version);
}

export function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
