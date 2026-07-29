import { describe, expect, it } from "vitest";
import { interpolateRoutePath } from "../src/api-routes.js";
import {
  runCatalogFuzzyCandidates,
  runCatalogLinkExact,
  runCatalogResolveFixture,
} from "../src/cli-handler-catalog-commands.js";
import type { ItotoriCliDependencies } from "../src/cli-handler-contracts.js";
import {
  createOpenRouterGenerationLookup,
  GenerationMetadataLookupError,
} from "../src/llm/generation-metadata.js";

describe("audit boundary hardening", () => {
  it.each([
    [
      "catalog link exact",
      runCatalogLinkExact,
      ["--request", "input.json", "--output", "out.json"],
    ],
    [
      "catalog fuzzy candidates",
      runCatalogFuzzyCandidates,
      ["--request", "input.json", "--output", "out.json"],
    ],
    ["catalog resolver fixture", runCatalogResolveFixture, ["--fixture", "input.json"]],
  ])(
    "rejects malformed JSON before %s reaches an internal operation",
    async (_name, handler, args) => {
      await expect(handler(args, dependenciesReading(null))).rejects.toThrow(
        /Catalog(ExactExternalIdLinkRequest|FuzzyCandidateRequest|ResolverFixtureInput) payload must be an object/u,
      );
    },
  );

  it("encodes reserved characters in a route path parameter", () => {
    expect(
      interpolateRoutePath("catalog.contextPanel", {
        projectId: "project/a?b#c",
        localeBranchId: "l",
        workId: "w",
      }),
    ).toBe("/api/projects/project%2Fa%3Fb%23c/locale-branches/l/catalog-context/w");
  });

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
});

function dependenciesReading(value: unknown): ItotoriCliDependencies {
  return {
    io: {
      readJson: () => value,
      writeJson: () => {
        throw new Error("malformed input reached output writing");
      },
    },
    migrateDatabase: async () => undefined,
    resetDatabase: async () => undefined,
    withServices: async () => {
      throw new Error("malformed input reached an internal operation");
    },
  };
}
