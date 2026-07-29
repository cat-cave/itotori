import type { RepositoryPermissionGateCase } from "./authorization-matrix.test.helpers.js";
import {
  projectGate,
  feedbackGate,
  modelLedgerGate,
  queueGate,
  catalogGate,
  catalogCrawlerGate,
  branchReferenceGate,
} from "./authorization-matrix.test.factories.js";

export const repositoryPermissionGateMatrixPart1 = [
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
    "loadLocaleBranchDraftTexts",
    "catalogRead",
    "context-correction-redrafter durable draft verification coverage",
    (repo) => repo.loadLocaleBranchDraftTexts(deniedActor, undefined as never),
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
    "loadManualFeedbackCorrectionContext",
    "feedbackImport",
    "repository.test.ts manual feedback correction context coverage",
    (repo) =>
      repo.loadManualFeedbackCorrectionContext(
        deniedActor,
        "feedback-report-denied",
        "feedback-evidence-denied",
      ),
  ),
  feedbackGate(
    "listUnitBoundFeedback",
    "feedbackImport",
    "repository.test.ts unit-bound feedback coverage",
    (repo) =>
      repo.listUnitBoundFeedback(deniedActor, {
        projectId: "project-denied",
        localeBranchId: "locale-branch-denied",
        bridgeUnitId: "bridge-unit-denied",
      }),
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
    "catalog-context-panel read model coverage (panel route)",
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
] satisfies readonly RepositoryPermissionGateCase[];
