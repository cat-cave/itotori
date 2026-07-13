import { readFileSync } from "node:fs";
import type {
  BenchmarkReportSummary,
  CatalogBenchmarkSeedFinderReadModel,
  CatalogCompletenessBenchmarkPools,
  CatalogConflictReviewReadModel,
  CatalogOpportunityRankingReadModel,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  JobsRunTableReadModel,
  ProjectCostReport,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
  TerminologySearchReadModel,
  WikiContextEntriesReadModel,
  WikiContextEntryHistoryReadModel,
  WikiContextEntryReadModel,
  WikiEntriesReadModel,
} from "@itotori/db";
import { summarizeQaAgents } from "../src/benchmark-report-summary.js";
import type {
  ApiAuthIdentityResponse,
  ApiWikiEditResponse,
  ApiLocalizationRunConfigResponse,
  ApiBranchPolicySettingsResponse,
  ApiDraftBranchRequest,
  ApiDraftBranchResponse,
  ApiErrorResponse,
  ApiProjectImportRequest,
  ApiProjectImportResponse,
  ApiRecordBenchmarkRequest,
  ApiRecordBenchmarkResponse,
  ApiRecordDecisionRequest,
  ApiRecordDecisionResponse,
  ApiRecordFindingRequest,
  ApiRecordFindingResponse,
  ApiRuntimeEvidenceRequest,
  ApiRuntimeEvidenceResponse,
  ApiModelRoutingSettingsResponse,
  ApiTranslationScopeSettingsResponse,
  ItotoriApiRouteId,
} from "../src/api-schema.js";
import type {
  BenchmarkReportV02,
  BridgeBundle,
  FindingRecordV02,
  RuntimeVerificationReport,
  TriageEventV02,
} from "@itotori/localization-bridge-schema";
import type { ProjectState, RuntimeIngestResult } from "../src/services/project-workflow.js";
import type { ProjectOverviewReadModel } from "../src/project-overview-read-model.js";
import type {
  BmkCockpitReadModel,
  BmkCockpitRunHistoryPage,
} from "../src/bmk-cockpit-read-model.js";

export const authIdentityFixture: ApiAuthIdentityResponse = {
  schemaVersion: "itotori.auth.identity.v0",
  actorUserId: "local-user",
  userId: "local-operator",
  principalId: "principal-local-operator",
  email: null,
  displayName: "Local operator",
  accounts: [
    {
      membershipId: "membership-local-operator",
      accountId: "account-local",
      accountSlug: "local",
      accountName: "Local workspace",
      permissionSetIds: ["permission-set-account-local-operator-all"],
      createdAt: "2026-07-08T00:00:00.000Z",
    },
  ],
};

export const costReportFixture: ProjectCostReport = {
  projectId: "project-1",
  currency: "USD",
  runCount: 2,
  billedMicrosUsd: 2180,
  zeroRunCount: 0,
  totalsByCostKind: [
    {
      costKind: "billed",
      runCount: 2,
      amountMicrosUsd: 2180, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      promptTokens: 22,
      completionTokens: 14,
      totalTokens: 36,
    },
    {
      costKind: "zero",
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  ],
  recentRuns: [
    {
      providerRunId: "provider-run-1",
      taskKind: "draft_translation",
      status: "succeeded",
      startedAt: "2026-06-17T00:00:00.000Z",
      structuredOutputMode: "json_schema",
      retryCount: 0,
      errorClasses: [],
      providerFamily: "fake",
      endpointFamily: "chat-completions",
      providerName: "itotori-fixture",
      requestedModelId: "itotori-fake-draft-v0",
      actualModelId: "itotori-fake-draft-v0",
      upstreamProvider: null,
      routeSettingsHash: null,
      promptPresetId: "itotori-draft-default-v1",
      promptTemplateVersion: "1.0.0",
      promptHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      fallbackUsed: false,
      fallbackPlan: ["itotori-fake-draft-v0"],
      costKind: "billed",
      amountMicrosUsd: 1200, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      tokenCountSource: "provider_reported",
      promptTokens: 12,
      completionTokens: 8,
      reasoningTokens: null,
      cachedInputTokens: null,
      totalTokens: 20,
      // ITOTORI-230 — fixture posture for a fake-provider draft run.
      // FakeModelProvider records the canonical localOnlyRoutingPosture
      // (zdr=true) since no data leaves the process.
      routingPosture: {
        order: ["itotori-fixture"],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
    },
    {
      providerRunId: "provider-run-2",
      taskKind: "benchmark_qa",
      status: "succeeded",
      startedAt: "2026-06-17T00:01:00.000Z",
      structuredOutputMode: "plain_json",
      retryCount: 1,
      errorClasses: ["provider_timeout_retry"],
      providerFamily: "openrouter",
      endpointFamily: "chat-completions",
      providerName: "openrouter",
      requestedModelId: "itotori-fake-qa-v0",
      actualModelId: "itotori-fake-qa-v1",
      upstreamProvider: "fixture-upstream",
      routeSettingsHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      promptPresetId: "itotori-benchmark-qa-v1",
      promptTemplateVersion: "1.0.0",
      promptHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      fallbackUsed: true,
      fallbackPlan: ["itotori-fake-qa-v0", "itotori-fake-qa-v1"],
      // ITOTORI-225 — was previously `provider_estimate`; the audited
      // run actually carried a real upstream charge captured from
      // `usage.cost`, so it correctly tags as `billed`.
      costKind: "billed",
      amountMicrosUsd: 980, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      tokenCountSource: "estimated",
      promptTokens: 10,
      completionTokens: 6,
      reasoningTokens: null,
      cachedInputTokens: null,
      totalTokens: 16,
      // ITOTORI-230 — fixture posture for an OR-routed benchmark-qa
      // run. Matches the canonical alpha shape from
      // docs/openrouter-integration-evidence/2026-06-25.json.
      routingPosture: {
        order: ["fixture-upstream"],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
    },
  ],
  translationMemoryReuse: {
    reuseEventCount: 1,
    appliedCount: 1,
    suggestedCount: 0,
    providerCallAvoidedCount: 1,
    estimatedPromptTokensSaved: 7,
    estimatedCompletionTokensSaved: 5,
    estimatedTotalTokensSaved: 12,
    estimatedCostUsdSaved: null,
    recentEvents: [
      {
        reuseEventId: "tm-reuse-1",
        localeBranchId: "locale-1",
        targetBridgeUnitId: "bridge-unit-repeat",
        memorySegmentId: "tm-memory-1",
        matchKind: "exact",
        matchScore: 1000,
        reuseStatus: "applied",
        sourceHash: "hash:repeat",
        candidateSourceHash: "hash:repeat",
        targetText: "Hello again.",
        providerCallAvoided: true,
        estimatedPromptTokensSaved: 7,
        estimatedCompletionTokensSaved: 5,
        estimatedTotalTokensSaved: 12,
        estimatedCostUsdSaved: null,
        calculation: "deterministic_character_estimate_v1",
        provenance: {
          requestId: "draft:project-1:locale-1:en-US",
          selectedMemorySegmentId: "tm-memory-1",
        },
        createdAt: "2026-06-17T00:02:00.000Z",
      },
    ],
  },
};

export const jobsRunTableFixture: JobsRunTableReadModel = {
  schemaVersion: "jobs.run_table.v0.2",
  generatedAt: "2026-07-07T00:00:00.000Z",
  filter: { projectId: "project-1" },
  pagination: {
    total: 1,
    limit: 20,
    offset: 0,
    page: 1,
    pageCount: 1,
    hasMore: false,
    nextOffset: null,
  },
  rows: [
    {
      runId: "provider-run-1",
      journalRunId: "journal-run-1",
      attemptId: "provider-run-1",
      providerRunId: "provider-run-1",
      bridgeUnitId: "bridge-unit-1",
      projectId: "project-1",
      localeBranchId: "locale-branch-1",
      task: "Draft translation",
      status: "succeeded",
      servedModel: "openai/gpt-4.1-mini",
      servedProvider: "openai",
      zdr: true,
      cost: { unit: "usd", amount: "0.00218000" },
      tokens: { in: 22, out: 14, total: 36 },
      fallback: {
        availability: "captured",
        used: false,
        plan: ["openai/gpt-4.1-mini"],
        chain: [],
      },
      createdAt: "2026-07-07T00:00:00.000Z",
    },
  ],
};

export const modelRoutingSettingsFixture: ApiModelRoutingSettingsResponse = {
  schemaVersion: "itotori.settings.model-routing.v0",
  projectId: "project-1",
  generatedAt: "2026-07-08T00:00:00.000Z",
  providers: [
    {
      providerId: "openrouter",
      providerFamily: "openrouter",
      endpointFamily: "chat-completions",
      providerName: "OpenRouter",
      metadata: { accountZdr: true },
    },
  ],
  models: [
    {
      modelRegistryId: "openrouter:anthropic/claude-3-5-sonnet",
      providerId: "openrouter",
      modelId: "anthropic/claude-3-5-sonnet",
      capabilities: { structuredOutput: true },
      pricing: { source: "fixture" },
    },
    {
      modelRegistryId: "openrouter:anthropic/claude-3-haiku",
      providerId: "openrouter",
      modelId: "anthropic/claude-3-haiku",
      capabilities: { structuredOutput: true },
      pricing: { source: "fixture" },
    },
  ],
  promptPresets: [
    {
      promptPresetId: "itotori-draft-default-v1",
      promptTemplateVersion: "1.0.0",
      presetSchemaVersion: "itotori.prompt-preset.v0",
      promptHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      configSnapshot: { template: "draft" },
    },
  ],
  routes: [
    {
      projectId: "project-1",
      taskKind: "draft_translation",
      providerId: "openrouter",
      modelId: "anthropic/claude-3-5-sonnet",
      modelRegistryId: "openrouter:anthropic/claude-3-5-sonnet",
      fallbackModelIds: ["anthropic/claude-3-haiku"],
      promptPresetId: "itotori-draft-default-v1",
      promptTemplateVersion: "1.0.0",
      updatedAt: "2026-07-08T00:00:00.000Z",
    },
  ],
};

export const branchPolicySettingsFixture: ApiBranchPolicySettingsResponse = {
  schemaVersion: "itotori.settings.branch-policy.v0",
  projectId: "project-1",
  localeBranchId: "locale-1",
  targetLocale: "en-US",
  sourceRevision: {
    sourceRevisionId: "source-revision-1",
    revisionKind: "bridge",
    value: "fixture-revision",
  },
  latestVersion: {
    styleGuideVersionId: "style-guide-version-1",
    status: "draft",
    versionSequence: 1,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    approvedAt: null,
    policy: {
      schemaVersion: "style-guide-policy.v0",
      sections: {
        tone: [{ ruleId: "tone.1", guidance: "Keep narration concise and emotionally direct." }],
        terminology: [
          { ruleId: "profanity.1", guidance: "Preserve strong language when plot-critical." },
        ],
        honorifics: [{ ruleId: "honorifics.1", guidance: "Retain honorifics for named speakers." }],
        formatting: [{ ruleId: "ruby.1", guidance: "Preserve ruby annotations on proper nouns." }],
        protectedSpans: [
          { ruleId: "protected_spans.1", guidance: "Do not edit variables or engine tags." },
        ],
      },
    },
  },
  approvedVersion: null,
  branchReference: {
    referenceId: "branch-policy-reference-1",
    versionSequence: 1,
    styleGuideVersionId: "style-guide-version-1",
    glossaryContentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    glossaryTermCount: 2,
    glossaryReviewItemCount: 1,
    updateReason: "Fixture branch policy",
    createdAt: "2026-07-08T00:00:00.000Z",
  },
  policy: {
    schemaVersion: "style-guide-policy.v0",
    sections: {
      tone: [{ ruleId: "tone.1", guidance: "Keep narration concise and emotionally direct." }],
      terminology: [
        { ruleId: "profanity.1", guidance: "Preserve strong language when plot-critical." },
      ],
      honorifics: [{ ruleId: "honorifics.1", guidance: "Retain honorifics for named speakers." }],
      formatting: [{ ruleId: "ruby.1", guidance: "Preserve ruby annotations on proper nouns." }],
      protectedSpans: [
        { ruleId: "protected_spans.1", guidance: "Do not edit variables or engine tags." },
      ],
    },
  },
};

export const translationScopeSettingsFixture: ApiTranslationScopeSettingsResponse = {
  schemaVersion: "itotori.settings.translation-scope.v0",
  projectId: "project-1",
  localeBranchId: "locale-1",
  scope: "dialogue-only",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

export const localizationRunConfigFixture: ApiLocalizationRunConfigResponse = {
  schemaVersion: "itotori.settings.localization-run-config.v0",
  projectId: "project-1",
  localeBranchId: "locale-1",
  configPath: "/operator/runs/project.localize.json",
  dataRoot: "/operator/game",
  pairPolicyPath: "/operator/policies/pair-policy.json",
  modelId: "deepseek/deepseek-v4-flash",
  providerId: "fireworks",
  runDir: "/operator/runs/project-pass",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

// ITOTORI-053 — cost drilldown fixture. Carries all three DISTINCT cost
// states (billed / zero / unknown) so the dashboard render + API-schema
// assertion exercise the zero-vs-unknown distinction, and adapter metadata
// that is CURATED (no raw provider payload — the repository strips those
// server-side, so a well-formed API response never contains one).
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
        amountMicrosUsd: 1200, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        displayAmountUsd: "0.0012", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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

const wikiContextVersionFixture = {
  contextEntryVersionId: "context-version-hero-scene-1",
  contextArtifactId: "context-artifact-hero-scene",
  parentVersionId: null,
  projectId: "project-1",
  localeBranchId: "locale-1",
  sourceRevisionId: "source-revision-1",
  category: "scene_summary" as const,
  kind: "scene" as const,
  status: "active" as const,
  title: "Prologue arrival",
  body: "The protagonist arrives at the academy and meets the guide.",
  data: { sceneId: "scene-prologue", summaryLocale: "en-US" },
  contentHash: "sha256:wiki-context-hero-scene",
  provenance: {
    producedByAgent: "scene-summary",
    producedByTool: "tool.scene-summary",
    producerVersion: "1.0.0",
    createdByUserId: null,
    origin: "localization_run",
    runId: "localization-run-1",
    providerRunId: "provider-run-1",
    provenance: {
      origin: "localization_run",
      runId: "localization-run-1",
      providerRunId: "provider-run-1",
    },
  },
  citations: [
    {
      bridgeUnitId: "bridge-unit-1",
      sourceRevisionId: "source-revision-1",
      sourceHash: "source-hash-1",
      citation: "scene 1 line 1",
      metadata: { sceneId: "scene-prologue" },
    },
  ],
  impact: {
    affectedUnitIds: ["bridge-unit-1"],
    invalidatedReason: null,
    invalidatedAt: null,
  },
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
  isHead: true,
} as const;

export const wikiContextEntryFixture: WikiContextEntryReadModel = {
  schemaVersion: "wiki.context.entry.v0.1",
  generatedAt: new Date("2026-07-10T00:01:00.000Z"),
  entry: {
    contextArtifactId: "context-artifact-hero-scene",
    projectId: "project-1",
    localeBranchId: "locale-1",
    sourceRevisionId: "source-revision-1",
    category: "scene_summary",
    kind: "scene",
    status: "active",
    title: "Prologue arrival",
    body: "The protagonist arrives at the academy and meets the guide.",
    data: { sceneId: "scene-prologue", summaryLocale: "en-US" },
    contentHash: "sha256:wiki-context-hero-scene",
    headVersionId: "context-version-hero-scene-1",
    versionCount: 1,
    provenance: wikiContextVersionFixture.provenance,
    citations: wikiContextVersionFixture.citations,
    impact: wikiContextVersionFixture.impact,
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T00:00:00.000Z"),
    history: [wikiContextVersionFixture],
  },
};

const { history: _wikiContextHistory, ...wikiContextEntrySummaryFixture } =
  wikiContextEntryFixture.entry;

export const wikiContextEntriesFixture: WikiContextEntriesReadModel = {
  schemaVersion: "wiki.context.entries.v0.1",
  generatedAt: new Date("2026-07-10T00:01:00.000Z"),
  filter: {
    projectId: "project-1",
    localeBranchId: "locale-1",
    sourceRevisionId: null,
    kind: null,
    includeStale: true,
  },
  pagination: { total: 1, limit: 20, offset: 0, hasMore: false, nextOffset: null },
  entries: [wikiContextEntrySummaryFixture],
};

export const wikiContextHistoryFixture: WikiContextEntryHistoryReadModel = {
  schemaVersion: "wiki.context.entry-history.v0.1",
  generatedAt: new Date("2026-07-10T00:01:00.000Z"),
  contextArtifactId: "context-artifact-hero-scene",
  headVersionId: "context-version-hero-scene-1",
  versions: [wikiContextVersionFixture],
};

export const wikiEditFixture: ApiWikiEditResponse = {
  schemaVersion: "wiki.context.edit.v0.1",
  generatedAt: new Date("2026-07-10T00:02:00.000Z"),
  correctionId: "context-correction-hero-scene",
  contextArtifactId: "context-artifact-hero-scene",
  contextEntryVersionId: "context-version-hero-scene-1",
  affectedUnitIds: ["bridge-unit-1"],
  invalidatedArtifactIds: ["context-artifact-dependent"],
  redraftJobId: "context-redraft-job-1",
  entry: wikiContextEntryFixture.entry,
};

export const wikiEntriesFixture: WikiEntriesReadModel = {
  schemaVersion: "wiki.entries.v0.1",
  generatedAt: new Date("2026-07-06T00:00:00.000Z"),
  filter: {
    projectId: "project-1",
    localeBranchId: "locale-1",
    sourceRevisionId: null,
    kind: null,
  },
  pagination: {
    total: 2,
    limit: 20,
    offset: 0,
    hasMore: false,
    nextOffset: null,
  },
  brandContext: {
    requestedProjectId: "project-1",
    requestedLocaleBranchId: "locale-1",
    contexts: [],
    inheritedContextArtifacts: [],
  },
  entries: [
    {
      entryId: "character:Hero",
      kind: "character",
      projectId: "project-1",
      localeBranchId: "locale-1",
      scope: {
        inheritance: "local",
        requestedProjectId: "project-1",
        requestedLocaleBranchId: "locale-1",
        sourceProjectId: "project-1",
        sourceLocaleBranchId: "locale-1",
        brandContextId: null,
        brandContextKey: null,
        brandContextName: null,
        brandContextRole: null,
      },
      sourceRevisionId: "source-revision-1",
      title: "Hero",
      characterId: "Hero",
      bio: {
        characterBioId: "bio-hero",
        locale: "en-US",
        text: "The protagonist.",
        status: "Fresh",
        stale: false,
        generatedAt: new Date("2026-07-06T00:00:00.000Z"),
      },
      appearances: [
        {
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          citedSourceHash: "source-hash-1",
          citeOrdinal: 1,
        },
      ],
      related: [
        {
          refKind: "term",
          refId: "term-hero",
          label: "Hero",
          relation: "terminology_alias",
        },
      ],
      relationships: [],
      revisions: [
        {
          characterBioId: "bio-hero",
          sourceRevisionId: "source-revision-1",
          status: "Fresh",
          generatedAt: new Date("2026-07-06T00:00:00.000Z"),
        },
      ],
    },
    {
      entryId: "term:term-hero",
      kind: "term",
      projectId: "project-1",
      localeBranchId: "locale-1",
      scope: {
        inheritance: "local",
        requestedProjectId: "project-1",
        requestedLocaleBranchId: "locale-1",
        sourceProjectId: "project-1",
        sourceLocaleBranchId: "locale-1",
        brandContextId: null,
        brandContextKey: null,
        brandContextName: null,
        brandContextRole: null,
      },
      title: "Hero",
      termId: "term-hero",
      sourceTerm: "Hero",
      preferredTranslation: "Hero",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      termKind: "character_name",
      partOfSpeech: null,
      status: "active",
      notes: null,
      aliases: [
        {
          aliasId: "alias-hero",
          aliasText: "勇者",
          aliasKind: "source_alias",
          locale: "ja-JP",
        },
      ],
      references: [
        {
          sourceRefId: "source-ref-hero",
          sourceRevisionId: "source-revision-1",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          referenceKind: "source_unit",
          citation: "hello.scene.001.line.001",
          context: "Speaker name",
        },
      ],
      related: [
        {
          refKind: "character",
          refId: "Hero",
          label: "Hero",
          relation: "terminology_alias",
        },
      ],
    },
  ],
};

export const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-1",
  projectKey: "project-1",
  name: "project-1",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
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

export const catalogConflictReviewFixture: CatalogConflictReviewReadModel = {
  rows: [
    {
      reviewId: "catalog-conflict:duplicate-external-id",
      catalogRecordId: "work-duplicate",
      conflictId: "duplicate-external-id",
      candidateIds: ["candidate-prior-1"],
      candidateCatalogIds: ["work-duplicate", "work-other"],
      exactLinkRefs: [
        {
          externalIdId: "external-dlsite-1",
          catalogSource: "dlsite",
          sourceId: "RJ010",
          externalIdKind: "store_product",
          workId: "work-duplicate",
          sourceProvenanceId: "prov-dlsite",
        },
      ],
      fuzzyScores: [],
      sourceIds: [{ catalogSource: "dlsite", sourceId: "RJ010" }],
      provenance: [
        {
          sourceProvenanceId: "prov-dlsite",
          catalogSource: "dlsite",
          sourceId: "RJ010",
          sourceRecordKind: "recorded_fixture",
          payloadHash: null,
          fetchedAt: new Date("2026-06-17T00:00:00.000Z"),
        },
      ],
      privateSourceCount: 0,
      severity: "error",
      status: "open",
      reasonCode: "duplicate_external_id",
      reasonDetail: "DLsite id was observed against multiple catalog identities.",
      conflictOrigin: "fixture_authored",
      conflictKind: "external_id",
      detectedAt: new Date("2026-06-17T00:00:00.000Z"),
      resolution: null,
    },
  ],
};

export const catalogCompletenessFixture: CatalogCompletenessBenchmarkPools = {
  targetLanguage: "en-US",
  pools: {
    mtl_only: [
      {
        workId: "work-mtl",
        canonicalTitle: "MTL Fixture",
        originalLanguage: "ja-JP",
        sourceIds: [{ catalogSource: "egs", sourceId: "egs-mtl" }],
        privateSourceCount: 0,
        statuses: [
          {
            languageStatusId: "status-mtl",
            language: "en-US",
            status: "mtl",
            statusScope: "work",
            platform: null,
            releaseId: null,
            sourceProvenanceId: "prov-egs-mtl",
            source: {
              sourceProvenanceId: "prov-egs-mtl",
              catalogSource: "egs",
              sourceRecordKind: "recorded_fixture",
              sourceId: "egs-mtl",
              sourceVersion: "fixture-2026-06-17",
              fetchedAt: new Date("2026-06-17T00:00:00.000Z"),
              rawContentRedactionClass: "public_metadata",
            },
            privateSourceCount: 0,
            confidence: "medium",
            observedAt: new Date("2026-06-17T00:00:00.000Z"),
            importedAt: new Date("2026-06-17T00:01:00.000Z"),
            parserVersion: "catalog-completeness-fixture.v0.1",
            rawContentRedactionClass: "public_metadata",
          },
        ],
        conflicts: [],
      },
    ],
    fan_partial: [],
    no_english: [],
    unknown: [],
    conflict: [],
  },
  publicReport: {
    schemaVersion: "catalog.completeness_public_report.v0.1",
    targetLanguage: "en-US",
    generatedAt: new Date("2026-06-17T00:02:00.000Z"),
    totalWorkCount: 1,
    conflictCount: 0,
    pools: [
      {
        pool: "mtl_only",
        workCount: 1,
        sourceIds: [{ catalogSource: "egs", sourceId: "egs-mtl" }],
      },
      { pool: "fan_partial", workCount: 0, sourceIds: [] },
      { pool: "no_english", workCount: 0, sourceIds: [] },
      { pool: "unknown", workCount: 0, sourceIds: [] },
      { pool: "conflict", workCount: 0, sourceIds: [] },
    ],
    statuses: [
      { status: "mtl", factCount: 1, sourceIds: [{ catalogSource: "egs", sourceId: "egs-mtl" }] },
    ],
  },
};

export const catalogBenchmarkSeedsFixture: CatalogBenchmarkSeedFinderReadModel = {
  schemaVersion: "catalog.benchmark_seed_finder.v0.1",
  targetLanguage: "en-US",
  generatedAt: new Date("2026-06-17T00:03:00.000Z"),
  rows: [
    {
      workId: "work-seed",
      canonicalTitle: "Benchmark Seed Fixture",
      originalLanguage: "ja-JP",
      sourceIds: [
        {
          catalogSource: "dlsite",
          sourceId: "RJSEED001",
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
      demandBucket: "very_high",
      readiness: {
        adapterId: "adapter-seed",
        identify: "supported",
        inventory: "supported",
        extract: "supported",
        patch: "partial",
        helper: "unknown",
        runtime: "unsupported",
      },
      provenance: [
        {
          catalogSource: "dlsite",
          sourceId: "RJSEED001",
          sourceRecordKind: "recorded_fixture",
          sourceVersion: "fixture-2026-06-17",
          fixtureId: "catalog-benchmark-seeds/dlsite/RJSEED001.json",
          redactionClass: "public_metadata",
        },
      ],
      decision: "seed",
      rank: 1,
      seedRank: 1,
      explanationCodes: ["pool:no_english", "demand_bucket:very_high", "local_ownership:owned"],
    },
  ],
};

export const catalogOpportunitiesFixture: CatalogOpportunityRankingReadModel = {
  schemaVersion: "catalog.opportunity_ranking.v0.1",
  targetLanguage: "en-US",
  generatedAt: new Date("2026-06-27T16:10:00.000Z"),
  weightsVersion: "catalog.opportunity_ranking.weights.v0.1",
  rows: [
    {
      rank: 1,
      workId: "work-opportunity",
      canonicalTitle: "Opportunity API Fixture",
      originalLanguage: "ja-JP",
      sourceIds: [
        {
          catalogSource: "dlsite",
          sourceId: "RJOPPAPI001",
          externalIdKind: "store_product",
        },
      ],
      engineName: "rpg-maker-mv-mz",
      adapterId: "kaifuu.rpg-maker-mv-mz",
      readiness: {
        adapterId: "kaifuu.rpg-maker-mv-mz",
        identify: "supported",
        inventory: "supported",
        extract: "supported",
        patch: "supported",
        helper: "unknown",
        runtime: "partial",
      },
      runtimeEvidenceReadiness: {
        status: "public_and_aggregate",
        publicFixtureEvidenceCount: 1,
        privateLocalAggregateEvidenceCount: 2,
      },
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
      demandFacts: {
        demandBucket: "very_high",
        dlCount: 61240,
        ratingAverage: 4.72,
        ratingCount: 1880,
        wishlistCount: 12040,
        bestRank: 3,
        workType: "RPG",
      },
      localOwnership: "owned",
      localEvidenceCount: 2,
      marketPrevalence: "public_and_local_aggregate",
      decision: "candidate",
      score: 100,
      factorBreakdown: [
        {
          factor: "translation_completeness",
          weight: 30,
          rawValue: 1,
          weightedScore: 30,
          evidenceRefs: ["catalog-language-status:work-opportunity:en-US:none"],
          explanationCode: "translation_completeness:no_english",
        },
        {
          factor: "local_ownership",
          weight: 8,
          rawValue: 1,
          weightedScore: 8,
          evidenceRefs: ["local_evidence_count:2"],
          explanationCode: "local_ownership:owned",
        },
        {
          factor: "dlsite_demand",
          weight: 20,
          rawValue: 1,
          weightedScore: 20,
          evidenceRefs: ["dlsite:RJOPPAPI001"],
          explanationCode: "dlsite_demand:very_high:rating_high",
        },
        {
          factor: "platform_language_conflict",
          weight: -60,
          rawValue: 0,
          weightedScore: 0,
          evidenceRefs: [],
          explanationCode: "platform_language_conflict:none",
        },
        {
          factor: "market_prevalence",
          weight: 8,
          rawValue: 1,
          weightedScore: 8,
          evidenceRefs: ["source_id_count:1", "local_evidence_count:2"],
          explanationCode: "market_prevalence:public_and_local_aggregate",
        },
        {
          factor: "adapter_readiness",
          weight: 18,
          rawValue: 1,
          weightedScore: 18,
          evidenceRefs: ["kaifuu.rpg-maker-mv-mz"],
          explanationCode: "adapter_readiness:patch_supported",
        },
        {
          factor: "runtime_evidence_readiness",
          weight: 6,
          rawValue: 1,
          weightedScore: 6,
          evidenceRefs: [
            "public_fixture_evidence_count:1",
            "private_local_aggregate_evidence_count:2",
          ],
          explanationCode: "runtime_evidence_readiness:public_and_aggregate",
        },
        {
          factor: "dlsite_work_type",
          weight: 0,
          rawValue: 1,
          weightedScore: 0,
          evidenceRefs: ["work_type:RPG"],
          explanationCode: "dlsite_work_type:rpg",
        },
        {
          factor: "existing_translation_status",
          weight: -20,
          rawValue: 0,
          weightedScore: 0,
          evidenceRefs: ["catalog-language-status:work-opportunity:en-US:none"],
          explanationCode: "existing_translation_status:none",
        },
        {
          factor: "benchmark_usefulness",
          weight: 10,
          rawValue: 1,
          weightedScore: 10,
          evidenceRefs: ["pool:no_english", "demand_bucket:very_high"],
          explanationCode: "benchmark_usefulness:high",
        },
        {
          factor: "unknown_evidence",
          weight: 0,
          rawValue: 0,
          weightedScore: 0,
          evidenceRefs: [],
          explanationCode: "unknown_evidence:none",
        },
      ],
      explanationCodes: [
        "translation_completeness:no_english",
        "local_ownership:owned",
        "dlsite_demand:very_high:rating_high",
        "platform_language_conflict:none",
        "market_prevalence:public_and_local_aggregate",
        "adapter_readiness:patch_supported",
        "runtime_evidence_readiness:public_and_aggregate",
        "dlsite_work_type:rpg",
        "existing_translation_status:none",
        "benchmark_usefulness:high",
        "unknown_evidence:none",
      ],
      provenance: [
        {
          catalogSource: "dlsite",
          sourceId: "RJOPPAPI001",
          sourceRecordKind: "recorded_fixture",
          sourceVersion: "fixture-2026-06-27",
          fixtureId: "catalog-opportunities/fixture.json",
          redactionClass: "public_metadata",
        },
      ],
      demotions: [],
    },
  ],
};

export const dashboardDecisionsFixture: DashboardDecisionReadModel = {
  projectId: "project-1",
  counts: {
    pendingDecisionCount: 3,
    projectFindingDecisionCount: 1,
    localeBranchFindingDecisionCount: 1,
    runtimeValidationDecisionCount: 1,
  },
  pendingDecisions: [
    {
      decisionId: "project_finding:finding-project-1",
      decisionKind: "project_finding",
      projectId: "project-1",
      findingId: "finding-project-1",
      findingKind: "terminology_consistency",
      severity: "P2",
      qualityCategory: "terminology",
      title: "Project terminology review",
      localeBranchId: null,
      targetLocale: null,
      branchStatus: null,
      runtimeRunId: null,
      runtimeStatus: null,
      createdAt: "2026-06-17T00:00:00.000Z",
    },
    {
      decisionId: "locale_branch_finding:finding-locale-1",
      decisionKind: "locale_branch_finding",
      projectId: "project-1",
      findingId: "finding-locale-1",
      findingKind: "protected_span_issue",
      severity: "P1",
      qualityCategory: "protected_content",
      title: "Protected span moved",
      localeBranchId: "locale-1",
      targetLocale: "en-US",
      branchStatus: "active",
      runtimeRunId: null,
      runtimeStatus: null,
      createdAt: "2026-06-17T00:01:00.000Z",
    },
    {
      decisionId: "runtime_validation:finding-runtime-1",
      decisionKind: "runtime_validation",
      projectId: "project-1",
      findingId: "finding-runtime-1",
      findingKind: "text_mismatch",
      severity: "P2",
      qualityCategory: "runtime_validation",
      title: "Runtime validation: text_mismatch",
      localeBranchId: "locale-1",
      targetLocale: "en-US",
      branchStatus: "active",
      runtimeRunId: "runtime-1",
      runtimeStatus: "failed",
      createdAt: "2026-06-17T00:02:00.000Z",
    },
  ],
};

export const runtimeStatusFixture: RuntimeDashboardStatus = {
  finalStatus: "hello_world_failed",
  runtimeRunId: "runtime-1",
  runtimeReportId: "runtime-1",
  runtimeStatus: "failed",
  fidelityTier: "layout_probe",
  evidenceTier: "E2",
  textEventCount: 1,
  frameCaptureCount: 0,
  screenshotArtifactCount: 1,
  recordingArtifactCount: 0,
  validationFindingCount: 1,
  traceEvents: [
    {
      runtimeEventId: "runtime-1:trace-1",
      eventKind: "text_seen",
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "hello.scene.001.line.001",
      draftId: "locale-1:bridge-unit-1",
      runtimeTargetId: "hello.scene.001.line.001",
      evidenceTier: null,
      frame: 12,
      textPreview: "Hello, {player}.",
      artifactIds: ["runtime-1:trace-artifact-1"],
    },
  ],
  findings: [
    {
      findingId: "runtime-1:finding-1",
      findingKind: "text_mismatch",
      severity: "error",
      message: "Observed runtime text did not match the draft text.",
      evidenceTier: "E2",
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "hello.scene.001.line.001",
      artifactId: "runtime-1:trace-artifact-1",
    },
  ],
  artifacts: [
    {
      artifactId: "runtime-1:screenshot-1",
      artifactKind: "screenshot",
      uri: "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-1.png",
      hash: "sha256:runtime-screenshot",
      mediaType: "image/png",
      byteSize: 2048,
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "hello.scene.001.line.001",
      diagnostic: null,
    },
    {
      artifactId: "runtime-1:trace-artifact-1",
      artifactKind: "trace_log",
      uri: "artifacts/utsushi/runtime/runtime-1/traces/trace-1.json",
      hash: "sha256:runtime-trace",
      mediaType: "application/json",
      byteSize: 512,
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "hello.scene.001.line.001",
      diagnostic: null,
    },
  ],
  approximations: [
    {
      approximationId: "runtime-1:approximation-1",
      approximationTier: "synthetic_fixture",
      scope: "capture",
      description: "Fixture capture approximates a host runtime frame.",
      evidenceTierCeiling: "E2",
      bridgeUnitIds: ["bridge-unit-1"],
    },
  ],
  unsupportedCapabilities: [
    {
      feature: "recording",
      status: "unsupported",
      fidelityTierCeiling: null,
      evidenceTierCeiling: null,
      limitations: ["Fixture adapter does not emit recordings."],
    },
  ],
  limitations: ["No reference-runtime pixel comparison is performed."],
};

export const bridgeFixture: BridgeBundle = {
  schemaVersion: "0.1.0",
  bridgeId: "bridge-1",
  sourceBundleHash: "hash-1",
  sourceLocale: "ja-JP",
  extractorName: "kaifuu-fixture",
  extractorVersion: "0.0.0",
  units: [
    {
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "hello.scene.001.line.001",
      occurrenceId: "occurrence-1",
      sourceHash: "source-hash-1",
      sourceLocale: "ja-JP",
      sourceText: "こんにちは、{player}。",
      textSurface: "dialogue",
      protectedSpans: [
        { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
      ],
      patchRef: {
        assetId: "source.json",
        writeMode: "replace",
        sourceUnitKey: "hello.scene.001.line.001",
      },
    },
  ],
};

export const projectFixture: ProjectState = {
  projectId: "project-1",
  localeBranchId: "locale-1",
  targetLocale: "en-US",
  drafts: { "bridge-unit-1": "Hello, {player}." },
  bridge: bridgeFixture,
};

export const nonJapaneseTargetProjectFixture: ProjectState = {
  projectId: "project-de-en",
  localeBranchId: "locale-de-en-us",
  targetLocale: "en-US",
  drafts: { "bridge-unit-de": "Good day, {player}." },
  bridge: {
    ...bridgeFixture,
    bridgeId: "bridge-de",
    sourceBundleHash: "hash-de",
    sourceLocale: "de-DE",
    units: [
      {
        ...bridgeFixture.units[0]!,
        bridgeUnitId: "bridge-unit-de",
        sourceUnitKey: "tag.scene.001.line.001",
        occurrenceId: "occurrence-de-1",
        sourceHash: "source-hash-de-1",
        sourceLocale: "de-DE",
        sourceText: "Guten Tag, {player}.",
        protectedSpans: [
          { kind: "placeholder", raw: "{player}", start: 11, end: 19, preserveMode: "exact" },
        ],
        patchRef: {
          assetId: "source-de.json",
          writeMode: "replace",
          sourceUnitKey: "tag.scene.001.line.001",
        },
      },
    ],
  },
};

export const runtimeReportFixture: RuntimeVerificationReport = {
  schemaVersion: "0.1.0",
  runtimeReportId: "runtime-1",
  adapterName: "utsushi-fixture",
  fidelityTier: "layout_probe",
  status: "passed",
  textEvents: [
    {
      runtimeTextEventId: "runtime-text-1",
      bridgeUnitId: "bridge-unit-1",
      text: "Hello, {player}.",
      frame: 1,
    },
  ],
  frameCaptures: [
    {
      frameCaptureId: "frame-1",
      bridgeUnitId: "bridge-unit-1",
      width: 320,
      height: 180,
      nonZeroPixels: 57600,
      artifactPath: "fixture://frame/1",
    },
  ],
  approximations: ["fixture"],
};

export const runtimeIngestResultFixture: RuntimeIngestResult = {
  status: "hello_world_passed",
  bridgeId: "bridge-1",
  localeBranchId: "locale-1",
  patchExportId: undefined,
  patchResultId: "patch-result-1",
  runtimeReportId: "runtime-1",
  dashboard: dashboardStatusFixture,
};

export const decisionEventFixture: TriageEventV02 = {
  eventId: "019ed004-0000-7000-8000-000000000201",
  eventKind: "triage_decision_recorded",
  occurredAt: "2026-06-17T00:00:00.000Z",
  actor: { actorKind: "human", displayName: "Fixture reviewer" },
  subjectRefs: [],
  provenance: [
    {
      provenanceId: "019ed004-0000-7000-8000-000000000202",
      provenanceKind: "human_review",
      noteHash: "sha256:decision-fixture-note",
    },
  ],
  causalLinks: [],
  payload: { optionId: "accept_fixture_decision" },
};

export const findingRecordFixture = readFixture<{ finding: FindingRecordV02 }>(
  "../../../packages/localization-bridge-schema/test/examples/finding-v0.2.json",
).finding;

export const benchmarkReportFixture = readFixture<BenchmarkReportV02>(
  "../../../packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json",
);

// ITOTORI-027 — the dashboard benchmark read model derived from the REAL
// recorded benchmark report fixture (same QA calibration the workflow
// persists), so the MSW handler stays in lockstep with the real schema.
export const benchmarkReportSummaryFixture: BenchmarkReportSummary = {
  benchmarkRunId: benchmarkReportFixture.benchmarkRunId,
  projectId: "project-1",
  localeBranchId: benchmarkReportFixture.localeBranchId ?? null,
  benchmarkName: benchmarkReportFixture.benchmarkName,
  status: benchmarkReportFixture.status,
  createdAt: benchmarkReportFixture.createdAt,
  sourceLocale: benchmarkReportFixture.sourceLocale,
  targetLocale: benchmarkReportFixture.targetLocale,
  systemCount: benchmarkReportFixture.systemsCompared.length,
  findingCount: benchmarkReportFixture.findingRecords.length,
  penaltyTotal: benchmarkReportFixture.penaltySummary.penaltyTotal,
  qaAgents: summarizeQaAgents(benchmarkReportFixture),
};

export const benchmarkReportsFixture: BenchmarkReportSummary[] = [benchmarkReportSummaryFixture];

export const bmkCockpitFixture: BmkCockpitReadModel = {
  schemaVersion: "itotori.bmk-cockpit.v0.1",
  generatedAt: "2026-07-08T00:00:00.000Z",
  projectId: dashboardStatusFixture.projectId,
  localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
  runId: "bmk-run-contract-1",
  targetLocale: "ja-JP",
  kind: "real_run",
  status: "succeeded",
  unitsScored: 24,
  recordedAt: "2026-07-08T00:00:00.000Z",
  contestants: [
    {
      role: "official",
      contestantKind: "official_localization",
      aggregateScore: 0.91,
      rank: 0,
      judgeMean: 3.6,
      metricMean: 0.86,
      coverage: null,
    },
    {
      role: "self",
      contestantKind: "itotori_context_on",
      aggregateScore: 0.83,
      rank: 1,
      judgeMean: 3.2,
      metricMean: 0.79,
      coverage: null,
    },
    {
      role: "self_nocontext",
      contestantKind: "itotori_context_off",
      aggregateScore: 0.74,
      rank: 2,
      judgeMean: 2.9,
      metricMean: 0.7,
      coverage: null,
    },
    {
      role: "fan",
      contestantKind: "fan_edited_mtl",
      aggregateScore: 0.68,
      rank: 3,
      judgeMean: 2.6,
      metricMean: 0.62,
      coverage: null,
    },
    {
      role: "mtl",
      contestantKind: "raw_mtl_baseline",
      aggregateScore: 0.42,
      rank: 4,
      judgeMean: 1.7,
      metricMean: 0.38,
      coverage: null,
    },
  ],
  rankedRoles: ["official", "self", "self_nocontext", "fan", "mtl"],
  humanAnchor: {
    raters: ["human-anchor-1"],
    judgeIds: ["judge-panel-1"],
    byDimensionCount: 3,
    divergentDimensionCount: 1,
    overall: {
      itemsCompared: 24,
      normalizedAgreement: 0.82,
      signedMeanDiff: -0.12,
      pearson: 0.78,
    },
  },
  confidence: {
    pearson: 0.78,
    normalizedAgreement: 0.82,
    value: 0.78,
    basis: "pearson",
  },
  actionableBacklog: {
    systemUnderTestId: "itotori_context_on",
    fanMtlSystemId: "fan_edited_mtl",
    professionalSystemId: "official_localization",
    items: [],
    countsByRank: { top_priority: 0, improvement_backlog: 0, regression_protection: 0 },
    perDimensionRegression: [],
    perSignalScores: [],
    dag: { nodes: [], findings: [] },
    adjudicatedFindings: [],
  },
  actionableBacklogSize: 0,
};

export const bmkCockpitHistoryFixture: BmkCockpitRunHistoryPage = {
  filter: {
    projectId: bmkCockpitFixture.projectId,
    localeBranchId: bmkCockpitFixture.localeBranchId,
  },
  pagination: {
    limit: 25,
    offset: 0,
    hasMore: false,
    nextOffset: null,
  },
  rows: [
    {
      runId: bmkCockpitFixture.runId,
      projectId: bmkCockpitFixture.projectId,
      localeBranchId: bmkCockpitFixture.localeBranchId,
      targetLocale: bmkCockpitFixture.targetLocale,
      kind: bmkCockpitFixture.kind,
      status: bmkCockpitFixture.status,
      unitsScored: bmkCockpitFixture.unitsScored,
      recordedAt: bmkCockpitFixture.recordedAt,
      bestRole: "official",
      actionableBacklogSize: bmkCockpitFixture.actionableBacklogSize,
      confidence: bmkCockpitFixture.confidence.value,
    },
  ],
};

export const projectOverviewFixture: ProjectOverviewReadModel = {
  schemaVersion: "projects.overview.v0.1",
  generatedAt: "2026-07-07T00:00:00.000Z",
  projectId: dashboardStatusFixture.projectId,
  progress: dashboardStatusFixture,
  decisions: dashboardDecisionsFixture,
  cost: costReportFixture,
  telemetry: {
    projectId: dashboardStatusFixture.projectId,
    bucket: "day",
    rows: [
      {
        bucketStart: "2026-06-16T00:00:00.000Z",
        runCount: 1,
        billedMicrosUsd: 900,
        costPerRunMicrosUsd: 900,
      },
      {
        bucketStart: "2026-06-17T00:00:00.000Z",
        runCount: 2,
        billedMicrosUsd: 1280,
        costPerRunMicrosUsd: 640,
      },
    ],
    throughputSeries: [1, 2],
    costPerRunSeries: [900, 640],
  },
  costDrilldown: costDrilldownFixture,
  journal: {
    filter: {
      projectId: dashboardStatusFixture.projectId,
      localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
    },
    pagination: {
      total: 1,
      limit: 10,
      offset: 0,
      page: 1,
      pageCount: 1,
      hasMore: false,
      nextOffset: null,
    },
    rows: [
      {
        journalRunId: "localization-journal-fixture-1",
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
        sourceRevisionId: dashboardStatusFixture.sourceBundleRevisionId,
        targetLocale: "en-US",
        createdAt: "2026-07-07T00:00:00.000Z",
        physicalCallCount: 3,
        failedPhysicalCallCount: 0,
        writtenOutcomeCount: 1,
        candidateCount: 2,
        qaFindingCount: 1,
        contextRefCount: 2,
        speakerLabelCount: 1,
      },
    ],
  },
  benchmarkHeadline: {
    reportCount: benchmarkReportsFixture.length,
    latestReport: benchmarkReportsFixture[0] ?? null,
  },
  canSteer: true,
};

function readFixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}

// ITOTORI-051 — project MUTATION route fixtures.
//
// Each project mutation route the dashboard / SPA mutation layer POSTs to has
// a SUCCESS request + response pair. The response shapes are the EXACT types
// `assertItotoriApiResponse` checks against the real api-schema contract, so
// the MSW handlers in `msw-handlers.ts` and the contract-drift tests in
// `msw-mutation-handlers.test.ts` catch a shape change (a renamed field, a
// narrowed enum, a new required field) instead of silently diverging.
//
// `apiMutationBadRequestResponseFixture` and
// `apiMutationForbiddenResponseFixture` are the shared typed error responses
// every mutation route may emit (a `bad_request` validation failure and a
// `forbidden` permission / scoping denial — ITOTORI-050). They are checked
// against `assertItotoriApiErrorResponse`.

export const bridgeImportRequestFixture: ApiProjectImportRequest = {
  bridge: bridgeFixture,
};

export const bridgeImportResponseFixture: ApiProjectImportResponse = {
  project: projectFixture,
  status: dashboardStatusFixture,
};

export const draftBranchRequestFixture: ApiDraftBranchRequest = {
  project: projectFixture,
  targetLocale: "fr-FR",
};

export const draftBranchResponseFixture: ApiDraftBranchResponse = {
  outcome: "drafted",
  project: projectFixture,
  status: dashboardStatusFixture,
  refusalMessage: null,
};

export const recordFindingRequestFixture: ApiRecordFindingRequest = {
  localeBranchId: "locale-1",
  finding: findingRecordFixture,
};

export const recordFindingResponseFixture: ApiRecordFindingResponse = {
  findingId: findingRecordFixture.findingId,
  status: "open",
};

export const recordDecisionRequestFixture: ApiRecordDecisionRequest = {
  localeBranchId: "locale-1",
  event: decisionEventFixture,
};

export const recordDecisionResponseFixture: ApiRecordDecisionResponse = {
  decisionId: decisionEventFixture.eventId,
  eventKind: decisionEventFixture.eventKind,
  recorded: true,
};

export const recordBenchmarkRequestFixture: ApiRecordBenchmarkRequest = {
  benchmarkReport: benchmarkReportFixture,
};

export const recordBenchmarkResponseFixture: ApiRecordBenchmarkResponse = {
  benchmarkRunId: benchmarkReportFixture.benchmarkRunId,
  artifactId: benchmarkReportFixture.benchmarkRunId,
  status: benchmarkReportFixture.status,
  systemCount: benchmarkReportFixture.systemsCompared.length,
  findingCount: benchmarkReportFixture.findingRecords.length,
};

export const runtimeEvidenceIngestRequestFixture: ApiRuntimeEvidenceRequest = {
  project: projectFixture,
  runtimeReport: runtimeReportFixture,
};

export const runtimeEvidenceIngestResponseFixture: ApiRuntimeEvidenceResponse =
  runtimeIngestResultFixture;

/**
 * ITOTORI-051 — the typed validation-failure response every project mutation
 * route emits when `parseXxxRequest` rejects the body (ApiValidationError →
 * 400 bad_request). The `error` message is the parser's, but the SHAPE is
 * stable across routes.
 */
export const apiMutationBadRequestResponseFixture: ApiErrorResponse = {
  error:
    "ApiProjectImportRequest: ApiProjectImportRequest.bridge: BridgeInput.schemaVersion must be 0.1.0 or 0.2.0",
  code: "bad_request",
};

/**
 * ITOTORI-050 / ITOTORI-051 — the typed permission / scoping-denial response
 * every project mutation route emits when either the permission gate
 * (AuthorizationError → 403 forbidden) or the server-side project/branch
 * ownership scope check (ProjectMutationScopeError → 403 forbidden) refuses
 * the mutation. The SHAPE is stable across routes.
 */
export const apiMutationForbiddenResponseFixture: ApiErrorResponse = {
  error: "user api-user-without-required-permission is missing permission project.import",
  code: "forbidden",
};

/**
 * ITOTORI-051 — the per-route mutation contract surface. Each entry binds a
 * project mutation {@link ItotoriApiRouteId} to its MSW origin URL, its
 * request fixture (the SUCCESS body the api-schema parser MUST accept), and
 * its response fixture (the SUCCESS body `assertItotoriApiResponse` MUST
 * accept). The contract-drift tests iterate this surface so adding a NEW
 * project mutation route forces a matching fixture + drift test rather than
 * silently passing.
 */
export type ApiMutationContractEntry = {
  routeId: Extract<
    ItotoriApiRouteId,
    | "imports.bridge"
    | "branches.draft"
    | "findings.record"
    | "decisions.record"
    | "benchmarks.record"
    | "runtimeEvidence.ingest"
  >;
  /** MSW URL the dashboard / SPA mutation layer POSTs to. */
  url: string;
  /** Label used in the parser + asserter error expectations. */
  requestTypeName: string;
  /** A field the parser requires; dropping it must FAIL the request contract. */
  requiredRequestField: string;
  /** A field the response asserter requires; mutating it must FAIL the response contract. */
  requiredResponseField: string;
  /** Substring of the parser's error message when the request shape drifts. */
  parserErrorSubstring: string;
};

export const apiMutationContract: readonly ApiMutationContractEntry[] = [
  {
    routeId: "imports.bridge",
    url: "http://itotori.test/api/imports/bridge",
    requestTypeName: "ApiProjectImportRequest",
    requiredRequestField: "bridge",
    requiredResponseField: "project",
    // `parseRequest` wraps the inner `BridgeInput` asserter as
    // `"ApiProjectImportRequest: <inner>"`, so the substring keys on the
    // request type label (always present) rather than the field path.
    parserErrorSubstring: "ApiProjectImportRequest",
  },
  {
    routeId: "branches.draft",
    url: "http://itotori.test/api/projects/project-1/branches",
    requestTypeName: "ApiDraftBranchRequest",
    requiredRequestField: "targetLocale",
    requiredResponseField: "status",
    // `targetLocale` is a top-level scalar, so `assertString` includes the
    // full `"ApiDraftBranchRequest.targetLocale"` field path.
    parserErrorSubstring: "ApiDraftBranchRequest.targetLocale",
  },
  {
    routeId: "findings.record",
    url: "http://itotori.test/api/projects/project-1/findings",
    requestTypeName: "ApiRecordFindingRequest",
    requiredRequestField: "finding",
    requiredResponseField: "findingId",
    parserErrorSubstring: "ApiRecordFindingRequest",
  },
  {
    routeId: "decisions.record",
    url: "http://itotori.test/api/projects/project-1/decisions",
    requestTypeName: "ApiRecordDecisionRequest",
    requiredRequestField: "event",
    requiredResponseField: "decisionId",
    parserErrorSubstring: "ApiRecordDecisionRequest",
  },
  {
    routeId: "benchmarks.record",
    url: "http://itotori.test/api/projects/project-1/benchmarks",
    requestTypeName: "ApiRecordBenchmarkRequest",
    requiredRequestField: "benchmarkReport",
    requiredResponseField: "benchmarkRunId",
    parserErrorSubstring: "ApiRecordBenchmarkRequest",
  },
  {
    routeId: "runtimeEvidence.ingest",
    url: "http://itotori.test/api/projects/project-1/runtime-evidence",
    requestTypeName: "ApiRuntimeEvidenceRequest",
    requiredRequestField: "runtimeReport",
    requiredResponseField: "patchResultId",
    parserErrorSubstring: "ApiRuntimeEvidenceRequest",
  },
] as const;
