import { afterEach, describe, expect, it } from "vitest";
import { ItotoriPrincipalRepository, localUserId } from "@itotori/db";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";

import { requireLivePostgres } from "../../../packages/itotori-db/test/live-postgres-suite.js";

const postgresDescribe = requireLivePostgres(describe);
const fieldCipherKey = Buffer.alloc(32, 11).toString("base64");

let priorFieldCipherKey: string | undefined;

afterEach(() => {
  if (priorFieldCipherKey === undefined) {
    delete process.env.ITOTORI_FIELD_CIPHER_KEY;
  } else {
    process.env.ITOTORI_FIELD_CIPHER_KEY = priorFieldCipherKey;
  }
});

postgresDescribe("database service bootstrap", () => {
  it("materializes the default account principal on a freshly migrated database", async () => {
    const context = await isolatedMigratedContext();
    priorFieldCipherKey = process.env.ITOTORI_FIELD_CIPHER_KEY;
    process.env.ITOTORI_FIELD_CIPHER_KEY = fieldCipherKey;
    try {
      await withDatabaseItotoriServices(
        { databaseUrl: context.databaseUrl },
        async () => undefined,
      );

      const identity = await new ItotoriPrincipalRepository(context.db).loadActorIdentity({
        userId: localUserId,
      });
      expect(identity.accounts).toEqual([
        expect.objectContaining({ accountId: "account-local", accountSlug: "local" }),
      ]);
    } finally {
      await context.close();
    }
  });
});
