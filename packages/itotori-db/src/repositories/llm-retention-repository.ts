import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import type { LlmMemoCipher } from "./llm-call-memo-repository.js";

type RegistryRow = {
  table_name: string;
  ciphertext_column: string;
  key_ref_column: string;
  deletion_state_column: string;
};

export type LlmRetentionDeletionReport = {
  deletedRows: number;
  destroyedKeyRefs: number;
  tables: Readonly<Record<string, number>>;
};

/** Deletes expired rebuilt-LLM ciphertext and leaves metadata tombstones. */
export class ItotoriLlmRetentionRepository {
  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
  ) {}

  async deleteExpired(now = new Date()): Promise<LlmRetentionDeletionReport> {
    if (Number.isNaN(now.getTime())) throw new Error("retention cutoff must be a valid date");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const registry = await client.query<RegistryRow>(`
        select table_name, ciphertext_column, key_ref_column, deletion_state_column
        from itotori_llm_encrypted_column_registry
        order by table_name, ciphertext_column
      `);
      const byTable = groupRegistry(registry.rows);
      const destroyed = new Set<string>();
      const tables: Record<string, number> = {};

      for (const [tableName, columns] of byTable) {
        const count = await deleteExpiredTable(client, this.cipher, {
          tableName,
          columns,
          now,
          destroyed,
        });
        if (count > 0) tables[tableName] = count;
      }

      await client.query("commit");
      return {
        deletedRows: Object.values(tables).reduce((sum, count) => sum + count, 0),
        destroyedKeyRefs: destroyed.size,
        tables,
      };
    } catch (error: unknown) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

function groupRegistry(rows: readonly RegistryRow[]): Map<string, RegistryRow[]> {
  const grouped = new Map<string, RegistryRow[]>();
  for (const row of rows) {
    assertIdentifier(row.table_name);
    assertIdentifier(row.ciphertext_column);
    assertIdentifier(row.key_ref_column);
    assertIdentifier(row.deletion_state_column);
    const columns = grouped.get(row.table_name) ?? [];
    if (columns.length > 0 && columns[0]?.deletion_state_column !== row.deletion_state_column) {
      throw new Error(`inconsistent deletion-state registry for ${row.table_name}`);
    }
    columns.push(row);
    grouped.set(row.table_name, columns);
  }
  return grouped;
}

async function deleteExpiredTable(
  client: PoolClient,
  cipher: LlmMemoCipher,
  input: {
    tableName: string;
    columns: readonly RegistryRow[];
    now: Date;
    destroyed: Set<string>;
  },
): Promise<number> {
  const table = quoteIdentifier(input.tableName);
  const state = quoteIdentifier(input.columns[0]!.deletion_state_column);
  const keyRefs = input.columns.map((column) => quoteIdentifier(column.key_ref_column)).join(", ");
  const expired = await client.query<{ key_refs: Array<string | null> }>(
    `select array[${keyRefs}] as key_refs from ${table}
     where ${state} = 'active' and retention_deadline <= $1::timestamptz
     for update`,
    [input.now.toISOString()],
  );

  for (const row of expired.rows) {
    for (const keyRef of row.key_refs) {
      if (keyRef === null || input.destroyed.has(keyRef)) continue;
      await cipher.destroyKey(keyRef);
      input.destroyed.add(keyRef);
    }
  }
  if (expired.rows.length === 0) return 0;

  const cleartext = input.columns
    .map((column) => `${quoteIdentifier(column.ciphertext_column)} = null`)
    .join(", ");
  const deleted = await client.query(
    `update ${table} set ${cleartext}, ${state} = 'deleted', deleted_at = $1::timestamptz
     where ${state} = 'active' and retention_deadline <= $1::timestamptz`,
    [input.now.toISOString()],
  );
  return deleted.rowCount ?? 0;
}

function assertIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error(`invalid retention registry name`);
}

function quoteIdentifier(value: string): string {
  assertIdentifier(value);
  return `"${value}"`;
}
