import { readdirSync, readFileSync } from "node:fs";
import * as ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  permissionValues,
  type AuthorizationActor,
  type Permission,
} from "../src/authorization.js";
import { ItotoriAssetLocalizationDecisionRepository } from "../src/repositories/asset-localization-decision-repository.js";
import { ItotoriAuditFindingRepository } from "../src/repositories/audit-finding-repository.js";
import { ItotoriReviewerQueueRepository } from "../src/repositories/reviewer-queue-repository.js";
import { ItotoriBranchReferenceRepository } from "../src/repositories/branch-reference-repository.js";
import { ItotoriCharacterRelationshipRepository } from "../src/repositories/character-relationship-repository.js";
import { ItotoriConformanceRepository } from "../src/repositories/conformance-repository.js";
import { EngineCapabilityReportRepository } from "../src/repositories/engine-capability-report-repository.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import { ItotoriContextArtifactRepository } from "../src/repositories/context-artifact-repository.js";
import { ItotoriDraftAttemptProviderLedgerRepository } from "../src/repositories/draft-attempt-provider-ledger-repository.js";
import { ItotoriDraftJobRepository } from "../src/repositories/draft-job-repository.js";
import { ItotoriEventQueueRepository } from "../src/repositories/event-queue-repository.js";
import { ItotoriExactSearchDocumentRepository } from "../src/repositories/exact-search-document-repository.js";
import { ItotoriFeedbackRepository } from "../src/repositories/feedback-repository.js";
import { ItotoriModelLedgerRepository } from "../src/repositories/model-ledger-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { ItotoriRouteChoiceMapRepository } from "../src/repositories/route-choice-map-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";
import { ItotoriTerminologyCandidateRepository } from "../src/repositories/terminology-candidate-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import { ItotoriTranslationBatchRepository } from "../src/repositories/translation-batch-repository.js";
import { ItotoriSceneSummaryRepository } from "../src/repositories/scene-summary-repository.js";
import { ItotoriTranslationMemoryRepository } from "../src/repositories/translation-memory-repository.js";
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
    "approveVersion",
    "draftWrite",
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
  sceneSummaryGate(
    "saveSummary",
    "draftWrite",
    "scene-summary-repository.test.ts save coverage",
    (repo) => repo.saveSummary(deniedActor, undefined as never),
  ),
  sceneSummaryGate(
    "loadSummaryByScene",
    "catalogRead",
    "scene-summary-repository.test.ts load-by-scene coverage",
    (repo) => repo.loadSummaryByScene(deniedActor, undefined as never),
  ),
  sceneSummaryGate(
    "loadSummaries",
    "catalogRead",
    "scene-summary-repository.test.ts load coverage",
    (repo) => repo.loadSummaries(deniedActor, undefined as never),
  ),
  sceneSummaryGate(
    "markStale",
    "draftWrite",
    "scene-summary-repository.test.ts mark stale coverage",
    (repo) => repo.markStale(deniedActor, undefined as never),
  ),
  sceneSummaryGate(
    "currentSourceHashesForBridgeUnits",
    "catalogRead",
    "scene-summary-repository.test.ts hashes coverage",
    (repo) => repo.currentSourceHashesForBridgeUnits(deniedActor, { bridgeUnitIds: [] }),
  ),
  sceneSummaryGate(
    "loadBridgeUnitsForSummary",
    "catalogRead",
    "scene-summary-repository.test.ts bridge units coverage",
    (repo) => repo.loadBridgeUnitsForSummary(deniedActor, { bridgeUnitIds: [] }),
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
  characterRelationshipGate(
    "saveBio",
    "draftWrite",
    "character-relationship-repository.test.ts save bio coverage",
    (repo) => repo.saveBio(deniedActor, undefined as never),
  ),
  characterRelationshipGate(
    "saveRelationship",
    "draftWrite",
    "character-relationship-repository.test.ts save relationship coverage",
    (repo) => repo.saveRelationship(deniedActor, undefined as never),
  ),
  characterRelationshipGate(
    "loadBios",
    "catalogRead",
    "character-relationship-repository.test.ts load bios coverage",
    (repo) => repo.loadBios(deniedActor, undefined as never),
  ),
  characterRelationshipGate(
    "loadBioByCharacter",
    "catalogRead",
    "character-relationship-repository.test.ts load bio by character coverage",
    (repo) => repo.loadBioByCharacter(deniedActor, undefined as never),
  ),
  characterRelationshipGate(
    "loadRelationshipsByProject",
    "catalogRead",
    "character-relationship-repository.test.ts load relationships by project coverage",
    (repo) => repo.loadRelationshipsByProject(deniedActor, undefined as never),
  ),
  characterRelationshipGate(
    "currentSourceHashesForBridgeUnits",
    "catalogRead",
    "character-relationship-repository.test.ts current-source-hashes coverage",
    (repo) => repo.currentSourceHashesForBridgeUnits(deniedActor, undefined as never),
  ),
  characterRelationshipGate(
    "markBioStale",
    "draftWrite",
    "character-relationship-repository.test.ts mark bio stale coverage",
    (repo) => repo.markBioStale(deniedActor, undefined as never),
  ),
  characterRelationshipGate(
    "markRelationshipStale",
    "draftWrite",
    "character-relationship-repository.test.ts mark relationship stale coverage",
    (repo) => repo.markRelationshipStale(deniedActor, undefined as never),
  ),
  routeChoiceMapGate(
    "saveRouteMap",
    "draftWrite",
    "route-choice-map-repository.test.ts save route map coverage",
    (repo) => repo.saveRouteMap(deniedActor, undefined as never),
  ),
  routeChoiceMapGate(
    "saveRouteChoice",
    "draftWrite",
    "route-choice-map-repository.test.ts save route choice coverage",
    (repo) => repo.saveRouteChoice(deniedActor, undefined as never),
  ),
  routeChoiceMapGate(
    "loadRouteMapsByProject",
    "catalogRead",
    "route-choice-map-repository.test.ts load route maps coverage",
    (repo) => repo.loadRouteMapsByProject(deniedActor, undefined as never),
  ),
  routeChoiceMapGate(
    "loadRouteChoicesByProject",
    "catalogRead",
    "route-choice-map-repository.test.ts load route choices coverage",
    (repo) => repo.loadRouteChoicesByProject(deniedActor, undefined as never),
  ),
  routeChoiceMapGate(
    "currentSourceHashesForBridgeUnits",
    "catalogRead",
    "route-choice-map-repository.test.ts current-source-hashes coverage",
    (repo) => repo.currentSourceHashesForBridgeUnits(deniedActor, undefined as never),
  ),
  routeChoiceMapGate(
    "markRouteMapStale",
    "draftWrite",
    "route-choice-map-repository.test.ts mark route map stale coverage",
    (repo) => repo.markRouteMapStale(deniedActor, undefined as never),
  ),
  routeChoiceMapGate(
    "markRouteChoiceStale",
    "draftWrite",
    "route-choice-map-repository.test.ts mark route choice stale coverage",
    (repo) => repo.markRouteChoiceStale(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "saveCandidate",
    "draftWrite",
    "terminology-candidate-repository.test.ts save candidate coverage",
    (repo) => repo.saveCandidate(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "loadCandidatesByProject",
    "catalogRead",
    "terminology-candidate-repository.test.ts load candidates coverage",
    (repo) => repo.loadCandidatesByProject(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "markCandidateStale",
    "draftWrite",
    "terminology-candidate-repository.test.ts mark candidate stale coverage",
    (repo) => repo.markCandidateStale(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "markCandidatePromoted",
    "draftWrite",
    "terminology-candidate-repository.test.ts mark candidate promoted coverage",
    (repo) => repo.markCandidatePromoted(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "markCandidateRejected",
    "draftWrite",
    "terminology-candidate-repository.test.ts mark candidate rejected coverage",
    (repo) => repo.markCandidateRejected(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "currentSourceHashesForBridgeUnits",
    "catalogRead",
    "terminology-candidate-repository.test.ts current-source-hashes coverage",
    (repo) => repo.currentSourceHashesForBridgeUnits(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "existsTerminologyTermBySurfaceForm",
    "catalogRead",
    "terminology-candidate-repository.test.ts exists surface-form coverage",
    (repo) => repo.existsTerminologyTermBySurfaceForm(deniedActor, undefined as never),
  ),
  terminologyCandidateGate(
    "countTerminologyTerms",
    "catalogRead",
    "terminology-candidate-repository.test.ts count terminology terms coverage",
    (repo) => repo.countTerminologyTerms(deniedActor, undefined as never),
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
  draftAttemptProviderLedgerGate(
    "recordLedgerEntry",
    "draftWrite",
    "draft-attempt-provider-ledger-repository.test.ts record ledger entry coverage",
    (repo) => repo.recordLedgerEntry(deniedActor, undefined as never),
  ),
  draftAttemptProviderLedgerGate(
    "loadEntriesByAttempt",
    "catalogRead",
    "draft-attempt-provider-ledger-repository.test.ts load entries by attempt coverage",
    (repo) => repo.loadEntriesByAttempt(deniedActor, "draft-job-attempt"),
  ),
  draftAttemptProviderLedgerGate(
    "loadEntriesByProviderProof",
    "catalogRead",
    "draft-attempt-provider-ledger-repository.test.ts load entries by provider proof coverage",
    (repo) => repo.loadEntriesByProviderProof(deniedActor, "provider-proof"),
  ),
  draftAttemptProviderLedgerGate(
    "sumCostByProject",
    "catalogRead",
    "draft-attempt-provider-ledger-repository.test.ts sum cost by project coverage",
    (repo) =>
      repo.sumCostByProject(deniedActor, "project", {
        from: new Date(0),
        to: new Date(0),
      }),
  ),
  draftAttemptProviderLedgerGate(
    "sumByPairAndDay",
    "catalogRead",
    "draft-attempt-provider-ledger-repository.test.ts sum by pair and day coverage",
    (repo) =>
      repo.sumByPairAndDay(deniedActor, "project", {
        from: new Date(0),
        to: new Date(0),
      }),
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
] as const satisfies readonly RepositoryPermissionGateCase[];

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
          "mutation": "ItotoriStyleGuideRepository.approveVersion",
          "requiredPermission": "draft.write",
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
          "mutation": "ItotoriSceneSummaryRepository.saveSummary",
          "requiredPermission": "draft.write",
          "successFixture": "scene-summary-repository.test.ts save coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneSummaryRepository.loadSummaryByScene",
          "requiredPermission": "catalog.read",
          "successFixture": "scene-summary-repository.test.ts load-by-scene coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneSummaryRepository.loadSummaries",
          "requiredPermission": "catalog.read",
          "successFixture": "scene-summary-repository.test.ts load coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneSummaryRepository.markStale",
          "requiredPermission": "draft.write",
          "successFixture": "scene-summary-repository.test.ts mark stale coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneSummaryRepository.currentSourceHashesForBridgeUnits",
          "requiredPermission": "catalog.read",
          "successFixture": "scene-summary-repository.test.ts hashes coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriSceneSummaryRepository.loadBridgeUnitsForSummary",
          "requiredPermission": "catalog.read",
          "successFixture": "scene-summary-repository.test.ts bridge units coverage",
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
          "mutation": "ItotoriCharacterRelationshipRepository.saveBio",
          "requiredPermission": "draft.write",
          "successFixture": "character-relationship-repository.test.ts save bio coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCharacterRelationshipRepository.saveRelationship",
          "requiredPermission": "draft.write",
          "successFixture": "character-relationship-repository.test.ts save relationship coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCharacterRelationshipRepository.loadBios",
          "requiredPermission": "catalog.read",
          "successFixture": "character-relationship-repository.test.ts load bios coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCharacterRelationshipRepository.loadBioByCharacter",
          "requiredPermission": "catalog.read",
          "successFixture": "character-relationship-repository.test.ts load bio by character coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCharacterRelationshipRepository.loadRelationshipsByProject",
          "requiredPermission": "catalog.read",
          "successFixture": "character-relationship-repository.test.ts load relationships by project coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCharacterRelationshipRepository.currentSourceHashesForBridgeUnits",
          "requiredPermission": "catalog.read",
          "successFixture": "character-relationship-repository.test.ts current-source-hashes coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCharacterRelationshipRepository.markBioStale",
          "requiredPermission": "draft.write",
          "successFixture": "character-relationship-repository.test.ts mark bio stale coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriCharacterRelationshipRepository.markRelationshipStale",
          "requiredPermission": "draft.write",
          "successFixture": "character-relationship-repository.test.ts mark relationship stale coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriRouteChoiceMapRepository.saveRouteMap",
          "requiredPermission": "draft.write",
          "successFixture": "route-choice-map-repository.test.ts save route map coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriRouteChoiceMapRepository.saveRouteChoice",
          "requiredPermission": "draft.write",
          "successFixture": "route-choice-map-repository.test.ts save route choice coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriRouteChoiceMapRepository.loadRouteMapsByProject",
          "requiredPermission": "catalog.read",
          "successFixture": "route-choice-map-repository.test.ts load route maps coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriRouteChoiceMapRepository.loadRouteChoicesByProject",
          "requiredPermission": "catalog.read",
          "successFixture": "route-choice-map-repository.test.ts load route choices coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriRouteChoiceMapRepository.currentSourceHashesForBridgeUnits",
          "requiredPermission": "catalog.read",
          "successFixture": "route-choice-map-repository.test.ts current-source-hashes coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriRouteChoiceMapRepository.markRouteMapStale",
          "requiredPermission": "draft.write",
          "successFixture": "route-choice-map-repository.test.ts mark route map stale coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriRouteChoiceMapRepository.markRouteChoiceStale",
          "requiredPermission": "draft.write",
          "successFixture": "route-choice-map-repository.test.ts mark route choice stale coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.saveCandidate",
          "requiredPermission": "draft.write",
          "successFixture": "terminology-candidate-repository.test.ts save candidate coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.loadCandidatesByProject",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-candidate-repository.test.ts load candidates coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.markCandidateStale",
          "requiredPermission": "draft.write",
          "successFixture": "terminology-candidate-repository.test.ts mark candidate stale coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.markCandidatePromoted",
          "requiredPermission": "draft.write",
          "successFixture": "terminology-candidate-repository.test.ts mark candidate promoted coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.markCandidateRejected",
          "requiredPermission": "draft.write",
          "successFixture": "terminology-candidate-repository.test.ts mark candidate rejected coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.currentSourceHashesForBridgeUnits",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-candidate-repository.test.ts current-source-hashes coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.existsTerminologyTermBySurfaceForm",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-candidate-repository.test.ts exists surface-form coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriTerminologyCandidateRepository.countTerminologyTerms",
          "requiredPermission": "catalog.read",
          "successFixture": "terminology-candidate-repository.test.ts count terminology terms coverage",
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
          "mutation": "ItotoriDraftAttemptProviderLedgerRepository.recordLedgerEntry",
          "requiredPermission": "draft.write",
          "successFixture": "draft-attempt-provider-ledger-repository.test.ts record ledger entry coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftAttemptProviderLedgerRepository.loadEntriesByAttempt",
          "requiredPermission": "catalog.read",
          "successFixture": "draft-attempt-provider-ledger-repository.test.ts load entries by attempt coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftAttemptProviderLedgerRepository.loadEntriesByProviderProof",
          "requiredPermission": "catalog.read",
          "successFixture": "draft-attempt-provider-ledger-repository.test.ts load entries by provider proof coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftAttemptProviderLedgerRepository.sumCostByProject",
          "requiredPermission": "catalog.read",
          "successFixture": "draft-attempt-provider-ledger-repository.test.ts sum cost by project coverage",
        },
        {
          "denialFixture": "missing permission actor user-without-required-permission",
          "mutation": "ItotoriDraftAttemptProviderLedgerRepository.sumByPairAndDay",
          "requiredPermission": "catalog.read",
          "successFixture": "draft-attempt-provider-ledger-repository.test.ts sum by pair and day coverage",
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
      ]
    `);
  });

  it("matches every repository source permission gate", () => {
    expect(repositoryPermissionGateMatrix.map(sourceGateKey).sort()).toEqual(
      sourcePermissionGates().map(sourceGateKey).sort(),
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("repository permission denial fixtures", () => {
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

function sceneSummaryGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriSceneSummaryRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriSceneSummaryRepository",
    sourceFile: "scene-summary-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriSceneSummaryRepository(db)),
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

function characterRelationshipGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriCharacterRelationshipRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriCharacterRelationshipRepository",
    sourceFile: "character-relationship-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriCharacterRelationshipRepository(db)),
  });
}

function routeChoiceMapGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriRouteChoiceMapRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriRouteChoiceMapRepository",
    sourceFile: "route-choice-map-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriRouteChoiceMapRepository(db)),
  });
}

function terminologyCandidateGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriTerminologyCandidateRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriTerminologyCandidateRepository",
    sourceFile: "terminology-candidate-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriTerminologyCandidateRepository(db)),
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

function draftAttemptProviderLedgerGate(
  mutation: string,
  permissionKey: PermissionKey,
  successFixture: string,
  run: (repository: ItotoriDraftAttemptProviderLedgerRepository) => Promise<unknown>,
): RepositoryPermissionGateCase {
  return repositoryGate({
    repository: "ItotoriDraftAttemptProviderLedgerRepository",
    sourceFile: "draft-attempt-provider-ledger-repository.ts",
    mutation,
    permissionKey,
    successFixture,
    runDeniedMutation: (db) => run(new ItotoriDraftAttemptProviderLedgerRepository(db)),
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
  "sourceFile" | "mutation" | "permissionKey"
>[] {
  const gates: Pick<RepositoryPermissionGateCase, "sourceFile" | "mutation" | "permissionKey">[] =
    [];
  const repositorySourceDir = new URL("../src/repositories/", import.meta.url);

  for (const sourceFile of readdirSync(repositorySourceDir).filter((file) =>
    file.endsWith(".ts"),
  )) {
    const sourceUrl = new URL(sourceFile, repositorySourceDir);
    const source = readFileSync(sourceUrl, "utf8");
    const parsedSource = ts.createSourceFile(
      sourceUrl.pathname,
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        callExpressionName(node.expression) === "requirePermission"
      ) {
        const gateAnnotation = repositoryGateAnnotation(source, parsedSource, node);
        const permissionKey = permissionKeyFromRepositoryCall(node, gateAnnotation);
        const sourceMethod = enclosingRepositoryMethod(node);
        if (sourceMethod === undefined && gateAnnotation === undefined) {
          throw new Error(
            `repository permission call at ${sourceLocation(parsedSource, node)} must be inside a repository method or declare @repository-permission-gate <Repository>.<mutation> <permissionKey>`,
          );
        }
        gates.push({
          sourceFile,
          mutation: gateAnnotation?.mutation ?? requiredSourceMethod(sourceMethod).method,
          permissionKey,
        });
      }

      ts.forEachChild(node, visit);
    }

    visit(parsedSource);
  }

  return gates;
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

function permissionKeyFromRepositoryCall(
  node: ts.CallExpression,
  annotation: RepositoryGateAnnotation | undefined,
): PermissionKey {
  const permissionArgument = node.arguments[2];
  const permissionKey =
    permissionArgument !== undefined && ts.isPropertyAccessExpression(permissionArgument)
      ? permissionArgument.name.text
      : undefined;

  if (permissionKey === undefined && annotation !== undefined) {
    return annotation.permissionKey;
  }
  if (permissionKey === undefined) {
    throw new Error(
      `repository permission call at ${sourceLocation(node.getSourceFile(), node)} must use permissionValues.<key> or declare @repository-permission-gate`,
    );
  }
  if (annotation !== undefined && annotation.permissionKey !== permissionKey) {
    throw new Error(
      `repository permission annotation at ${sourceLocation(node.getSourceFile(), node)} names ${annotation.permissionKey}, but the call uses ${permissionKey}`,
    );
  }
  return permissionKey as PermissionKey;
}

function repositoryGateAnnotation(
  source: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): RepositoryGateAnnotation | undefined {
  const comments = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
  const leadingComment = comments
    .map((comment) => source.slice(comment.pos, comment.end))
    .join("\n");
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
      `invalid repository permission annotation at ${sourceLocation(sourceFile, node)}`,
    );
  }
  return {
    repository,
    mutation,
    permissionKey: permissionKey as PermissionKey,
  };
}

function enclosingRepositoryMethod(node: ts.Node): RepositorySourceMethod | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isMethodDeclaration(current)) {
      const methodName = current.name.getText();
      const parent = current.parent;
      if (ts.isClassDeclaration(parent) && parent.name !== undefined) {
        return { repository: parent.name.text, method: methodName };
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

function callExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
}

function sourceGateKey({
  sourceFile,
  mutation,
  permissionKey,
}: Pick<RepositoryPermissionGateCase, "sourceFile" | "mutation" | "permissionKey">): string {
  return `${sourceFile}:${mutation}:${permissionKey}`;
}

function requiredContext(context: DatabaseContext | undefined): DatabaseContext {
  if (context === undefined) {
    throw new Error("database context was not initialized");
  }
  return context;
}
