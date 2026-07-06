import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  catalogPathRedactionClassValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-07-06T12:00:00.000Z";

const NATURAL_KEY_INDEX_NAME = "itotori_catalog_seed_targets_source_origin_idx";
const STATUS_PRIORITY_INDEX_NAME = "itotori_catalog_seed_targets_status_idx";

// CATALOG-062: prior coverage only asserted the index NAMES (via pg_indexes),
// so a migration could silently flip uniqueness, drop the coalesce(origin_ref, '')
// expression column, or reverse priority ordering and still pass. These
// assertions pin the EXACT Postgres index definition returned by pg_get_indexdef
// — uniqueness, expression columns, and column ordering are all load-bearing.
// Raw pg_catalog queries are used (rather than the drizzle `sql` tag) because we
// interrogate Postgres system catalogs, not drizzle-modeled tables.

describe("catalog seed target index definitions (CATALOG-062)", () => {
  it("pins the natural-key UNIQUE index and the status/priority index exactly via pg_get_indexdef", async () => {
    const context = await isolatedMigratedContext();
    try {
      const result = await context.pool.query<{
        schema_name: string;
        index_name: string;
        index_definition: string;
      }>(
        `
          select current_schema() as schema_name,
                 c.relname as index_name,
                 pg_get_indexdef(c.oid) as index_definition
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = current_schema()
            and c.relkind = 'i'
            and c.relname = any($1::text[])
        `,
        [[NATURAL_KEY_INDEX_NAME, STATUS_PRIORITY_INDEX_NAME]],
      );

      const byName = new Map(result.rows.map((row) => [row.index_name, row]));

      const naturalKeyRow = byName.get(NATURAL_KEY_INDEX_NAME);
      expect(naturalKeyRow, `expected index ${NATURAL_KEY_INDEX_NAME} to exist`).toBeDefined();
      const naturalKeySchema = String(naturalKeyRow?.schema_name);
      // Pins the UNIQUE keyword (uniqueness), the COALESCE(origin_ref, ''::text)
      // expression column, and the four-column natural-key ordering. Dropping
      // uniqueness, removing/altering the coalesce expression, or reordering
      // columns fails this assertion.
      expect(String(naturalKeyRow?.index_definition)).toBe(
        naturalKeyIndexDefinition(naturalKeySchema),
      );

      const statusPriorityRow = byName.get(STATUS_PRIORITY_INDEX_NAME);
      expect(
        statusPriorityRow,
        `expected index ${STATUS_PRIORITY_INDEX_NAME} to exist`,
      ).toBeDefined();
      const statusPrioritySchema = String(statusPriorityRow?.schema_name);
      // Pins the absence of UNIQUE (non-uniqueness) and the priority DESC
      // ordering within the (status, priority DESC, added_at) column list.
      // Adding uniqueness, dropping DESC, or reordering columns fails this.
      expect(String(statusPriorityRow?.index_definition)).toBe(
        statusPriorityIndexDefinition(statusPrioritySchema),
      );
    } finally {
      await context.close();
    }
  });
});

// CATALOG-062 regression: when a local-scan entry is re-recorded against the
// same (local_scan_id, path_hash), the unique entry-path index keeps the
// ORIGINAL local_scan_entry_id PK. recordLocalScan must link nested seed
// targets to the PERSISTED entry id — whether the caller supplied the parent
// entry id explicitly OR omitted it — not to the caller's (now-discarded) id.

describe("nested seed target local scan entry linkage (CATALOG-062)", () => {
  it("keeps nested seed targets linked to the persisted local scan entry for both caller-supplied and omitted parent entry ids", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const localScanId = uuid(1);
      const persistedEntryId = uuid(10);
      const callerEntryId = uuid(11);
      const scanRootPathHash = hash("linkage-regression-root");
      const entryPathHash = hash("linkage-regression-entry-path");

      const baseScanInput = {
        localScanId,
        scanRootLabel: "linkage regression",
        scanRootPathHash,
        scannerName: "linkage-regression-scanner",
        scannerVersion: "0.0.0",
        startedAt: fetchedAt,
        completedAt: fetchedAt,
      };

      // First record: the entry is persisted under persistedEntryId.
      await repo.recordLocalScan(localActor, {
        ...baseScanInput,
        entries: [
          {
            localScanEntryId: persistedEntryId,
            pathHash: entryPathHash,
            pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
          },
        ],
      });

      // Second record: same (localScanId, pathHash) collides on the unique
      // entry-path index, so the persisted PK stays persistedEntryId even though
      // the caller now supplies callerEntryId. Both nested seed targets must
      // resolve to the PERSISTED entry, never the caller's discarded id.
      const callerSuppliedSeedId = uuid(20);
      const omittedSeedId = uuid(21);
      const replayed = await repo.recordLocalScan(localActor, {
        ...baseScanInput,
        entries: [
          {
            localScanEntryId: callerEntryId,
            pathHash: entryPathHash,
            pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
            seedTargets: [
              {
                seedTargetId: callerSuppliedSeedId,
                catalogSource: catalogSourceValues.dlsite,
                sourceId: "RJLINKAGE_CALLER",
                seedOrigin: catalogSeedOriginValues.localScan,
                status: catalogSeedStatusValues.pending,
                priority: 5,
                localScanEntryId: callerEntryId,
              },
              {
                seedTargetId: omittedSeedId,
                catalogSource: catalogSourceValues.dlsite,
                sourceId: "RJLINKAGE_OMITTED",
                seedOrigin: catalogSeedOriginValues.localScan,
                status: catalogSeedStatusValues.pending,
                priority: 5,
              },
            ],
          },
        ],
      });

      // The replayed entry carries the PERSISTED id, proving conflict resolution
      // diverged the persisted PK from the caller-supplied callerEntryId.
      expect(replayed.entries[0]?.localScanEntryId).toBe(persistedEntryId);

      const persisted = await context.pool.query<{
        seedTargetId: string;
        localScanEntryId: string | null;
      }>(
        `
          select seed_target_id as "seedTargetId",
                 local_scan_entry_id as "localScanEntryId"
          from itotori_catalog_seed_targets
          where seed_target_id = any($1::text[])
        `,
        [[callerSuppliedSeedId, omittedSeedId]],
      );
      const byId = new Map(persisted.rows.map((row) => [row.seedTargetId, row.localScanEntryId]));
      // Both branches (caller-supplied parent id AND omitted parent id) keep the
      // nested seed target linked to the persisted local scan entry.
      expect(byId.get(callerSuppliedSeedId)).toBe(persistedEntryId);
      expect(byId.get(omittedSeedId)).toBe(persistedEntryId);
      // Sanity: neither seed target was linked to the caller's discarded id.
      expect(byId.get(callerSuppliedSeedId)).not.toBe(callerEntryId);
      expect(byId.get(omittedSeedId)).not.toBe(callerEntryId);
    } finally {
      await context.close();
    }
  });
});

function naturalKeyIndexDefinition(schemaName: string): string {
  return (
    `CREATE UNIQUE INDEX ${NATURAL_KEY_INDEX_NAME} ` +
    `ON ${schemaName}.itotori_catalog_seed_targets USING btree ` +
    `(catalog_source, source_id, seed_origin, COALESCE(origin_ref, ''::text))`
  );
}

function statusPriorityIndexDefinition(schemaName: string): string {
  return (
    `CREATE INDEX ${STATUS_PRIORITY_INDEX_NAME} ` +
    `ON ${schemaName}.itotori_catalog_seed_targets USING btree ` +
    `(status, priority DESC, added_at)`
  );
}

function uuid(id: number): string {
  return `019ed004-0000-7000-8000-${String(id).padStart(12, "0")}`;
}

function hash(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
