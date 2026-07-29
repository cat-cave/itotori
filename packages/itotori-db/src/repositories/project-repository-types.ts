import type {
  BridgeBundle,
  BridgeBundleV02,
  FindingRecordV02,
  PatchExport,
  PatchExportV02,
  PatchResultV02,
  RuntimeEvidenceReportV02,
  RuntimeVerificationReport,
  TriageEventV02,
} from "@itotori/localization-bridge-schema";
import type { ProjectCostReport, ProviderRunLedgerInput } from "./model-ledger-repository.js";

export const defaultWorkspaceId = "local-workspace";
export const defaultWorkspaceName = "Local workspace";

// Postgres permits at most 65,535 bind parameters in one statement.  A real
// whole-game bridge can contain more source units than that, so ownership and
// stable-key checks must not turn the full unit set into one `IN (...)` query.
const POSTGRES_IN_ARRAY_BATCH_SIZE = 10_000;

/** The adapter-owned extraction descriptor persisted with a project binding. */
export type ProjectExtractProfile = Record<string, unknown>;

/**
 * The engine-specific project binding. The concrete registry belongs to the
 * application composition layer, while the repository depends only on this
 * narrow membership contract so it never owns a hardcoded engine list.
 */
export type ProjectEngineBinding = {
  engineFamily: string;
  sourceRoot: string;
  buildRoot: string;
  extractProfile: ProjectExtractProfile;
};

/** Registry contract enforced before a project binding is persisted. */
export type ProjectEngineFamilyRegistry = {
  has(engineFamily: string): boolean;
};

/** Raised when an import/provision request names an engine absent from its registry. */
export class UnknownProjectEngineFamilyError extends Error {
  constructor(readonly engineFamily: string) {
    super(`engine family '${engineFamily}' is not registered for project binding`);
  }
}

/**
 * Guard the complete persisted binding at the project create/import boundary.
 * Engine membership comes exclusively from the injected registry; this package
 * deliberately cannot infer or name individual engine families.
 */
export function assertProjectEngineBinding(
  binding: ProjectEngineBinding,
  registry: ProjectEngineFamilyRegistry,
): void {
  // Engine binding is nullable until a project is (re-)imported with one (see
  // migration 0113): rows/scopes that predate or do not carry a binding are
  // valid and skip validation. Only a binding that is actually present is
  // checked — a partially-supplied binding is a hard error.
  const fields = [
    binding.engineFamily,
    binding.sourceRoot,
    binding.buildRoot,
    binding.extractProfile,
  ];
  const anyPresent = fields.some((value) => value !== undefined && value !== null);
  if (!anyPresent) {
    return;
  }
  if (!registry.has(binding.engineFamily)) {
    throw new UnknownProjectEngineFamilyError(binding.engineFamily);
  }
  for (const [field, value] of [
    ["sourceRoot", binding.sourceRoot],
    ["buildRoot", binding.buildRoot],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`project ${field} must be a non-empty path`);
    }
  }
  if (
    typeof binding.extractProfile !== "object" ||
    binding.extractProfile === null ||
    Array.isArray(binding.extractProfile)
  ) {
    throw new Error("project extractProfile must be an object");
  }
}

export type ItotoriProjectRecord = ProjectEngineBinding & {
  projectId: string;
  bridge: BridgeBundle | BridgeBundleV02;
  localeBranchId: string;
  targetLocale: string;
  drafts: Record<string, string>;
  importStatus?: BridgeImportStatus;
  patchExport?: PatchExport | PatchExportV02;
  patchResult?: PatchResultV02;
  runtimeReport?: RuntimeVerificationReport | RuntimeEvidenceReportV02;
};

/** Narrow persisted-draft projection used by durable rerun verification. */
export type LoadLocaleBranchDraftTextsInput = {
  projectId: string;
  localeBranchId: string;
  bridgeUnitIds: readonly string[];
};

/**
 * The run-identity a whole-project localize run declares in its config
 * (`projectId` / `localeBranchId` / `sourceRevisionId` + the target/source
 * locales). {@link ItotoriProjectRepository.ensureRunProjectScope} upserts the
 * parent workspace -> project -> source-revision -> source-bundle -> locale-branch
 * graph these ids imply, so the journal-run FKs are satisfied before the first
 * live persist. Game-agnostic: every field is a
 * config value, never a hardcoded id.
 */
export type LocalizationRunProjectScope = ProjectEngineBinding & {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
  /** BCP-47 source locale (read from the run's bridge bundle). */
  sourceLocale: string;
};

export type BridgeImportFutureReferences = {
  catalogWorkId: string | null;
  localCorpusEntryId: string | null;
  readinessProfileId: string | null;
  completenessStatusId: string | null;
};

export type BridgeImportDiffCounts = {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
};

export type BridgeImportRevisionDiffCounts = {
  added: number;
  existing: number;
};

export type BridgeImportStatus = {
  bridgeImportId: string;
  projectId: string;
  bridgeId: string;
  sourceBundleId: string;
  sourceBundleHash: string;
  sourceBundleRevisionId: string;
  schemaVersion: string;
  sourceLocale: string;
  importedAt: string;
  unitCount: number;
  assetCount: number;
  sourceRevisionCount: number;
  validationFailureCount: number;
  units: BridgeImportDiffCounts;
  assets: BridgeImportDiffCounts;
  sourceRevisions: BridgeImportRevisionDiffCounts;
  futureReferences: BridgeImportFutureReferences;
};

export type ArtifactInput = {
  artifactId: string;
  projectId: string;
  artifactKind: string;
  localeBranchId?: string;
  sourceBundleId?: string;
  bridgeUnitId?: string;
  findingId?: string;
  uri?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
};

export type FindingInput = {
  projectId: string;
  localeBranchId?: string;
  finding: FindingRecordV02;
  status?: "open" | "resolved" | "superseded";
};

export type EventInput = {
  projectId: string;
  localeBranchId?: string;
  event: TriageEventV02;
};

export type BenchmarkArtifactLedgerInput = {
  artifact: ArtifactInput;
  providerRuns: ProviderRunLedgerInput[];
};

export type LocaleBranchStatus = {
  localeBranchId: string;
  targetLocale: string;
  status: string;
  currentStyleGuidePolicyVersionId: string | null;
  unitCount: number;
  translatedUnitCount: number;
  openFindingCount: number;
  artifactCount: number;
};

export type LocaleBranchIdentity = {
  localeBranchId: string;
  projectId: string;
  sourceBundleId: string;
  sourceBundleRevisionId: string;
  sourceLocale: string;
  targetLocale: string;
  branchName: string;
  status: string;
};

export type ProjectDashboardStatus = {
  projectId: string;
  projectKey: string;
  name: string;
  status: string;
  sourceLocale: string;
  /**
   * Registered engine family bound to the project (`itotori_projects.engine_family`).
   * Null when the project has not been bound to an engine yet. Opaque registry key —
   * never a hardcoded engine list on the client.
   */
  engineFamily: string | null;
  sourceBundleId: string;
  sourceBundleHash: string;
  sourceBundleRevisionId: string;
  branchCount: number;
  unitCount: number;
  findingCount: number;
  artifactCount: number;
  latestEventKind: string | null;
  latestEventAt: string | null;
  selectedLocaleBranchId: string | null;
  currentStyleGuidePolicyVersionId: string | null;
  importStatus: BridgeImportStatus;
  cost: ProjectCostReport;
  localeBranches: LocaleBranchStatus[];
};

export type RuntimeDashboardStatus = {
  finalStatus: string;
  runtimeRunId: string | null;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  textEventCount: number;
  frameCaptureCount: number;
  evidenceTier: string | null;
  screenshotArtifactCount: number;
  recordingArtifactCount: number;
  validationFindingCount: number;
  traceEvents: RuntimeDashboardTraceEvent[];
  findings: RuntimeDashboardFinding[];
  artifacts: RuntimeDashboardArtifact[];
  approximations: RuntimeDashboardApproximation[];
  unsupportedCapabilities: RuntimeDashboardUnsupportedCapability[];
  limitations: string[];
};

/**
 * Raised when a route asks for a specific runtime run that no longer exists.
 *
 * This is intentionally distinct from the unscoped "no runtime status" case:
 * a caller with a stale deep link needs a not-found diagnostic, while an
 * unscoped dashboard can still describe an empty project state separately.
 */
export class RuntimeRunNotFoundError extends Error {
  constructor(readonly runtimeRunId: string) {
    super(`runtime run ${runtimeRunId} was not found`);
    this.name = "RuntimeRunNotFoundError";
  }
}

/**
 * An EXPLICIT project scope named a project that does not exist. Distinct from
 * the unscoped "no project state at all" case: a scoped read must fail closed
 * with a not-found diagnostic instead of silently answering from whichever
 * project happens to be the most recently updated one.
 */
export class ProjectScopeNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} was not found`);
    this.name = "ProjectScopeNotFoundError";
  }
}

export type RuntimeDashboardTraceEvent = {
  runtimeEventId: string;
  eventKind: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  draftId: string | null;
  runtimeTargetId: string | null;
  evidenceTier: string | null;
  frame: number | null;
  textPreview: string | null;
  artifactIds: string[];
};

export type RuntimeDashboardFinding = {
  findingId: string;
  findingKind: string;
  severity: string;
  message: string;
  evidenceTier: string;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  artifactId: string | null;
};

export type RuntimeDashboardArtifact = {
  artifactId: string;
  artifactKind: string;
  uri: string | null;
  hash: string | null;
  hashProvenance: RuntimeArtifactHashProvenance | null;
  mediaType: string | null;
  byteSize: number | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  diagnostic: string | null;
};

/**
 * Discriminator that tells dashboard readers whether a runtime artifact hash
 * was supplied by the adapter as authentic content evidence (`content`) or
 * was generated by the repository as a deterministic placeholder over
 * managed-artifact metadata (`repository_fallback`). Persisted on the
 * artifact row's metadata at save time so the dashboard cannot mistake a
 * placeholder for content proof.
 */
export const RUNTIME_ARTIFACT_HASH_PROVENANCES = ["content", "repository_fallback"] as const;

export type RuntimeArtifactHashProvenance = (typeof RUNTIME_ARTIFACT_HASH_PROVENANCES)[number];

export type RuntimeDashboardApproximation = {
  approximationId: string;
  approximationTier: string;
  scope: string;
  description: string;
  evidenceTierCeiling: string;
  bridgeUnitIds: string[];
};

export type RuntimeDashboardUnsupportedCapability = {
  feature: string;
  status: string;
  fidelityTierCeiling: string | null;
  evidenceTierCeiling: string | null;
  limitations: string[];
};

export type DashboardPendingDecisionKind =
  | "project_finding"
  | "locale_branch_finding"
  | "runtime_validation";

export type DashboardPendingDecision = {
  decisionId: string;
  decisionKind: DashboardPendingDecisionKind;
  projectId: string;
  findingId: string;
  findingKind: string;
  severity: string;
  qualityCategory: string | null;
  title: string;
  localeBranchId: string | null;
  targetLocale: string | null;
  branchStatus: string | null;
  runtimeRunId: string | null;
  runtimeStatus: string | null;
  createdAt: string;
};

export type DashboardDecisionCounts = {
  pendingDecisionCount: number;
  projectFindingDecisionCount: number;
  localeBranchFindingDecisionCount: number;
  runtimeValidationDecisionCount: number;
};

export type DashboardDecisionReadModel = {
  projectId: string;
  counts: DashboardDecisionCounts;
  pendingDecisions: DashboardPendingDecision[];
};

/**
 * Per-(qa agent, evaluated system) calibration recorded with a benchmark
 * report. `truePositives` / `falsePositives` / `falseNegatives` are the QA
 * FP/FN representation the cost & quality dashboard surfaces; they are
 * computed at record time from the report's seeded-defect oracle (never
 * re-estimated) and persisted in the benchmark_report artifact metadata.
 */
export type BenchmarkQaAgentSummary = {
  qaAgentId: string;
  qaAgentVersion: string;
  evaluatedSystemId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  seededPrecision: number;
  seededRecall: number;
  f1: number;
  findingsEmitted: number;
  scorableFindings: number;
};

/**
 * A recorded benchmark report as read back for the cost & quality
 * dashboard's benchmark views + report drilldown. Sourced from the
 * persisted benchmark_report artifact; the cost side is tracked
 * separately through the ledger (`ProjectCostReport`).
 */
export type BenchmarkReportSummary = {
  benchmarkRunId: string;
  projectId: string;
  localeBranchId: string | null;
  benchmarkName: string;
  status: string;
  createdAt: string;
  sourceLocale: string;
  targetLocale: string;
  systemCount: number;
  findingCount: number;
  penaltyTotal: number;
  qaAgents: BenchmarkQaAgentSummary[];
};
