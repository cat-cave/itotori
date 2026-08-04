import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DB_OWNED_APP_TEST_FILES } from "./db-owned-app-proofs.mjs";
import { databaseAppVitestArguments, runDatabaseAppProofs } from "./run-db-owned-app-proofs.mjs";

test("DB lane invokes every DB-owned app proof through the DB Vitest config", () => {
  const args = databaseAppVitestArguments();
  assert.ok(args.includes("vitest.db.config.ts"));
  assert.match(
    readFileSync("apps/itotori/vitest.db.config.ts", "utf8"),
    /fileParallelism:\s*false/u,
  );
  for (const file of DB_OWNED_APP_TEST_FILES) assert.ok(args.includes(file), file);
});

test("missing DATABASE_URL fails before any DB-owned proof can vanish", () => {
  assert.throws(
    () => runDatabaseAppProofs(() => assert.fail("must not spawn"), {}),
    /require DATABASE_URL/u,
  );
});
