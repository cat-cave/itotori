import type {
  CostDrilldownPage,
  ProjectDashboardStatus,
  TerminologySearchReadModel,
} from "@itotori/db";
import type { ApiProjectsResponse } from "../src/api-schema.js";
import { costReportFixture } from "./api-fixtures-settings.js";

export const costDrilldownFixture: CostDrilldownPage = {
  filter: {
    projectId: "project-1",
    systemId: null,
    from: null,
    to: null,
  },
  pagination: {
    total: 3,
    limit: 20,
    offset: 0,
    page: 1,
    pageCount: 1,
    hasMore: false,
    nextOffset: null,
  },
  rows: [
    {
      providerRunId: "provider-run-billed",
      projectId: "project-1",
      systemId: "system-reallive",
      taskKind: "draft_translation",
      status: "succeeded",
      startedAt: "2026-06-17T00:02:00.000Z",
      cost: {
        state: "billed",
        amountMicrosUsd: 1200, // cost-audit-allow: synthetic fixture cost, not a real billed amount
        displayAmountUsd: "0.0012", // cost-audit-allow: synthetic fixture cost, not a real billed amount
      },
      provider: {
        providerId: "provider-abc",
        providerFamily: "openrouter",
        endpointFamily: "chat-completions",
        providerName: "openrouter",
        requestedModelId: "itotori-fake-draft-v0",
        actualModelId: "itotori-fake-draft-v0",
        upstreamProvider: "fixture-upstream",
        routeSettingsHash:
          "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        adapterMetadata: {
          providerRouting: { order: ["fixture-upstream"], allowFallbacks: false },
        },
      },
    },
    {
      providerRunId: "provider-run-zero",
      projectId: "project-1",
      systemId: "system-reallive",
      taskKind: "draft_translation",
      status: "failed",
      startedAt: "2026-06-17T00:01:00.000Z",
      cost: { state: "zero", amountMicrosUsd: 0, displayAmountUsd: "0" },
      provider: {
        providerId: "provider-abc",
        providerFamily: "fake",
        endpointFamily: "chat-completions",
        providerName: "itotori-fixture",
        requestedModelId: "itotori-fake-draft-v0",
        actualModelId: "itotori-fake-draft-v0",
        upstreamProvider: null,
        routeSettingsHash: null,
        adapterMetadata: {},
      },
    },
    {
      providerRunId: "provider-run-unknown",
      projectId: "project-1",
      systemId: "system-softpal",
      taskKind: "draft_translation",
      status: "succeeded",
      startedAt: "2026-06-17T00:00:00.000Z",
      cost: { state: "unknown" },
      provider: {
        providerId: "provider-def",
        providerFamily: "fake",
        endpointFamily: "chat-completions",
        providerName: "itotori-fixture",
        requestedModelId: "itotori-fake-draft-v0",
        actualModelId: "itotori-fake-draft-v0",
        upstreamProvider: null,
        routeSettingsHash: null,
        adapterMetadata: { providerRouting: { order: ["itotori-fixture"] } },
      },
    },
  ],
};

export const terminologySearchFixture: TerminologySearchReadModel = {
  query: "Hero",
  normalizedQuery: "hero",
  localeBranchId: "locale-1",
  results: [
    {
      score: 100,
      matchKinds: ["exact_source"],
      term: {
        termId: "term-hero",
        projectId: "project-1",
        localeBranchId: "locale-1",
        sourceTerm: "Hero",
        normalizedSourceTerm: "hero",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        preferredTranslation: "Hero",
        normalizedPreferredTranslation: "hero",
        termKind: "character_name",
        partOfSpeech: null,
        status: "active",
        caseSensitive: true,
        notes: null,
        metadata: {},
        createdByUserId: "local-user",
        createdAt: new Date("2026-06-18T00:00:00.000Z"),
        updatedAt: new Date("2026-06-18T00:00:00.000Z"),
        aliases: [
          {
            aliasId: "alias-hero",
            termId: "term-hero",
            aliasText: "勇者",
            normalizedAliasText: "勇者",
            aliasKind: "source_alias",
            locale: "ja-JP",
            metadata: {},
            createdAt: new Date("2026-06-18T00:00:00.000Z"),
          },
        ],
        sourceReferences: [
          {
            sourceRefId: "source-ref-hero",
            termId: "term-hero",
            sourceRevisionId: "source-revision-1",
            bridgeUnitId: "bridge-unit-1",
            sourceProvenanceId: null,
            referenceKind: "source_unit",
            citation: "hello.scene.001.line.001",
            context: "Speaker name",
            metadata: {},
            createdAt: new Date("2026-06-18T00:00:00.000Z"),
          },
        ],
        semanticIndex: {
          semanticIndexId: "semantic-hero",
          termId: "term-hero",
          searchDocument: "Hero\n勇者\nSpeaker name",
          searchTokens: ["hero", "勇者", "speaker", "name"],
          embeddingProvider: "itotori-lexical",
          embeddingModel: "terminology-lexical-token-index-v1",
          embeddingDimension: 0,
          embeddingVector: null,
          contentHash: "sha256:terminology-fixture",
          status: "indexed_lexical",
          metadata: {
            hookKind: "lexical_token_index",
            indexKind: "lexical_token_index",
            semanticReady: false,
            vectorReady: false,
          },
          refreshedAt: new Date("2026-06-18T00:00:00.000Z"),
          createdAt: new Date("2026-06-18T00:00:00.000Z"),
          updatedAt: new Date("2026-06-18T00:00:00.000Z"),
        },
      },
    },
  ],
};

export const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-1",
  projectKey: "project-1",
  name: "project-1",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
  engineFamily: "synthetic_fixture",
  sourceBundleId: "bridge-1",
  sourceBundleHash: "hash-1",
  sourceBundleRevisionId: "revision-1",
  branchCount: 2,
  unitCount: 1,
  findingCount: 3,
  artifactCount: 3,
  latestEventKind: "patch_result_recorded",
  latestEventAt: "2026-06-17T00:00:00.000Z",
  selectedLocaleBranchId: "019ed065-0000-7000-8000-000000000110",
  currentStyleGuidePolicyVersionId: "019ed065-0000-7000-8000-000000000120",
  importStatus: {
    bridgeImportId: "bridge-import:project-1:bridge-1:revision-1",
    projectId: "project-1",
    bridgeId: "bridge-1",
    sourceBundleId: "bridge-1",
    sourceBundleHash: "hash-1",
    sourceBundleRevisionId: "revision-1",
    schemaVersion: "0.1.0",
    sourceLocale: "ja-JP",
    importedAt: "2026-06-17T00:00:00.000Z",
    unitCount: 1,
    assetCount: 1,
    sourceRevisionCount: 4,
    validationFailureCount: 0,
    units: { added: 1, updated: 0, removed: 0, unchanged: 0 },
    assets: { added: 1, updated: 0, removed: 0, unchanged: 0 },
    sourceRevisions: { added: 4, existing: 0 },
    futureReferences: {
      catalogWorkId: null,
      localCorpusEntryId: null,
      readinessProfileId: null,
      completenessStatusId: null,
    },
  },
  cost: costReportFixture,
  localeBranches: [
    {
      localeBranchId: "locale-1",
      targetLocale: "en-US",
      status: "active",
      currentStyleGuidePolicyVersionId: null,
      unitCount: 1,
      translatedUnitCount: 1,
      openFindingCount: 1,
      artifactCount: 3,
    },
    {
      localeBranchId: "019ed065-0000-7000-8000-000000000110",
      targetLocale: "fr-FR",
      status: "active",
      currentStyleGuidePolicyVersionId: "019ed065-0000-7000-8000-000000000120",
      unitCount: 1,
      translatedUnitCount: 1,
      openFindingCount: 0,
      artifactCount: 1,
    },
  ],
};

const emptyRunStatusCounts = {
  queued: 0,
  running: 0,
  paused: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
} as const;

const emptyUnitCounts = {
  decoded: 0,
  drafted: 0,
  QA: 0,
  accepted: 0,
  patched: 0,
} as const;

/**
 * Three concurrent portfolio projects (distinct progress rollups) plus a
 * run-less project for the empty-state card. Identity is generic fixture data
 * — no game titles. Consumed by the portfolio progress UI tests + MSW/e2e.
 */
export const portfolioProjectsFixture: ApiProjectsResponse = {
  projects: [
    {
      ...dashboardStatusFixture,
      projectId: "project-1",
      projectKey: "project-alpha",
      name: "project-alpha",
      engineFamily: "reallive",
      progress: {
        projectId: "project-1",
        runCount: 1,
        runStatusCounts: {
          ...emptyRunStatusCounts,
          queued: 1,
        },
        unitCounts: { decoded: 0, drafted: 1, QA: 0, accepted: 0, patched: 0 },
        roleCounts: {
          writer: { decoded: 0, drafted: 1, QA: 0, accepted: 0, patched: 0 },
        },
        totalCostMicrosUsd: 13,
        averageCoveragePercent: 75,
        blockers: [
          {
            runId: "portfolio-run-1",
            bridgeUnitId: "portfolio-unit-1",
            role: "writer",
            blockers: ["review-needed"],
          },
        ],
      },
    },
    {
      ...dashboardStatusFixture,
      projectId: "project-2",
      projectKey: "project-beta",
      name: "project-beta",
      status: "drafting",
      engineFamily: "siglus",
      findingCount: 0,
      progress: {
        projectId: "project-2",
        runCount: 2,
        runStatusCounts: {
          ...emptyRunStatusCounts,
          running: 1,
          completed: 1,
        },
        unitCounts: { decoded: 1, drafted: 0, QA: 1, accepted: 2, patched: 0 },
        roleCounts: {
          writer: { decoded: 1, drafted: 0, QA: 0, accepted: 1, patched: 0 },
          reviewer: { decoded: 0, drafted: 0, QA: 1, accepted: 1, patched: 0 },
        },
        totalCostMicrosUsd: 42_000,
        averageCoveragePercent: 55,
        blockers: [],
      },
    },
    {
      ...dashboardStatusFixture,
      projectId: "project-3",
      projectKey: "project-gamma",
      name: "project-gamma",
      status: "runtime_ingested",
      engineFamily: "kiri_kiri_xp3",
      findingCount: 1,
      progress: {
        projectId: "project-3",
        runCount: 1,
        runStatusCounts: {
          ...emptyRunStatusCounts,
          completed: 1,
        },
        unitCounts: { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 3 },
        roleCounts: {
          patcher: { decoded: 0, drafted: 0, QA: 0, accepted: 0, patched: 3 },
        },
        totalCostMicrosUsd: 17,
        averageCoveragePercent: 100,
        blockers: [
          {
            runId: "portfolio-run-3",
            bridgeUnitId: "portfolio-unit-3",
            role: "patcher",
            blockers: ["awaiting-check"],
          },
        ],
      },
    },
    {
      ...dashboardStatusFixture,
      projectId: "project-4",
      projectKey: "project-idle",
      name: "project-idle",
      status: "pending",
      engineFamily: null,
      branchCount: 0,
      unitCount: 0,
      findingCount: 0,
      artifactCount: 0,
      latestEventKind: null,
      latestEventAt: null,
      selectedLocaleBranchId: null,
      localeBranches: [],
      progress: {
        projectId: "project-4",
        runCount: 0,
        runStatusCounts: { ...emptyRunStatusCounts },
        unitCounts: { ...emptyUnitCounts },
        roleCounts: {},
        totalCostMicrosUsd: 0,
        averageCoveragePercent: 0,
        blockers: [],
      },
    },
  ],
};

export const portfolioProjectFixture = portfolioProjectsFixture.projects[0]!;

/** Three concurrent projects only (no run-less row) — pure progress surface. */
export const portfolioLiveProjectsFixture: ApiProjectsResponse = {
  projects: portfolioProjectsFixture.projects.slice(0, 3),
};

/** Single run-less project for the empty progress card path. */
export const portfolioRunlessProjectsFixture: ApiProjectsResponse = {
  projects: [portfolioProjectsFixture.projects[3]!],
};
