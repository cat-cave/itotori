import type * as deps from "./project-repository-dependencies.js";
import type * as api from "./project-repository-types.js";
import { ProjectImportRepository } from "./project-repository-import-mixin.js";
import { ProjectDraftRepository } from "./project-repository-drafts-mixin.js";
import { ProjectRuntimePersistenceRepository } from "./project-repository-runtime-persistence-mixin.js";
import { ProjectRecordsRepository } from "./project-repository-records-mixin.js";
import { ProjectDashboardRepository } from "./project-repository-dashboard-mixin.js";
import { ProjectRuntimeDashboardRepository } from "./project-repository-runtime-dashboard-mixin.js";

export * from "./project-repository-types.js";

export interface ItotoriProjectRepositoryPort {
  reset(actor: deps.AuthorizationActor): Promise<void>;
  importSourceBundle(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
  ): Promise<api.BridgeImportStatus>;
  ensureRunProjectScope(
    actor: deps.AuthorizationActor,
    scope: api.LocalizationRunProjectScope,
  ): Promise<void>;
  saveDrafts(actor: deps.AuthorizationActor, project: api.ItotoriProjectRecord): Promise<void>;
  loadLocaleBranchDraftTexts(
    actor: deps.AuthorizationActor,
    input: api.LoadLocaleBranchDraftTextsInput,
  ): Promise<Map<string, string | null>>;
  savePatchExport(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
    patchExport: deps.PatchExport | deps.PatchExportV02,
  ): Promise<void>;
  saveRuntimeReport(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
    runtimeReport: deps.RuntimeVerificationReport | deps.RuntimeEvidenceReportV02,
    patchResultId: string,
  ): Promise<api.ProjectDashboardStatus>;
  appendEvent(actor: deps.AuthorizationActor, input: api.EventInput): Promise<void>;
  recordFinding(actor: deps.AuthorizationActor, input: api.FindingInput): Promise<void>;
  linkArtifact(actor: deps.AuthorizationActor, input: api.ArtifactInput): Promise<void>;
  recordBenchmarkArtifactWithProviderLedger(
    actor: deps.AuthorizationActor,
    input: api.BenchmarkArtifactLedgerInput,
  ): Promise<void>;
  listLocaleBranchIdentities(projectId: string): Promise<api.LocaleBranchIdentity[]>;
  listBenchmarkReports(projectId: string): Promise<api.BenchmarkReportSummary[]>;
  requireProjectScope(projectId: string): Promise<string>;
  getDashboardStatus(projectId?: string): Promise<api.ProjectDashboardStatus>;
  getRuntimeStatus(
    actor: deps.AuthorizationActor,
    runtimeRunId?: string,
    projectId?: string,
  ): Promise<api.RuntimeDashboardStatus>;
  getDashboardDecisions(projectId?: string): Promise<api.DashboardDecisionReadModel>;
}

export class ItotoriProjectRepository implements ItotoriProjectRepositoryPort {
  private readonly imports: ProjectImportRepository;
  private readonly drafts: ProjectDraftRepository;
  private readonly records: ProjectRecordsRepository;
  private readonly dashboard: ProjectDashboardRepository;
  private readonly runtimePersistence: ProjectRuntimePersistenceRepository;
  private readonly runtimeDashboard: ProjectRuntimeDashboardRepository;

  constructor(db: deps.ItotoriDatabase, engineFamilyRegistry: api.ProjectEngineFamilyRegistry) {
    this.imports = new ProjectImportRepository(db, engineFamilyRegistry);
    this.drafts = new ProjectDraftRepository(db, engineFamilyRegistry);
    this.records = new ProjectRecordsRepository(db, engineFamilyRegistry);
    this.dashboard = new ProjectDashboardRepository(db, engineFamilyRegistry);
    this.runtimePersistence = new ProjectRuntimePersistenceRepository(
      db,
      engineFamilyRegistry,
      (projectId) => this.dashboard.getDashboardStatus(projectId),
    );
    this.runtimeDashboard = new ProjectRuntimeDashboardRepository(
      db,
      engineFamilyRegistry,
      (projectId) => this.dashboard.requireProjectScope(projectId),
    );
  }

  reset(actor: deps.AuthorizationActor) {
    return this.imports.reset(actor);
  }
  importSourceBundle(actor: deps.AuthorizationActor, project: api.ItotoriProjectRecord) {
    return this.imports.importSourceBundle(actor, project);
  }
  ensureRunProjectScope(actor: deps.AuthorizationActor, scope: api.LocalizationRunProjectScope) {
    return this.drafts.ensureRunProjectScope(actor, scope);
  }
  saveDrafts(actor: deps.AuthorizationActor, project: api.ItotoriProjectRecord) {
    return this.drafts.saveDrafts(actor, project);
  }
  loadLocaleBranchDraftTexts(
    actor: deps.AuthorizationActor,
    input: api.LoadLocaleBranchDraftTextsInput,
  ) {
    return this.drafts.loadLocaleBranchDraftTexts(actor, input);
  }
  savePatchExport(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
    patchExport: deps.PatchExport | deps.PatchExportV02,
  ) {
    return this.drafts.savePatchExport(actor, project, patchExport);
  }
  saveRuntimeReport(
    actor: deps.AuthorizationActor,
    project: api.ItotoriProjectRecord,
    runtimeReport: deps.RuntimeVerificationReport | deps.RuntimeEvidenceReportV02,
    patchResultId: string,
  ) {
    return this.runtimePersistence.saveRuntimeReport(actor, project, runtimeReport, patchResultId);
  }
  appendEvent(actor: deps.AuthorizationActor, input: api.EventInput) {
    return this.records.appendEvent(actor, input);
  }
  recordFinding(actor: deps.AuthorizationActor, input: api.FindingInput) {
    return this.records.recordFinding(actor, input);
  }
  linkArtifact(actor: deps.AuthorizationActor, input: api.ArtifactInput) {
    return this.records.linkArtifact(actor, input);
  }
  recordBenchmarkArtifactWithProviderLedger(
    actor: deps.AuthorizationActor,
    input: api.BenchmarkArtifactLedgerInput,
  ) {
    return this.records.recordBenchmarkArtifactWithProviderLedger(actor, input);
  }
  listLocaleBranchIdentities(projectId: string) {
    return this.records.listLocaleBranchIdentities(projectId);
  }
  listBenchmarkReports(projectId: string) {
    return this.records.listBenchmarkReports(projectId);
  }
  requireProjectScope(projectId: string) {
    return this.dashboard.requireProjectScope(projectId);
  }
  getDashboardStatus(projectId?: string) {
    return this.dashboard.getDashboardStatus(projectId);
  }
  getRuntimeStatus(actor: deps.AuthorizationActor, runtimeRunId?: string, projectId?: string) {
    return this.runtimeDashboard.getRuntimeStatus(actor, runtimeRunId, projectId);
  }
  getDashboardDecisions(projectId?: string) {
    return this.dashboard.getDashboardDecisions(projectId);
  }
}
