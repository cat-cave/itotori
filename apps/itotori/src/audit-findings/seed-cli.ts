#!/usr/bin/env node
/**
 * `just audit-findings-seed` entrypoint.
 *
 * Connects to DATABASE_URL, scans docs/audits/*.md for structured
 * audit-finding blocks (see ./parser.ts for the block grammar), and
 * inserts every finding into itotori_audit_findings via the
 * permission-gated repository. Exits non-zero on any parse or write
 * error.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ItotoriAuditFindingRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  migrate,
} from "@itotori/db";
import { bootstrapAuditFindings } from "./bootstrap.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    process.stderr.write("DATABASE_URL is required to seed audit findings; aborting.\n");
    process.exit(1);
  }

  // Resolve repo root from dist/audit-findings/seed-cli.js. The package
  // is shipped via TypeScript build, so resolution is relative to the
  // compiled file (apps/itotori/dist/audit-findings/seed-cli.js -> repo
  // root four levels up).
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../../..");
  const auditsDir = resolve(repoRoot, "docs/audits");

  await migrate(databaseUrl);
  const context = createDatabaseContext(databaseUrl);
  try {
    const actor = await bootstrapLocalUser(context.db);
    const repo = new ItotoriAuditFindingRepository(context.db);
    const summary = await bootstrapAuditFindings(
      { recordFinding: (a, input) => repo.recordFinding(a, input) },
      {
        actor,
        auditsDirectoryAbsolutePath: auditsDir,
        repoRootAbsolutePath: repoRoot,
      },
    );

    process.stdout.write(
      `audit findings seed -> ${summary.findingsInserted} inserted ` +
        `across ${summary.reportsWithFindings} of ${summary.reportsScanned} reports\n`,
    );
    for (const row of summary.perReport) {
      process.stdout.write(`  ${row.auditReportId}: ${row.findingsInserted}\n`);
    }
  } finally {
    await context.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`audit findings seed failed: ${String(err)}\n`);
  process.exitCode = 1;
});
