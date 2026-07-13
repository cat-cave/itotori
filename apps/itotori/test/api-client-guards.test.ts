import { describe, expect, it } from "vitest";
import { assertBrowserItotoriApiResponse } from "../src/api-client-guards.js";

describe("browser API response guard", () => {
  it("rejects a wiki edit receipt that omits the rerun outcome", () => {
    expect(() =>
      assertBrowserItotoriApiResponse("wiki.edit", {
        schemaVersion: "wiki.context.edit.v0.2",
        contextEntryVersionId: "context-version-1",
        entry: {},
      }),
    ).toThrow("response for wiki.edit.rerun is required");
  });

  it("requires the rerun outcome for newly added wiki context too", () => {
    expect(() =>
      assertBrowserItotoriApiResponse("wiki.add", {
        schemaVersion: "wiki.context.edit.v0.2",
        contextEntryVersionId: "context-version-1",
        entry: {},
      }),
    ).toThrow("response for wiki.add.rerun is required");
  });
});
