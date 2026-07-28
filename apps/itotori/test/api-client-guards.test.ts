import { describe, expect, it } from "vitest";
import type {
  CatalogBenchmarkSeedRow,
  CatalogReleaseRecord,
  LocaleBranchStatus,
} from "@itotori/db";
import { assertBrowserItotoriApiResponse } from "../src/api-client-guards.js";
import { assertItotoriApiResponse } from "../src/api-schema.js";
import { projectOverviewFixture } from "./api-fixtures.js";

type CatalogContextPanelResponseJson = {
  schemaVersion: "catalog.context_panel_route.v0.1";
  generatedAt: string;
  params: { projectId: string; localeBranchId: string; workId: string };
  row: CatalogBenchmarkSeedRow;
  releases: Array<
    Omit<CatalogReleaseRecord, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string }
  >;
  projectState: { targetLanguage: string; localeBranch: LocaleBranchStatus | null };
};

const row: CatalogBenchmarkSeedRow = {
  workId: "work-1",
  canonicalTitle: "Fixture work",
  originalLanguage: "ja",
  sourceIds: [{ catalogSource: "vndb", sourceId: "v1", externalIdKind: "source_record" }],
  completenessPool: "no_english",
  translationStatuses: [
    { language: "en-US", status: "none", confidence: "high", statusScope: "work", platform: null },
  ],
  localOwnership: "owned",
  localEvidenceCount: 1,
  demandBucket: "high",
  readiness: {
    adapterId: "fixture-adapter",
    identify: "supported",
    inventory: "supported",
    extract: "supported",
    patch: "partial",
    helper: "unknown",
    runtime: "unsupported",
  },
  provenance: [],
  decision: "seed",
  rank: 1,
  seedRank: 1,
  explanationCodes: ["fixture"],
};

const release: CatalogReleaseRecord = {
  releaseId: "release-1",
  workId: row.workId,
  catalogSource: "vndb",
  sourceReleaseId: null,
  releaseTitle: "Fixture work",
  releaseKind: "original",
  editionName: null,
  milestone: null,
  packageKind: "loose_files",
  engineName: null,
  engineSource: null,
  engineConfidence: null,
  engineProvenanceId: null,
  platform: "windows",
  language: "ja",
  releaseDate: "2026-01-01",
  releaseYear: 2026,
  isOfficial: true,
  sourceProvenanceId: null,
  metadata: {},
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const localeBranch: LocaleBranchStatus = {
  localeBranchId: "branch-1",
  targetLocale: "en-US",
  status: "in_progress",
  currentStyleGuidePolicyVersionId: null,
  unitCount: 2,
  translatedUnitCount: 1,
  openFindingCount: 0,
  artifactCount: 1,
};

function catalogContextPanelResponse(): CatalogContextPanelResponseJson {
  return {
    schemaVersion: "catalog.context_panel_route.v0.1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    params: {
      projectId: "project-1",
      localeBranchId: localeBranch.localeBranchId,
      workId: row.workId,
    },
    row,
    releases: [
      {
        ...release,
        createdAt: release.createdAt.toISOString(),
        updatedAt: release.updatedAt.toISOString(),
      },
    ],
    projectState: { targetLanguage: "en-US", localeBranch },
  };
}

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

  it("rejects malformed nested catalog row, release, and project-state payloads", () => {
    const valid = catalogContextPanelResponse();
    const rowMalformed = { ...valid, row: { ...valid.row, rank: "first" } };
    expect(() => assertBrowserItotoriApiResponse("catalog.contextPanel", rowMalformed)).toThrow(
      "catalog.contextPanel.row.rank must be a non-negative integer",
    );

    const firstRelease = valid.releases[0];
    if (firstRelease === undefined) throw new Error("fixture release is missing");
    const releaseMalformed = { ...valid, releases: [{ ...firstRelease, isOfficial: "yes" }] };
    expect(() => assertBrowserItotoriApiResponse("catalog.contextPanel", releaseMalformed)).toThrow(
      "catalog.contextPanel.releases[0].isOfficial must be a boolean",
    );

    const branch = valid.projectState.localeBranch;
    if (branch === null) {
      throw new Error("fixture locale branch is missing");
    }
    const stateMalformed = {
      ...valid,
      projectState: { ...valid.projectState, localeBranch: { ...branch, unitCount: -1 } },
    };
    expect(() => assertBrowserItotoriApiResponse("catalog.contextPanel", stateMalformed)).toThrow(
      "catalog.contextPanel.projectState.localeBranch.unitCount must be a non-negative integer",
    );
  });

  it("accepts a well-formed nested catalog context response", () => {
    expect(() =>
      assertBrowserItotoriApiResponse("catalog.contextPanel", catalogContextPanelResponse()),
    ).not.toThrow();
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
