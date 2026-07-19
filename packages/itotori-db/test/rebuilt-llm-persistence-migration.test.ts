import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseContext } from "../src/connection.js";
import { conversationEventIdFromContentHash } from "../src/llm-content-address.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const historyTables = [
  "itotori_llm_call_memos",
  "itotori_llm_http_attempts",
  "itotori_llm_conversation_events",
  "itotori_llm_accepted_outputs",
  "itotori_llm_wiki_versions",
  "itotori_llm_dependency_edges",
  "itotori_llm_human_inputs",
] as const;

const rebuiltTables = [
  "itotori_llm_encrypted_column_registry",
  ...historyTables,
  "itotori_llm_cas_heads",
  "itotori_llm_context_snapshots",
  "itotori_llm_localization_snapshots",
] as const;

const encryptedColumns = [
  ["itotori_llm_accepted_outputs", "output_ciphertext"],
  ["itotori_llm_call_memos", "outcome_ciphertext"],
  ["itotori_llm_call_memos", "request_ciphertext"],
  ["itotori_llm_call_memos", "response_ciphertext"],
  ["itotori_llm_conversation_events", "event_body_ciphertext"],
  ["itotori_llm_http_attempts", "request_ciphertext"],
  ["itotori_llm_http_attempts", "response_ciphertext"],
  ["itotori_llm_human_inputs", "human_input_ciphertext"],
  ["itotori_llm_wiki_versions", "wiki_ciphertext"],
] as const;

const expectedColumnsByTable = {
  itotori_llm_encrypted_column_registry:
    "table_name ciphertext_column key_ref_column hash_column retention_class deletion_state_column encryption_method".split(
      " ",
    ),
  itotori_llm_call_memos:
    "memo_key semantic_hash schema_version request_ciphertext request_key_ref request_content_hash response_ciphertext response_key_ref response_content_hash outcome_ciphertext outcome_key_ref outcome_content_hash outcome_kind verification_status generation_id requested_model provider_policy served_model served_provider prompt_token_count completion_token_count reasoning_token_count cached_token_count billing_state cost_usd completed_at retention_deadline deletion_state deleted_at served_pair_status".split(
      " ",
    ),
  itotori_llm_http_attempts:
    "attempt_id memo_key attempt_ordinal request_ciphertext request_key_ref request_content_hash response_ciphertext response_key_ref response_content_hash request_hash attempt_status http_status generation_id billing_state cost_usd started_at completed_at retention_deadline deletion_state deleted_at admission_scope failure_class max_exposure_usd deadline_at served_pair_status served_model served_provider verification_status router_attempts prompt_token_count completion_token_count reasoning_token_count cached_token_count reported_cost_usd".split(
      " ",
    ),
  itotori_llm_conversation_events:
    "event_id schema_version parent_event_ids event_kind snapshot_kind snapshot_id actor_role event_body_ciphertext event_body_key_ref event_body_content_hash memo_key accepted created_at retention_deadline deletion_state deleted_at projection_kind projection_ref projection_auxiliary_ref".split(
      " ",
    ),
  itotori_llm_accepted_outputs:
    "output_id semantic_key schema_version output_version supersedes_output_id parent_output_ids memo_keys snapshot_kind snapshot_id subject_type subject_id stage source_hash output_ciphertext output_key_ref output_content_hash accepted_at retention_deadline deletion_state deleted_at".split(
      " ",
    ),
  itotori_llm_wiki_versions:
    "wiki_version_id wiki_kind object_id object_version supersedes_version snapshot_kind snapshot_id object_kind wiki_ciphertext wiki_key_ref wiki_content_hash created_at retention_deadline deletion_state deleted_at object_language subject_kind subject_id scope_kind scope_route_ids provisional context_scope run_mode provenance_edited_by provenance_author_role localization_snapshot_id source_object_id".split(
      " ",
    ),
  itotori_llm_dependency_edges:
    "edge_id downstream_wiki_version_id dependency_hash upstream_object_id upstream_version claim_id field_path rendering_id scope_ref from_play_order through_play_order created_at".split(
      " ",
    ),
  itotori_llm_human_inputs:
    "input_id input_kind subject_ref human_input_ciphertext human_input_key_ref human_input_content_hash created_at retention_deadline deletion_state deleted_at".split(
      " ",
    ),
  itotori_llm_cas_heads:
    "head_namespace snapshot_id subject_type subject_id head_stage head_id head_version head_content_hash updated_at".split(
      " ",
    ),
  itotori_llm_context_snapshots:
    "snapshot_id schema_version snapshot_content_hash snapshot_identity created_at".split(" "),
  itotori_llm_localization_snapshots:
    "snapshot_id schema_version snapshot_content_hash context_snapshot_id snapshot_identity created_at".split(
      " ",
    ),
} as const satisfies Record<(typeof rebuiltTables)[number], readonly string[]>;

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = [
  "0101_rebuilt_llm_persistence.sql",
  "0102_rebuilt_llm_history_truncate_guard.sql",
  "0103_llm_attempt_admission_exposure.sql",
  "0105_llm_served_pair_quarantine.sql",
  "0106_llm_transcript_snapshots.sql",
  "0108_llm_explicit_unknown_quarantine.sql",
  "0109_wiki_snapshot_binding.sql",
]
  .map((file) => readFileSync(join(here, "..", "migrations", file), "utf8"))
  .join("\n");
const hash = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as const;

describe("rebuilt LLM persistence migration", () => {
  let context: (DatabaseContext & { databaseUrl: string }) | undefined;

  beforeAll(async () => {
    context = await isolatedMigratedContext();
  });

  afterAll(async () => {
    await context?.close();
  });

  it("provisions the fresh schema and registers every ciphertext column", async () => {
    const pool = context!.pool;
    const tables = await pool.query<{ table_name: string }>(
      `
        select table_name
        from information_schema.tables
        where table_schema = current_schema()
          and table_name = any($1::text[])
        order by table_name
      `,
      [[...rebuiltTables]],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...rebuiltTables].sort());

    const registered = await pool.query<{ table_name: string; ciphertext_column: string }>(`
      select table_name, ciphertext_column
      from itotori_llm_encrypted_column_registry
      order by table_name, ciphertext_column
    `);
    expect(registered.rows.map((row) => [row.table_name, row.ciphertext_column])).toEqual(
      encryptedColumns,
    );
    const actualCiphertext = await pool.query<{ table_name: string; column_name: string }>(
      `
        select table_name, column_name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = any($1::text[])
          and column_name like '%ciphertext%'
        order by table_name, column_name
      `,
      [[...historyTables]],
    );
    expect(actualCiphertext.rows.map((row) => [row.table_name, row.column_name])).toEqual(
      registered.rows.map((row) => [row.table_name, row.ciphertext_column]),
    );
    const incompleteRegistration = await pool.query(`
      select registry.table_name, registry.ciphertext_column
      from itotori_llm_encrypted_column_registry registry
      where not exists (
        select 1 from information_schema.columns column_info
        where column_info.table_schema = current_schema()
          and column_info.table_name = registry.table_name
          and column_info.column_name in (
            registry.key_ref_column, registry.hash_column,
            registry.deletion_state_column, 'retention_deadline'
          )
        having count(*) = 4
      )
    `);
    expect(incompleteRegistration.rows).toEqual([]);

    const lifecycleColumns = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `
        select table_name, column_name, is_nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = any($1::text[])
          and column_name in ('retention_deadline', 'deletion_state')
        order by table_name, column_name
      `,
      [[...historyTables].filter((table) => table !== "itotori_llm_dependency_edges")],
    );
    expect(lifecycleColumns.rows).toHaveLength(12);
    expect(lifecycleColumns.rows.every((column) => column.is_nullable === "NO")).toBe(true);

    const truncateTriggers = await pool.query<{ table_name: string }>(
      `
        select relation.relname as table_name
        from pg_trigger trigger
        join pg_class relation on relation.oid = trigger.tgrelid
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = current_schema()
          and relation.relname = any($1::text[])
          and not trigger.tgisinternal
          and (trigger.tgtype & 32) <> 0
        order by relation.relname
      `,
      [[...historyTables]],
    );
    expect(truncateTriggers.rows.map((row) => row.table_name)).toEqual([...historyTables].sort());
  });

  it("allows only the exact rebuilt-table column contract", async () => {
    await expect(assertExactRebuiltColumns(context!.pool)).resolves.toBeUndefined();
  });

  it("rejects unexpected ownership-shaped columns regardless of their names", async () => {
    const client = await context!.pool.connect();
    try {
      await client.query("begin");
      await client.query(`
        alter table itotori_llm_call_memos
          add column claimed_by_worker text,
          add column owner_run_id text,
          add column locked_until timestamptz
      `);
      await expect(assertExactRebuiltColumns(client)).rejects.toThrow(
        /unexpected rebuilt LLM columns/u,
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("rejects duplicate memo, attempt, output, wiki, and head identities", async () => {
    const pool = context!.pool;
    await insertMemo(pool, hash("1"), hash("2"));
    await expect(insertMemo(pool, hash("1"), hash("3"))).rejects.toMatchObject({ code: "23505" });

    await insertAttempt(pool, "attempt-a", hash("1"), 1);
    await expect(insertAttempt(pool, "attempt-b", hash("1"), 1)).rejects.toMatchObject({
      code: "23505",
    });

    await insertAcceptedOutput(pool, "output-a", hash("4"), 1);
    await expect(insertAcceptedOutput(pool, "output-b", hash("4"), 2)).rejects.toMatchObject({
      code: "23505",
    });

    await insertWikiVersion(pool, "wiki-version-a", hash("5"));
    await expect(insertWikiVersion(pool, "wiki-version-b", hash("6"))).rejects.toMatchObject({
      code: "23505",
    });

    await insertHead(pool);
    await expect(insertHead(pool)).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects confirmed served-pair columns without a generation id", async () => {
    const pool = context!.pool;
    await expect(
      pool.query(
        `
          insert into itotori_llm_call_memos (
            memo_key, semantic_hash, schema_version,
            request_ciphertext, request_key_ref, request_content_hash,
            response_ciphertext, response_key_ref, response_content_hash,
            outcome_ciphertext, outcome_key_ref, outcome_content_hash,
            outcome_kind, verification_status, generation_id, requested_model,
            provider_policy, served_model, served_provider, served_pair_status,
            billing_state, cost_usd, completed_at, retention_deadline
          ) values (
            $1, $2, 'itotori.physical-step-memo.v2',
            decode('11', 'hex'), 'key/illegal-memo-request', $3,
            decode('12', 'hex'), 'key/illegal-memo-response', $4,
            decode('13', 'hex'), 'key/illegal-memo-outcome', $5,
            'terminal', 'quarantined', null, 'requested-model', '{}'::jsonb,
            'served-model', 'served-provider', 'confirmed',
            'billing_unknown', null, now(), now() + interval '1 day'
          )
        `,
        [hash("c"), hash("d"), hash("e"), hash("f"), hash("a")],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `
          insert into itotori_llm_http_attempts (
            attempt_id, memo_key, attempt_ordinal, admission_scope,
            request_ciphertext, request_key_ref, request_content_hash, request_hash,
            attempt_status, failure_class, generation_id,
            served_pair_status, served_model, served_provider, verification_status,
            router_attempts, billing_state, max_exposure_usd,
            started_at, deadline_at, completed_at, retention_deadline
          ) values (
            'attempt-without-generation', $1, 1, 'migration-test',
            decode('14', 'hex'), 'key/illegal-attempt', $2, $3,
            'transport-error', 'permanent', null,
            'confirmed', 'served-model', 'served-provider', 'quarantined',
            '[]'::jsonb, 'billing_unknown', 0,
            now(), now(), now(), now() + interval '1 day'
          )
        `,
        [hash("b"), hash("c"), hash("d")],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("freezes history while allowing deletion tombstones and monotonic CAS", async () => {
    const pool = context!.pool;
    const liveMemoKey = hash("e");
    await insertMemo(pool, liveMemoKey, hash("f"));
    await insertEvent(pool);
    await expect(
      pool.query("update itotori_llm_conversation_events set accepted = true"),
    ).rejects.toThrow(/immutable/u);

    await expect(
      pool.query("update itotori_llm_accepted_outputs set output_version = 3"),
    ).rejects.toThrow(/immutable/u);
    await expect(
      pool.query("update itotori_llm_wiki_versions set object_kind = 'term-ruling'"),
    ).rejects.toThrow(/immutable/u);

    await insertDependency(pool);
    await expect(
      pool.query("update itotori_llm_dependency_edges set upstream_version = 2"),
    ).rejects.toThrow(/immutable/u);

    await pool.query(
      `
        update itotori_llm_call_memos
        set request_ciphertext = null,
            response_ciphertext = null,
            outcome_ciphertext = null,
            deletion_state = 'deleted',
            deleted_at = now()
        where memo_key = $1
      `,
      [hash("1")],
    );
    const tombstone = await pool.query<{
      deletion_state: string;
      request_ciphertext: Buffer | null;
    }>(
      "select deletion_state, request_ciphertext from itotori_llm_call_memos where memo_key = $1",
      [hash("1")],
    );
    expect(tombstone.rows[0]).toEqual({ deletion_state: "deleted", request_ciphertext: null });

    await insertAcceptedOutput(pool, "output-next", hash("8"), 2, liveMemoKey);
    const advanced = await pool.query(
      `
        update itotori_llm_cas_heads
        set head_id = 'output-next', head_version = 2, head_content_hash = $1, updated_at = now()
        where head_namespace = 'accepted-output' and snapshot_id = $2
          and subject_type = 'unit' and subject_id = 'unit-a' and head_stage = 'final'
          and head_version = 1
      `,
      [hash("0"), hash("7")],
    );
    expect(advanced.rowCount).toBe(1);
    await expect(pool.query("update itotori_llm_cas_heads set head_version = 4")).rejects.toThrow(
      /CAS head advance is invalid/u,
    );
  });

  it("rejects truncation of immutable history", async () => {
    await expect(context!.pool.query("truncate itotori_llm_call_memos")).rejects.toThrow(
      /history is immutable/u,
    );
  });

  it("is idempotent on upgrade and rolls back interrupted application", async () => {
    await expect(context!.pool.query(migrationSql)).resolves.toBeDefined();

    const schema = `itotori_migration_rollback_${Date.now()}`;
    const client = await context!.pool.connect();
    try {
      await client.query(`create schema ${schema}`);
      await client.query("begin");
      await client.query(`set local search_path to ${schema}`);
      await client.query(migrationSql);
      await expect(client.query("select * from deliberately_missing_relation")).rejects.toThrow();
      await client.query("rollback");
      const remaining = await client.query<{ count: number }>(
        `
          select count(*)::int as count
          from information_schema.tables
          where table_schema = $1 and table_name = any($2::text[])
        `,
        [schema, [...rebuiltTables]],
      );
      expect(remaining.rows[0]?.count).toBe(0);
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.query(`drop schema if exists ${schema} cascade`);
      client.release();
    }
  });
});

type Queryable = Pick<DatabaseContext["pool"], "query">;

async function assertExactRebuiltColumns(pool: Queryable): Promise<void> {
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `
      select table_name, column_name
      from information_schema.columns
      where table_schema = current_schema() and table_name = any($1::text[])
      order by table_name, column_name
    `,
    [[...rebuiltTables]],
  );
  const actual = new Map(rebuiltTables.map((table) => [table, new Set<string>()]));
  for (const column of columns.rows)
    actual.get(column.table_name as (typeof rebuiltTables)[number])?.add(column.column_name);
  const differences = rebuiltTables.flatMap((table) => {
    const expected = new Set(expectedColumnsByTable[table]);
    const columnsForTable = actual.get(table)!;
    return [
      ...[...columnsForTable]
        .filter((column) => !expected.has(column))
        .map((column) => `+${table}.${column}`),
      ...[...expected]
        .filter((column) => !columnsForTable.has(column))
        .map((column) => `-${table}.${column}`),
    ];
  });
  if (differences.length > 0)
    throw new Error(`unexpected rebuilt LLM columns: ${differences.join(", ")}`);
}

async function insertMemo(pool: Queryable, memoKey: string, semanticHash: string): Promise<void> {
  await pool.query(
    `
      insert into itotori_llm_call_memos (
        memo_key, semantic_hash, schema_version,
        request_ciphertext, request_key_ref, request_content_hash,
        response_ciphertext, response_key_ref, response_content_hash,
        outcome_ciphertext, outcome_key_ref, outcome_content_hash,
        outcome_kind, verification_status, generation_id, requested_model,
        provider_policy, served_model, served_provider, served_pair_status,
        prompt_token_count, completion_token_count, reasoning_token_count, cached_token_count,
        billing_state, cost_usd, completed_at, retention_deadline
      ) values (
        $1, $2, 'itotori.physical-step-memo.v2',
        decode('01', 'hex'), 'key/request', $3,
        decode('02', 'hex'), 'key/response', $4,
        decode('03', 'hex'), 'key/outcome', $5,
        'terminal', 'verified', 'generation-a', 'model-a',
        '{}'::jsonb, 'served-model-a', 'provider-a', 'confirmed', 1, 1, 0, 0,
        'confirmed', 0, now(), now() + interval '1 day'
      )
    `,
    [memoKey, semanticHash, hash("a"), hash("b"), hash("c")],
  );
}

async function insertAttempt(
  pool: Queryable,
  attemptId: string,
  memoKey: string,
  ordinal: number,
): Promise<void> {
  await pool.query(
    `
      insert into itotori_llm_http_attempts (
        attempt_id, memo_key, attempt_ordinal, admission_scope,
        request_ciphertext, request_key_ref, request_content_hash, request_hash,
        attempt_status, failure_class, served_pair_status, verification_status,
        router_attempts, billing_state, max_exposure_usd,
        started_at, deadline_at, completed_at, retention_deadline
      ) values (
        $1, $2, $3, 'migration-test', decode('04', 'hex'), 'key/attempt', $4, $5,
        'transport-error', 'transient', 'unknown', 'quarantined', '[]'::jsonb,
        'billing_unknown', 0,
        now(), now(), now(), now() + interval '1 day'
      )
    `,
    [attemptId, memoKey, ordinal, hash("d"), hash("e")],
  );
}

async function insertAcceptedOutput(
  pool: Queryable,
  outputId: string,
  semanticKey: string,
  version: number,
  memoKey = hash("1"),
): Promise<void> {
  await pool.query(
    `
      insert into itotori_llm_accepted_outputs (
        output_id, semantic_key, schema_version, output_version,
        memo_keys, snapshot_kind, snapshot_id, subject_type, subject_id, stage, source_hash,
        output_ciphertext, output_key_ref, output_content_hash, accepted_at, retention_deadline
      ) values (
        $1, $2, 'itotori.accepted-output.v1', $3, array[$6],
        'localization', $7, 'unit', 'unit-a', 'final', $4,
        decode('05', 'hex'), 'key/output', $5, now(), now() + interval '1 day'
      )
    `,
    [outputId, semanticKey, version, hash("f"), hash("0"), memoKey, hash("7")],
  );
}

async function insertWikiVersion(pool: Queryable, versionId: string, contentHash: string) {
  await pool.query(
    `
      insert into itotori_llm_context_snapshots (
        snapshot_id, schema_version, snapshot_content_hash, snapshot_identity, created_at
      ) values (
        $1, 'itotori.context-snapshot.v1', $1,
        '{"sourceLanguage":"ja-JP","contextScope":"whole-game"}'::jsonb, now()
      ) on conflict (snapshot_id) do nothing
    `,
    [hash("7")],
  );
  await pool.query(
    `
      insert into itotori_llm_wiki_versions (
        wiki_version_id, wiki_kind, object_id, object_version,
        snapshot_kind, snapshot_id, object_kind,
        wiki_ciphertext, wiki_key_ref, wiki_content_hash, created_at, retention_deadline,
        object_language, subject_kind, subject_id, scope_kind, provisional,
        context_scope, run_mode
      ) values (
        $1, 'source-object', 'wiki-a', 1,
        'context', $3, 'style-contract',
        decode('06', 'hex'), 'key/wiki', $2, now(), now() + interval '1 day',
        'ja-JP', 'game', 'project-a', 'global', false,
        'whole-game', 'production'
      )
    `,
    [versionId, contentHash, hash("7")],
  );
}

async function insertHead(pool: Queryable): Promise<void> {
  await pool.query(
    `
      insert into itotori_llm_cas_heads (
        head_namespace, snapshot_id, subject_type, subject_id, head_stage,
        head_id, head_version, head_content_hash, updated_at
      ) values (
        'accepted-output', $2, 'unit', 'unit-a', 'final',
        'output-a', 1, $1, now()
      )
    `,
    [hash("0"), hash("7")],
  );
}

async function insertEvent(pool: Queryable): Promise<void> {
  const bodyContentHash = hash("a");
  const snapshotId = hash("7");
  const eventId = conversationEventIdFromContentHash({
    parentIds: [],
    kind: "input",
    snapshotId,
    role: "human",
    bodyContentHash,
  });
  await pool.query(
    `
      insert into itotori_llm_conversation_events (
        event_id, schema_version, event_kind, snapshot_kind, snapshot_id, actor_role,
        event_body_ciphertext, event_body_key_ref, event_body_content_hash,
        accepted, created_at, retention_deadline
      ) values (
        $1, 'itotori.conversation-event.v1', 'input', 'localization', $3, 'human',
        decode('07', 'hex'), 'key/event', $2, false, now(), now() + interval '1 day'
      )
    `,
    [eventId, bodyContentHash, snapshotId],
  );
}

async function insertDependency(pool: Queryable): Promise<void> {
  await pool.query(
    `
      insert into itotori_llm_dependency_edges (
        edge_id, downstream_wiki_version_id, dependency_hash,
        upstream_object_id, upstream_version, claim_id, scope_ref, created_at
      ) values (
        'edge-a', 'wiki-version-a', $1, 'wiki-upstream', 1, 'claim-a',
        '{"kind":"global"}'::jsonb, now()
      )
    `,
    [hash("b")],
  );
}
