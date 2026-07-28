// Real HTTP + Postgres proof for the user-facing play flag loop. The unit is
// first imported from a localization bridge, so its bridgeUnitId is the
// pipeline identity protected by the source-unit foreign key -- not a second
// feedback-only identifier.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "@itotori/db";
import {
  assertBridgeBundle,
  type BridgeBundle,
} from "../../../packages/localization-bridge-schema/src/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { ItotoriProjectRepository } from "../../../packages/itotori-db/src/repositories/project-repository.js";
import { testProjectEngineFamilyRegistry } from "../../../packages/itotori-db/test/project-engine-family-registry.js";
import { createItotoriServer } from "../src/server.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const localActor: AuthorizationActor = { userId: localUserId };
const note = "The branch reaches this line with the wrong speaker.";
const servers: ReturnType<typeof createItotoriServer>[] = [];

// Fixed wire-format excerpts from the native producer regression vectors:
// kaifuu-siglus emits the declared Scene.pck SceneList id, while kaifuu-softpal
// emits the sole decoded SCRIPT.SRC structure scene.  These are deliberately
// bridge *outputs*, not fixtures that provision a route coordinate after the
// fact.  The Rust producer tests named below derive and assert those values
// from decoded source bytes; this HTTP test only imports what a producer gave
// it and proves the dashboard-facing ledger loop.
const producerBridgeByEngine = {
  siglus: {
    schemaVersion: "0.1.0",
    bridgeId: "siglus-producer-scene-0007",
    sourceBundleHash: "siglus-decoded-scene-pck",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-siglus",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "siglus-producer-unit-0007-0028",
        sourceUnitKey: "siglus:scene-opening#28",
        occurrenceId: "siglus:scene-opening#28",
        sourceHash: "siglus-decoded-text-0028",
        sourceLocale: "ja-JP",
        sourceText: "decoded Siglus line",
        speaker: "",
        textSurface: "dialogue",
        protectedSpans: [],
        context: { route: { sceneId: "siglus:scene-0007" } },
        patchRef: {
          assetId: "siglus:scene-opening",
          writeMode: "replace",
          sourceUnitKey: "siglus:scene-opening#28",
        },
      },
    ],
  },
  softpal: {
    schemaVersion: "0.1.0",
    bridgeId: "softpal-producer-script-src",
    sourceBundleHash: "softpal-decoded-script-src",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-softpal",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "softpal-producer-unit-0016",
        sourceUnitKey: "softpal:dialogue:16",
        occurrenceId: "softpal:dialogue:16",
        sourceHash: "softpal-decoded-text-0016",
        sourceLocale: "ja-JP",
        sourceText: "decoded Softpal line",
        speaker: "decoded speaker",
        textSurface: "dialogue",
        protectedSpans: [],
        context: { route: { sceneId: "scene:script-src" } },
        patchRef: {
          assetId: "softpal:SCRIPT.SRC",
          writeMode: "replace",
          sourceUnitKey: "softpal:dialogue:16",
        },
      },
    ],
  },
} as const;

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
        const bridge = producerBridge(engine);
        assertBridgeBundle(bridge);
        const bridgeUnitId = bridge.units[0]!.bridgeUnitId;
        const sceneId = bridge.units[0]!.context.route.sceneId;
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
              sceneId,
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

function producerBridge(engine: "siglus" | "softpal"): BridgeBundle {
  // structuredClone keeps the fixture immutable across the two real database
  // imports; neither this test nor its setup adds or repairs context.route.
  return structuredClone(producerBridgeByEngine[engine]) as unknown as BridgeBundle;
}
