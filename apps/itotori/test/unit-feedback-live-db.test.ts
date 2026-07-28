// Real HTTP + Postgres proof for the user-facing play flag loop. The unit is
// first imported from a localization bridge, so its bridgeUnitId is the
// pipeline identity protected by the source-unit foreign key -- not a second
// feedback-only identifier.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "@itotori/db";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  draftJobFixtureLocaleBranchId,
  draftJobFixtureProjectId,
  provisionDraftJobFixtureProject,
} from "../../../packages/itotori-db/test/draft-job-fixtures.js";
import { createItotoriServer } from "../src/server.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const localActor: AuthorizationActor = { userId: localUserId };
const bridgeUnitId = "unit-draft-1";
const otherBridgeUnitId = "unit-draft-2";
const sceneId = "scene-001";
const note = "The branch reaches this line with the wrong speaker.";
const servers: ReturnType<typeof createItotoriServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

postgresDescribe("unit-bound feedback over imported localization units", () => {
  beforeAll(() => {
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 17).toString("base64");
  });

  it("persists a play flag and reads it back only through the same imported bridge unit", async () => {
    const context = await isolatedMigratedContext();
    try {
      await provisionDraftJobFixtureProject(context.db, localActor);
      const server = createItotoriServer({ databaseUrl: context.databaseUrl });
      servers.push(server);
      const origin = await listen(server);

      const write = await fetch(
        `${origin}/api/projects/${draftJobFixtureProjectId}/locale-branches/${draftJobFixtureLocaleBranchId}/flags`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bridgeUnitId,
            sceneId,
            note,
            severity: "warning",
          }),
        },
      );
      const receipt = (await write.json()) as Record<string, unknown>;
      expect(write.status).toBe(200);
      expect(receipt).toMatchObject({
        projectId: draftJobFixtureProjectId,
        localeBranchId: draftJobFixtureLocaleBranchId,
        note,
        severity: "warning",
        category: null,
      });

      const read = await fetch(
        `${origin}/api/projects/${draftJobFixtureProjectId}/locale-branches/${draftJobFixtureLocaleBranchId}/unit-feedback?bridgeUnitId=${bridgeUnitId}`,
      );
      const body = (await read.json()) as {
        bridgeUnitId: string;
        notes: Array<Record<string, unknown>>;
      };
      expect(read.status).toBe(200);
      expect(body.bridgeUnitId).toBe(bridgeUnitId);
      expect(body.notes).toEqual([
        expect.objectContaining({
          bridgeUnitId,
          sceneId,
          note,
          severity: "warning",
          category: null,
        }),
      ]);

      const otherRead = await fetch(
        `${origin}/api/projects/${draftJobFixtureProjectId}/locale-branches/${draftJobFixtureLocaleBranchId}/unit-feedback?bridgeUnitId=${otherBridgeUnitId}`,
      );
      expect((await otherRead.json()) as { notes: unknown[] }).toMatchObject({ notes: [] });
    } finally {
      await context.close();
    }
  });
});

async function listen(server: ReturnType<typeof createItotoriServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unit feedback proof server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}
