import { describe, expect, it } from "vitest";
import { assertBrowserItotoriApiResponse } from "../src/api-client-guards.js";

describe("browser API response guard", () => {
  it("rejects a WikiObject edit receipt that omits durable history and impact", () => {
    expect(() =>
      assertBrowserItotoriApiResponse("wiki.edit", {
        schemaVersion: "itotori.wiki.write.v1",
        receipt: {},
      }),
    ).toThrow("response for wiki.edit.history is required");
  });

  it("requires the bounded enhancement receipt on WikiObject apply", () => {
    expect(() =>
      assertBrowserItotoriApiResponse("wiki.apply", {
        schemaVersion: "itotori.wiki.apply.v1",
        history: [],
        dependencyImpact: {},
      }),
    ).toThrow("response for wiki.apply.receipt is required");
  });
});
