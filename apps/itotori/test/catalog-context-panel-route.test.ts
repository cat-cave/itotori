// @vitest-environment jsdom
import { createHash } from "node:crypto";
import {
  EngineCapabilityReportRepository,
  ItotoriCatalogRepository,
  bootstrapLocalUser,
  catalogConfidenceValues,
  catalogDemandFactKindValues,
  catalogEngineSourceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogPathRedactionClassValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  localUserId,
  type AuthorizationActor,
  type LocaleBranchStatus,
  type ProjectDashboardStatus,
} from "@itotori/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  handleReadOnlyItotoriApiRequest,
  type ItotoriReadOnlyApiServices,
} from "../src/api-handlers.js";
import {
  parseCatalogContextPanelRoute,
  renderCatalogContextPanelRoute,
} from "../src/catalog-context-panel-route.js";
import { costReportFixture } from "./api-fixtures.js";
import type { ApiCatalogContextPanelResponse } from "../src/api-schema.js";

const localActor: AuthorizationActor = { userId: localUserId };
const projectId = "project-catalog-context";
const localeBranchId = "locale-catalog-context-en";
const workId = "019ed119-0000-7000-8000-000000000119";
const releaseId = "019ed119-0000-7000-8000-000000000120";
const aliasReleaseId = "019ed119-0000-7000-8000-000000000121";
const provenanceId = "019ed119-0000-7000-8000-000000000122";
const fetchedAt = "2026-07-09T12:00:00.000Z";

const localeBranch: LocaleBranchStatus = {
  localeBranchId,
  targetLocale: "en-US",
  status: "in_progress",
  currentStyleGuidePolicyVersionId: null,
  unitCount: 12,
  translatedUnitCount: 3,
  openFindingCount: 1,
  artifactCount: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog context panel route", () => {
  it("parses the live dashboard route", () => {
    expect(
      parseCatalogContextPanelRoute(
        `/projects/${projectId}/locale-branches/${localeBranchId}/catalog-context/${workId}`,
      ),
    ).toEqual({ projectId, localeBranchId, workId });
    expect(parseCatalogContextPanelRoute("/catalog-context")).toBeNull();
  });

  it("fetches the read model and dispatches renderCatalogContextPanel", async () => {
    const body = apiReadModelFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    const root = document.createElement("div");

    await renderCatalogContextPanelRoute(root, { projectId, localeBranchId, workId });

    expect(fetch).toHaveBeenCalledWith(
      `/api/projects/${projectId}/locale-branches/${localeBranchId}/catalog-context/${workId}`,
    );
    expect(root.querySelector('[data-state="catalog-context-ready"]')).not.toBeNull();
    expect(root.textContent).toContain("Route wiring fixture");
    expect(root.textContent).toContain("Route wiring fixture Deluxe");
    expect(root.textContent).toContain("en-US");
    expect(root.textContent).toContain("3/12");
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "serves the panel read model from real catalog DB queries for a work and target branch",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        await bootstrapLocalUser(context.db);
        const repo = new ItotoriCatalogRepository(context.db);
        const capabilities = new EngineCapabilityReportRepository(context.db);
        await capabilities.writeMatrix(localActor, {
          adapterId: "rpg-maker-mv",
          identify: { kind: "supported" },
          inventory: { kind: "supported" },
          extract: { kind: "supported" },
          patch: { kind: "partial", limitations: ["manual archive rebuild"] },
        });
        await seedCatalogContextWork(repo);

        const response = await handleReadOnlyItotoriApiRequest(
          {
            method: "GET",
            pathname: `/api/projects/${projectId}/locale-branches/${localeBranchId}/catalog-context/${workId}`,
          },
          readOnlyServices(repo),
        );

        expect(response.statusCode).toBe(200);
        const body = response.body as ApiCatalogContextPanelResponse;
        expect(body.schemaVersion).toBe("catalog.context_panel_route.v0.1");
        expect(body.params).toEqual({ projectId, localeBranchId, workId });
        expect(body.row).toMatchObject({
          workId,
          canonicalTitle: "Route wiring fixture",
          completenessPool: "no_english",
          localOwnership: "owned",
          demandBucket: "high",
          readiness: {
            adapterId: "rpg-maker-mv",
            identify: "supported",
            inventory: "supported",
            extract: "supported",
            patch: "partial",
          },
        });
        expect(body.releases.map((release) => release.releaseTitle)).toEqual([
          "Route wiring fixture",
          "Route wiring fixture Deluxe",
        ]);
        expect(body.projectState.localeBranch).toEqual(localeBranch);
      } finally {
        await context.close();
      }
    },
  );
});

function readOnlyServices(repo: ItotoriCatalogRepository): ItotoriReadOnlyApiServices {
  const dashboard = dashboardStatusFixture();
  return {
    projectWorkflow: {
      listLocaleBranchIdentities: async () => [
        {
          projectId,
          localeBranchId,
          sourceBundleId: "source-bundle-catalog-context",
          sourceBundleRevisionId: "source-revision-catalog-context",
          sourceLocale: "ja-JP",
          targetLocale: localeBranch.targetLocale,
          branchName: "English",
          status: localeBranch.status,
        },
      ],
      getDashboardStatus: async () => dashboard,
    },
    catalogRepository: {
      catalogContextPanelForWork: (input) => repo.catalogContextPanelForWork(localActor, input),
    },
  } as unknown as ItotoriReadOnlyApiServices;
}

async function seedCatalogContextWork(repo: ItotoriCatalogRepository): Promise<void> {
  const provenance = await repo.recordSourceProvenance(localActor, {
    sourceProvenanceId: provenanceId,
    catalogSource: catalogSourceValues.dlsite,
    sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
    sourceId: "RJROUTE119",
    sourceVersion: "route-context-fixture-v1",
    requestId: "fixture:catalog-context-panel-route",
    httpStatus: 200,
    ok: true,
    payloadHash: hash("catalog-context-panel-route"),
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
    payload: { sourceId: "RJROUTE119" },
    fetchedAt,
    metadata: { fixtureId: "catalog-context-panel-route" },
  });
  await repo.upsertWork(localActor, {
    workId,
    canonicalTitle: "Route wiring fixture",
    originalLanguage: "ja-JP",
    engine: {
      engineName: "rpg-maker-mv",
      engineSource: catalogEngineSourceValues.manual,
      engineConfidence: catalogConfidenceValues.high,
      engineProvenanceId: provenance.sourceProvenanceId,
    },
    externalIds: [
      {
        externalIdId: "019ed119-0000-7000-8000-000000000123",
        catalogSource: catalogSourceValues.dlsite,
        sourceId: "RJROUTE119",
        externalIdKind: catalogExternalIdKindValues.storeProduct,
        sourceProvenanceId: provenance.sourceProvenanceId,
        confidence: catalogConfidenceValues.high,
      },
    ],
    releases: [
      releaseFixture(releaseId, "Route wiring fixture", null),
      releaseFixture(aliasReleaseId, "Route wiring fixture Deluxe", "Deluxe"),
    ],
    languageStatuses: [
      {
        languageStatusId: "019ed119-0000-7000-8000-000000000124",
        language: "en-US",
        status: catalogLanguageStatusValues.none,
        sourceProvenanceId: provenance.sourceProvenanceId,
        confidence: catalogConfidenceValues.high,
        observedAt: fetchedAt,
        importedAt: fetchedAt,
        parserVersion: "catalog-context-panel-route.v0.1",
        rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
      },
    ],
    demandFacts: [
      {
        demandFactId: "019ed119-0000-7000-8000-000000000125",
        catalogSource: catalogSourceValues.dlsite,
        sourceId: "RJROUTE119",
        factKind: catalogDemandFactKindValues.dlCount,
        factValue: { count: 3_500 },
        sourceProvenanceId: provenance.sourceProvenanceId,
        observedAt: fetchedAt,
        parserVersion: "catalog-context-panel-route.v0.1",
      },
    ],
  });
  await repo.recordLocalScan(localActor, {
    localScanId: "019ed119-0000-7000-8000-000000000126",
    scanRootLabel: "catalog context route local fixture",
    scanRootPathHash: hash("/private/catalog-context-route"),
    scannerName: "catalog-context-panel-route-test",
    scannerVersion: "0.0.0",
    startedAt: fetchedAt,
    completedAt: "2026-07-09T12:05:00.000Z",
    entries: [
      {
        localScanEntryId: "019ed119-0000-7000-8000-000000000127",
        workId,
        pathHash: hash("/private/catalog-context-route/story.ks"),
        pathRedactionClass: catalogPathRedactionClassValues.privatePathHash,
        owned: true,
        engineName: "rpg-maker-mv",
        engineSource: catalogEngineSourceValues.localScan,
        engineConfidence: catalogConfidenceValues.high,
        sourceProvenanceId: provenance.sourceProvenanceId,
      },
    ],
  });
}

function releaseFixture(
  id: string,
  releaseTitle: string,
  editionName: string | null,
): NonNullable<Parameters<ItotoriCatalogRepository["upsertWork"]>[1]["releases"]>[number] {
  return {
    releaseId: id,
    catalogSource: catalogSourceValues.dlsite,
    sourceReleaseId: id,
    releaseTitle,
    releaseKind: catalogReleaseKindValues.original,
    editionName,
    packageKind: "loose_files",
    platform: "windows",
    language: "ja-JP",
    releaseDate: "2024-05-01",
    releaseYear: 2024,
    isOfficial: true,
    sourceProvenanceId: provenanceId,
  };
}

function apiReadModelFixture(): ApiCatalogContextPanelResponse {
  const now = "2026-07-09T12:00:00.000Z";
  return {
    schemaVersion: "catalog.context_panel_route.v0.1",
    generatedAt: now,
    params: { projectId, localeBranchId, workId },
    row: {
      workId,
      canonicalTitle: "Route wiring fixture",
      originalLanguage: "ja-JP",
      sourceIds: [
        {
          catalogSource: "dlsite",
          sourceId: "RJROUTE119",
          externalIdKind: "store_product",
        },
      ],
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
        adapterId: "rpg-maker-mv",
        identify: "supported",
        inventory: "supported",
        extract: "supported",
        patch: "partial",
        helper: "unknown",
        runtime: "unknown",
      },
      provenance: [],
      decision: "seed",
      rank: 1,
      seedRank: 1,
      explanationCodes: [],
    },
    releases: [
      releaseRecordFixture(releaseId, "Route wiring fixture", null, now),
      releaseRecordFixture(aliasReleaseId, "Route wiring fixture Deluxe", "Deluxe", now),
    ],
    projectState: {
      targetLanguage: "en-US",
      localeBranch,
    },
  } as unknown as ApiCatalogContextPanelResponse;
}

function releaseRecordFixture(
  id: string,
  releaseTitle: string,
  editionName: string | null,
  now: string,
): Record<string, unknown> {
  return {
    releaseId: id,
    workId,
    catalogSource: "dlsite",
    sourceReleaseId: id,
    releaseTitle,
    releaseKind: "original",
    editionName,
    milestone: null,
    packageKind: "loose_files",
    engineName: null,
    engineSource: null,
    engineConfidence: null,
    engineProvenanceId: null,
    platform: "windows",
    language: "ja-JP",
    releaseDate: "2024-05-01",
    releaseYear: 2024,
    isOfficial: true,
    sourceProvenanceId: provenanceId,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function dashboardStatusFixture(): ProjectDashboardStatus {
  return {
    projectId,
    projectKey: projectId,
    name: projectId,
    status: "runtime_ingested",
    sourceLocale: "ja-JP",
    sourceBundleId: "source-bundle-catalog-context",
    sourceBundleHash: "source-hash-catalog-context",
    sourceBundleRevisionId: "source-revision-catalog-context",
    branchCount: 1,
    unitCount: localeBranch.unitCount,
    findingCount: localeBranch.openFindingCount,
    artifactCount: localeBranch.artifactCount,
    latestEventKind: "patch_result_recorded",
    latestEventAt: "2026-07-09T12:00:00.000Z",
    selectedLocaleBranchId: localeBranch.localeBranchId,
    currentStyleGuidePolicyVersionId: null,
    importStatus: null,
    cost: { ...costReportFixture, projectId },
    localeBranches: [localeBranch],
  };
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
