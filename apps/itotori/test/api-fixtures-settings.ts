import type {
  ApiAuthIdentityResponse,
  ApiBranchPolicySettingsResponse,
  ApiLocalizationRunConfigResponse,
  ApiModelRoutingSettingsResponse,
  ApiTranslationScopeSettingsResponse,
  JobsRunTableReadModel,
} from "../src/api-schema.js";
import type { ProjectCostReport } from "@itotori/db";

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
      amountMicrosUsd: 2180, // cost-audit-allow: synthetic fixture cost, not a real billed amount
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
      amountMicrosUsd: 1200, // cost-audit-allow: synthetic fixture cost, not a real billed amount
      tokenCountSource: "provider_reported",
      promptTokens: 12,
      completionTokens: 8,
      reasoningTokens: null,
      cachedInputTokens: null,
      totalTokens: 20,
      // policy — fixture posture for a fake-provider draft run.
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
      // policy — was previously `provider_estimate`; the audited
      // run actually carried a real upstream charge captured from
      // `usage.cost`, so it correctly tags as `billed`.
      costKind: "billed",
      amountMicrosUsd: 980, // cost-audit-allow: synthetic fixture cost, not a real billed amount
      tokenCountSource: "estimated",
      promptTokens: 10,
      completionTokens: 6,
      reasoningTokens: null,
      cachedInputTokens: null,
      totalTokens: 16,
      // policy — fixture posture for an OR-routed benchmark-qa
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
  schemaVersion: "jobs.run_table.v0.3",
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
      jobId: "job-1",
      projectId: "project-1",
      localeBranchId: "locale-branch-1",
      task: "Draft translation",
      status: "succeeded",
      servedModel: "openai/gpt-4.1-mini",
      servedProvider: "openai",
      zdr: { availability: "captured", enforced: true },
      cost: { availability: "captured", unit: "usd", amount: "0.00218" },
      tokens: { in: 22, out: 14, total: 36 },
      fallback: {
        used: false,
        plan: ["openai/gpt-4.1-mini"],
        chain: null,
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

// policy — cost drilldown fixture. Carries all three DISTINCT cost
// states (billed / zero / unknown) so the dashboard render + API-schema
// assertion exercise the zero-vs-unknown distinction, and adapter metadata
// that is CURATED (no raw provider payload — the repository strips those
// server-side, so a well-formed API response never contains one).
