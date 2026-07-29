import { describe, expect, it } from "vitest";
import {
  runCatalogFuzzyCandidates,
  runCatalogLinkExact,
  runCatalogResolveFixture,
} from "../src/cli-handler-catalog-commands.js";
import type { ItotoriCliDependencies } from "../src/cli-handler-contracts.js";

describe("catalog CLI input validation", () => {
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
