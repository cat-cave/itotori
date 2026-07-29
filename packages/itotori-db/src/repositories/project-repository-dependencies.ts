export { createHash } from "node:crypto";
export { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
export {
  assertPatchExport,
  assertPatchExportV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  BRIDGE_SCHEMA_VERSION_V02,
  evaluatePatchExportCompatibilityV02,
  RUNTIME_ARTIFACT_KINDS_V02,
} from "@itotori/localization-bridge-schema";
export type {
  BridgeAssetV02,
  BridgeBundle,
  BridgeBundleV02,
  FindingRecordV02,
  LocalizationUnitV02,
  PatchExport,
  PatchExportV02,
  PatchResultV02,
  RuntimeArtifactRefV02,
  RuntimeArtifactKindV02,
  RuntimeBridgeUnitRefV02,
  RuntimeEvidenceReportV02,
  RuntimeValidationFindingV02,
  RuntimeVerificationReport,
  SourceRevisionV02,
  TriageEventV02,
} from "@itotori/localization-bridge-schema";
export type { ItotoriDatabase } from "../connection.js";
export { bootstrapLocalUser, permissionValues, requirePermission } from "../authorization.js";
export type { AuthorizationActor } from "../authorization.js";
export {
  ItotoriModelLedgerRepository,
  insertProviderRunLedgerRows,
} from "./model-ledger-repository.js";
export type { ProjectCostReport, ProviderRunLedgerInput } from "./model-ledger-repository.js";
export { ensureBranchPolicyGlossaryReferenceInTx } from "./branch-reference-repository.js";
export {
  artifacts,
  assets,
  bridgeImports,
  costLedgerEntries,
  eventOutbox,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  findings,
  jobEvents,
  jobQueue,
  localeBranches,
  localeBranchStatusValues,
  localeBranchUnits,
  modelProviders,
  modelRegistry,
  promptPresets,
  projectStatusValues,
  projects,
  providerRuns,
  runtimeBridgeUnitRefRoleValues,
  runtimeEvidenceBridgeUnitRefs,
  runtimeEvidenceItems,
  runtimeEvidenceKindValues,
  runtimeEvidenceRuns,
  runtimeValidationFindings,
  sourceBundles,
  sourceRevisions,
  sourceUnits,
  styleGuides,
  styleGuideVersions,
  translationMemoryReuseEvents,
  translationMemorySegments,
  workspaces,
} from "../schema.js";
export type { RuntimeBridgeUnitRefRole, RuntimeEvidenceKind } from "../schema.js";
