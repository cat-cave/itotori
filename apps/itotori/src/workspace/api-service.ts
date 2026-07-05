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
  BridgeUnitTextRecord,
  CandidateAssetRecord,
  LoadSceneSummariesQuery,
  LocaleBranchIdentity,
  ProjectDashboardStatus,
  SceneSummaryRecord,
  SearchExactInput,
  SearchExactToolResult,
  TerminologySearchInput,
  TerminologySearchReadModel,
} from "@itotori/db";
import { sceneSummaryStatusValues } from "@itotori/db";
import type { ReviewerDetailContext } from "../reviewer/detail-fixtures.js";
import { reviewerDetailDiagnosticCodeValues } from "../reviewer/detail-fixtures.js";
import {
  workspaceDiagnosticCodeValues,
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
  loadSceneSummaries(query: LoadSceneSummariesQuery): Promise<SceneSummaryRecord[]>;
  loadBridgeUnitsForSummary(bridgeUnitIds: string[]): Promise<Map<string, BridgeUnitTextRecord>>;
  loadActiveAssetDecisions(
    projectId: string,
    localeBranchId: string,
  ): Promise<AssetDecisionRecord[]>;
  loadCandidateAssets(projectId: string, localeBranchId: string): Promise<CandidateAssetRecord[]>;
  searchExact(input: SearchExactInput): Promise<SearchExactToolResult>;
  searchTerminology(input: TerminologySearchInput): Promise<TerminologySearchReadModel>;
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
    const base = {
      schemaVersion: "workspace.scene_browse.v0.1" as const,
      generatedAt: this.now(),
      permission: input.permission,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    };
    if (!input.permission.canReadQueue) {
      return {
        ...base,
        scenes: [],
        diagnostics: [permissionDeniedDiagnostic(input.permission)],
      };
    }
    const diagnostics: WorkspaceDiagnostic[] = [];
    const summaryQuery: LoadSceneSummariesQuery = {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    };
    if (input.sourceRevisionId !== undefined) {
      summaryQuery.sourceRevisionId = input.sourceRevisionId;
    }
    if (input.sceneId !== undefined) {
      summaryQuery.sceneId = input.sceneId;
    }
    const summaries = await this.deps.readPort.loadSceneSummaries(summaryQuery);
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
    const allBridgeUnitIds = [
      ...new Set(
        scopedSummaries.flatMap((summary) =>
          summary.citations.map((citation) => citation.bridgeUnitId),
        ),
      ),
    ];
    const unitsById =
      allBridgeUnitIds.length === 0
        ? new Map<string, BridgeUnitTextRecord>()
        : await this.deps.readPort.loadBridgeUnitsForSummary(allBridgeUnitIds);
    const scenes: WorkspaceSceneContext[] = scopedSummaries.map((summary) => {
      const stale = summary.status === sceneSummaryStatusValues.stale;
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
        sceneSummaryId: summary.sceneSummaryId,
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
        results: [],
        droppedOpaqueCount: 0,
        diagnostics: [permissionDeniedDiagnostic(input.permission)],
      };
    }
    const diagnostics: WorkspaceDiagnostic[] = [];
    const results: WorkspaceSearchResult[] = [];
    let droppedOpaqueCount = 0;
    let normalizedQuery = input.query.trim().toLowerCase();

    if (mode === workspaceSearchModeValues.all || mode === workspaceSearchModeValues.exact) {
      const exactInput: SearchExactInput = {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        query: input.query,
      };
      if (input.limit !== undefined) {
        exactInput.limit = input.limit;
      }
      const exact = await this.deps.readPort.searchExact(exactInput);
      normalizedQuery = exact.normalizedQuery;
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
          matchKind: "exact",
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
      if (input.limit !== undefined) {
        terminologyInput.limit = input.limit;
      }
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
          matchKind: "terminology",
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

    if (droppedOpaqueCount > 0) {
      diagnostics.push({
        code: workspaceDiagnosticCodeValues.opaqueSearchResultDropped,
        message: `${droppedOpaqueCount} search hit(s) were dropped because they lacked a source artifact id, locale branch id, or bridge unit ref; opaque results are never surfaced.`,
      });
    }

    results.sort((left, right) => right.score - left.score);

    return {
      ...base,
      normalizedQuery,
      results,
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
}): string {
  const params = new URLSearchParams({
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    query: input.query,
  });
  if (input.mode !== undefined) {
    params.set("mode", input.mode);
  }
  return `/api/workspace/search?${params.toString()}`;
}
