import { describe, expect, it } from "vitest";
import { assertBrowserItotoriApiResponse } from "../src/api-client-guards.js";
import { assertItotoriApiResponse } from "../src/api-schema.js";
import { projectOverviewFixture } from "./api-fixtures.js";

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

  it("serves durable journal facts without retired source revision provenance", () => {
    expect(projectOverviewFixture.journal.rows).toEqual([
      expect.objectContaining({
        status: "completed",
        attemptedUnitCount: 2,
        finalizedUnitCount: 2,
        patchedUnitCount: 1,
        servedPairs: [{ model: "fixture-model", provider: "fixture-provider" }],
      }),
    ]);
    expect(() =>
      assertItotoriApiResponse("projects.overview", projectOverviewFixture),
    ).not.toThrow();
    expect(() =>
      assertItotoriApiResponse("projects.overview", {
        ...projectOverviewFixture,
        journal: {
          ...projectOverviewFixture.journal,
          rows: projectOverviewFixture.journal.rows.map((row) => ({
            ...row,
            sourceRevisionId: "retired-source-revision",
          })),
        },
      }),
    ).toThrow(
      "ProjectOverviewReadModel.journal.rows[0].sourceRevisionId is not part of the public API response",
    );
  });
});
