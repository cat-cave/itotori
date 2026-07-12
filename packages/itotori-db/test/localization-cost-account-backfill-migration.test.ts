import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { migrate, migrations } from "../src/migrations.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("0082 localization cost-account backfill", () => {
  it("upgrades historical billed spend without counting estimates and refreshes existing accounts", async () => {
    const databaseUrl = requiredDatabaseUrl();
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schemaName = `itotori_cost_backfill_${Date.now()}_${randomBytes(6).toString("hex")}`;
    const schemaUrl = databaseUrlWithSearchPath(databaseUrl, schemaName);

    await admin.query(`create schema ${quoteIdentifier(schemaName)}`);
    const pool = new pg.Pool({ connectionString: schemaUrl });
    try {
      await migrateThroughAtomicCostReservations(pool);
      await seedHistoricalJournalState(pool);

      // This is a real upgrade from the pre-0082 migration boundary, rather
      // than replaying the SQL into a schema that has already applied 0082.
      await migrate(schemaUrl);

      expect(await costAccounts(pool)).toEqual([
        {
          runId: "run-cost-backfill-existing-account",
          capMatches: true,
          spentMatches: true,
          reservedMatches: true,
        },
        {
          runId: "run-cost-backfill-new-account",
          capMatches: true,
          spentMatches: true,
          reservedMatches: true,
        },
      ]);

      const applied = await pool.query<{ migration_id: string }>(
        `
          select migration_id
          from itotori_schema_migrations
          where migration_id = '0082_backfill_localization_run_cost_accounts'
        `,
      );
      expect(applied.rows).toEqual([
        { migration_id: "0082_backfill_localization_run_cost_accounts" },
      ]);
    } finally {
      await pool.end();
      await admin.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
      await admin.end();
    }
  });
});

async function migrateThroughAtomicCostReservations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    create table itotori_schema_migrations (
      migration_id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const atomicCostReservationIndex = migrations.findIndex(
    (migration) => migration.id === "0081_atomic_cost_reservations",
  );
  expect(atomicCostReservationIndex).toBeGreaterThanOrEqual(0);

  for (const migration of migrations.slice(0, atomicCostReservationIndex + 1)) {
    const body = migrationSql(migration.file);
    await pool.query(body);
    await pool.query(
      "insert into itotori_schema_migrations (migration_id, checksum) values ($1, $2)",
      [migration.id, createHash("sha256").update(body).digest("hex")],
    );
  }
}

async function seedHistoricalJournalState(pool: pg.Pool): Promise<void> {
  await pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-cost-backfill', 'Cost backfill workspace')
  `);
  await pool.query(`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      'project-cost-backfill', 'workspace-cost-backfill', 'cost-backfill',
      'Cost backfill project', 'ja-JP', 'imported'
    )
  `);
  await pool.query(`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values ('source-revision-cost-backfill', 'project-cost-backfill', 'bridge_revision', 'v1')
  `);
  await pool.query(`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'source-bundle-cost-backfill', 'project-cost-backfill',
      'source-revision-cost-backfill', 'bridge-cost-backfill',
      '0.2.0', 'hash:cost-backfill', 'ja-JP', 'fixture-extractor', '1.0.0', 0, 0
    )
  `);
  await pool.query(`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      'locale-branch-cost-backfill', 'project-cost-backfill',
      'source-bundle-cost-backfill', 'en-US', 'English', 'active'
    )
  `);

  await pool.query(`
    insert into itotori_localization_journal_runs (
      run_id, project_id, locale_branch_id, source_revision_id, target_locale,
      frozen_scope, routing_policy, cost_policy
    ) values
      (
        'run-cost-backfill-new-account', 'project-cost-backfill',
        'locale-branch-cost-backfill', 'source-revision-cost-backfill', 'en-US',
        '{"kind":"explicit_units","bridgeUnitIds":["unit-cost-backfill-new"]}'::jsonb,
        '{}'::jsonb,
        '{"budgetCapUsd":"0.90"}'::jsonb
      ),
      (
        'run-cost-backfill-existing-account', 'project-cost-backfill',
        'locale-branch-cost-backfill', 'source-revision-cost-backfill', 'en-US',
        '{"kind":"explicit_units","bridgeUnitIds":["unit-cost-backfill-existing"]}'::jsonb,
        '{}'::jsonb,
        '{"budgetCapUsd":1.5}'::jsonb
      )
  `);
  await pool.query(`
    insert into itotori_localization_journal_run_units (
      run_id, bridge_unit_id, unit_ordinal, state
    ) values
      ('run-cost-backfill-new-account', 'unit-cost-backfill-new', 0, 'pending'),
      ('run-cost-backfill-existing-account', 'unit-cost-backfill-existing', 0, 'pending')
  `);

  await insertHistoricalAttempts(pool, {
    runId: "run-cost-backfill-new-account",
    bridgeUnitId: "unit-cost-backfill-new",
    suffix: "new",
    billedUsd: "0.20",
    legacyUsd: "0.30",
    providerEstimateUsd: "0.40",
  });
  await insertHistoricalAttempts(pool, {
    runId: "run-cost-backfill-existing-account",
    bridgeUnitId: "unit-cost-backfill-existing",
    suffix: "existing",
    billedUsd: "0.10",
    legacyUsd: "0.20",
    providerEstimateUsd: "0.30",
  });

  // 0081 already allowed a live account before the historical-spend
  // projection.  The 0082 conflict path must repair spent_usd while keeping
  // that in-flight reservation and cap intact.
  await pool.query(`
    insert into itotori_localization_run_cost_accounts (
      run_id, cap_usd, spent_usd, reserved_usd
    ) values (
      'run-cost-backfill-existing-account', 1.5, 0, 0.125
    )
  `);
}

async function insertHistoricalAttempts(
  pool: pg.Pool,
  input: {
    runId: string;
    bridgeUnitId: string;
    suffix: string;
    billedUsd: string;
    legacyUsd: string;
    providerEstimateUsd: string;
  },
): Promise<void> {
  const attempts = [
    { label: "billed", costKind: "billed", costUsd: input.billedUsd },
    { label: "legacy", costKind: null, costUsd: input.legacyUsd },
    {
      label: "provider-estimate",
      costKind: "provider_estimate",
      costUsd: input.providerEstimateUsd,
    },
  ] as const;

  for (const [index, attempt] of attempts.entries()) {
    await pool.query(
      `
        insert into itotori_llm_attempts (
          attempt_id, run_id, bridge_unit_id, stage, agent_label, logical_call_id,
          attempt_index, model_id, provider_id, provider_run_id, cost_usd, cost_kind,
          zdr, validation_result, retry_decision, artifact_ref, error_classes,
          started_at, completed_at
        ) values (
          $1, $2, $3, 'translation', 'translator', $4,
          1, 'model-cost-backfill', 'provider-cost-backfill', $1, $5, $6,
          true, 'accepted', 'write', $7, '[]'::jsonb,
          '2026-07-12T12:00:00.000Z'::timestamptz,
          '2026-07-12T12:00:01.000Z'::timestamptz
        )
      `,
      [
        `attempt-cost-backfill-${input.suffix}-${attempt.label}`,
        input.runId,
        input.bridgeUnitId,
        `logical-cost-backfill-${input.suffix}-${index}`,
        attempt.costUsd,
        attempt.costKind,
        `provider-run:attempt-cost-backfill-${input.suffix}-${attempt.label}`,
      ],
    );
  }
}

async function costAccounts(pool: pg.Pool): Promise<
  {
    runId: string;
    capMatches: boolean;
    spentMatches: boolean;
    reservedMatches: boolean;
  }[]
> {
  const result = await pool.query<{
    run_id: string;
    cap_matches: boolean;
    spent_matches: boolean;
    reserved_matches: boolean;
  }>(`
    select
      run_id,
      case run_id
        when 'run-cost-backfill-new-account' then cap_usd = 0.9
        when 'run-cost-backfill-existing-account' then cap_usd = 1.5
      end as cap_matches,
      case run_id
        when 'run-cost-backfill-new-account' then spent_usd = 0.5
        when 'run-cost-backfill-existing-account' then spent_usd = 0.3
      end as spent_matches,
      case run_id
        when 'run-cost-backfill-new-account' then reserved_usd = 0
        when 'run-cost-backfill-existing-account' then reserved_usd = 0.125
      end as reserved_matches
    from itotori_localization_run_cost_accounts
    where run_id in (
      'run-cost-backfill-new-account',
      'run-cost-backfill-existing-account'
    )
    order by run_id
  `);

  return result.rows.map((row) => ({
    runId: row.run_id,
    capMatches: row.cap_matches,
    spentMatches: row.spent_matches,
    reservedMatches: row.reserved_matches,
  }));
}

function requiredDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for DB-backed migration tests");
  }
  return databaseUrl;
}

function migrationSql(file: string): string {
  return readFileSync(join(here, "..", "migrations", file), "utf8");
}

function databaseUrlWithSearchPath(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
