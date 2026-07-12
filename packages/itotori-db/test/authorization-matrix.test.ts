import { readdirSync, readFileSync } from "node:fs";
import type { Node } from "@babel/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isCallExpression,
  isMemberExpression,
  leadingCommentText,
  memberPropertyName,
  nameOf,
  parseTypeScript,
  permissionHelperAliases,
  permissionHelperCallName,
  sourceLocation,
  walk,
} from "../../../scripts/stable-ts-ast.mjs";
import {
  permissionValues,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import { ItotoriAuthMemberManagementRepository } from "../src/repositories/auth-member-management-repository.js";
import { ItotoriAuthBillingSeatRepository } from "../src/repositories/auth-billing-seat-repository.js";
import { ItotoriAuthSessionService } from "../src/repositories/auth-session-service.js";
import { ItotoriAssetLocalizationDecisionRepository } from "../src/repositories/asset-localization-decision-repository.js";
import { ItotoriAuditFindingRepository } from "../src/repositories/audit-finding-repository.js";
import { ItotoriBenchmarkRunRepository } from "../src/repositories/benchmark-run-repository.js";
import { ItotoriAuthSsoSettingsRepository } from "../src/repositories/auth-sso-settings-repository.js";
import { ItotoriReviewerQueueRepository } from "../src/repositories/reviewer-queue-repository.js";
import { ItotoriBranchReferenceRepository } from "../src/repositories/branch-reference-repository.js";
import { ItotoriConformanceRepository } from "../src/repositories/conformance-repository.js";
import { EngineCapabilityReportRepository } from "../src/repositories/engine-capability-report-repository.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import { ItotoriContextArtifactRepository } from "../src/repositories/context-artifact-repository.js";
import { ItotoriDraftJobRepository } from "../src/repositories/draft-job-repository.js";
import { ItotoriEventQueueRepository } from "../src/repositories/event-queue-repository.js";
import { ItotoriExactSearchDocumentRepository } from "../src/repositories/exact-search-document-repository.js";
import { ItotoriFeedbackRepository } from "../src/repositories/feedback-repository.js";
import { ItotoriLocalizationJournalRepository } from "../src/repositories/localization-journal-repository.js";
import { ItotoriModelLedgerRepository } from "../src/repositories/model-ledger-repository.js";
import { ItotoriModelRoutingSettingsRepository } from "../src/repositories/model-routing-settings-repository.js";
import {
  type ItotoriPrincipalRepositoryPort,
  ItotoriPrincipalRepository,
  listAccountPermissionSets,
  loadPermissionSetAccountId,
} from "../src/repositories/principal-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import { ItotoriTranslationBatchRepository } from "../src/repositories/translation-batch-repository.js";
import { ItotoriSceneCoverageRepository } from "../src/repositories/scene-coverage-repository.js";
import { ItotoriSemanticContextReadRepository } from "../src/repositories/semantic-context-read-repository.js";
import { ItotoriSourceUnitRepository } from "../src/repositories/source-unit-repository.js";
import { ItotoriTranslationMemoryRepository } from "../src/repositories/translation-memory-repository.js";
import { ItotoriTranslationScopeSettingsRepository } from "../src/repositories/translation-scope-settings-repository.js";
import { ItotoriLocalizationPassRunConfigRepository } from "../src/repositories/localization-pass-run-config-repository.js";
import { ItotoriWikiReadmodelRepository } from "../src/repositories/wiki-readmodel-repository.js";
import { ItotoriWorkspaceCorrectionRepository } from "../src/repositories/workspace-correction-repository.js";
import type { DatabaseContext, ItotoriDatabase } from "../src/connection.js";
import { assertDeniedRepositoryMutation } from "./authorization-test-helpers.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

type PermissionKey = keyof typeof permissionValues;

type RepositoryPermissionGateCase = {
  repository: string;
  sourceFile: string;
  mutation: string;
  permissionKey: PermissionKey;
  requiredPermission: Permission;
  successFixture: string;
  denialFixture: string;
  runDeniedMutation: (db: ItotoriDatabase) => Promise<unknown>;
};

const repositoryPermissionGateMatrix = [
  projectGate("reset", "systemReset", "repository.test.ts reset coverage", (repo) =>
    repo.reset(deniedActor),
  ),
  projectGate("importSourceBundle", "projectImport", "repository.test.ts import coverage", (repo) =>
    repo.importSourceBundle(deniedActor, undefined as never),
  ),
  projectGate(
    "ensureRunProjectScope",
    "projectImport",
    "project-run-scope-provisioning.test.ts run scope provisioning coverage",
    (repo) => repo.ensureRunProjectScope(deniedActor, undefined as never),
  ),
  projectGate("saveDrafts", "draftWrite", "repository.test.ts draft persistence coverage", (repo) =>
    repo.saveDrafts(deniedActor, undefined as never),
  ),
  projectGate(
    "savePatchExport",
    "patchExport",
    "repository.test.ts patch export persistence coverage",
    (repo) => repo.savePatchExport(deniedActor, undefined as never, undefined as never),
  ),
  projectGate(
    "saveRuntimeReport",
    "runtimeIngest",
    "repository.test.ts runtime report persistence coverage",
    (repo) =>
      repo.saveRuntimeReport(deniedActor, undefined as never, undefined as never, "patch-result"),
  ),
  projectGate("appendEvent", "runtimeIngest", "repository.test.ts event coverage", (repo) =>
    repo.appendEvent(deniedActor, undefined as never),
  ),
  projectGate("recordFinding", "runtimeIngest", "repository.test.ts finding coverage", (repo) =>
    repo.recordFinding(deniedActor, undefined as never),
  ),
  projectGate("linkArtifact", "runtimeIngest", "repository.test.ts artifact coverage", (repo) =>
    repo.linkArtifact(deniedActor, undefined as never),
  ),
  projectGate(
    "getRuntimeStatus",
    "catalogRead",
    "repository.test.ts runtime status coverage",
    (repo) => repo.getRuntimeStatus(deniedActor, "runtime-denied"),
  ),
  projectGate(
    "recordBenchmarkArtifactWithProviderLedger",
    "runtimeIngest",
    "model-ledger-repository.test.ts atomic benchmark artifact coverage",
    (repo) => repo.recordBenchmarkArtifactWithProviderLedger(deniedActor, undefined as never),
  ),
  feedbackGate(
    "importManualFeedback",
    "feedbackImport",
    "repository.test.ts manual feedback coverage",
    (repo) => repo.importManualFeedback(deniedActor, undefined as never),
  ),
  feedbackGate(
    "loadManualFeedbackReviewerQueueContext",
    "feedbackImport",
    "repository.test.ts manual feedback queue context coverage",
    (repo) =>
      repo.loadManualFeedbackReviewerQueueContext(
        deniedActor,
        "feedback-report-denied",
        "feedback-evidence-denied",
      ),
  ),
  modelLedgerGate(
    "recordProviderRun",
    "runtimeIngest",
    "model-ledger-repository.test.ts provider run coverage",
    (repo) => repo.recordProviderRun(deniedActor, undefined as never),
  ),
  modelLedgerGate(
    "countZdrEnforcedByPair",
    "catalogRead",
    "model-ledger-repository.test.ts ZDR-enforced count coverage",
    (repo) =>
      repo.countZdrEnforcedByPair(deniedActor, "project-denied", {
        from: new Date("2026-06-01T00:00:00Z"),
        to: new Date("2026-06-30T00:00:00Z"),
      }),
  ),
  modelLedgerGate(
    "countCostKindsByPair",
    "catalogRead",
    "model-ledger-repository.test.ts cost kind count coverage",
    (repo) =>
      repo.countCostKindsByPair(deniedActor, "project-denied", {
        from: new Date("2026-06-01T00:00:00Z"),
        to: new Date("2026-06-30T00:00:00Z"),
      }),
  ),
  modelLedgerGate(
    "getProjectCostReport",
    "catalogRead",
    "model-ledger-repository.test.ts project cost report coverage",
    (repo) => repo.getProjectCostReport(deniedActor, "project-denied"),
  ),
  modelLedgerGate(
    "getCostLedgerDrilldown",
    "catalogRead",
    "model-ledger-repository.test.ts cost drilldown coverage",
    (repo) => repo.getCostLedgerDrilldown(deniedActor, { projectId: "project-denied" }),
  ),
  modelLedgerGate(
    "getProjectTelemetryTimeseries",
    "catalogRead",
    "model-ledger-repository.test.ts telemetry timeseries coverage",
    (repo) => repo.getProjectTelemetryTimeseries(deniedActor, "project-denied"),
  ),
  queueGate(
    "appendOutboxEvent",
    "queueManage",
    "event-queue-repository.test.ts outbox event coverage",
    (repo) => repo.appendOutboxEvent(deniedActor, undefined as never),
  ),
  queueGate("enqueueJob", "queueManage", "event-queue-repository.test.ts job coverage", (repo) =>
    repo.enqueueJob(deniedActor, undefined as never),
  ),
  queueGate(
    "enqueueJobs",
    "queueManage",
    "event-queue-repository.test.ts atomic job chain coverage",
    (repo) => repo.enqueueJobs(deniedActor, undefined as never),
  ),
  queueGate(
    "appendOutboxEventWithJobs",
    "queueManage",
    "event-queue-repository.test.ts outbox plus jobs coverage",
    (repo) => repo.appendOutboxEventWithJobs(deniedActor, undefined as never),
  ),
  queueGate(
    "claimOutboxEvents",
    "queueManage",
    "event-queue-repository.test.ts outbox claim coverage",
    (repo) => repo.claimOutboxEvents(deniedActor, "worker"),
  ),
  queueGate(
    "markOutboxEventPublished",
    "queueManage",
    "event-queue-repository.test.ts outbox publish coverage",
    (repo) => repo.markOutboxEventPublished(deniedActor, "outbox", "worker"),
  ),
  queueGate(
    "markOutboxEventFailed",
    "queueManage",
    "event-queue-repository.test.ts outbox failure coverage",
    (repo) => repo.markOutboxEventFailed(deniedActor, "outbox", "worker", undefined as never),
  ),
  queueGate(
    "recoverExpiredOutboxLeases",
    "queueManage",
    "event-queue-repository.test.ts outbox lease recovery coverage",
    (repo) => repo.recoverExpiredOutboxLeases(deniedActor),
  ),
  queueGate(
    "claimJobs",
    "queueManage",
    "event-queue-repository.test.ts job claim coverage",
    (repo) => repo.claimJobs(deniedActor, "worker"),
  ),
  queueGate(
    "completeJob",
    "queueManage",
    "event-queue-repository.test.ts job completion coverage",
    (repo) => repo.completeJob(deniedActor, "job", "worker"),
  ),
  queueGate(
    "failJob",
    "queueManage",
    "event-queue-repository.test.ts job failure coverage",
    (repo) => repo.failJob(deniedActor, "job", "worker", undefined as never),
  ),
  queueGate(
    "recoverExpiredJobLeases",
    "queueManage",
    "event-queue-repository.test.ts job lease recovery coverage",
    (repo) => repo.recoverExpiredJobLeases(deniedActor),
  ),
  queueGate(
    "getOutboxEvent",
    "queueRead",
    "event-queue-repository.test.ts authorized outbox read coverage",
    (repo) => repo.getOutboxEvent(deniedActor, "outbox"),
  ),
  queueGate(
    "getJob",
    "queueRead",
    "event-queue-repository.test.ts authorized job read coverage",
    (repo) => repo.getJob(deniedActor, "job"),
  ),
  queueGate(
    "getJobEvents",
    "queueRead",
    "job-events-audit.test.ts job event read coverage",
    (repo) => repo.getJobEvents(deniedActor, "job"),
  ),
  queueGate(
    "pruneJobEvents",
    "queueManage",
    "job-events-audit.test.ts retention prune coverage",
    (repo) => repo.pruneJobEvents(deniedActor),
  ),
  queueGate(
    "loadQueueHealth",
    "queueRead",
    "event-queue-queue-health.test.ts queue health read coverage",
    (repo) => repo.loadQueueHealth(deniedActor),
  ),
  catalogGate(
    "recordSourceProvenance",
    "catalogWrite",
    "catalog-repository.test.ts source provenance coverage",
    (repo) => repo.recordSourceProvenance(deniedActor, undefined as never),
  ),
  catalogGate("upsertWork", "catalogWrite", "catalog-repository.test.ts work coverage", (repo) =>
    repo.upsertWork(deniedActor, undefined as never),
  ),
  catalogGate(
    "recordLocalScan",
    "catalogWrite",
    "catalog-repository.test.ts local scan coverage",
    (repo) => repo.recordLocalScan(deniedActor, undefined as never),
  ),
  catalogGate(
    "recordSeedTarget",
    "catalogWrite",
    "catalog-repository.test.ts seed target coverage",
    (repo) => repo.recordSeedTarget(deniedActor, undefined as never),
  ),
  catalogGate(
    "getWorkSnapshot",
    "catalogRead",
    "catalog-repository.test.ts work read coverage",
    (repo) => repo.getWorkSnapshot(deniedActor, "work"),
  ),
  catalogGate(
    "getWorkByExternalId",
    "catalogRead",
    "catalog-repository.test.ts external id read coverage",
    (repo) => repo.getWorkByExternalId(deniedActor, undefined as never, "source"),
  ),
  catalogGate(
    "listSeedTargets",
    "catalogRead",
    "catalog-repository.test.ts seed target read coverage",
    (repo) => repo.listSeedTargets(deniedActor),
  ),
  catalogGate(
    "listBenchmarkSelectableSeedTargets",
    "catalogRead",
    "catalog-recorded-importers.test.ts benchmark selectable seed read coverage",
    (repo) => repo.listBenchmarkSelectableSeedTargets(deniedActor),
  ),
  catalogGate(
    "listCatalogCandidateTargetWorks",
    "catalogRead",
    "catalog-repository.test.ts candidate target read coverage",
    (repo) => repo.listCatalogCandidateTargetWorks(deniedActor),
  ),
  catalogGate(
    "recordCatalogCandidateMatch",
    "catalogWrite",
    "catalog-repository.test.ts candidate match coverage",
    (repo) => repo.recordCatalogCandidateMatch(deniedActor, undefined as never),
  ),
  catalogGate(
    "listCatalogCandidateMatches",
    "catalogRead",
    "catalog-repository.test.ts candidate match read coverage",
    (repo) => repo.listCatalogCandidateMatches(deniedActor),
  ),
  catalogGate(
    "catalogConflictReview",
    "catalogRead",
    "catalog-conflict-review.test.ts read model coverage",
    (repo) => repo.catalogConflictReview(deniedActor),
  ),
  catalogGate(
    "catalogCompletenessBenchmarkPools",
    "catalogRead",
    "catalog-repository.test.ts completeness benchmark pool coverage",
    (repo) => repo.catalogCompletenessBenchmarkPools(deniedActor),
  ),
  catalogGate(
    "catalogAlphaBenchmarkOpportunityRanking",
    "catalogRead",
    "catalog-recorded-importers.test.ts alpha benchmark opportunity ranking coverage",
    (repo) => repo.catalogAlphaBenchmarkOpportunityRanking(deniedActor),
  ),
  catalogGate(
    "catalogOpportunityRanking",
    "catalogRead",
    "catalog-opportunity-ranking-read-model.test.ts read model coverage",
    (repo) => repo.catalogOpportunityRanking(deniedActor, { limit: 20 }),
  ),
  catalogGate(
    "catalogContextPanelForWork",
    "catalogRead",
    "catalog-context-panel read model coverage (itotori-119 panel route)",
    (repo) =>
      repo.catalogContextPanelForWork(deniedActor, {
        workId: "work-id",
        targetLanguage: "en-US",
      }),
  ),
  catalogGate(
    "catalogBenchmarkSeedFinder",
    "catalogRead",
    "catalog-benchmark-seed-finder.test.ts read model coverage",
    (repo) => repo.catalogBenchmarkSeedFinder(deniedActor),
  ),
  catalogCrawlerGate(
    "getCheckpoint",
    "catalogRead",
    "catalog-crawler-repository.test.ts checkpoint read coverage",
    (repo) => repo.getCheckpoint(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "startCrawlerJob",
    "catalogWrite",
    "catalog-crawler-repository.test.ts crawler job start coverage",
    (repo) => repo.startCrawlerJob(deniedActor, "worker", undefined as never),
  ),
  catalogCrawlerGate(
    "recordFetchedStep",
    "catalogWrite",
    "catalog-crawler-repository.test.ts fetched step coverage",
    (repo) => repo.recordFetchedStep(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "commitStepImport",
    "catalogWrite",
    "catalog-crawler-repository.test.ts atomic step commit coverage",
    (repo) => repo.commitStepImport(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "markStepImported",
    "catalogWrite",
    "catalog-crawler-repository.test.ts imported marker coverage",
    (repo) => repo.markStepImported(deniedActor, "step", "worker"),
  ),
  catalogCrawlerGate(
    "markStepFailed",
    "catalogWrite",
    "catalog-crawler-repository.test.ts failed marker coverage",
    (repo) => repo.markStepFailed(deniedActor, "step", new Error("failed"), "worker"),
  ),
  catalogCrawlerGate(
    "saveCheckpoint",
    "catalogWrite",
    "catalog-crawler-repository.test.ts checkpoint write coverage",
    (repo) => repo.saveCheckpoint(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "saveRateLimit",
    "catalogWrite",
    "catalog-crawler-repository.test.ts rate-limit write coverage",
    (repo) => repo.saveRateLimit(deniedActor, undefined as never),
  ),
  catalogCrawlerGate(
    "completeCrawlerJob",
    "catalogWrite",
    "catalog-crawler-repository.test.ts crawler job completion coverage",
    (repo) => repo.completeCrawlerJob(deniedActor, "job", "worker", null),
  ),
  catalogCrawlerGate(
    "failCrawlerJob",
    "catalogWrite",
    "catalog-crawler-repository.test.ts crawler job failure coverage",
    (repo) => repo.failCrawlerJob(deniedActor, "job", "worker", new Error("failed")),
  ),
  branchReferenceGate(
    "resolveBranchPolicyGlossaryReference",
    "catalogRead",
    "terminology-repository.test.ts branch-scoped policy/glossary coverage",
    (repo) =>
      repo.resolveBranchPolicyGlossaryReference(deniedActor, {
        projectId: "project",
        localeBranchId: "locale",
      }),
  ),
  branchReferenceGate(
    "updateBranchPolicyGlossaryReference",
    "draftWrite",
    "terminology-repository.test.ts branch reference update coverage",
    (repo) =>
      repo.updateBranchPolicyGlossaryReference(deniedActor, {
        projectId: "project",
        localeBranchId: "locale",
        updateReason: "permission_denial_fixture",
      }),
  ),
  styleGuideGate(
    "createVersion",
    "draftWrite",
    "style-guide-repository.test.ts version persistence coverage",
    (repo) => repo.createVersion(deniedActor, undefined as never),
  ),
  styleGuideGate(
    "authorizeApproval",
    "styleGuideApprove",
    "style-guide-repository.test.ts approval authorization coverage",
    (repo) => repo.authorizeApproval(deniedActor),
  ),
  styleGuideGate(
    "approveVersion",
    "styleGuideApprove",
    "style-guide-repository.test.ts approval coverage",
    (repo) => repo.approveVersion(deniedActor, undefined as never),
  ),
  terminologyGate(
    "upsertTerm",
    "draftWrite",
    "terminology-repository.test.ts term persistence coverage",
    (repo) => repo.upsertTerm(deniedActor, undefined as never),
  ),
  terminologyGate(
    "searchTerms",
    "catalogRead",
    "terminology-repository.test.ts term search coverage",
    (repo) => repo.searchTerms(deniedActor, undefined as never),
  ),
  terminologyGate(
    "listConflicts",
    "catalogRead",
    "terminology-repository.test.ts conflict listing coverage",
    (repo) => repo.listConflicts(deniedActor),
  ),
  terminologyGate(
    "getGlossaryContext",
    "catalogRead",
    "terminology-repository.test.ts glossary context coverage",
    (repo) => repo.getGlossaryContext(deniedActor, undefined as never),
  ),
  terminologyGate(
    "upsertGlossaryReviewItem",
    "draftWrite",
    "terminology-repository.test.ts glossary review item coverage",
    (repo) => repo.upsertGlossaryReviewItem(deniedActor, undefined as never),
  ),
  terminologyGate(
    "listGlossaryReviewItems",
    "catalogRead",
    "terminology-repository.test.ts glossary review queue coverage",
    (repo) => repo.listGlossaryReviewItems(deniedActor),
  ),
  translationMemoryGate(
    "upsertSegment",
    "draftWrite",
    "translation-memory-repository.test.ts segment persistence coverage",
    (repo) => repo.upsertSegment(deniedActor, undefined as never),
  ),
  translationMemoryGate(
    "recordReuse",
    "draftWrite",
    "translation-memory-repository.test.ts reuse provenance coverage",
    (repo) => repo.recordReuse(deniedActor, undefined as never),
  ),
  exactSearchGate(
    "refreshDocuments",
    "projectImport",
    "exact-search-document-repository.test.ts refresh coverage",
    (repo) => repo.refreshDocuments(deniedActor, undefined as never),
  ),
  exactSearchGate(
    "searchExact",
    "catalogRead",
    "exact-search-document-repository.test.ts search.exact coverage",
    (repo) => repo.searchExact(deniedActor, undefined as never),
  ),
  contextArtifactGate(
    "upsertArtifact",
    "projectImport",
    "context-artifact-repository.test.ts artifact upsert coverage",
    (repo) => repo.upsertArtifact(deniedActor, undefined as never),
  ),
  contextArtifactGate(
    "invalidateAffectedArtifacts",
    "projectImport",
    "context-artifact-repository.test.ts source invalidation coverage",
    (repo) => repo.invalidateAffectedArtifacts(deniedActor, undefined as never),
  ),
  contextArtifactGate(
    "retrieveArtifacts",
    "catalogRead",
    "context-artifact-repository.test.ts retrieval coverage",
    (repo) => repo.retrieveArtifacts(deniedActor, undefined as never),
  ),
  contextArtifactGate(
    "listEntryVersions",
    "catalogRead",
    "context-artifact-repository.test.ts entry history coverage",
    (repo) => repo.listEntryVersions(deniedActor, undefined as never),
  ),
  semanticContextReadGate(
    "loadArtifacts",
    "catalogRead",
    "context-artifact-repository.test.ts central semantic projection coverage",
    (repo) => repo.loadSceneSummaries(deniedActor, undefined as never),
  ),
  sourceUnitGate(
    "currentSourceHashes",
    "catalogRead",
    "context-artifact-repository.test.ts source-unit hash coverage",
    (repo) => repo.currentSourceHashes(deniedActor, undefined as never),
  ),
  sourceUnitGate(
    "loadSourceUnits",
    "catalogRead",
    "context-artifact-repository.test.ts source-unit hydration coverage",
    (repo) => repo.loadSourceUnits(deniedActor, undefined as never),
  ),
  sourceUnitGate(
    "loadSourceUnitsForScope",
    "catalogRead",
    "context-artifact-repository.test.ts source-unit scope coverage",
    (repo) => repo.loadSourceUnitsForScope(deniedActor, undefined as never),
  ),
  translationBatchGate(
    "saveBatches",
    "draftWrite",
    "translation-batch-repository.test.ts save coverage",
    (repo) => repo.saveBatches(deniedActor, undefined as never),
  ),
  translationBatchGate(
    "loadBatches",
    "catalogRead",
    "translation-batch-repository.test.ts load coverage",
    (repo) => repo.loadBatches(deniedActor, undefined as never),
  ),
  translationBatchGate(
    "loadBatchById",
    "catalogRead",
    "translation-batch-repository.test.ts load-by-id coverage",
    (repo) => repo.loadBatchById(deniedActor, "batch-id"),
  ),
  conformanceGate(
    "saveConformanceRun",
    "runtimeIngest",
    "conformance-repository.test.ts save coverage",
    (repo) => repo.saveConformanceRun(deniedActor, undefined as never),
  ),
  conformanceGate(
    "loadConformanceRun",
    "catalogRead",
    "conformance-repository.test.ts load coverage",
    (repo) => repo.loadConformanceRun(deniedActor, "conformance-run-id"),
  ),
  engineCapabilityReportGate(
    "writeMatrix",
    "projectImport",
    "engine-capability-report-repository.test.ts write matrix coverage",
    (repo) =>
      repo.writeMatrix(deniedActor, {
        adapterId: "kaifuu.test",
        identify: { kind: "supported" },
        inventory: { kind: "supported" },
        extract: { kind: "supported" },
        patch: { kind: "supported" },
      }),
  ),
  engineCapabilityReportGate(
    "recordCapabilityEvidence",
    "projectImport",
    "engine-capability-report-repository.test.ts capability evidence coverage",
    (repo) => repo.recordCapabilityEvidence(deniedActor, undefined as never),
  ),
  wikiReadmodelGate(
    "loadEntries",
    "catalogRead",
    "wiki-readmodel-repository.test.ts entries read-model coverage",
    (repo) =>
      repo.loadEntries(deniedActor, {
        projectId: "project-denied",
        localeBranchId: "locale-denied",
      }),
  ),
  draftJobGate(
    "createDraftJob",
    "draftWrite",
    "draft-job-repository.test.ts create draft job coverage",
    (repo) => repo.createDraftJob(deniedActor, undefined as never),
  ),
  draftJobGate(
    "recordAttempt",
    "draftWrite",
    "draft-job-repository.test.ts record attempt coverage",
    (repo) => repo.recordAttempt(deniedActor, "draft-job", undefined as never),
  ),
  draftJobGate(
    "markAttemptSucceeded",
    "draftWrite",
    "draft-job-repository.test.ts mark attempt succeeded coverage",
    (repo) => repo.markAttemptSucceeded(deniedActor, "draft-job-attempt", new Date()),
  ),
  draftJobGate(
    "markAttemptFailed",
    "draftWrite",
    "draft-job-repository.test.ts mark attempt failed coverage",
    (repo) => repo.markAttemptFailed(deniedActor, "draft-job-attempt", "reason", false, new Date()),
  ),
  draftJobGate(
    "cancelDraftJob",
    "draftWrite",
    "draft-job-repository.test.ts cancel draft job coverage",
    (repo) => repo.cancelDraftJob(deniedActor, "draft-job"),
  ),
  draftJobGate(
    "loadDraftJob",
    "catalogRead",
    "draft-job-repository.test.ts load draft job coverage",
    (repo) => repo.loadDraftJob(deniedActor, "draft-job"),
  ),
  draftJobGate(
    "loadDraftJobsByProject",
    "catalogRead",
    "draft-job-repository.test.ts load draft jobs by project coverage",
    (repo) => repo.loadDraftJobsByProject(deniedActor, "project"),
  ),
  draftJobGate(
    "loadDraftJobAttempts",
    "catalogRead",
    "draft-job-repository.test.ts load draft job attempts coverage",
    (repo) => repo.loadDraftJobAttempts(deniedActor, "draft-job"),
  ),
  assetLocalizationDecisionGate(
    "recordDecision",
    "draftWrite",
    "asset-localization-decision-repository.test.ts record decision coverage",
    (repo) => repo.recordDecision(deniedActor, undefined as never),
  ),
  assetLocalizationDecisionGate(
    "recordDecisionsBulk",
    "draftWrite",
    "asset-localization-decision-repository.test.ts record decisions bulk coverage",
    (repo) => repo.recordDecisionsBulk(deniedActor, undefined as never),
  ),
  assetLocalizationDecisionGate(
    "loadActiveDecisions",
    "catalogRead",
    "asset-localization-decision-repository.test.ts load active decisions coverage",
    (repo) => repo.loadActiveDecisions(deniedActor, "project", "locale"),
  ),
  assetLocalizationDecisionGate(
    "loadCandidateAssets",
    "catalogRead",
    "asset-localization-decision-repository.test.ts load candidate assets coverage",
    (repo) => repo.loadCandidateAssets(deniedActor, "project", "locale"),
  ),
  assetLocalizationDecisionGate(
    "loadDecisionHistory",
    "catalogRead",
    "asset-localization-decision-repository.test.ts load decision history coverage",
    (repo) =>
      repo.loadDecisionHistory(deniedActor, "project", "locale", {
        kind: "bridgeAssetRef",
        ref: "asset.json#example",
      }),
  ),
  assetLocalizationDecisionGate(
    "loadDecisionsByPolicy",
    "catalogRead",
    "asset-localization-decision-repository.test.ts load decisions by policy coverage",
    (repo) => repo.loadDecisionsByPolicy(deniedActor, "project", "locale", "keep_original"),
  ),
  benchmarkRunGate(
    "recordRun",
    "runtimeIngest",
    "benchmark-run-repository.test.ts record run coverage",
    (repo) => repo.recordRun(deniedActor, undefined as never),
  ),
  benchmarkRunGate(
    "loadRun",
    "catalogRead",
    "benchmark-run-repository.test.ts load run coverage",
    (repo) => repo.loadRun(deniedActor, "bmk-run-x"),
  ),
  benchmarkRunGate(
    "loadLatestRunForProject",
    "catalogRead",
    "benchmark-run-repository.test.ts load latest run for project coverage",
    (repo) => repo.loadLatestRunForProject(deniedActor, "project"),
  ),
  benchmarkRunGate(
    "loadRunsForProject",
    "catalogRead",
    "benchmark-run-repository.test.ts load runs for project coverage",
    (repo) => repo.loadRunsForProject(deniedActor, "project"),
  ),
  sceneCoverageGate(
    "setCoverage",
    "queueManage",
    "scene-coverage-repository.test.ts set coverage coverage",
    (repo) => repo.setCoverage(deniedActor, undefined as never),
  ),
  sceneCoverageGate(
    "loadCoverageForBranch",
    "queueRead",
    "scene-coverage-repository.test.ts load coverage for branch coverage",
    (repo) => repo.loadCoverageForBranch(deniedActor, undefined as never),
  ),
  sceneCoverageGate(
    "loadCoverageForScene",
    "queueRead",
    "scene-coverage-repository.test.ts load coverage for scene coverage",
    (repo) => repo.loadCoverageForScene(deniedActor, undefined as never),
  ),
  auditFindingGate(
    "recordFinding",
    "auditWrite",
    "audit-finding-repository.test.ts record finding coverage",
    (repo) => repo.recordFinding(deniedActor, undefined as never),
  ),
  auditFindingGate(
    "loadFindingsByNode",
    "catalogRead",
    "audit-finding-repository.test.ts load findings by node coverage",
    (repo) => repo.loadFindingsByNode(deniedActor, "UTSUSHI-200"),
  ),
  auditFindingGate(
    "loadFindingsByReport",
    "catalogRead",
    "audit-finding-repository.test.ts load findings by report coverage",
    (repo) => repo.loadFindingsByReport(deniedActor, "AUDIT-REPORT-1"),
  ),
  auditFindingGate(
    "loadOpenFindings",
    "catalogRead",
    "audit-finding-repository.test.ts load open findings coverage",
    (repo) => repo.loadOpenFindings(deniedActor),
  ),
  auditFindingGate(
    "markFindingFixed",
    "auditWrite",
    "audit-finding-repository.test.ts mark finding fixed coverage",
    (repo) => repo.markFindingFixed(deniedActor, "audit-finding-x", new Date()),
  ),
  auditFindingGate(
    "markFindingSuperseded",
    "auditWrite",
    "audit-finding-repository.test.ts mark finding superseded coverage",
    (repo) =>
      repo.markFindingSuperseded(deniedActor, "audit-finding-old", "audit-finding-new", new Date()),
  ),
  reviewerQueueGate(
    "createItem",
    "queueManage",
    "reviewer-queue-repository.test.ts create item coverage",
    (repo) => repo.createItem(deniedActor, undefined as never),
  ),
  reviewerQueueGate(
    "applyAction",
    "queueManage",
    "reviewer-queue-repository.test.ts apply action coverage",
    (repo) => repo.applyAction(deniedActor, undefined as never),
  ),
  reviewerQueueGate(
    "applyActionAndEnqueueJobs",
    "queueManage",
    "reviewer-queue-repository.test.ts atomic reviewer action plus jobs coverage",
    (repo) => repo.applyActionAndEnqueueJobs(deniedActor, undefined as never, undefined as never),
  ),
  reviewerQueueGate(
    "applyActionsAndEnqueueJobs",
    "queueManage",
    "reviewer-queue-repository.test.ts atomic reviewer actions plus jobs coverage",
    (repo) => repo.applyActionsAndEnqueueJobs(deniedActor, undefined as never, undefined as never),
  ),
  reviewerQueueGate(
    "getItem",
    "queueRead",
    "reviewer-queue-repository.test.ts get item coverage",
    (repo) => repo.getItem(deniedActor, "reviewer-queue-x"),
  ),
  reviewerQueueGate(
    // Manage-scoped read: importRuntimeFeedback reads the item it is about
    // to manage under queue.manage, NOT queue.read, so a read-restricted
    // manage role is not silently blocked from importing runtime evidence.
    "getItemForManage",
    "queueManage",
    "reviewer-queue-repository.test.ts get item for manage coverage",
    (repo) => repo.getItemForManage(deniedActor, "reviewer-queue-x"),
  ),
  reviewerQueueGate(
    "loadItemsByBranch",
    "queueRead",
    "reviewer-queue-repository.test.ts load items by branch coverage",
    (repo) => repo.loadItemsByBranch(deniedActor, "branch-x"),
  ),
  reviewerQueueGate(
    "loadTransitionsByItem",
    "queueRead",
    "reviewer-queue-repository.test.ts load transitions by item coverage",
    (repo) => repo.loadTransitionsByItem(deniedActor, "reviewer-queue-x"),
  ),
  workspaceCorrectionGate(
    "recordCorrectionEdit",
    "queueManage",
    "workspace-correction-repository.test.ts record correction coverage",
    (repo) => repo.recordCorrectionEdit(deniedActor, undefined as never),
  ),
  workspaceCorrectionGate(
    "loadCorrectionEditsByBranch",
    "queueRead",
    "workspace-correction-repository.test.ts load corrections by branch coverage",
    (repo) => repo.loadCorrectionEditsByBranch(deniedActor, "branch-x"),
  ),
  localizationJournalGate(
    "seedRun",
    "draftWrite",
    "localization-journal-repository.test.ts atomic run/unit seed coverage",
    (repo) => repo.seedRun(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "createRun",
    "draftWrite",
    "localization-journal-repository.test.ts create run coverage",
    (repo) => repo.createRun(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "persistAttempts",
    "draftWrite",
    "localization-journal-repository.test.ts failure-attempt persistence coverage",
    (repo) => repo.persistAttempts(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "beginAttempt",
    "draftWrite",
    "localization-journal-repository.test.ts pre-dispatch attempt coverage",
    (repo) => repo.beginAttempt(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "reserveAttemptCost",
    "draftWrite",
    "invocation-supervisor-db.test.ts atomic N-way reservation coverage",
    (repo) => repo.reserveAttemptCost(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "completeAttempt",
    "draftWrite",
    "localization-journal-repository.test.ts attempt completion coverage",
    (repo) => repo.completeAttempt(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "reconcileAttemptBilling",
    "draftWrite",
    "localization-journal-repository.test.ts late billed-cost reconciliation coverage",
    (repo) => repo.reconcileAttemptBilling(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "persistUnit",
    "draftWrite",
    "localization-journal-repository.test.ts atomic outcome persistence coverage",
    (repo) => repo.persistUnit(deniedActor, undefined as never),
  ),
  localizationJournalGate(
    "loadRun",
    "catalogRead",
    "localization-journal-repository.test.ts run read coverage",
    (repo) => repo.loadRun(deniedActor, "journal-run-denied"),
  ),
  localizationJournalGate(
    "loadRunCostAccount",
    "catalogRead",
    "invocation-supervisor-db.test.ts durable cost account coverage",
    (repo) => repo.loadRunCostAccount(deniedActor, "journal-run-denied"),
  ),
  localizationJournalGate(
    "loadCostReservations",
    "catalogRead",
    "invocation-supervisor-db.test.ts durable cost reservation coverage",
    (repo) => repo.loadCostReservations(deniedActor, "journal-run-denied"),
  ),
  localizationJournalGate(
    "loadRunUnits",
    "catalogRead",
    "localization-journal-repository.test.ts planned unit read coverage",
    (repo) => repo.loadRunUnits(deniedActor, "journal-run-denied"),
  ),
  localizationJournalGate(
    "pauseRun",
    "draftWrite",
    "localization-journal-repository.test.ts operational pause coverage",
    (repo) =>
      repo.pauseRun(deniedActor, "journal-run-denied", undefined as never, undefined as never),
  ),
  localizationJournalGate(
    "resumeRun",
    "draftWrite",
    "localization-journal-repository.test.ts operational resume coverage",
    (repo) => repo.resumeRun(deniedActor, "journal-run-denied", undefined as never),
  ),
  localizationJournalGate(
    "raiseRunCostCap",
    "draftWrite",
    "invocation-supervisor-db.test.ts cap raise coverage",
    (repo) => repo.raiseRunCostCap(deniedActor, "journal-run-denied", "1"),
  ),
  localizationJournalGate(
    "renewRunLease",
    "draftWrite",
    "localization-journal-repository.test.ts live lease renewal coverage",
    (repo) => repo.renewRunLease(deniedActor, "journal-run-denied", undefined as never),
  ),
  localizationJournalGate(
    "releaseRunLease",
    "draftWrite",
    "localization-journal-repository.test.ts paused lease release coverage",
    (repo) => repo.releaseRunLease(deniedActor, "journal-run-denied", undefined as never),
  ),
  localizationJournalGate(
    "loadRunsForBranch",
    "catalogRead",
    "localization-journal-repository.test.ts branch history read coverage",
    (repo) => repo.loadRunsForBranch(deniedActor, "locale-branch-denied"),
  ),
  localizationJournalGate(
    "loadRunOutcomes",
    "catalogRead",
    "localization-journal-repository.test.ts outcome provenance read coverage",
    (repo) => repo.loadRunOutcomes(deniedActor, "journal-run-denied"),
  ),
  localizationJournalGate(
    "loadAttemptsForRun",
    "catalogRead",
    "localization-journal-repository.test.ts attempt read coverage",
    (repo) => repo.loadAttemptsForRun(deniedActor, "journal-run-denied"),
  ),
  localizationJournalGate(
    "sumAttemptsByPairAndDay",
    "catalogRead",
    "localization-journal-repository.test.ts attempt aggregate coverage",
    (repo) =>
      repo.sumAttemptsByPairAndDay(deniedActor, "project", { from: new Date(0), to: new Date(0) }),
  ),
  localizationJournalGate(
    "countZdrEnforcedAttemptsByPair",
    "catalogRead",
    "localization-journal-repository.test.ts ZDR aggregate coverage",
    (repo) =>
      repo.countZdrEnforcedAttemptsByPair(deniedActor, "project", {
        from: new Date(0),
        to: new Date(0),
      }),
  ),
  localizationJournalGate(
    "countCostKindsByPair",
    "catalogRead",
    "localization-journal-repository.test.ts cost-kind aggregate coverage",
    (repo) =>
      repo.countCostKindsByPair(deniedActor, "project", { from: new Date(0), to: new Date(0) }),
  ),
  localizationJournalGate(
    "loadJobsRunTable",
    "catalogRead",
    "jobs-run-table-read-model.test.ts journal jobs run table coverage",
    (repo) => repo.loadJobsRunTable(deniedActor, { projectId: "project" }),
  ),
  principalGate(
    "createAccount",
    "authAdmin",
    "principal-repository.test.ts create account coverage",
    (repo) => repo.createAccount(deniedActor, undefined as never),
  ),
  principalGate(
    "createPrincipal",
    "authAdmin",
    "principal-repository.test.ts create principal coverage",
    (repo) => repo.createPrincipal(deniedActor, undefined as never),
  ),
  principalGate(
    "createPermissionSet",
    "authPermissionsManage",
    "principal-repository.test.ts create permission set coverage",
    (repo) => repo.createPermissionSet(deniedActor, undefined as never),
  ),
  principalGate(
    "addPermissionToSet",
    "authPermissionsManage",
    "permission-set-model.test.ts add permission to set coverage",
    (repo) => repo.addPermissionToSet(deniedActor, undefined as never),
  ),
  principalGate(
    "removePermissionFromSet",
    "authPermissionsManage",
    "permission-set-model.test.ts remove permission from set coverage",
    (repo) => repo.removePermissionFromSet(deniedActor, undefined as never),
  ),
  principalGate(
    "renamePermissionSet",
    "authPermissionsManage",
    "permission-set-model.test.ts rename permission set coverage",
    (repo) => repo.renamePermissionSet(deniedActor, undefined as never),
  ),
  principalGate(
    "deletePermissionSet",
    "authPermissionsManage",
    "permission-set-model.test.ts delete permission set coverage",
    (repo) => repo.deletePermissionSet(deniedActor, undefined as never),
  ),
  principalGate(
    "grantPermissionSet",
    "authPermissionsManage",
    "principal-repository.test.ts grant permission set coverage",
    (repo) => repo.grantPermissionSet(deniedActor, undefined as never),
  ),
  principalGate(
    "revokePermissionSet",
    "authPermissionsManage",
    "auth-grant-audit-log.test.ts revoke permission set coverage",
    (repo) => repo.revokePermissionSet(deniedActor, undefined as never),
  ),
  principalGate(
    "grantDirectPermission",
    "authPermissionsManage",
    "principal-repository.test.ts grant direct permission coverage",
    (repo) => repo.grantDirectPermission(deniedActor, undefined as never),
  ),
  principalGate(
    "mapProviderClaimToDirectPermission",
    "authAdmin",
    "effective-permission-resolver.test.ts provider claim mapping coverage",
    (repo) => repo.mapProviderClaimToDirectPermission(deniedActor, undefined as never),
  ),
  principalGate(
    "revokeDirectPermission",
    "authPermissionsManage",
    "auth-grant-audit-log.test.ts revoke direct permission coverage",
    (repo) => repo.revokeDirectPermission(deniedActor, undefined as never),
  ),
  principalGate(
    "loadPrincipal",
    "authAdmin",
    "principal-repository.test.ts load principal coverage",
    (repo) => repo.loadPrincipal(deniedActor, "principal-x"),
  ),
  principalGate(
    "resolvePrincipalPermissions",
    "authPermissionsManage",
    "principal-repository.test.ts resolve principal permissions coverage",
    (repo) => repo.resolvePrincipalPermissions(deniedActor, "principal-x"),
  ),
  principalExportGate(
    "listAccountPermissionSets",
    "authPermissionsManage",
    "principal-repository.test.ts permission set helper coverage",
    (db) => listAccountPermissionSets(db, deniedActor, "account-denied"),
  ),
  principalExportGate(
    "loadPermissionSetAccountId",
    "authPermissionsManage",
    "principal-repository.test.ts permission set helper coverage",
    (db) => loadPermissionSetAccountId(db, deniedActor, "permission-set-denied"),
  ),
  authSsoSettingsGate(
    "configureSettings",
    "authSsoManage",
    "auth-sso-settings-repository.test.ts configure settings coverage",
    (repo) => repo.configureSettings(deniedActor, undefined as never),
  ),
  authMemberManagementGate(
    "inviteMember",
    "authMembersManage",
    "auth-member-management-repository.test.ts invite member coverage",
    (repo) => repo.inviteMember(deniedActor, undefined as never),
  ),
  authMemberManagementGate(
    "acceptInvitation",
    "authMembersManage",
    "auth-member-management-repository.test.ts accept invitation coverage",
    (repo) => repo.acceptInvitation(deniedActor, undefined as never),
  ),
  authMemberManagementGate(
    "listMembers",
    "authMembersManage",
    "auth-member-management-repository.test.ts list members coverage",
    (repo) => repo.listMembers(deniedActor, "account-denied"),
  ),
  authMemberManagementGate(
    "removeMember",
    "authMembersManage",
    "auth-member-management-repository.test.ts remove member coverage",
    (repo) => repo.removeMember(deniedActor, undefined as never),
  ),
  authBillingSeatGate(
    "loadSeatUsage",
    "authMembersManage",
    "auth-billing-seat-repository.test.ts load seat usage coverage",
    (repo) => repo.loadSeatUsage(deniedActor, "account-denied"),
  ),
  modelRoutingSettingsGate(
    "loadSettings",
    "catalogRead",
    "model-routing-settings-repository.test.ts load settings coverage",
    (repo) => repo.loadSettings(deniedActor, "project-denied"),
  ),
  modelRoutingSettingsGate(
    "saveRoute",
    "draftWrite",
    "model-routing-settings-repository.test.ts save route coverage",
    (repo) => repo.saveRoute(deniedActor, undefined as never),
  ),
  translationScopeSettingsGate(
    "loadSettings",
    "catalogRead",
    "translation-scope-settings-repository.test.ts load settings coverage",
    (repo) =>
      repo.loadSettings(deniedActor, {
        projectId: "project-denied",
        localeBranchId: "locale-branch-denied",
      }),
  ),
  translationScopeSettingsGate(
    "saveSettings",
    "draftWrite",
    "translation-scope-settings-repository.test.ts save settings coverage",
    (repo) =>
      repo.saveSettings(deniedActor, {
        projectId: "project-denied",
        localeBranchId: "locale-branch-denied",
        scope: "dialogue-only",
      }),
  ),
  localizationPassRunConfigGate(
    "saveRunConfig",
    "draftWrite",
    "localization-pass-run-config-repository.test.ts save coverage",
    (repo) => repo.saveRunConfig(deniedActor, undefined as never),
  ),
  authSessionServiceGate(
    "listPrincipalSessions",
    "authSessionsManage",
    "auth-session-service.test.ts list principal sessions coverage",
    (repo) => repo.listPrincipalSessions(deniedActor, undefined as never),
  ),
  authSessionServiceGate(
    "revokePrincipalSession",
    "authSessionsManage",
    "auth-session-service.test.ts revoke principal session coverage",
    (repo) => repo.revokePrincipalSession(deniedActor, undefined as never),
  ),
] as const satisfies readonly RepositoryPermissionGateCase[];

/**
 * auth-007 — the auth-management API permission matrix.
 *
 * `authManagementOperations` is the EXHAUSTIVE list of permission-gated public methods on
 * `ItotoriPrincipalRepository` (the auth-management surface: principal/account/
 * permission-set CRUD, direct + set grant/revoke, and the gated principal
 * reads). `loadActorIdentity` is intentionally excluded: it is a constrained
 * self-read for the signed-in actor, and the exhaustiveness assertion below
 * tracks it separately so new public methods still must be classified.
 * Account/principal administration is gated on `auth.admin`; permission editor
 * operations are gated on `auth.permissions.manage`. Every entry is registered
 * in `repositoryPermissionGateMatrix` with a success fixture and a denial
 * fixture.
 * The `satisfies` clause keeps each entry honest against
 * `ItotoriPrincipalRepositoryPort`; the runtime exhaustiveness assertion in the
 * `auth-management operation matrix (auth-007)` group makes the list EXHAUSTIVE
 * against the actual class's public methods, so adding a new auth-management
 * method without registering it here fails the test. The per-operation
 * assertions then require each listed operation to carry its expected matrix
 * entry AND matching `requirePermission` call in source — closing the gap the
 * generic repository source-gate scan cannot: an auth-management method that
 * forgets its `requirePermission` call entirely.
 */
const authManagementOperations = [
  "createAccount",
  "createPrincipal",
  "createPermissionSet",
  "addPermissionToSet",
  "removePermissionFromSet",
  "renamePermissionSet",
  "deletePermissionSet",
  "grantPermissionSet",
  "revokePermissionSet",
  "grantDirectPermission",
  "mapProviderClaimToDirectPermission",
  "revokeDirectPermission",
  "loadPrincipal",
  "resolvePrincipalPermissions",
] as const satisfies readonly (keyof ItotoriPrincipalRepositoryPort)[];

const principalRepositorySelfReadOperations = [
  "loadActorIdentity",
] as const satisfies readonly (keyof ItotoriPrincipalRepositoryPort)[];

const authManagementOperationPermissionKeys = {
  createAccount: "authAdmin",
  createPrincipal: "authAdmin",
  createPermissionSet: "authPermissionsManage",
  addPermissionToSet: "authPermissionsManage",
  removePermissionFromSet: "authPermissionsManage",
  renamePermissionSet: "authPermissionsManage",
  deletePermissionSet: "authPermissionsManage",
  grantPermissionSet: "authPermissionsManage",
  revokePermissionSet: "authPermissionsManage",
  grantDirectPermission: "authPermissionsManage",
  mapProviderClaimToDirectPermission: "authAdmin",
  revokeDirectPermission: "authPermissionsManage",
  loadPrincipal: "authAdmin",
  resolvePrincipalPermissions: "authPermissionsManage",
} as const satisfies Record<(typeof authManagementOperations)[number], PermissionKey>;

describe("repository permission gate matrix", () => {
  it("names each permission-gated repository/API-adjacent mutation with fixtures", () => {
    expect(
      repositoryPermissionGateMatrix.map(
        ({ repository, mutation, requiredPermission, successFixture, denialFixture }) => ({
          mutation: `${repository}.${mutation}`,
          requiredPermission,
          successFixture,
          denialFixture,
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.reset",
          "requiredPermission": "system.reset",
          "successFixture": "repository.test.ts reset coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.importSourceBundle",
          "requiredPermission": "project.import",
          "successFixture": "repository.test.ts import coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.ensureRunProjectScope",
          "requiredPermission": "project.import",
          "successFixture": "project-run-scope-provisioning.test.ts run scope provisioning coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.saveDrafts",
          "requiredPermission": "draft.write",
          "successFixture": "repository.test.ts draft persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.savePatchExport",
          "requiredPermission": "patch.export",
          "successFixture": "repository.test.ts patch export persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.saveRuntimeReport",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts runtime report persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.appendEvent",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts event coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.recordFinding",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts finding coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.linkArtifact",
          "requiredPermission": "runtime.ingest",
          "successFixture": "repository.test.ts artifact coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.getRuntimeStatus",
          "requiredPermission": "catalog.read",
          "successFixture": "repository.test.ts runtime status coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriProjectRepository.recordBenchmarkArtifactWithProviderLedger",
          "requiredPermission": "runtime.ingest",
          "successFixture": "model-ledger-repository.test.ts atomic benchmark artifact coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriFeedbackRepository.importManualFeedback",
          "requiredPermission": "feedback.import",
          "successFixture": "repository.test.ts manual feedback coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriFeedbackRepository.loadManualFeedbackReviewerQueueContext",
          "requiredPermission": "feedback.import",
          "successFixture": "repository.test.ts manual feedback queue context coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelLedgerRepository.recordProviderRun",
          "requiredPermission": "runtime.ingest",
          "successFixture": "model-ledger-repository.test.ts provider run coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelLedgerRepository.countZdrEnforcedByPair",
          "requiredPermission": "catalog.read",
          "successFixture": "model-ledger-repository.test.ts ZDR-enforced count coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelLedgerRepository.countCostKindsByPair",
          "requiredPermission": "catalog.read",
          "successFixture": "model-ledger-repository.test.ts cost kind count coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelLedgerRepository.getProjectCostReport",
          "requiredPermission": "catalog.read",
          "successFixture": "model-ledger-repository.test.ts project cost report coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelLedgerRepository.getCostLedgerDrilldown",
          "requiredPermission": "catalog.read",
          "successFixture": "model-ledger-repository.test.ts cost drilldown coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelLedgerRepository.getProjectTelemetryTimeseries",
          "requiredPermission": "catalog.read",
          "successFixture": "model-ledger-repository.test.ts telemetry timeseries coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.appendOutboxEvent",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox event coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.enqueueJob",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.enqueueJobs",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts atomic job chain coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.appendOutboxEventWithJobs",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox plus jobs coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.claimOutboxEvents",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox claim coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.markOutboxEventPublished",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox publish coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.markOutboxEventFailed",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox failure coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.recoverExpiredOutboxLeases",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts outbox lease recovery coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.claimJobs",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job claim coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.completeJob",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job completion coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.failJob",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job failure coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.recoverExpiredJobLeases",
          "requiredPermission": "queue.manage",
          "successFixture": "event-queue-repository.test.ts job lease recovery coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.getOutboxEvent",
          "requiredPermission": "queue.read",
          "successFixture": "event-queue-repository.test.ts authorized outbox read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.getJob",
          "requiredPermission": "queue.read",
          "successFixture": "event-queue-repository.test.ts authorized job read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.getJobEvents",
          "requiredPermission": "queue.read",
          "successFixture": "job-events-audit.test.ts job event read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.pruneJobEvents",
          "requiredPermission": "queue.manage",
          "successFixture": "job-events-audit.test.ts retention prune coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriEventQueueRepository.loadQueueHealth",
          "requiredPermission": "queue.read",
          "successFixture": "event-queue-queue-health.test.ts queue health read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordSourceProvenance",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts source provenance coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.upsertWork",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts work coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordLocalScan",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts local scan coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordSeedTarget",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts seed target coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.getWorkSnapshot",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts work read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.getWorkByExternalId",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts external id read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.listSeedTargets",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts seed target read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.listBenchmarkSelectableSeedTargets",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-recorded-importers.test.ts benchmark selectable seed read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.listCatalogCandidateTargetWorks",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts candidate target read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.recordCatalogCandidateMatch",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-repository.test.ts candidate match coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.listCatalogCandidateMatches",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts candidate match read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.catalogConflictReview",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-conflict-review.test.ts read model coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.catalogCompletenessBenchmarkPools",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-repository.test.ts completeness benchmark pool coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.catalogAlphaBenchmarkOpportunityRanking",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-recorded-importers.test.ts alpha benchmark opportunity ranking coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.catalogOpportunityRanking",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-opportunity-ranking-read-model.test.ts read model coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.catalogContextPanelForWork",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-context-panel read model coverage (itotori-119 panel route)",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogRepository.catalogBenchmarkSeedFinder",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-benchmark-seed-finder.test.ts read model coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.getCheckpoint",
          "requiredPermission": "catalog.read",
          "successFixture": "catalog-crawler-repository.test.ts checkpoint read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.startCrawlerJob",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts crawler job start coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.recordFetchedStep",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts fetched step coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.commitStepImport",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts atomic step commit coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.markStepImported",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts imported marker coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.markStepFailed",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts failed marker coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.saveCheckpoint",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts checkpoint write coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.saveRateLimit",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts rate-limit write coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.completeCrawlerJob",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts crawler job completion coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCatalogCrawlerRepository.failCrawlerJob",
          "requiredPermission": "catalog.write",
          "successFixture": "catalog-crawler-repository.test.ts crawler job failure coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriBranchReferenceRepository.resolveBranchPolicyGlossaryReference",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-repository.test.ts branch-scoped policy/glossary coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriBranchReferenceRepository.updateBranchPolicyGlossaryReference",
          "requiredPermission": "draft.write",
          "successFixture": "terminology-repository.test.ts branch reference update coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriStyleGuideRepository.createVersion",
          "requiredPermission": "draft.write",
          "successFixture": "style-guide-repository.test.ts version persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriStyleGuideRepository.authorizeApproval",
          "requiredPermission": "style_guide.approve",
          "successFixture": "style-guide-repository.test.ts approval authorization coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriStyleGuideRepository.approveVersion",
          "requiredPermission": "style_guide.approve",
          "successFixture": "style-guide-repository.test.ts approval coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyRepository.upsertTerm",
          "requiredPermission": "draft.write",
          "successFixture": "terminology-repository.test.ts term persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyRepository.searchTerms",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-repository.test.ts term search coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyRepository.listConflicts",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-repository.test.ts conflict listing coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyRepository.getGlossaryContext",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-repository.test.ts glossary context coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyRepository.upsertGlossaryReviewItem",
          "requiredPermission": "draft.write",
          "successFixture": "terminology-repository.test.ts glossary review item coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyRepository.listGlossaryReviewItems",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-repository.test.ts glossary review queue coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTranslationMemoryRepository.upsertSegment",
          "requiredPermission": "draft.write",
          "successFixture": "translation-memory-repository.test.ts segment persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTranslationMemoryRepository.recordReuse",
          "requiredPermission": "draft.write",
          "successFixture": "translation-memory-repository.test.ts reuse provenance coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriExactSearchDocumentRepository.refreshDocuments",
          "requiredPermission": "project.import",
          "successFixture": "exact-search-document-repository.test.ts refresh coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriExactSearchDocumentRepository.searchExact",
          "requiredPermission": "catalog.read",
          "successFixture": "exact-search-document-repository.test.ts search.exact coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriContextArtifactRepository.upsertArtifact",
          "requiredPermission": "project.import",
          "successFixture": "context-artifact-repository.test.ts artifact upsert coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriContextArtifactRepository.invalidateAffectedArtifacts",
          "requiredPermission": "project.import",
          "successFixture": "context-artifact-repository.test.ts source invalidation coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriContextArtifactRepository.retrieveArtifacts",
          "requiredPermission": "catalog.read",
          "successFixture": "context-artifact-repository.test.ts retrieval coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriContextArtifactRepository.listEntryVersions",
          "requiredPermission": "catalog.read",
          "successFixture": "context-artifact-repository.test.ts entry history coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSemanticContextReadRepository.loadArtifacts",
          "requiredPermission": "catalog.read",
          "successFixture": "context-artifact-repository.test.ts central semantic projection coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSourceUnitRepository.currentSourceHashes",
          "requiredPermission": "catalog.read",
          "successFixture": "context-artifact-repository.test.ts source-unit hash coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSourceUnitRepository.loadSourceUnits",
          "requiredPermission": "catalog.read",
          "successFixture": "context-artifact-repository.test.ts source-unit hydration coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSourceUnitRepository.loadSourceUnitsForScope",
          "requiredPermission": "catalog.read",
          "successFixture": "context-artifact-repository.test.ts source-unit scope coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTranslationBatchRepository.saveBatches",
          "requiredPermission": "draft.write",
          "successFixture": "translation-batch-repository.test.ts save coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTranslationBatchRepository.loadBatches",
          "requiredPermission": "catalog.read",
          "successFixture": "translation-batch-repository.test.ts load coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTranslationBatchRepository.loadBatchById",
          "requiredPermission": "catalog.read",
          "successFixture": "translation-batch-repository.test.ts load-by-id coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriConformanceRepository.saveConformanceRun",
          "requiredPermission": "runtime.ingest",
          "successFixture": "conformance-repository.test.ts save coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriConformanceRepository.loadConformanceRun",
          "requiredPermission": "catalog.read",
          "successFixture": "conformance-repository.test.ts load coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "EngineCapabilityReportRepository.writeMatrix",
          "requiredPermission": "project.import",
          "successFixture": "engine-capability-report-repository.test.ts write matrix coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "EngineCapabilityReportRepository.recordCapabilityEvidence",
          "requiredPermission": "project.import",
          "successFixture": "engine-capability-report-repository.test.ts capability evidence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriWikiReadmodelRepository.loadEntries",
          "requiredPermission": "catalog.read",
          "successFixture": "wiki-readmodel-repository.test.ts entries read-model coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.createDraftJob",
          "requiredPermission": "draft.write",
          "successFixture": "draft-job-repository.test.ts create draft job coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.recordAttempt",
          "requiredPermission": "draft.write",
          "successFixture": "draft-job-repository.test.ts record attempt coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.markAttemptSucceeded",
          "requiredPermission": "draft.write",
          "successFixture": "draft-job-repository.test.ts mark attempt succeeded coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.markAttemptFailed",
          "requiredPermission": "draft.write",
          "successFixture": "draft-job-repository.test.ts mark attempt failed coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.cancelDraftJob",
          "requiredPermission": "draft.write",
          "successFixture": "draft-job-repository.test.ts cancel draft job coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.loadDraftJob",
          "requiredPermission": "catalog.read",
          "successFixture": "draft-job-repository.test.ts load draft job coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.loadDraftJobsByProject",
          "requiredPermission": "catalog.read",
          "successFixture": "draft-job-repository.test.ts load draft jobs by project coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftJobRepository.loadDraftJobAttempts",
          "requiredPermission": "catalog.read",
          "successFixture": "draft-job-repository.test.ts load draft job attempts coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAssetLocalizationDecisionRepository.recordDecision",
          "requiredPermission": "draft.write",
          "successFixture": "asset-localization-decision-repository.test.ts record decision coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAssetLocalizationDecisionRepository.recordDecisionsBulk",
          "requiredPermission": "draft.write",
          "successFixture": "asset-localization-decision-repository.test.ts record decisions bulk coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAssetLocalizationDecisionRepository.loadActiveDecisions",
          "requiredPermission": "catalog.read",
          "successFixture": "asset-localization-decision-repository.test.ts load active decisions coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAssetLocalizationDecisionRepository.loadCandidateAssets",
          "requiredPermission": "catalog.read",
          "successFixture": "asset-localization-decision-repository.test.ts load candidate assets coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAssetLocalizationDecisionRepository.loadDecisionHistory",
          "requiredPermission": "catalog.read",
          "successFixture": "asset-localization-decision-repository.test.ts load decision history coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAssetLocalizationDecisionRepository.loadDecisionsByPolicy",
          "requiredPermission": "catalog.read",
          "successFixture": "asset-localization-decision-repository.test.ts load decisions by policy coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriBenchmarkRunRepository.recordRun",
          "requiredPermission": "runtime.ingest",
          "successFixture": "benchmark-run-repository.test.ts record run coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriBenchmarkRunRepository.loadRun",
          "requiredPermission": "catalog.read",
          "successFixture": "benchmark-run-repository.test.ts load run coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriBenchmarkRunRepository.loadLatestRunForProject",
          "requiredPermission": "catalog.read",
          "successFixture": "benchmark-run-repository.test.ts load latest run for project coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriBenchmarkRunRepository.loadRunsForProject",
          "requiredPermission": "catalog.read",
          "successFixture": "benchmark-run-repository.test.ts load runs for project coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneCoverageRepository.setCoverage",
          "requiredPermission": "queue.manage",
          "successFixture": "scene-coverage-repository.test.ts set coverage coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneCoverageRepository.loadCoverageForBranch",
          "requiredPermission": "queue.read",
          "successFixture": "scene-coverage-repository.test.ts load coverage for branch coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneCoverageRepository.loadCoverageForScene",
          "requiredPermission": "queue.read",
          "successFixture": "scene-coverage-repository.test.ts load coverage for scene coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuditFindingRepository.recordFinding",
          "requiredPermission": "audit.write",
          "successFixture": "audit-finding-repository.test.ts record finding coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuditFindingRepository.loadFindingsByNode",
          "requiredPermission": "catalog.read",
          "successFixture": "audit-finding-repository.test.ts load findings by node coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuditFindingRepository.loadFindingsByReport",
          "requiredPermission": "catalog.read",
          "successFixture": "audit-finding-repository.test.ts load findings by report coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuditFindingRepository.loadOpenFindings",
          "requiredPermission": "catalog.read",
          "successFixture": "audit-finding-repository.test.ts load open findings coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuditFindingRepository.markFindingFixed",
          "requiredPermission": "audit.write",
          "successFixture": "audit-finding-repository.test.ts mark finding fixed coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuditFindingRepository.markFindingSuperseded",
          "requiredPermission": "audit.write",
          "successFixture": "audit-finding-repository.test.ts mark finding superseded coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.createItem",
          "requiredPermission": "queue.manage",
          "successFixture": "reviewer-queue-repository.test.ts create item coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.applyAction",
          "requiredPermission": "queue.manage",
          "successFixture": "reviewer-queue-repository.test.ts apply action coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.applyActionAndEnqueueJobs",
          "requiredPermission": "queue.manage",
          "successFixture": "reviewer-queue-repository.test.ts atomic reviewer action plus jobs coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.applyActionsAndEnqueueJobs",
          "requiredPermission": "queue.manage",
          "successFixture": "reviewer-queue-repository.test.ts atomic reviewer actions plus jobs coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.getItem",
          "requiredPermission": "queue.read",
          "successFixture": "reviewer-queue-repository.test.ts get item coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.getItemForManage",
          "requiredPermission": "queue.manage",
          "successFixture": "reviewer-queue-repository.test.ts get item for manage coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.loadItemsByBranch",
          "requiredPermission": "queue.read",
          "successFixture": "reviewer-queue-repository.test.ts load items by branch coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriReviewerQueueRepository.loadTransitionsByItem",
          "requiredPermission": "queue.read",
          "successFixture": "reviewer-queue-repository.test.ts load transitions by item coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriWorkspaceCorrectionRepository.recordCorrectionEdit",
          "requiredPermission": "queue.manage",
          "successFixture": "workspace-correction-repository.test.ts record correction coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriWorkspaceCorrectionRepository.loadCorrectionEditsByBranch",
          "requiredPermission": "queue.read",
          "successFixture": "workspace-correction-repository.test.ts load corrections by branch coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.seedRun",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts atomic run/unit seed coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.createRun",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts create run coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.persistAttempts",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts failure-attempt persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.beginAttempt",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts pre-dispatch attempt coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.reserveAttemptCost",
          "requiredPermission": "draft.write",
          "successFixture": "invocation-supervisor-db.test.ts atomic N-way reservation coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.completeAttempt",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts attempt completion coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.reconcileAttemptBilling",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts late billed-cost reconciliation coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.persistUnit",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts atomic outcome persistence coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadRun",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts run read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadRunCostAccount",
          "requiredPermission": "catalog.read",
          "successFixture": "invocation-supervisor-db.test.ts durable cost account coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadCostReservations",
          "requiredPermission": "catalog.read",
          "successFixture": "invocation-supervisor-db.test.ts durable cost reservation coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadRunUnits",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts planned unit read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.pauseRun",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts operational pause coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.resumeRun",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts operational resume coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.raiseRunCostCap",
          "requiredPermission": "draft.write",
          "successFixture": "invocation-supervisor-db.test.ts cap raise coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.renewRunLease",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts live lease renewal coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.releaseRunLease",
          "requiredPermission": "draft.write",
          "successFixture": "localization-journal-repository.test.ts paused lease release coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadRunsForBranch",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts branch history read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadRunOutcomes",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts outcome provenance read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadAttemptsForRun",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts attempt read coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.sumAttemptsByPairAndDay",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts attempt aggregate coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.countZdrEnforcedAttemptsByPair",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts ZDR aggregate coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.countCostKindsByPair",
          "requiredPermission": "catalog.read",
          "successFixture": "localization-journal-repository.test.ts cost-kind aggregate coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationJournalRepository.loadJobsRunTable",
          "requiredPermission": "catalog.read",
          "successFixture": "jobs-run-table-read-model.test.ts journal jobs run table coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.createAccount",
          "requiredPermission": "auth.admin",
          "successFixture": "principal-repository.test.ts create account coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.createPrincipal",
          "requiredPermission": "auth.admin",
          "successFixture": "principal-repository.test.ts create principal coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.createPermissionSet",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "principal-repository.test.ts create permission set coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.addPermissionToSet",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "permission-set-model.test.ts add permission to set coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.removePermissionFromSet",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "permission-set-model.test.ts remove permission from set coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.renamePermissionSet",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "permission-set-model.test.ts rename permission set coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.deletePermissionSet",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "permission-set-model.test.ts delete permission set coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.grantPermissionSet",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "principal-repository.test.ts grant permission set coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.revokePermissionSet",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "auth-grant-audit-log.test.ts revoke permission set coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.grantDirectPermission",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "principal-repository.test.ts grant direct permission coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.mapProviderClaimToDirectPermission",
          "requiredPermission": "auth.admin",
          "successFixture": "effective-permission-resolver.test.ts provider claim mapping coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.revokeDirectPermission",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "auth-grant-audit-log.test.ts revoke direct permission coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.loadPrincipal",
          "requiredPermission": "auth.admin",
          "successFixture": "principal-repository.test.ts load principal coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepository.resolvePrincipalPermissions",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "principal-repository.test.ts resolve principal permissions coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepositoryExports.listAccountPermissionSets",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "principal-repository.test.ts permission set helper coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriPrincipalRepositoryExports.loadPermissionSetAccountId",
          "requiredPermission": "auth.permissions.manage",
          "successFixture": "principal-repository.test.ts permission set helper coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthSsoSettingsRepository.configureSettings",
          "requiredPermission": "auth.sso.manage",
          "successFixture": "auth-sso-settings-repository.test.ts configure settings coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthMemberManagementRepository.inviteMember",
          "requiredPermission": "auth.members.manage",
          "successFixture": "auth-member-management-repository.test.ts invite member coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthMemberManagementRepository.acceptInvitation",
          "requiredPermission": "auth.members.manage",
          "successFixture": "auth-member-management-repository.test.ts accept invitation coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthMemberManagementRepository.listMembers",
          "requiredPermission": "auth.members.manage",
          "successFixture": "auth-member-management-repository.test.ts list members coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthMemberManagementRepository.removeMember",
          "requiredPermission": "auth.members.manage",
          "successFixture": "auth-member-management-repository.test.ts remove member coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthBillingSeatRepository.loadSeatUsage",
          "requiredPermission": "auth.members.manage",
          "successFixture": "auth-billing-seat-repository.test.ts load seat usage coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelRoutingSettingsRepository.loadSettings",
          "requiredPermission": "catalog.read",
          "successFixture": "model-routing-settings-repository.test.ts load settings coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriModelRoutingSettingsRepository.saveRoute",
          "requiredPermission": "draft.write",
          "successFixture": "model-routing-settings-repository.test.ts save route coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTranslationScopeSettingsRepository.loadSettings",
          "requiredPermission": "catalog.read",
          "successFixture": "translation-scope-settings-repository.test.ts load settings coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTranslationScopeSettingsRepository.saveSettings",
          "requiredPermission": "draft.write",
          "successFixture": "translation-scope-settings-repository.test.ts save settings coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriLocalizationPassRunConfigRepository.saveRunConfig",
          "requiredPermission": "draft.write",
          "successFixture": "localization-pass-run-config-repository.test.ts save coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthSessionService.listPrincipalSessions",
          "requiredPermission": "auth.sessions.manage",
          "successFixture": "auth-session-service.test.ts list principal sessions coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriAuthSessionService.revokePrincipalSession",
          "requiredPermission": "auth.sessions.manage",
          "successFixture": "auth-session-service.test.ts revoke principal session coverage",
        },
      ]
    `);
  });

  it("matches every repository source permission gate", () => {
    expectRepositoryPermissionGateMatrixMatches(
      repositoryPermissionGateMatrix,
      sourcePermissionGates(),
    );
  });

  it("fails matrix coverage when a repository aliases requirePermission for an unregistered gate", () => {
    const sourceGates = sourcePermissionGatesFromSource(
      "probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriProbeRepository {
          async unregisteredMutation(actor) {
            const checkPermission = requirePermission;
            await checkPermission(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );

    expect(sourceGates.map(sourceGateKey)).toEqual([
      "ItotoriProbeRepository:probe-repository.ts:unregisteredMutation:draftWrite",
    ]);
    expect(() => expectRepositoryPermissionGateMatrixMatches([], sourceGates)).toThrow(
      /probe-repository\.ts:unregisteredMutation:draftWrite/u,
    );
    expect(() => expectRepositoryPermissionGateMatrixMatches([], sourceGates)).toThrow(
      /repository ItotoriProbeRepository method unregisteredMutation/u,
    );
  });

  it("discovers optional-chained requirePermission calls the same as plain ones (P1)", () => {
    // Babel uses OptionalCallExpression for `requirePermission?.(…)`; source
    // gate discovery must not drop those calls.
    const plainGates = sourcePermissionGatesFromSource(
      "optional-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriOptionalProbeRepository {
          async plainMutation(actor) {
            await requirePermission(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    const optionalGates = sourcePermissionGatesFromSource(
      "optional-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriOptionalProbeRepository {
          async plainMutation(actor) {
            await requirePermission?.(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );

    expect(optionalGates.map(sourceGateKey)).toEqual(plainGates.map(sourceGateKey));
    expect(optionalGates.map(sourceGateKey)).toEqual([
      "ItotoriOptionalProbeRepository:optional-probe-repository.ts:plainMutation:draftWrite",
    ]);
  });

  it("discovers destructured / array / default / computed requirePermission aliases (P1 matrix)", () => {
    const expected = [
      "ItotoriAliasProbeRepository:alias-probe-repository.ts:destructuredMutation:draftWrite",
    ];

    const destructured = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";
        const authorization = { requirePermission };

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            const { requirePermission: check } = authorization;
            await check(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(destructured.map(sourceGateKey)).toEqual(expected);

    const arrayAliased = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            const [check] = [requirePermission];
            await check(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(arrayAliased.map(sourceGateKey)).toEqual(expected);

    const defaulted = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";
        const authorization = { requirePermission };

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            const { requirePermission: check = requirePermission } = authorization;
            await check(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(defaulted.map(sourceGateKey)).toEqual(expected);

    const computed = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";
        const authorization = { requirePermission };

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            await authorization?.["requirePermission"]?.(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );
    expect(computed.map(sourceGateKey)).toEqual(expected);

    const computedPermissionKey = sourcePermissionGatesFromSource(
      "alias-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriAliasProbeRepository {
          async destructuredMutation(actor) {
            await requirePermission(this.db, actor, permissionValues?.["draftWrite"]);
          }
        }
      `,
    );
    expect(computedPermissionKey.map(sourceGateKey)).toEqual(expected);
  });

  it("distinguishes two repositories that share a method name and permission key by repository identity (SHARED-029)", () => {
    // Two repository classes in one source file both gate a method with the
    // same name on the same permission. Repository identity must keep the two
    // gates as distinct source-alignment keys so neither can mask the other.
    const sourceGates = sourcePermissionGatesFromSource(
      "shared-probe-repository.ts",
      `
        import { permissionValues, requirePermission } from "../authorization.js";

        class ItotoriProbeRepositoryA {
          async sharedMutation(actor) {
            await requirePermission(this.db, actor, permissionValues.draftWrite);
          }
        }

        class ItotoriProbeRepositoryB {
          async sharedMutation(actor) {
            await requirePermission(this.db, actor, permissionValues.draftWrite);
          }
        }
      `,
    );

    expect(sourceGates.map(sourceGateKey)).toEqual([
      "ItotoriProbeRepositoryA:shared-probe-repository.ts:sharedMutation:draftWrite",
      "ItotoriProbeRepositoryB:shared-probe-repository.ts:sharedMutation:draftWrite",
    ]);

    // Registering both repositories' gates aligns with the source gates.
    expect(() =>
      expectRepositoryPermissionGateMatrixMatches(
        [
          {
            repository: "ItotoriProbeRepositoryA",
            sourceFile: "shared-probe-repository.ts",
            mutation: "sharedMutation",
            permissionKey: "draftWrite" as PermissionKey,
          },
          {
            repository: "ItotoriProbeRepositoryB",
            sourceFile: "shared-probe-repository.ts",
            mutation: "sharedMutation",
            permissionKey: "draftWrite" as PermissionKey,
          },
        ],
        sourceGates,
      ),
    ).not.toThrow();

    // A matrix that registers only one repository's gate fails: the collision
    // is caught and the diagnostic names the missing repository identity.
    const partialMatrix = [
      {
        repository: "ItotoriProbeRepositoryA",
        sourceFile: "shared-probe-repository.ts",
        mutation: "sharedMutation",
        permissionKey: "draftWrite" as PermissionKey,
      },
    ];
    expect(() => expectRepositoryPermissionGateMatrixMatches(partialMatrix, sourceGates)).toThrow(
      /repository ItotoriProbeRepositoryB method sharedMutation/u,
    );
  });
});

describe("repository permission denial fixtures", () => {
  let context: DatabaseContext | undefined;

  beforeAll(async () => {
    context = await isolatedMigratedContext();
  });

  afterAll(async () => {
    await context?.close();
  });

  it.each(repositoryPermissionGateMatrix)(
    "denies $repository.$mutation without $requiredPermission",
    async ({ requiredPermission, runDeniedMutation }) => {
      await assertDeniedRepositoryMutation({
        actor: deniedActor,
        permission: requiredPermission,
        run: () => runDeniedMutation(requiredContext(context).db),
      });
    },
  );
});

describe("auth-management operation matrix (auth-007)", () => {
  const authManagementMatrixEntries = repositoryPermissionGateMatrix.filter(
    (entry) => entry.repository === "ItotoriPrincipalRepository",
  );
  const principalSourceGates = sourcePermissionGates().filter(
    (gate) => gate.sourceFile === "principal-repository.ts",
  );

  // ANY auth-management-op-is-gated check: the explicit list must cover EVERY
  // permission-gated public method on ItotoriPrincipalRepository, while the
  // self-read list must cover EVERY intentional ungated public method. A new
  // public method added to the class without being classified fails here, and
  // the per-operation tests below fail if a listed auth-management op is
  // un-gated or un-registered.
  it("registers every ItotoriPrincipalRepository public method as an auth-management operation", () => {
    expect([...authManagementOperations, ...principalRepositorySelfReadOperations].sort()).toEqual(
      principalRepositoryPublicMethods(),
    );
    const matrixMutations = authManagementMatrixEntries.map((entry) => entry.mutation).sort();
    expect(matrixMutations).toEqual([...authManagementOperations].sort());
  });

  it.each(authManagementOperations)(
    "gates ItotoriPrincipalRepository.%s on its expected auth permission with success and denial fixtures",
    (operation) => {
      const entry = authManagementMatrixEntries.find((e) => e.mutation === operation);
      expect(
        entry,
        `ItotoriPrincipalRepository.${operation} must be registered in the authorization matrix`,
      ).toBeDefined();
      if (entry === undefined) {
        return;
      }
      const expectedPermissionKey = authManagementOperationPermissionKeys[operation];
      expect(
        entry.permissionKey,
        `ItotoriPrincipalRepository.${operation} must be gated on ${expectedPermissionKey}`,
      ).toBe(expectedPermissionKey);
      expect(
        entry.requiredPermission,
        `ItotoriPrincipalRepository.${operation} must require permission ${permissionValues[expectedPermissionKey]}`,
      ).toBe(permissionValues[expectedPermissionKey]);
      expect(
        entry.successFixture,
        `ItotoriPrincipalRepository.${operation} must reference a success fixture`,
      ).toMatch(/coverage$/);
      expect(
        entry.denialFixture,
        `ItotoriPrincipalRepository.${operation} must reference a denial fixture`,
      ).toMatch(/missing permission actor/);
    },
  );

  it.each(authManagementOperations)(
    "calls requirePermission with the expected permission in source for ItotoriPrincipalRepository.%s",
    (operation) => {
      const gate = principalSourceGates.find((g) => g.mutation === operation);
      expect(
        gate,
        `ItotoriPrincipalRepository.${operation} must call requirePermission in principal-repository.ts`,
      ).toBeDefined();
      if (gate === undefined) {
        return;
      }
      const expectedPermissionKey = authManagementOperationPermissionKeys[operation];
      expect(
        gate.permissionKey,
        `ItotoriPrincipalRepository.${operation} source gate must be ${expectedPermissionKey}`,
      ).toBe(expectedPermissionKey);
    },
  );
});

function projectGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriProjectRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriProjectRepository",
    sourceFile: "project-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriProjectRepository(db)),
  });
}

function feedbackGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriFeedbackRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriFeedbackRepository",
    sourceFile: "feedback-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriFeedbackRepository(db)),
  });
}

function modelLedgerGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriModelLedgerRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriModelLedgerRepository",
    sourceFile: "model-ledger-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriModelLedgerRepository(db)),
  });
}

function queueGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriEventQueueRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriEventQueueRepository",
    sourceFile: "event-queue-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriEventQueueRepository(db)),
  });
}

function catalogGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriCatalogRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriCatalogRepository",
    sourceFile: "catalog-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriCatalogRepository(db)),
  });
}

function catalogCrawlerGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriCatalogCrawlerRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriCatalogCrawlerRepository",
    sourceFile: "catalog-crawler-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriCatalogCrawlerRepository(db)),
  });
}

function branchReferenceGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriBranchReferenceRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriBranchReferenceRepository",
    sourceFile: "branch-reference-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriBranchReferenceRepository(db)),
  });
}

function styleGuideGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriStyleGuideRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriStyleGuideRepository",
    sourceFile: "style-guide-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriStyleGuideRepository(db)),
  });
}

function terminologyGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTerminologyRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTerminologyRepository",
    sourceFile: "terminology-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTerminologyRepository(db)),
  });
}

function translationMemoryGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTranslationMemoryRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTranslationMemoryRepository",
    sourceFile: "translation-memory-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTranslationMemoryRepository(db)),
  });
}

function exactSearchGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriExactSearchDocumentRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriExactSearchDocumentRepository",
    sourceFile: "exact-search-document-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriExactSearchDocumentRepository(db)),
  });
}

function contextArtifactGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriContextArtifactRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriContextArtifactRepository",
    sourceFile: "context-artifact-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriContextArtifactRepository(db)),
  });
}

function semanticContextReadGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriSemanticContextReadRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriSemanticContextReadRepository",
    sourceFile: "semantic-context-read-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriSemanticContextReadRepository(db)),
  });
}

function sourceUnitGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriSourceUnitRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriSourceUnitRepository",
    sourceFile: "source-unit-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriSourceUnitRepository(db)),
  });
}

function translationBatchGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTranslationBatchRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTranslationBatchRepository",
    sourceFile: "translation-batch-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTranslationBatchRepository(db)),
  });
}

function conformanceGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriConformanceRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriConformanceRepository",
    sourceFile: "conformance-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriConformanceRepository(db)),
  });
}

function engineCapabilityReportGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: EngineCapabilityReportRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "EngineCapabilityReportRepository",
    sourceFile: "engine-capability-report-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new EngineCapabilityReportRepository(db)),
  });
}

function wikiReadmodelGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriWikiReadmodelRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriWikiReadmodelRepository",
    sourceFile: "wiki-readmodel-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriWikiReadmodelRepository(db)),
  });
}

function draftJobGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriDraftJobRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriDraftJobRepository",
    sourceFile: "draft-job-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriDraftJobRepository(db)),
  });
}

function assetLocalizationDecisionGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAssetLocalizationDecisionRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAssetLocalizationDecisionRepository",
    sourceFile: "asset-localization-decision-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAssetLocalizationDecisionRepository(db)),
  });
}

function benchmarkRunGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriBenchmarkRunRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriBenchmarkRunRepository",
    sourceFile: "benchmark-run-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriBenchmarkRunRepository(db)),
  });
}

function sceneCoverageGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriSceneCoverageRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriSceneCoverageRepository",
    sourceFile: "scene-coverage-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriSceneCoverageRepository(db)),
  });
}

function auditFindingGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuditFindingRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuditFindingRepository",
    sourceFile: "audit-finding-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuditFindingRepository(db)),
  });
}

function reviewerQueueGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriReviewerQueueRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriReviewerQueueRepository",
    sourceFile: "reviewer-queue-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriReviewerQueueRepository(db)),
  });
}

function workspaceCorrectionGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriWorkspaceCorrectionRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriWorkspaceCorrectionRepository",
    sourceFile: "workspace-correction-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriWorkspaceCorrectionRepository(db)),
  });
}

function localizationJournalGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriLocalizationJournalRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriLocalizationJournalRepository",
    sourceFile: "localization-journal-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriLocalizationJournalRepository(db)),
  });
}

function principalGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriPrincipalRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriPrincipalRepository",
    sourceFile: "principal-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriPrincipalRepository(db)),
  });
}

function principalExportGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (db: ItotoriDatabase) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriPrincipalRepositoryExports",
    sourceFile: "principal-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: run,
  });
}

function authSsoSettingsGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthSsoSettingsRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthSsoSettingsRepository",
    sourceFile: "auth-sso-settings-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthSsoSettingsRepository(db)),
  });
}

function authMemberManagementGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthMemberManagementRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthMemberManagementRepository",
    sourceFile: "auth-member-management-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthMemberManagementRepository(db)),
  });
}

function authBillingSeatGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthBillingSeatRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthBillingSeatRepository",
    sourceFile: "auth-billing-seat-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthBillingSeatRepository(db)),
  });
}

function modelRoutingSettingsGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriModelRoutingSettingsRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriModelRoutingSettingsRepository",
    sourceFile: "model-routing-settings-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriModelRoutingSettingsRepository(db)),
  });
}

function translationScopeSettingsGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTranslationScopeSettingsRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTranslationScopeSettingsRepository",
    sourceFile: "translation-scope-settings-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTranslationScopeSettingsRepository(db)),
  });
}

function localizationPassRunConfigGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriLocalizationPassRunConfigRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriLocalizationPassRunConfigRepository",
    sourceFile: "localization-pass-run-config-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriLocalizationPassRunConfigRepository(db)),
  });
}

function authSessionServiceGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriAuthSessionService) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriAuthSessionService",
    sourceFile: "auth-session-service.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriAuthSessionService(db)),
  });
}

function repositoryGate(
  input: Omit<RepositoryPermissionGateCase, "requiredPermission" | "denialFixture">,
): RepositoryPermissionGateCase {
  return {
    ...input,
    requiredPermission: permissionValues[input.permissionKey],
    denialFixture: `missing permission actor ${deniedActor.userId}`,
  };
}

function sourcePermissionGates(): Pick<
  RepositoryPermissionGateCase,
  "repository" | "sourceFile" | "mutation" | "permissionKey"
>[] {
  const gates: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[] = [];
  const repositorySourceDir = new URL("../src/repositories/", import.meta.url);

  for (const sourceFile of readdirSync(repositorySourceDir).filter((file) =>
    file.endsWith(".ts"),
  )) {
    const sourceUrl = new URL(sourceFile, repositorySourceDir);
    const source = readFileSync(sourceUrl, "utf8");
    gates.push(...sourcePermissionGatesFromSource(sourceFile, source, sourceUrl.pathname));
  }

  return gates;
}

function sourcePermissionGatesFromSource(
  sourceFileName: string,
  source: string,
  parsedSourceFileName = sourceFileName,
): Pick<
  RepositoryPermissionGateCase,
  "repository" | "sourceFile" | "mutation" | "permissionKey"
>[] {
  const parsedSource = parseTypeScript(source, parsedSourceFileName);
  const requirePermissionAliases = permissionHelperAliases(parsedSource, "requirePermission");
  const gates: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[] = [];

  walk(parsedSource, (node) => {
    // Optional calls (`requirePermission?.(…)`) are OptionalCallExpression in
    // Babel; TypeScript's AST treated them as ordinary CallExpression.
    if (
      isCallExpression(node) &&
      permissionHelperCallName(node.callee, requirePermissionAliases) !== undefined
    ) {
      const gateAnnotation = repositoryGateAnnotation(node);
      const permissionKey = permissionKeyFromRepositoryCall(
        node,
        gateAnnotation,
        parsedSourceFileName,
      );
      const sourceMethod = enclosingRepositoryMethod(node);
      if (sourceMethod === undefined && gateAnnotation === undefined) {
        throw new Error(
          `repository permission call at ${sourceLocation(parsedSourceFileName, node)} must be inside a repository method or declare @repository-permission-gate <Repository>.<mutation> <permissionKey>`,
        );
      }
      gates.push({
        repository: gateAnnotation?.repository ?? requiredSourceMethod(sourceMethod).repository,
        sourceFile: sourceFileName,
        mutation: gateAnnotation?.mutation ?? requiredSourceMethod(sourceMethod).method,
        permissionKey,
      });
    }
  });

  return gates;
}

function expectRepositoryPermissionGateMatrixMatches(
  matrix: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[],
  sourceGates: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >[],
): void {
  const matrixKeys = matrix.map(sourceGateKey).sort();
  const sourceKeys = sourceGates.map(sourceGateKey).sort();
  if (JSON.stringify(matrixKeys) === JSON.stringify(sourceKeys)) {
    return;
  }
  // Set-equality failed. Produce a repository-identity-naming diff (SHARED-029)
  // so the diagnostic calls out WHICH repository is missing or extra instead of
  // only dumping the two key lists.
  const matrixByKey = new Map(matrix.map((gate) => [sourceGateKey(gate), gate]));
  const sourceByKey = new Map(sourceGates.map((gate) => [sourceGateKey(gate), gate]));
  const missingMatrixEntries = sourceKeys
    .filter((key, index) => sourceKeys.indexOf(key) === index && !matrixByKey.has(key))
    .sort();
  const extraMatrixEntries = matrixKeys
    .filter((key, index) => matrixKeys.indexOf(key) === index && !sourceByKey.has(key))
    .sort();
  const duplicateMatrixEntries = matrixKeys.filter(
    (key, index) => matrixKeys.indexOf(key) !== index,
  );
  const duplicateSourceEntries = sourceKeys.filter(
    (key, index) => sourceKeys.indexOf(key) !== index,
  );
  throw new Error(
    [
      "repository permission matrix does not match source gates",
      ...missingMatrixEntries.map(
        (key) =>
          `missing matrix entry for source gate — ${describeRepositoryGate(sourceByKey.get(key)!)} [${key}]`,
      ),
      ...extraMatrixEntries.map(
        (key) =>
          `extra matrix entry without source gate — ${describeRepositoryGate(matrixByKey.get(key)!)} [${key}]`,
      ),
      ...duplicateMatrixEntries.map((key) => `duplicate matrix entry — ${key}`),
      ...duplicateSourceEntries.map((key) => `duplicate source gate — ${key}`),
    ].join("\n"),
  );
}

type RepositorySourceMethod = {
  repository: string;
  method: string;
};

type RepositoryGateAnnotation = {
  repository: string;
  mutation: string;
  permissionKey: PermissionKey;
};

type ParentNode = Node & { parent?: Node | null };

function permissionKeyFromRepositoryCall(
  node: Node,
  annotation: RepositoryGateAnnotation | undefined,
  fileName: string,
): PermissionKey {
  if (!isCallExpression(node)) {
    throw new Error(
      `repository permission call at ${sourceLocation(fileName, node)} is not a call expression`,
    );
  }
  const permissionArgument = node.arguments[2];
  // Static `permissionValues.draftWrite` and literal-computed
  // `permissionValues?.["draftWrite"]` are equivalent gate identities.
  const permissionKey =
    permissionArgument !== undefined && isMemberExpression(permissionArgument)
      ? memberPropertyName(permissionArgument)
      : undefined;

  if (permissionKey === undefined && annotation !== undefined) {
    return annotation.permissionKey;
  }
  if (permissionKey === undefined) {
    throw new Error(
      `repository permission call at ${sourceLocation(fileName, node)} must use permissionValues.<key> or declare @repository-permission-gate`,
    );
  }
  if (annotation !== undefined && annotation.permissionKey !== permissionKey) {
    throw new Error(
      `repository permission annotation at ${sourceLocation(fileName, node)} names ${annotation.permissionKey}, but the call uses ${permissionKey}`,
    );
  }
  return permissionKey as PermissionKey;
}

function repositoryGateAnnotation(node: Node): RepositoryGateAnnotation | undefined {
  const parentNode = node as ParentNode;
  const candidateNodes = [node, parentNode.parent, parentNode.parent?.parent].filter(
    (candidate): candidate is Node => candidate !== undefined && candidate !== null,
  );
  for (const candidate of candidateNodes) {
    const annotation = repositoryGateAnnotationOnNode(candidate);
    if (annotation !== undefined) {
      return annotation;
    }
  }
  return undefined;
}

function repositoryGateAnnotationOnNode(node: Node): RepositoryGateAnnotation | undefined {
  const leadingComment = leadingCommentText(node);
  const match =
    /@repository-permission-gate\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)/u.exec(
      leadingComment,
    );
  if (match === null) {
    return undefined;
  }
  const [, repository, mutation, permissionKey] = match;
  if (repository === undefined || mutation === undefined || permissionKey === undefined) {
    throw new Error(
      `invalid repository permission annotation at ${sourceLocation("<source>", node)}`,
    );
  }
  return {
    repository,
    mutation,
    permissionKey: permissionKey as PermissionKey,
  };
}

function enclosingRepositoryMethod(node: Node): RepositorySourceMethod | undefined {
  let current: ParentNode | null | undefined = (node as ParentNode).parent;
  while (current !== undefined && current !== null) {
    if (current.type === "ClassMethod" || current.type === "ClassPrivateMethod") {
      const methodName = nameOf(current.key) ?? "";
      // Babel: ClassDeclaration -> ClassBody -> ClassMethod
      const classBody = current.parent;
      const classDecl = classBody?.type === "ClassBody" ? classBody.parent : classBody;
      if (
        classDecl?.type === "ClassDeclaration" &&
        classDecl.id !== null &&
        classDecl.id !== undefined
      ) {
        return { repository: classDecl.id.name, method: methodName };
      }
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function requiredSourceMethod(
  sourceMethod: RepositorySourceMethod | undefined,
): RepositorySourceMethod {
  if (sourceMethod === undefined) {
    throw new Error("repository source method is required");
  }
  return sourceMethod;
}

function sourceGateKey({
  repository,
  sourceFile,
  mutation,
  permissionKey,
}: Pick<
  RepositoryPermissionGateCase,
  "repository" | "sourceFile" | "mutation" | "permissionKey"
>): string {
  return `${repository}:${sourceFile}:${mutation}:${permissionKey}`;
}

/**
 * Human-readable diagnostic for a matrix/source gate mismatch that names the
 * repository identity (SHARED-029), so two shared repository files with the
 * same method name + permission key cannot collapse/mask one another without
 * the diagnostic calling out WHICH repository is missing or extra.
 */
function describeRepositoryGate(
  gate: Pick<
    RepositoryPermissionGateCase,
    "repository" | "sourceFile" | "mutation" | "permissionKey"
  >,
): string {
  return `repository ${gate.repository} method ${gate.mutation} (${gate.sourceFile}) requires ${gate.permissionKey}`;
}

function requiredContext(context: DatabaseContext | undefined): DatabaseContext {
  if (context === undefined) {
    throw new Error("database context was not initialized");
  }
  return context;
}

/**
 * The sorted names of every PUBLIC method declared on `ItotoriPrincipalRepository`
 * (the auth-management surface), read from source via the TypeScript AST. This is
 * the runtime exhaustiveness primitive for `authManagementOperations`: a new
 * public method on the class that is not listed (and thus not matrix-registered)
 * makes the auth-management-group list drift and fails the test. Private /
 * protected helpers are excluded so only the gated auth-management API counts.
 */
function principalRepositoryPublicMethods(): string[] {
  const repositorySourceDir = new URL("../src/repositories/", import.meta.url);
  const sourcePath = new URL("principal-repository.ts", repositorySourceDir);
  const source = readFileSync(sourcePath, "utf8");
  const sourceFile = parseTypeScript(source, sourcePath.pathname);
  const methods: string[] = [];
  walk(sourceFile, (node) => {
    if (node.type !== "ClassDeclaration" || node.id?.name !== "ItotoriPrincipalRepository") {
      return;
    }
    for (const member of node.body.body) {
      // Mirror ts.isMethodDeclaration: constructors are ConstructorDeclaration,
      // not methods, so Babel ClassMethod kind:"constructor" must be excluded.
      if (member.type !== "ClassMethod" || member.kind === "constructor") {
        continue;
      }
      if (member.accessibility === "private" || member.accessibility === "protected") {
        continue;
      }
      const methodName = nameOf(member.key);
      if (methodName !== undefined) {
        methods.push(methodName);
      }
    }
  });
  return methods.sort();
}
