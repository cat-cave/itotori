import { expect, it } from "vitest";
import type { AuthorizationActor } from "@itotori/db";

import {
  PatchbackProduceService,
  type LoadedProducePlan,
  type PatchbackProduceInputLoaderPort,
} from "../src/play/patchback-produce-service.js";

const actor = { userId: "produce-test", permissions: [] } as unknown as AuthorizationActor;

it("returns null (a clean 404) when the produce plan loader finds no eligible run", async () => {
  const loader: PatchbackProduceInputLoaderPort = {
    async load(): Promise<LoadedProducePlan | null> {
      return null;
    },
  };
  const service = new PatchbackProduceService({ loader });

  expect(await service.produceArchive(actor, { runId: "missing" })).toBeNull();
});
