#!/usr/bin/env node
// Allocate a collision-free database migration filename and write an empty
// SQL stub. Concurrent authors do not share a sequential counter: the ordinal
// is UTC wall time plus 4 hex entropy, so two agents minting at the same
// second still produce distinct, lexicographically ordered ids.
//
// Usage:
//   node scripts/new-db-migration.mjs <slug>
//   node scripts/new-db-migration.mjs add_widget_table
//
// Apply order is the lexicographic sort of packages/itotori-db/migrations/*.sql.
// No shared registry file is edited.

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "packages", "itotori-db", "migrations");

function allocateOrdinal(now = new Date()) {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  const entropy = randomBytes(2).toString("hex");
  return `${year}${month}${day}${hour}${minute}${second}${entropy}`;
}

function main(argv) {
  const slug = argv[2];
  if (slug === undefined || slug.length === 0) {
    process.stderr.write(
      "usage: node scripts/new-db-migration.mjs <slug>\n" +
        "  slug: lowercase [a-z][a-z0-9_]* describing the change\n" +
        "  Do NOT pick sequential ordinals (0122, …); this script mints a stamp ordinal.\n",
    );
    process.exit(2);
  }
  if (!/^[a-z][a-z0-9_]*$/u.test(slug)) {
    process.stderr.write(
      `new-db-migration: invalid slug ${JSON.stringify(slug)}; use [a-z][a-z0-9_]*\n`,
    );
    process.exit(2);
  }

  // Retry a few times on the astronomically unlikely entropy collision.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ordinal = allocateOrdinal();
    const file = `${ordinal}_${slug}.sql`;
    const path = join(migrationsDir, file);
    if (existsSync(path)) continue;
    const body =
      `-- Migration ${ordinal}_${slug}\n` +
      `-- Allocated by scripts/new-db-migration.mjs (stamp ordinal; do not renumber).\n` +
      `\n`;
    writeFileSync(path, body, { flag: "wx" });
    process.stdout.write(
      [
        `created ${path}`,
        `ordinal ${ordinal} (stamp; unique by construction)`,
        "apply order: lexicographic among packages/itotori-db/migrations/*.sql",
        "no registry edit required — discovery loads every .sql file",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }

  process.stderr.write("new-db-migration: failed to allocate a unique filename\n");
  process.exit(1);
}

main(process.argv);
