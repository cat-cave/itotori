import { describe, expect, it } from "vitest";

import { assertFact } from "../src/services/catalog-recorded-importer-utils.js";

describe("catalog recorded importer fact validation", () => {
  it.each([
    ["source ID", { sourceId: " \t", canonicalTitle: "A valid title" }, "fact.sourceId"],
    [
      "canonical title",
      { sourceId: "valid-source-id", canonicalTitle: " \t" },
      "fact.canonicalTitle",
    ],
  ])("rejects a whitespace-only %s", (_field, fact, fieldName) => {
    expect(() => assertFact(fact)).toThrow(`${fieldName} is required`);
  });
});
