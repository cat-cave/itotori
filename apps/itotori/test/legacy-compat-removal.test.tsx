// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { App } from "../src/ui/App.js";
import { grantedStudioCapabilityView } from "../src/ui/caps-context.js";
import { authIdentityFixture } from "./api-fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installEmptyAssetDecisionsFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : input.toString();
    const url = new URL(rawUrl, "http://itotori.test");
    const body =
      url.pathname === "/api/auth/identity"
        ? authIdentityFixture
        : url.pathname.endsWith("/catalog-context/work-1")
          ? catalogContextResponse
          : { decisions: [] };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
}

const catalogContextResponse = {
  schemaVersion: "catalog.context_panel_route.v0.1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  params: { projectId: "project-1", localeBranchId: "locale-1", workId: "work-1" },
  row: {
    workId: "work-1",
    canonicalTitle: "Fixture work",
    originalLanguage: "ja",
    sourceIds: [{ catalogSource: "vndb", sourceId: "v1", externalIdKind: "source_record" }],
    completenessPool: "no_english",
    translationStatuses: [
      {
        language: "en-US",
        status: "none",
        confidence: "high",
        statusScope: "work",
        platform: null,
      },
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
  },
  releases: [
    {
      releaseId: "release-1",
      workId: "work-1",
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  projectState: {
    targetLanguage: "en-US",
    localeBranch: {
      localeBranchId: "locale-1",
      targetLocale: "en-US",
      status: "in_progress",
      currentStyleGuidePolicyVersionId: null,
      unitCount: 2,
      translatedUnitCount: 1,
      openFindingCount: 0,
      artifactCount: 1,
    },
  },
};

describe("removed HTML route bridge", () => {
  it("renders the asset-decisions SPA screen through the typed API client", async () => {
    installEmptyAssetDecisionsFetch();
    render(
      <App
        location={{
          pathname: "/projects/project-1/locale-branches/locale-1/asset-decisions",
          search: "",
        }}
        caps={grantedStudioCapabilityView()}
        navigate={() => {}}
      />,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-screen", "asset-decisions");
    expect(
      await screen.findByText("No active asset decisions were returned by the API."),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-legacy-route]")).toBeNull();
  });

  it("renders catalog context from its typed API route without an HTML renderer", async () => {
    installEmptyAssetDecisionsFetch();
    render(
      <App
        location={{
          pathname: "/projects/project-1/locale-branches/locale-1/catalog-context/work-1",
          search: "",
        }}
        caps={grantedStudioCapabilityView()}
        navigate={() => {}}
      />,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-screen", "catalog-context");
    expect(await screen.findByText("Fixture work")).toBeInTheDocument();
    expect(document.querySelector("[data-legacy-route]")).toBeNull();
  });
});
