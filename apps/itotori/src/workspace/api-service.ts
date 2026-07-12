// ITOTORI-040 — localization workspace read-model service.
//
// Composes the read-model ports the rest of the app already exposes
// (project dashboard status + locale-branch identity, scene summaries,
// asset decisions, exact / terminology search, reviewer detail context)
// into the workspace browse / comparison / search read-models. The
// service NEVER touches Postgres directly — `LocalizationWorkspaceReadPort`
// is the only persistence seam, and the DB-backed implementation is wired
// in `services/database-services.ts` from the existing repositories. Tests
// inject an in-memory port.
//
// Read-through-API: the JSON API layer (`api-handlers.ts`) calls these
// methods and serializes the result; the SPA route fetches that JSON. The
// comparison method delegates to the reviewer detail read-model
// (`loadComparisonContext`) rather than re-deriving source/draft/final, so
// there is exactly one source of truth for the comparison.

import type {
  AssetDecisionRecord,
  CandidateAssetRecord,
  ContextSceneSummary,
  JobsRunTableReadModel,
  LocaleBranchIdentity,
  ProjectDashboardStatus,
  SearchExactInput,
  SearchExactToolResult,
  TerminologySearchInput,
  TerminologySearchReadModel,
  SourceUnitTextRecord,
} from "@itotori/db";
import type { ReviewerQueueDashboardReadModel } from "../reviewer/api-service.js";
import type { ReviewerDetailContext } from "../reviewer/detail-fixtures.js";
import { reviewerDetailDiagnosticCodeValues } from "../reviewer/detail-fixtures.js";
import {
  workspaceDiagnosticCodeValues,
  workspaceSearchResultKindValues,
  workspaceSearchModeValues,
  type WorkspaceAssetBrowseReadModel,
  type WorkspaceAssetEntry,
  type WorkspaceComparisonCell,
  type WorkspaceComparisonReadModel,
  type WorkspaceDiagnostic,
  type WorkspaceLocaleBranchSummary,
  type WorkspacePermissionView,
  type WorkspaceProjectBrowseReadModel,
  type WorkspaceProjectSummary,
  type WorkspaceRuntimeEvidenceLink,
  type WorkspaceSceneBrowseReadModel,
  type WorkspaceSceneContext,
  type WorkspaceSceneUnit,
  type WorkspaceSearchMode,
  type WorkspaceSearchPagination,
  type WorkspaceSearchReadModel,
  type WorkspaceSearchResult,
} from "./read-model.js";

/**
 * The single persistence seam for the workspace. Each method maps 1:1 to
 * an existing read-model / repository call (already actor-bound by the
 * wiring layer). The workspace composes these; it does not reimplement
 * any of them.
 */
export interface LocalizationWorkspaceReadPort {
  getDashboardStatus(): Promise<ProjectDashboardStatus>;
  listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]>;
  loadSceneSummaries(query: {
    projectId: string;
    localeBranchId?: string;
    sourceRevisionId?: string;
  }): Promise<ContextSceneSummary[]>;
  loadBridgeUnitsForSummary(bridgeUnitIds: string[]): Promise<Map<string, SourceUnitTextRecord>>;
  loadActiveAssetDecisions(
    projectId: string,
    localeBranchId: string,
  ): Promise<AssetDecisionRecord[]>;
  loadCandidateAssets(projectId: string, localeBranchId: string): Promise<CandidateAssetRecord[]>;
  searchExact(input: SearchExactInput): Promise<SearchExactToolResult>;
  searchTerminology(input: TerminologySearchInput): Promise<TerminologySearchReadModel>;
  loadRunTable(input: {
    projectId: string;
    limit?: number;
    offset?: number;
  }): Promise<JobsRunTableReadModel>;
  loadReviewerDashboard(input: {
    localeBranchId: string;
    permission: WorkspacePermissionView;
  }): Promise<ReviewerQueueDashboardReadModel>;
  loadReviewItemIdsByBridgeUnit(input: {
    localeBranchId: string;
    bridgeUnitIds: string[];
    permission: WorkspacePermissionView;
  }): Promise<Map<string, string>>;
  loadComparisonContext(input: {
    reviewItemId: string;
    permission: WorkspacePermissionView;
  }): Promise<ReviewerDetailContext>;
}

export type LocalizationWorkspaceApiServiceDeps = {
  readPort: LocalizationWorkspaceReadPort;
  now?: () => Date;
};

export type LoadWorkspaceProjectBrowseInput = {
  permission: WorkspacePermissionView;
};

export type LoadWorkspaceSceneBrowseInput = {
  projectId: string;
  localeBranchId: string;
  sceneId?: string;
  sourceRevisionId?: string;
  limit?: number;
  offset?: number;
  permission: WorkspacePermissionView;
};

export type LoadWorkspaceAssetBrowseInput = {
  projectId: string;
  localeBranchId: string;
  permission: WorkspacePermissionView;
};

export type LoadWorkspaceComparisonInput = {
  reviewItemId: string;
  permission: WorkspacePermissionView;
};

export type LoadWorkspaceSearchInput = {
  projectId: string;
  localeBranchId: string;
  query: string;
  mode?: WorkspaceSearchMode;
  limit?: number;
  offset?: number;
  canReadCatalog: boolean;
  permission: WorkspacePermissionView;
};

export interface LocalizationWorkspaceApiServicePort {
  loadProjectBrowse(
    input: LoadWorkspaceProjectBrowseInput,
  ): Promise<WorkspaceProjectBrowseReadModel>;
  loadSceneBrowse(input: LoadWorkspaceSceneBrowseInput): Promise<WorkspaceSceneBrowseReadModel>;
  loadAssetBrowse(input: LoadWorkspaceAssetBrowseInput): Promise<WorkspaceAssetBrowseReadModel>;
  loadComparison(input: LoadWorkspaceComparisonInput): Promise<WorkspaceComparisonReadModel>;
  loadSearch(input: LoadWorkspaceSearchInput): Promise<WorkspaceSearchReadModel>;
}

export class LocalizationWorkspaceApiService implements LocalizationWorkspaceApiServicePort {
  private readonly now: () => Date;

  constructor(private readonly deps: LocalizationWorkspaceApiServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async loadProjectBrowse(
    input: LoadWorkspaceProjectBrowseInput,
  ): Promise<WorkspaceProjectBrowseReadModel> {
    if (!input.permission.canReadQueue) {
      return {
        schemaVersion: "workspace.project_browse.v0.1",
        generatedAt: this.now(),
        permission: input.permission,
        projects: [],
        diagnostics: [permissionDeniedDiagnostic(input.permission)],
      };
    }
    const status = await this.deps.readPort.getDashboardStatus();
    const identities = await this.deps.readPort.listLocaleBranchIdentities(status.projectId);
    const identityById = new Map(identities.map((identity) => [identity.localeBranchId, identity]));
    const diagnostics: WorkspaceDiagnostic[] = [];
    const localeBranches: WorkspaceLocaleBranchSummary[] = [];
    for (const branch of status.localeBranches) {
      const identity = identityById.get(branch.localeBranchId);
      // A branch present in the dashboard status REQUIRES a resolvable
      // identity (branch name + source locale). If it fails to resolve,
      // never fabricate the identity from the raw branch id / project
      // source locale — surface it and drop the branch (ITOTORI-059).
      if (identity === undefined) {
        diagnostics.push(unresolvedLocaleBranchIdentityDiagnostic(branch.localeBranchId));
        continue;
      }
      localeBranches.push({
        localeBranchId: branch.localeBranchId,
        projectId: status.projectId,
        branchName: identity.branchName,
        sourceLocale: identity.sourceLocale,
        targetLocale: branch.targetLocale,
        status: branch.status,
        unitCount: branch.unitCount,
        translatedUnitCount: branch.translatedUnitCount,
        openFindingCount: branch.openFindingCount,
        artifactCount: branch.artifactCount,
        currentStyleGuidePolicyVersionId: branch.currentStyleGuidePolicyVersionId,
        sceneBrowsePath: workspaceSceneBrowsePath(status.projectId, branch.localeBranchId),
        assetBrowsePath: workspaceAssetBrowsePath(status.projectId, branch.localeBranchId),
      });
    }
    const project: WorkspaceProjectSummary = {
      projectId: status.projectId,
      projectKey: status.projectKey,
      name: status.name,
      status: status.status,
      sourceLocale: status.sourceLocale,
      sourceBundleRevisionId: status.sourceBundleRevisionId,
      branchCount: status.branchCount,
      unitCount: status.unitCount,
      localeBranches,
    };
    return {
      schemaVersion: "workspace.project_browse.v0.1",
      generatedAt: this.now(),
      permission: input.permission,
      projects: [project],
      diagnostics,
    };
  }

  async loadSceneBrowse(
    input: LoadWorkspaceSceneBrowseInput,
  ): Promise<WorkspaceSceneBrowseReadModel> {
    const limit = normalizeWorkspaceSceneLimit(input.limit);
    const offset = normalizeWorkspaceSceneOffset(input.offset);
    const base = {
      schemaVersion: "workspace.scene_browse.v0.1" as const,
      generatedAt: this.now(),
      permission: input.permission,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      pagination: searchPagination(0, limit, offset),
    };
    if (!input.permission.canReadQueue) {
      return {
        ...base,
        scenes: [],
        diagnostics: [permissionDeniedDiagnostic(input.permission)],
      };
    }
    const diagnostics: WorkspaceDiagnostic[] = [];
    const summaryQuery: {
      projectId: string;
      localeBranchId: string;
      sourceRevisionId?: string;
    } = {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    };
    if (input.sourceRevisionId !== undefined) {
      summaryQuery.sourceRevisionId = input.sourceRevisionId;
    }
    const summaries = (await this.deps.readPort.loadSceneSummaries(summaryQuery)).filter(
      (summary) => input.sceneId === undefined || summary.sceneId === input.sceneId,
    );
    // Locale-branch identity guard (ITOTORI-059): never conflate branches.
    const scopedSummaries = summaries.filter((summary) => {
      if (summary.localeBranchId !== input.localeBranchId) {
        diagnostics.push(
          branchConflationDiagnostic("scene summary", summary.localeBranchId, input),
        );
        return false;
      }
      return true;
    });
    if (scopedSummaries.length === 0) {
      diagnostics.push({
        code: workspaceDiagnosticCodeValues.missingSceneSummaries,
        message: `No scene summaries are available for locale branch ${input.localeBranchId}; the reviewer cannot navigate by translated summaries yet.`,
      });
    }
    const pageSummaries = scopedSummaries.slice(offset, offset + limit);
    const pagination = searchPagination(scopedSummaries.length, limit, offset);
    const allBridgeUnitIds = [
      ...new Set(
        pageSummaries.flatMap((summary) =>
          summary.citations.map((citation) => citation.bridgeUnitId),
        ),
      ),
    ];
    const unitsById =
      allBridgeUnitIds.length === 0
        ? new Map<string, SourceUnitTextRecord>()
        : await this.deps.readPort.loadBridgeUnitsForSummary(allBridgeUnitIds);
    const reviewItemIdByBridgeUnit =
      allBridgeUnitIds.length === 0
        ? new Map<string, string>()
        : await this.deps.readPort.loadReviewItemIdsByBridgeUnit({
            localeBranchId: input.localeBranchId,
            bridgeUnitIds: allBridgeUnitIds,
            permission: input.permission,
          });
    const scenes: WorkspaceSceneContext[] = pageSummaries.map((summary) => {
      const stale = summary.status === "Stale";
      const units: WorkspaceSceneUnit[] = [];
      let unresolvedCitedUnitCount = 0;
      for (const citation of summary.citations
        .slice()
        .sort((left, right) => left.citeOrdinal - right.citeOrdinal)) {
        const unit = unitsById.get(citation.bridgeUnitId);
        // A scene-cited bridge unit REQUIRES a resolvable identity
        // (sourceUnitKey + occurrenceId). If the lookup returns nothing,
        // never fabricate that identity from the raw bridgeUnitId and mark
        // it cited — surface it and drop the fabricated citation. speaker /
        // sourceText remain legitimately optional on a resolved unit.
        if (unit === undefined) {
          unresolvedCitedUnitCount += 1;
          continue;
        }
        units.push({
          bridgeUnitId: citation.bridgeUnitId,
          reviewItemId: reviewItemIdByBridgeUnit.get(citation.bridgeUnitId) ?? null,
          sourceUnitKey: unit.sourceUnitKey,
          speaker: unit.speaker,
          occurrenceId: unit.occurrenceId,
          sourceText: unit.sourceText,
          cited: true,
        });
      }
      if (unresolvedCitedUnitCount > 0) {
        diagnostics.push({
          code: workspaceDiagnosticCodeValues.unresolvedCitedUnit,
          message: `Scene ${summary.sceneId} cites ${unresolvedCitedUnitCount} bridge unit(s) whose identity (source unit key / occurrence id) could not be resolved; those citations are omitted rather than surfaced with a fabricated identity.`,
        });
      }
      if (units.length === 0) {
        diagnostics.push({
          code: workspaceDiagnosticCodeValues.missingUnits,
          message: `Scene ${summary.sceneId} summary cites no bridge units; unit-level navigation is unavailable for this scene.`,
        });
      }
      if (stale) {
        diagnostics.push({
          code: workspaceDiagnosticCodeValues.staleSceneSummary,
          message: `Scene ${summary.sceneId} summary is ${summary.status}; the translated summary may not reflect the current source revision.`,
        });
      }
      return {
        sceneId: summary.sceneId,
        sceneSummaryId: summary.contextArtifactId,
        localeBranchId: summary.localeBranchId,
        sourceRevisionId: summary.sourceRevisionId,
        summaryLocale: summary.summaryLocale,
        summaryText: summary.summaryText,
        status: summary.status,
        stale,
        generatedAt: summary.generatedAt,
        units,
        citedUnitCount: units.length,
      };
    });
    return {
      ...base,
      pagination,
      scenes,
      diagnostics,
    };
  }

  async loadAssetBrowse(
    input: LoadWorkspaceAssetBrowseInput,
  ): Promise<WorkspaceAssetBrowseReadModel> {
    const base = {
      schemaVersion: "workspace.asset_browse.v0.1" as const,
      generatedAt: this.now(),
      permission: input.permission,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    };
    if (!input.permission.canReadQueue) {
      return { ...base, assets: [], diagnostics: [permissionDeniedDiagnostic(input.permission)] };
    }
    const diagnostics: WorkspaceDiagnostic[] = [];
    const [decisions, candidates] = await Promise.all([
      this.deps.readPort.loadActiveAssetDecisions(input.projectId, input.localeBranchId),
      this.deps.readPort.loadCandidateAssets(input.projectId, input.localeBranchId),
    ]);
    const decisionByRef = new Map<string, AssetDecisionRecord>();
    for (const decision of decisions) {
      if (decision.localeBranchId !== input.localeBranchId) {
        diagnostics.push(
          branchConflationDiagnostic("asset decision", decision.localeBranchId, input),
        );
        continue;
      }
      decisionByRef.set(assetRefKey(decision.assetRef), decision);
    }
    const entries = new Map<string, WorkspaceAssetEntry>();
    for (const candidate of candidates) {
      const key = assetRefKey(candidate.assetRef);
      const decision = decisionByRef.get(key) ?? null;
      entries.set(key, {
        assetRef: { kind: candidate.assetRef.kind, ref: candidate.assetRef.ref },
        assetKind: candidate.assetKind,
        displayLabel: candidate.displayLabel ?? null,
        decided: decision !== null,
        decisionPolicy: decision?.decisionPolicy ?? null,
        decisionRationale: decision?.decisionRationale ?? null,
      });
    }
    // Decisions on assets that are no longer candidates still belong in the
    // browse so the reviewer sees the full localized-asset inventory.
    for (const [key, decision] of decisionByRef) {
      if (entries.has(key)) {
        continue;
      }
      entries.set(key, {
        assetRef: { kind: decision.assetRef.kind, ref: decision.assetRef.ref },
        assetKind: decision.assetKind,
        displayLabel: null,
        decided: true,
        decisionPolicy: decision.decisionPolicy,
        decisionRationale: decision.decisionRationale,
      });
    }
    return {
      ...base,
      assets: [...entries.values()].sort((left, right) =>
        left.assetRef.ref.localeCompare(right.assetRef.ref),
      ),
      diagnostics,
    };
  }

  async loadComparison(input: LoadWorkspaceComparisonInput): Promise<WorkspaceComparisonReadModel> {
    if (!input.permission.canReadQueue) {
      return {
        schemaVersion: "workspace.comparison.v0.1",
        generatedAt: this.now(),
        permission: input.permission,
        reviewItemId: input.reviewItemId,
        localeBranchId: null,
        sourceRevisionId: null,
        bridgeUnitId: null,
        sourceUnitKey: null,
        contextNote: null,
        cells: [],
        hasFinal: false,
        runtimeEvidenceLinks: [],
        diagnostics: [permissionDeniedDiagnostic(input.permission)],
      };
    }
    const context = await this.deps.readPort.loadComparisonContext({
      reviewItemId: input.reviewItemId,
      permission: input.permission,
    });
    return projectComparison(input.reviewItemId, context, this.now());
  }

  async loadSearch(input: LoadWorkspaceSearchInput): Promise<WorkspaceSearchReadModel> {
    const mode = input.mode ?? workspaceSearchModeValues.all;
    const limit = normalizeSearchLimit(input.limit);
    const offset = normalizeSearchOffset(input.offset);
    const base = {
      schemaVersion: "workspace.search.v0.1" as const,
      generatedAt: this.now(),
      permission: input.permission,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      query: input.query,
      mode,
    };
    if (!input.permission.canReadQueue) {
      return {
        ...base,
        normalizedQuery: input.query.trim().toLowerCase(),
        pagination: searchPagination(0, limit, offset),
        results: [],
        droppedOpaqueCount: 0,
        diagnostics: [permissionDeniedDiagnostic(input.permission)],
      };
    }
    const diagnostics: WorkspaceDiagnostic[] = [];
    const results: WorkspaceSearchResult[] = [];
    let droppedOpaqueCount = 0;
    let normalizedQuery = input.query.trim().toLowerCase();
    const upstreamLimit = Math.min(100, limit + offset);

    if (mode === workspaceSearchModeValues.all || mode === workspaceSearchModeValues.exact) {
      const exactInput: SearchExactInput = {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        query: input.query,
      };
      exactInput.limit = upstreamLimit;
      const exact = await this.deps.readPort.searchExact(exactInput);
      if (normalizedQuery.length > 0) {
        normalizedQuery = exact.normalizedQuery;
      }
      for (const match of exact.matches) {
        if (match.localeBranchId !== input.localeBranchId) {
          diagnostics.push(
            branchConflationDiagnostic("exact search match", match.localeBranchId, input),
          );
          continue;
        }
        const bridgeUnitRef =
          bridgeUnitRefFromProvenance(match.provenance) ?? match.sourceArtifactId;
        if (
          match.sourceArtifactId.length === 0 ||
          match.localeBranchId.length === 0 ||
          bridgeUnitRef.length === 0
        ) {
          droppedOpaqueCount += 1;
          continue;
        }
        results.push({
          resultKind: workspaceSearchResultKindValues.unit,
          matchKind: "exact",
          id: match.searchDocumentId,
          title: match.exactTerm,
          subtitle: match.sourceArtifactId,
          targetPath: workspaceComparisonRoutePath(match.searchDocumentId),
          localeBranchId: match.localeBranchId,
          sourceArtifactId: match.sourceArtifactId,
          bridgeUnitRef,
          sourceRevisionId: match.sourceRevisionId,
          sourceLocale: match.sourceLocale,
          targetLocale: match.targetLocale,
          snippet: match.exactTerm,
          score: 1,
          matchRefId: match.searchDocumentId,
        });
      }
    }

    if (mode === workspaceSearchModeValues.all || mode === workspaceSearchModeValues.terminology) {
      const terminologyInput: TerminologySearchInput = {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        query: input.query,
      };
      terminologyInput.limit = upstreamLimit;
      const terminology = await this.deps.readPort.searchTerminology(terminologyInput);
      for (const result of terminology.results) {
        const term = result.term;
        if (term.localeBranchId !== input.localeBranchId) {
          diagnostics.push(
            branchConflationDiagnostic("terminology match", term.localeBranchId, input),
          );
          continue;
        }
        const reference = term.sourceReferences.find((ref) => ref.bridgeUnitId !== null);
        const bridgeUnitRef = reference?.bridgeUnitId ?? null;
        if (bridgeUnitRef === null) {
          // No bridge-unit citation — refuse to surface an opaque term hit.
          droppedOpaqueCount += 1;
          continue;
        }
        results.push({
          resultKind: workspaceSearchResultKindValues.term,
          matchKind: "terminology",
          id: term.termId,
          title: term.sourceTerm,
          subtitle: term.preferredTranslation,
          targetPath: workspaceSearchRoutePath({
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            query: term.sourceTerm,
            mode: workspaceSearchModeValues.terminology,
          }),
          localeBranchId: term.localeBranchId,
          sourceArtifactId: term.termId,
          bridgeUnitRef,
          sourceRevisionId: reference?.sourceRevisionId ?? null,
          sourceLocale: term.sourceLocale,
          targetLocale: term.targetLocale,
          snippet: `${term.sourceTerm} → ${term.preferredTranslation}`,
          score: result.score,
          matchRefId: term.termId,
        });
      }
    }

    if (mode === workspaceSearchModeValues.all) {
      const query = normalizedQuery;
      const sceneSummaries = await this.deps.readPort.loadSceneSummaries({
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
      });
      const branchSceneSummaries = sceneSummaries.filter((summary) => {
        if (summary.localeBranchId === input.localeBranchId) {
          return true;
        }
        diagnostics.push(
          branchConflationDiagnostic("scene search match", summary.localeBranchId, input),
        );
        return false;
      });
      const bridgeUnitIds = [
        ...new Set(
          branchSceneSummaries.flatMap((summary) =>
            summary.citations.map((citation) => citation.bridgeUnitId),
          ),
        ),
      ];
      const bridgeUnits = await this.deps.readPort.loadBridgeUnitsForSummary(bridgeUnitIds);
      const characters = new Map<string, { name: string; bridgeUnitId: string; sceneId: string }>();
      for (const summary of branchSceneSummaries) {
        if (searchTextMatches(query, [summary.sceneId, summary.summaryText, summary.status])) {
          results.push({
            resultKind: workspaceSearchResultKindValues.scene,
            matchKind: "entity",
            id: summary.contextArtifactId,
            title: summary.sceneId,
            subtitle: summary.summaryText,
            targetPath: workspaceSceneRoutePath(
              input.projectId,
              input.localeBranchId,
              summary.sceneId,
            ),
            localeBranchId: input.localeBranchId,
            sourceArtifactId: summary.contextArtifactId,
            bridgeUnitRef: summary.citations[0]?.bridgeUnitId ?? summary.sceneId,
            sourceRevisionId: summary.sourceRevisionId,
            sourceLocale: null,
            targetLocale: summary.summaryLocale,
            snippet: summary.summaryText,
            score: entityScore(query, [summary.sceneId, summary.summaryText]),
            matchRefId: summary.contextArtifactId,
          });
        }
        for (const citation of summary.citations) {
          const unit = bridgeUnits.get(citation.bridgeUnitId);
          if (unit === undefined) {
            continue;
          }
          if (unit.speaker !== null) {
            characters.set(unit.speaker, {
              name: unit.speaker,
              bridgeUnitId: unit.bridgeUnitId,
              sceneId: summary.sceneId,
            });
          }
          if (
            searchTextMatches(query, [
              unit.bridgeUnitId,
              unit.sourceUnitKey,
              unit.speaker,
              unit.sourceText,
              unit.occurrenceId,
            ])
          ) {
            results.push({
              resultKind: workspaceSearchResultKindValues.unit,
              matchKind: "entity",
              id: unit.bridgeUnitId,
              title: unit.sourceUnitKey,
              subtitle: unit.speaker,
              targetPath: workspaceComparisonRoutePath(unit.bridgeUnitId),
              localeBranchId: input.localeBranchId,
              sourceArtifactId: unit.bridgeUnitId,
              bridgeUnitRef: unit.bridgeUnitId,
              sourceRevisionId: summary.sourceRevisionId,
              sourceLocale: null,
              targetLocale: summary.summaryLocale,
              snippet: unit.sourceText,
              score: entityScore(query, [unit.sourceUnitKey, unit.speaker, unit.sourceText]),
              matchRefId: unit.bridgeUnitId,
            });
          }
        }
      }
      for (const character of characters.values()) {
        if (!searchTextMatches(query, [character.name])) {
          continue;
        }
        results.push({
          resultKind: workspaceSearchResultKindValues.character,
          matchKind: "entity",
          id: `character:${character.name}`,
          title: character.name,
          subtitle: `Seen in ${character.sceneId}`,
          targetPath: workspaceSceneRoutePath(
            input.projectId,
            input.localeBranchId,
            character.sceneId,
          ),
          localeBranchId: input.localeBranchId,
          sourceArtifactId: `character:${character.name}`,
          bridgeUnitRef: character.bridgeUnitId,
          sourceRevisionId: null,
          sourceLocale: null,
          targetLocale: null,
          snippet: character.name,
          score: entityScore(query, [character.name]),
          matchRefId: character.name,
        });
      }

      if (input.canReadCatalog) {
        const runTable = await this.deps.readPort.loadRunTable({
          projectId: input.projectId,
          limit: upstreamLimit,
          offset: 0,
        });
        for (const run of runTable.rows) {
          if (run.localeBranchId !== input.localeBranchId) {
            continue;
          }
          if (
            !searchTextMatches(query, [
              run.runId,
              run.providerRunId,
              run.task,
              run.status,
              run.servedModel,
              run.servedProvider,
            ])
          ) {
            continue;
          }
          results.push({
            resultKind: workspaceSearchResultKindValues.run,
            matchKind: "entity",
            id: run.runId,
            title: run.task,
            subtitle: `${run.status} · ${run.servedProvider}`,
            targetPath: `/jobs?projectId=${encodeURIComponent(input.projectId)}&runId=${encodeURIComponent(run.runId)}`,
            localeBranchId: run.localeBranchId,
            sourceArtifactId: run.attemptId,
            bridgeUnitRef: run.bridgeUnitId,
            sourceRevisionId: null,
            sourceLocale: null,
            targetLocale: null,
            snippet: run.providerRunId,
            score: entityScore(query, [run.runId, run.providerRunId, run.task, run.status]),
            matchRefId: run.runId,
          });
        }
      }

      const dashboard = await this.deps.readPort.loadReviewerDashboard({
        localeBranchId: input.localeBranchId,
        permission: input.permission,
      });
      for (const row of dashboard.rows) {
        if (
          !searchTextMatches(query, [
            row.reviewItemId,
            row.summary,
            row.findingId,
            row.itemKind,
            row.state,
            row.sourceItemRef,
          ])
        ) {
          continue;
        }
        results.push({
          resultKind: workspaceSearchResultKindValues.finding,
          matchKind: "entity",
          id: row.findingId ?? row.reviewItemId,
          title: row.summary,
          subtitle: `${row.itemKind} · ${row.state}`,
          targetPath: row.detailPath,
          localeBranchId: row.localeBranchId,
          sourceArtifactId: row.sourceItemRef,
          bridgeUnitRef: row.sourceItemRef,
          sourceRevisionId: row.sourceRevisionId,
          sourceLocale: null,
          targetLocale: null,
          snippet: row.summary,
          score: entityScore(query, [row.summary, row.findingId, row.reviewItemId]),
          matchRefId: row.reviewItemId,
        });
      }

      for (const action of workspaceSearchActions(input)) {
        if (!searchTextMatches(query, [action.title, action.subtitle])) {
          continue;
        }
        results.push(action);
      }
    }

    if (droppedOpaqueCount > 0) {
      diagnostics.push({
        code: workspaceDiagnosticCodeValues.opaqueSearchResultDropped,
        message: `${droppedOpaqueCount} search hit(s) were dropped because they lacked a source artifact id, locale branch id, or bridge unit ref; opaque results are never surfaced.`,
      });
    }

    results.sort((left, right) => right.score - left.score);
    const total = results.length;
    const pageResults = results.slice(offset, offset + limit);

    return {
      ...base,
      normalizedQuery,
      pagination: searchPagination(total, limit, offset),
      results: pageResults,
      droppedOpaqueCount,
      diagnostics,
    };
  }
}

function projectComparison(
  reviewItemId: string,
  context: ReviewerDetailContext,
  generatedAt: Date,
): WorkspaceComparisonReadModel {
  const diagnostics: WorkspaceDiagnostic[] = [];
  if (!context.permission.canReadQueue) {
    return {
      schemaVersion: "workspace.comparison.v0.1",
      generatedAt,
      permission: context.permission,
      reviewItemId,
      localeBranchId: null,
      sourceRevisionId: null,
      bridgeUnitId: null,
      sourceUnitKey: null,
      contextNote: null,
      cells: [],
      hasFinal: false,
      runtimeEvidenceLinks: [],
      diagnostics: [permissionDeniedDiagnostic(context.permission)],
    };
  }
  const cells: WorkspaceComparisonCell[] = [];
  if (context.source !== null) {
    cells.push({
      side: "source",
      locale: context.source.sourceLocale,
      text: context.source.sourceText,
      label: `Source (${context.source.sourceLocale})`,
    });
  }
  if (context.draft !== null) {
    cells.push({
      side: "draft",
      locale: context.draft.targetLocale,
      text: context.draft.draftText,
      label: `Draft (${context.draft.targetLocale})`,
    });
    if (context.draft.approvedPatchText !== null) {
      cells.push({
        side: "final",
        locale: context.draft.targetLocale,
        text: context.draft.approvedPatchText,
        label: `Final / approved (${context.draft.targetLocale})`,
      });
    }
  }
  if (cells.length === 0) {
    diagnostics.push({
      code: workspaceDiagnosticCodeValues.comparisonUnavailable,
      message: `Reviewer item ${reviewItemId} has neither source nor draft text loaded; there is nothing to compare.`,
    });
  }
  const hasFinal = cells.some((cell) => cell.side === "final");
  const runtimeEvidenceLinks: WorkspaceRuntimeEvidenceLink[] = context.runtimeEvidence.map(
    (evidence) => ({
      evidenceKind: evidence.evidenceKind,
      evidenceTier: evidence.evidenceTier,
      runtimeTargetId: evidence.runtimeTargetId,
      observationEventIds: evidence.observationEventIds,
      artifactHashes: evidence.artifactHashes,
      providerProofRefs: evidence.providerProofRefs,
      summary: evidence.summary,
    }),
  );
  // Carry forward the detail loader's stale/missing diagnostics so the
  // workspace comparison surfaces the same banners as the reviewer page.
  for (const detailDiagnostic of context.diagnostics) {
    if (detailDiagnostic.code === reviewerDetailDiagnosticCodeValues.staleSourceRevision) {
      diagnostics.push({
        code: workspaceDiagnosticCodeValues.comparisonUnavailable,
        message: detailDiagnostic.message,
      });
    }
  }
  return {
    schemaVersion: "workspace.comparison.v0.1",
    generatedAt,
    permission: context.permission,
    reviewItemId,
    localeBranchId: context.item?.localeBranchId ?? null,
    sourceRevisionId: context.item?.sourceRevisionId ?? context.source?.sourceRevisionId ?? null,
    bridgeUnitId: context.source?.bridgeUnitId ?? null,
    sourceUnitKey: context.source?.sourceUnitKey ?? null,
    contextNote: context.source?.contextNote ?? null,
    cells,
    hasFinal,
    runtimeEvidenceLinks,
    diagnostics,
  };
}

function permissionDeniedDiagnostic(permission: WorkspacePermissionView): WorkspaceDiagnostic {
  const reason =
    permission.denialReasons[0] ??
    `user ${permission.actorUserId} is missing permission queue.read`;
  return {
    code: workspaceDiagnosticCodeValues.permissionDenied,
    message: `Workspace read blocked: ${reason}`,
  };
}

function branchConflationDiagnostic(
  recordLabel: string,
  recordBranchId: string,
  input: { localeBranchId: string },
): WorkspaceDiagnostic {
  return {
    code: workspaceDiagnosticCodeValues.branchConflationGuard,
    message: `Dropped ${recordLabel} on locale branch ${recordBranchId} while browsing locale branch ${input.localeBranchId}; branches are never conflated.`,
  };
}

function unresolvedLocaleBranchIdentityDiagnostic(localeBranchId: string): WorkspaceDiagnostic {
  return {
    code: workspaceDiagnosticCodeValues.unresolvedLocaleBranchIdentity,
    message: `Locale branch ${localeBranchId} is present in the project dashboard status but its identity (branch name / source locale) could not be resolved; the branch is omitted rather than surfaced with a fabricated name.`,
  };
}

function assetRefKey(assetRef: { kind: string; ref: string }): string {
  return `${assetRef.kind}:${assetRef.ref}`;
}

function bridgeUnitRefFromProvenance(provenance: Record<string, unknown>): string | null {
  const value = provenance.bridgeUnitId ?? provenance.sourceArtifactId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeSearchLimit(limit: number | undefined): number {
  return limit === undefined ? 25 : Math.min(limit, 100);
}

function normalizeSearchOffset(offset: number | undefined): number {
  return offset === undefined ? 0 : offset;
}

function searchPagination(total: number, limit: number, offset: number): WorkspaceSearchPagination {
  const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
  const hasMore = offset + limit < total;
  return {
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pageCount,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

const WORKSPACE_SCENE_DEFAULT_LIMIT = 100;
const WORKSPACE_SCENE_MAX_LIMIT = 500;

function normalizeWorkspaceSceneLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return WORKSPACE_SCENE_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return WORKSPACE_SCENE_DEFAULT_LIMIT;
  }
  return Math.min(limit, WORKSPACE_SCENE_MAX_LIMIT);
}

function normalizeWorkspaceSceneOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return 0;
  }
  return offset;
}

function searchTextMatches(query: string, values: readonly (string | null | undefined)[]): boolean {
  if (query.length === 0) {
    return true;
  }
  return values.some((value) => value?.toLowerCase().includes(query) ?? false);
}

function entityScore(query: string, values: readonly (string | null | undefined)[]): number {
  if (query.length === 0) {
    return 0.25;
  }
  for (const value of values) {
    const normalized = value?.toLowerCase();
    if (normalized === undefined) {
      continue;
    }
    if (normalized === query) {
      return 0.95;
    }
    if (normalized.startsWith(query)) {
      return 0.8;
    }
    if (normalized.includes(query)) {
      return 0.6;
    }
  }
  return 0.1;
}

function workspaceSearchActions(input: LoadWorkspaceSearchInput): WorkspaceSearchResult[] {
  const actions: WorkspaceSearchResult[] = [
    workspaceSearchAction(input, {
      id: "action:workspace.search",
      title: "Search workspace",
      subtitle: "Find scenes, units, characters, terms, runs, findings, and actions",
      targetPath: workspaceSearchRoutePath({
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        query: input.query,
        mode: workspaceSearchModeValues.all,
      }),
      score: 0.5,
    }),
    workspaceSearchAction(input, {
      id: "action:workspace.scenes",
      title: "Browse scenes",
      subtitle: "Open translated scene summaries",
      targetPath: workspaceSceneRoutePath(input.projectId, input.localeBranchId),
      score: 0.45,
    }),
    workspaceSearchAction(input, {
      id: "action:workspace.assets",
      title: "Browse assets",
      subtitle: "Open localizable asset decisions",
      targetPath: workspaceAssetRoutePath(input.projectId, input.localeBranchId),
      score: 0.45,
    }),
    workspaceSearchAction(input, {
      id: "action:workspace.corrections",
      title: "Open corrections",
      subtitle: "Preview manual correction scope",
      targetPath: workspaceCorrectionsRoutePath(input.localeBranchId),
      score: 0.4,
    }),
  ];
  if (input.permission.canManageQueue) {
    actions.push(
      workspaceSearchAction(input, {
        id: "action:workspace.submitCorrections",
        title: "Submit corrections",
        subtitle: "Apply reviewed manual corrections",
        targetPath: workspaceCorrectionsRoutePath(input.localeBranchId),
        score: 0.35,
      }),
    );
  }
  return actions;
}

function workspaceSearchAction(
  input: LoadWorkspaceSearchInput,
  action: {
    id: string;
    title: string;
    subtitle: string;
    targetPath: string;
    score: number;
  },
): WorkspaceSearchResult {
  return {
    resultKind: workspaceSearchResultKindValues.action,
    matchKind: "action",
    id: action.id,
    title: action.title,
    subtitle: action.subtitle,
    targetPath: action.targetPath,
    localeBranchId: input.localeBranchId,
    sourceArtifactId: action.id,
    bridgeUnitRef: action.id,
    sourceRevisionId: null,
    sourceLocale: null,
    targetLocale: null,
    snippet: action.subtitle,
    score: action.score,
    matchRefId: action.id,
  };
}

function workspaceSceneRoutePath(
  projectId: string,
  localeBranchId: string,
  sceneId?: string,
): string {
  const params = new URLSearchParams({ projectId, localeBranchId });
  if (sceneId !== undefined) {
    params.set("sceneId", sceneId);
  }
  return `/workspace/scenes?${params.toString()}`;
}

function workspaceAssetRoutePath(projectId: string, localeBranchId: string): string {
  const params = new URLSearchParams({ projectId, localeBranchId });
  return `/workspace/assets?${params.toString()}`;
}

function workspaceComparisonRoutePath(reviewItemId: string): string {
  const params = new URLSearchParams({ reviewItemId });
  return `/workspace/comparison?${params.toString()}`;
}

function workspaceSearchRoutePath(input: {
  projectId: string;
  localeBranchId: string;
  query: string;
  mode?: WorkspaceSearchMode;
}): string {
  const params = new URLSearchParams({
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    query: input.query,
  });
  if (input.mode !== undefined) {
    params.set("mode", input.mode);
  }
  return `/workspace/search?${params.toString()}`;
}

function workspaceCorrectionsRoutePath(localeBranchId: string): string {
  const params = new URLSearchParams({ localeBranchId });
  return `/workspace/corrections?${params.toString()}`;
}

export function workspaceSceneBrowsePath(projectId: string, localeBranchId: string): string {
  return `/api/workspace/scenes?projectId=${encodeURIComponent(projectId)}&localeBranchId=${encodeURIComponent(localeBranchId)}`;
}

export function workspaceAssetBrowsePath(projectId: string, localeBranchId: string): string {
  return `/api/workspace/assets?projectId=${encodeURIComponent(projectId)}&localeBranchId=${encodeURIComponent(localeBranchId)}`;
}

export function workspaceComparisonPath(reviewItemId: string): string {
  return `/api/workspace/comparison?reviewItemId=${encodeURIComponent(reviewItemId)}`;
}

export function workspaceSearchPath(input: {
  projectId: string;
  localeBranchId: string;
  query: string;
  mode?: WorkspaceSearchMode;
  limit?: number;
  offset?: number;
}): string {
  const params = new URLSearchParams({
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    query: input.query,
  });
  if (input.mode !== undefined) {
    params.set("mode", input.mode);
  }
  if (input.limit !== undefined) {
    params.set("limit", String(input.limit));
  }
  if (input.offset !== undefined) {
    params.set("offset", String(input.offset));
  }
  return `/api/workspace/search?${params.toString()}`;
}
