import {
  AssetDecisionRecord,
  BenchmarkRecordResult,
  BenchmarkReportSummary,
  BenchmarkReportV02,
  BridgeBundle,
  BridgeBundleV02,
  CandidateAssetRecord,
  CatalogBenchmarkSeedFinderReadModel,
  CatalogCompletenessBenchmarkPools,
  CatalogConflictReviewReadModel,
  CatalogContextPanelReadModel,
  CatalogExternalIdKind,
  CatalogOpportunityRankingReadModel,
  CatalogSource,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ExtractEngineId,
  ExtractModeForEngine,
  ExtractSource,
  FindingRecordResult,
  FindingRecordV02,
  JobsRunTableReadModel,
  ProjectCostReport,
  ProjectDashboardStatus,
  ProjectOverviewReadModel,
  ProjectRunPortfolioProgressSummary,
  ProjectState,
  QueueHealthReadModel,
  RuntimeEvidenceReportV02,
  RuntimeIngestResult,
  RuntimeVerificationReport,
  TerminologySearchReadModel,
  WikiApplyReceipt,
  WikiDependentView,
  WikiHistoryEntry,
  WikiObjectView,
  WikiWriteAssertion,
  WikiWriteReceipt,
} from "./dependencies.js";
import { API_ERROR_RESPONSE_CODES, ApiErrorResponse } from "./api-domain-01.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import { asStrictRecord, assertEnum, assertString } from "./api-domain-29.js";

export type ItotoriStrictApiBodyName = keyof typeof STRICT_API_BODY_KEYS;

/**
 * policy — assert an {@link ApiErrorResponse} body. Error responses are
 * not tied to a single route id (every route may emit one), so they are
 * validated independently of {@link assertItotoriApiResponse}. The MSW
 * mutation contract handlers + tests use this so a typed error-shape change
 * (a renamed `code` enum value, a missing `error` string, an extra leaked
 * field) fails a dashboard contract test instead of silently diverging.
 */
export function assertItotoriApiErrorResponse(
  value: unknown,
  label = "ApiErrorResponse",
): asserts value is ApiErrorResponse {
  const response = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiErrorResponse);
  assertString(response.error, `${label}.error`);
  assertEnum(response.code, API_ERROR_RESPONSE_CODES, `${label}.code`);
}

export type ApiProjectsResponse = {
  projects: ProjectPortfolioEntry[];
};

/** The portfolio list preserves the dashboard shape and adds run progress. */
export type ProjectPortfolioEntry = ProjectDashboardStatus & {
  progress: ProjectRunPortfolioProgressSummary;
};

export type ApiProjectCostResponse = ProjectCostReport;

export type ApiProjectCostDrilldownResponse = CostDrilldownPage;

export type ApiProjectOverviewResponse = ProjectOverviewReadModel;

export type ApiJobsRunTableResponse = JobsRunTableReadModel;

export type ApiBenchmarkReportsResponse = {
  reports: BenchmarkReportSummary[];
};

/** policy — typed queue-health read-model (outbox lag, job/retry/dead-letter). */
export type ApiQueueHealthResponse = QueueHealthReadModel;

export type ApiDashboardDecisionsResponse = DashboardDecisionReadModel;

export type ApiCatalogConflictReviewResponse = CatalogConflictReviewReadModel;

export type ApiCatalogCompletenessResponse = CatalogCompletenessBenchmarkPools;

export type ApiCatalogBenchmarkSeedsResponse = CatalogBenchmarkSeedFinderReadModel;

export type ApiCatalogContextPanelResponse = CatalogContextPanelReadModel;

export type ApiCatalogOpportunitiesResponse = CatalogOpportunityRankingReadModel;

export type ApiTerminologySearchResponse = TerminologySearchReadModel;

/** Source WikiObjects are selected by their snapshot, never a locale branch.
 * Per-target bible renderings live under their own localization snapshot. */
export type ApiWikiListResponse = {
  schemaVersion: "itotori.wiki.objects.v1";
  generatedAt: string;
  snapshotId: string;
  sourceObjects: readonly WikiObjectView[];
  renderings: readonly WikiObjectView[];
};

/** One typed WikiObject plus immutable history and its precise consumers. */
export type ApiWikiShowResponse = {
  schemaVersion: "itotori.wiki.object.v1";
  generatedAt: string;
  view: WikiObjectView;
  history: readonly WikiHistoryEntry[];
  dependencyImpact: { readonly dependents: readonly WikiDependentView[] };
};

export type ApiWikiHistoryResponse = {
  schemaVersion: "itotori.wiki.history.v1";
  generatedAt: string;
  view: WikiObjectView;
  history: readonly WikiHistoryEntry[];
};

/** A direct edit/feedback is always bound to an authoritative head assertion.
 * The candidate itself is parsed by the strict HumanInput contract at the
 * object-API boundary. */
export type ApiWikiWriteRequest = {
  input: unknown;
  assertion: WikiWriteAssertion;
};

/** Retained only for the patch-iteration feedback payload's closed operation
 * vocabulary; it is not a Wiki HTTP endpoint category. */
export type ApiWikiAddKind = "note" | "glossary" | "style";

export type ApiWikiApplyRequest = {
  inputIds: readonly string[];
  assertion: WikiWriteAssertion;
};

export type ApiWikiEditResponse = {
  schemaVersion: "itotori.wiki.write.v1";
  generatedAt: string;
  receipt: WikiWriteReceipt;
  history: readonly WikiHistoryEntry[];
  dependencyImpact: WikiWriteReceipt["dependencyImpact"];
};

export type ApiWikiFeedbackResponse = ApiWikiEditResponse;

export type ApiWikiApplyResponse = {
  schemaVersion: "itotori.wiki.apply.v1";
  generatedAt: string;
  receipt: WikiApplyReceipt;
  history: readonly WikiHistoryEntry[];
  dependencyImpact: WikiApplyReceipt["dependencyImpact"];
};

export type ApiAssetDecisionsResponse = {
  decisions: AssetDecisionRecord[];
};

export type ApiCandidateAssetsResponse = {
  candidateAssets: CandidateAssetRecord[];
};

export type ApiProjectImportRequest = {
  bridge: BridgeBundle | BridgeBundleV02;
  bootstrapSelection?: ApiBootstrapCatalogSelection;
};

/**
 * A Studio decode/extract request is the registry's engine-discriminated source
 * union. There is no default engine and no cross-adapter top-level input: each
 * variant carries only the source, identity, and mode fields its adapter owns.
 */
export type ApiProjectDecodeExtractRequest = ExtractSource;

/**
 * The produced v0.2 BridgeBundle (read back from the file kaifuu wrote), the
 * resolved decode mode, and the exact kaifuu-cli invocation. The bridge feeds
 * the SAME `imports.bridge` ingestion path the manual upload used.
 */
export type ApiProjectDecodeExtractResponseEnvelope = {
  bridge: BridgeBundleV02;
  command: string;
};

/** The common bridge output plus the selected adapter's engine/mode variant. */
export type ApiProjectDecodeExtractResponse = {
  [E in ExtractEngineId]: ApiProjectDecodeExtractResponseEnvelope & {
    engine: E;
    mode: ExtractModeForEngine<E>;
  };
}[ExtractEngineId];

export type ApiBootstrapCatalogSourceId = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
};

export type ApiBootstrapCatalogCandidate = {
  workId: string;
  canonicalTitle: string;
  sourceIds: ApiBootstrapCatalogSourceId[];
  adapterId: string | null;
};

export type ApiBootstrapCatalogSelection = {
  selectedWorkId: string;
  candidates: ApiBootstrapCatalogCandidate[];
};

export type ApiProjectImportResponse = {
  project: ProjectState;
  status: ProjectDashboardStatus;
};

export type ApiDraftBranchRequest = {
  project: ProjectState;
  targetLocale: string;
};

export type ApiDraftBranchResponse =
  | {
      /** The draft workflow completed. */
      outcome: "drafted";
      project: ProjectState;
      status: ProjectDashboardStatus;
      refusalMessage: null;
    }
  | {
      /** The provider refused before producing a draft. */
      outcome: "refused";
      project: null;
      status: null;
      refusalMessage: string;
    };

export type ApiRecordFindingRequest = {
  localeBranchId?: string;
  finding: FindingRecordV02;
  status?: "open" | "resolved" | "superseded";
};

export type ApiRecordFindingResponse = FindingRecordResult;

export type ApiRecordBenchmarkRequest = {
  benchmarkReport: BenchmarkReportV02;
};

export type ApiRecordBenchmarkResponse = BenchmarkRecordResult;

export type ApiRuntimeEvidenceRequest = {
  project: ProjectState;
  runtimeReport: RuntimeVerificationReport | RuntimeEvidenceReportV02;
};

export type ApiRuntimeEvidenceResponse = RuntimeIngestResult;

export type ApiAuthSsoProviderConfig =
  | {
      protocol: "oidc";
      providerId: string;
      displayName: string;
      enabled: boolean;
      issuer: string;
      clientId: string;
      scopes: readonly string[];
    }
  | {
      protocol: "saml";
      providerId: string;
      displayName: string;
      enabled: boolean;
      ssoUrl: string;
      entityId: string;
      certificateFingerprint?: string;
    };

export type ApiAccountSecuritySettings = {
  requireSso: boolean;
  requireMfa: boolean;
  allowPasswordLogin: boolean;
};

export type ApiAuthSessionPolicy = {
  idleTimeoutMinutes: number;
  absoluteTimeoutMinutes: number;
};

export type ApiConfigureAuthSsoSettingsRequest = {
  accountId: string;
  provider: ApiAuthSsoProviderConfig;
  security: ApiAccountSecuritySettings;
  sessionPolicy: ApiAuthSessionPolicy;
};

export type ApiModelRoutingProvider = {
  providerId: string;
  providerFamily: string;
  endpointFamily: string;
  providerName: string;
  metadata: Record<string, unknown>;
};

export type ApiModelRoutingModel = {
  modelRegistryId: string;
  providerId: string;
  modelId: string;
  capabilities: Record<string, unknown>;
  pricing: Record<string, unknown>;
};
