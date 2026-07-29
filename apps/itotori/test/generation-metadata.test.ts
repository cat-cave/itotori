import { expect, it } from "vitest";
import {
  createOpenRouterGenerationLookup,
  GenerationMetadataLookupError,
} from "../src/llm/generation-metadata.js";

it("surfaces generation lookup transport failures instead of reporting absent metadata", async () => {
  const failure = new Error("storage unavailable");
  const lookup = createOpenRouterGenerationLookup({
    apiKey: "test-key",
    fetcher: async () => {
      throw failure;
    },
  });

  const error = await lookup("generation:test").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(GenerationMetadataLookupError);
  if (!(error instanceof GenerationMetadataLookupError)) throw error;
  expect(error.cause).toBe(failure);
});

it("keeps a genuinely absent generation distinct from a lookup failure", async () => {
  const lookup = createOpenRouterGenerationLookup({
    apiKey: "test-key",
    fetcher: async () => new Response(null, { status: 404 }),
  });

  await expect(lookup("generation:absent")).resolves.toMatchObject({
    generationId: "generation:absent",
    served: { status: "unknown" },
  });
});
