import { afterAll, beforeAll, describe, it } from "vitest";
import { deniedActor, repositoryPermissionGateMatrix } from "./authorization-matrix.test.core.js";
import { requiredContext } from "./authorization-matrix.test.helpers.js";
import type { DatabaseContext } from "../src/connection.js";
import { assertDeniedRepositoryMutation } from "./authorization-test-helpers.js";
import { isolatedMigratedContext } from "./db-test-context.js";

describe("repository permission denial fixtures", () => {
  let context: DatabaseContext | undefined;

  beforeAll(async () => {
    context = await isolatedMigratedContext();
  });

  afterAll(async () => {
    await context?.close();
  });

  it.each(repositoryPermissionGateMatrix)(
    "denies $repository.$mutation without $requiredPermission",
    async ({ requiredPermission, runDeniedMutation }) => {
      await assertDeniedRepositoryMutation({
        actor: deniedActor,
        permission: requiredPermission,
        run: () => runDeniedMutation(requiredContext(context).db),
      });
    },
  );
});
