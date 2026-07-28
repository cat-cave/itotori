// Real HTTP + Postgres proof for the user-facing play flag loop. The unit is
// first imported from a localization bridge, so its bridgeUnitId is the
// pipeline identity protected by the source-unit foreign key -- not a second
// feedback-only identifier.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "@itotori/db";
import { createSyntheticLargeBridgeBundle } from "../../../packages/localization-bridge-schema/src/synthetic-large-project.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { ItotoriProjectRepository } from "../../../packages/itotori-db/src/repositories/project-repository.js";
import { testProjectEngineFamilyRegistry } from "../../../packages/itotori-db/test/project-engine-family-registry.js";
import { createItotoriServer } from "../src/server.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const localActor: AuthorizationActor = { userId: localUserId };
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

  for (const engine of ["siglus", "softpal"] as const) {
    it(`persists a play flag against the imported ${engine} unit and producer scene only`, async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectId = `project-${engine}-addressable`;
        const localeBranchId = `locale-${engine}-addressable`;
        const bridge = createSyntheticLargeBridgeBundle({
          seed: `addressable-${engine}`,
          targetJapaneseCharacters: 1,
          assetCount: 1,
        });
        const bridgeUnitId = bridge.units[0]!.bridgeUnitId;
        const sceneId = bridge.units[0]!.context.route?.sceneId;
        expect(sceneId).toBeDefined();
        await new ItotoriProjectRepository(
          context.db,
          testProjectEngineFamilyRegistry,
        ).importSourceBundle(localActor, {
          projectId,
          engineFamily: engine,
          sourceRoot: "/fixture/source",
          buildRoot: "/fixture/build",
          extractProfile: { adapter: engine },
          localeBranchId,
          targetLocale: "en-US",
          drafts: {},
          bridge,
        });
        const server = createItotoriServer({ databaseUrl: context.databaseUrl });
        servers.push(server);
        const origin = await listen(server);

        const write = await fetch(
          `${origin}/api/projects/${projectId}/locale-branches/${localeBranchId}/flags`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              bridgeUnitId,
              sceneId: sceneId!,
              note,
              severity: "warning",
            }),
          },
        );
        const receipt = (await write.json()) as Record<string, unknown>;
        expect(write.status).toBe(200);
        expect(receipt).toMatchObject({
          projectId,
          localeBranchId,
          note,
          severity: "warning",
          category: null,
        });

        const read = await fetch(
          `${origin}/api/projects/${projectId}/locale-branches/${localeBranchId}/unit-feedback?bridgeUnitId=${bridgeUnitId}`,
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

        const resolved = await fetch(
          `${origin}/api/projects/${projectId}/locale-branches/${localeBranchId}/addressable-units/${bridgeUnitId}`,
        );
        expect(await resolved.json()).toMatchObject({
          unit: { state: "resolved", bridgeUnitId, sceneId },
        });
      } finally {
        await context.close();
      }
    });
  }
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
