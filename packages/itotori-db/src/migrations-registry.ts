import { loadMigrationEntries, type MigrationEntry } from "./migration-identity.js";

/**
 * Canonical migration list, discovered from packages/itotori-db/migrations.
 *
 * Apply order is lexicographic on the migration id. Authors add a uniquely
 * named `.sql` file (via `node scripts/new-db-migration.mjs <slug>`) and do not
 * edit a shared ordinal counter or registry array — that is what makes
 * concurrent migration authoring merge-clean under fan-out.
 */
export const migrations: readonly MigrationEntry[] = loadMigrationEntries();
