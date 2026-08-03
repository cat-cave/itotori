import * as deps from "./api-handler-dependencies.js";

export type ApiMutationPermissionGate = {
  mutation: string;
  permissionKey: keyof typeof deps.permissionValues;
  permission: deps.Permission;
};

export const apiMutationPermissionGates = {
  bridgeImport: apiMutationGate("bridge import", "projectImport"),
  // p3-in-studio-decode-extract-trigger — the in-studio decode/extract produces
  // the SAME import artifact (a bridge bundle) the manual upload did, so it
  // carries the SAME `project.import` authority as `bridgeImport`.
  decodeExtract: apiMutationGate("decode extract", "projectImport"),
  branchDraft: apiMutationGate("branch draft", "draftWrite"),
  findingRecord: apiMutationGate("finding record", "runtimeIngest"),
  benchmarkRecord: apiMutationGate("benchmark record", "runtimeIngest"),
  runtimeEvidenceIngest: apiMutationGate("runtime evidence ingest", "runtimeIngest"),
  // A wiki edit is a direct node-8 context correction. The service still
  // enforces this authority at its persistence boundary; this keeps the HTTP
  // route's capability declaration explicit as well.
  wikiEdit: apiMutationGate("wiki edit", "projectImport"),
  // ovw-launch-pass-action — the `canSteer` steer permission is `draft.write`:
  // launching the next pass drives the drafting of pass N+1, the same authority
  // that protects the draft workflow.
  launchPass: apiMutationGate("launch pass", "draftWrite"),
  localizationRunConfigSave: apiMutationGate("localization run config save", "draftWrite"),
  ssoSettingsConfigure: apiMutationGate("SSO settings configure", "authSsoManage"),
  modelRoutingRead: apiMutationGate("model routing read", "catalogRead"),
  modelRoutingSave: apiMutationGate("model routing save", "draftWrite"),
  branchPolicyRead: apiMutationGate("branch policy read", "catalogRead"),
  branchPolicySave: apiMutationGate("branch policy save", "draftWrite"),
  translationScopeRead: apiMutationGate("translation scope read", "catalogRead"),
  translationScopeSave: apiMutationGate("translation scope save", "draftWrite"),
  membersList: apiMutationGate("members list", "authMembersManage"),
  billingSeatUsage: apiMutationGate("billing seat usage", "authMembersManage"),
  membersInvite: apiMutationGate("members invite", "authMembersManage"),
  membersAccept: apiMutationGate("members accept", "authMembersManage"),
  membersRemove: apiMutationGate("members remove", "authMembersManage"),
  permissionSetsList: apiMutationGate("permission sets list", "authPermissionsManage"),
  permissionSetsGrant: apiMutationGate("permission set grant", "authPermissionsManage"),
  permissionSetsRevoke: apiMutationGate("permission set revoke", "authPermissionsManage"),
  sessionsList: apiMutationGate("sessions list", "authSessionsManage"),
  sessionsRevoke: apiMutationGate("sessions revoke", "authSessionsManage"),
  // p0-result-revision — replacing a delivered target line creates and
  // selects a new patch revision, so it carries the same `draft.write`
  // authority as other draft-affecting production mutations.
  playTargetEdit: apiMutationGate("play target edit", "draftWrite"),
  patchIterationPlay: apiMutationGate("patch iteration play session", "draftWrite"),
  patchIterationFeedback: apiMutationGate("patch iteration feedback", "draftWrite"),
  patchIterationRefine: apiMutationGate("patch iteration refine", "draftWrite"),
  // play-flag-composer — canFlag is feedback.import (playtester flags into
  // the canonical context-correction path via ManualFeedbackImport).
  flagAnnotation: apiMutationGate("play flag annotation", "feedbackImport"),
} as const;

export type ApiJsonResponse = {
  statusCode: number;
  body: deps.ItotoriApiResponseBody;
};

export type ItotoriApiRequest = {
  method: string;
  pathname: string;
  search?: string;
  body?: unknown;
};

/**
 * p0-result-revision — production-bound play-tester port. Authentication and
 * server-managed artifact placement are intentionally captured by the service
 * factory; neither becomes a public HTTP field. The route only supplies the
 * parent patch, unit identity, and target-language replacement.
 */
export type PlayTesterResultRevisionApiPort = {
  editTarget(input: {
    parentPatchVersionId: string;
    bridgeUnitId: string;
    targetBody: string;
  }): Promise<deps.PlayTesterTargetEditResponse>;
  loadSelectedExport(input: { runId: string }): Promise<deps.SelectedPatchExportResponse>;
  loadSelectedArchive(input: { runId: string }): Promise<deps.DeliveredPatchArchive | null>;
  loadExactPatchExport(input: {
    patchVersionId: string;
  }): Promise<deps.PlayablePatchExportResponse>;
  loadExactPatchArchive(input: {
    patchVersionId: string;
  }): Promise<deps.DeliveredPatchArchive | null>;
};

/**
 * policy — the read/query dependencies exposed to the READ-ONLY (query)
 * API handlers. This is a least-privilege surface: it deliberately picks ONLY
 * the read methods of each shared service, so a query handler that receives an
 * {@link ItotoriReadOnlyApiServices} is *structurally* (type-level) unable to
 * reach a mutation — `projectWorkflow.draftProject`,
 * `projectWorkflow.draftProject`,
 * etc. are not on the type. The default read-only factory
 * (`readOnlyApiServices` / `withDatabaseReadOnlyApiServices` in
 * `services/database-services.ts`) additionally narrows at RUNTIME (the
 * produced object carries no mutation methods), reusing the same shared
 * service instances rather than re-wiring repositories.
 */
export type ItotoriReadOnlyApiServices = {
  authorization: Pick<deps.ItotoriAuthorizationPort, "requirePermission">;
  catalogRepository: {
    catalogConflictReview(
      filter?: deps.CatalogConflictReviewFilter,
    ): Promise<deps.CatalogConflictReviewReadModel>;
    catalogCompletenessBenchmarkPools(
      filter?: deps.CatalogCompletenessPoolFilter,
    ): Promise<deps.CatalogCompletenessBenchmarkPools>;
    catalogBenchmarkSeedFinder(
      filter?: deps.CatalogBenchmarkSeedFinderFilter,
    ): Promise<deps.CatalogBenchmarkSeedFinderReadModel>;
    catalogContextPanelForWork(input: {
      workId: string;
      targetLanguage: string;
    }): Promise<deps.CatalogContextPanelCatalogReadModel | null>;
    catalogOpportunityRanking(
      filter?: deps.CatalogOpportunityRankingFilter,
    ): Promise<deps.CatalogOpportunityRankingReadModel>;
  };
  terminologyRepository: {
    searchTerms(input: deps.TerminologySearchInput): Promise<deps.TerminologySearchReadModel>;
  };
  /** Read-only source WikiObject / localized-bible surface. */
  wikiObjectApi?: Pick<deps.WikiObjectApiService, "list" | "show" | "history">;
  assetDecisions: {
    loadActiveDecisions(
      projectId: string,
      localeBranchId: string,
      opts?: { kindFilter?: deps.AssetLocalizationDecisionAssetKind },
    ): Promise<deps.AssetDecisionRecord[]>;
    loadCandidateAssets(
      projectId: string,
      localeBranchId: string,
      opts?: { kindFilter?: deps.AssetLocalizationDecisionAssetKind },
    ): Promise<deps.CandidateAssetRecord[]>;
  };
  projectWorkflow: Pick<
    deps.ItotoriProjectWorkflowPort,
    | "listLocaleBranchIdentities"
    | "listPortfolio"
    | "getDashboardStatus"
    | "getDashboardStatusForProject"
    | "getDashboardDecisions"
    | "getProjectOverview"
    | "getRuntimeStatus"
    | "getCostReport"
    | "getCostDrilldown"
    | "getBenchmarkReports"
  >;
  /**
   * policy — the queue-health read-model loader powering the
   * `queue.health` route (operator inspection of outbox/job lag, retries,
   * dead-letter). Read-only; gated on `queue.read` inside the repository.
   */
  queueHealth: {
    loadQueueHealth(options?: deps.LoadQueueHealthOptions): Promise<deps.QueueHealthReadModel>;
  };
  jobs: {
    loadRunTable(options?: deps.LoadJobsRunTableOptions): Promise<deps.JobsRunTableReadModel>;
  };
  authMembers: {
    listMembers(accountId: string): Promise<readonly deps.MemberRecord[]>;
  };
  modelRouting: {
    loadSettings(projectId: string): Promise<deps.ModelRoutingSettingsRecord>;
  };
  branchPolicy: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<deps.ApiBranchPolicySettingsResponse>;
  };
  translationScope: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<deps.ApiTranslationScopeSettingsResponse>;
  };
  authBilling: {
    loadSeatUsage(accountId: string): Promise<deps.AuthAccountSeatUsageRecord>;
  };
  authPermissions: {
    listPermissionSets(accountId: string): Promise<readonly deps.PermissionSetRecord[]>;
  };
  authIdentity: {
    loadIdentity(): Promise<deps.ActorIdentityRecord>;
  };
  /**
   * play-routemap-ui — Play RouteMap route/choice tree read-model composed
   * from routeMaps / routeChoices (coverage from map status).
   */
  playRouteMap: deps.RouteMapReadModelPort;
  /** Unit-bound feedback list — notes written by the play flag path. */
  unitFeedback: Pick<deps.ManualFeedbackImportPort, "listUnitFeedback">;
  /** Resolve cited bridge units only within the current imported branch. */
  addressableUnits: {
    resolveAddressableBridgeUnits(
      actor: { userId: string },
      input: { projectId: string; localeBranchId: string; bridgeUnitIds: readonly string[] },
    ): Promise<
      readonly (
        | { bridgeUnitId: string; sourceUnitKey: string; state: "resolved"; sceneId: string }
        | {
            bridgeUnitId: string;
            state: "unresolvable";
            reason: "not_imported_in_branch" | "scene_coordinate_missing";
          }
      )[]
    >;
  };
  /** p0-result-revision — read only the selected production delivery export. */
  playTesterResultRevision: Pick<
    PlayTesterResultRevisionApiPort,
    "loadSelectedExport" | "loadSelectedArchive" | "loadExactPatchExport" | "loadExactPatchArchive"
  >;
};

/**
 * The full dependency surface for the API handler entrypoint. It is the
 * read-only surface {@link ItotoriReadOnlyApiServices} INTERSECTED with the
 * mutation methods the write (POST) handlers need. The intersection keeps the
 * read picks and adds the mutation picks, so `projectWorkflow` gains the
 * record/draft/ingest writes.
 */
export type ItotoriApiServices = ItotoriReadOnlyApiServices & {
  /** The WikiObject read/write substrate. Optional only for focused unit
   * suites; the production database factory wires the encrypted repositories
   * and the handler refuses loudly when a deliberately minimal composition omits it. */
  wikiObjectApi?: deps.WikiObjectApiService;
  /** The bounded child runner used only by the explicit Wiki apply boundary.
   * Edits and feedback never invoke it. */
  wikiApply?: {
    readonly runner: deps.EnhancementRunner;
    readonly decodedFacts: readonly deps.DecodedFact[];
  };
  /**
   * The kept localize/draft mutation's new-pipeline substrate: resolve the live
   * `WorkflowPortDeps` (or fake ports for a proof) for one run policy. Production
   * assembles it from `composition/live`; the remaining role-input assemblers over
   * the decode facts + installed bible are a substrate seam not yet wired into the
   * live factory (flagged). Optional so unit suites can omit it; the handler
   * refuses loudly when it is missing — it never routes to the old service.
   */
  localizationSubstrate?: {
    resolvePortSource(
      request: deps.RunPolicyRequest,
      perRun: deps.LocalizationPerRunInput,
    ): deps.LocalizationPortSource | Promise<deps.LocalizationPortSource>;
  };
  /**
   * The kept `patch play` mutation's new-pipeline substrate: the exact-surface
   * loader + registered runtime-launcher registry the composition `runPlaySession`
   * drives. The live factory wires it from the localization-iteration surface read
   * (no journal reservation/finalizer).
   */
  patchPlay: deps.PlayEntrypointDeps;
  /**
   * The produce-a-playable-build mutation's substrate: an actor-bound
   * {@link deps.BoundPatchbackProduceServicePort} that drives the REAL native
   * patchback apply over a run's accepted outputs and returns the produced tar.
   * Optional so unit suites can omit it; the handler refuses loudly when it is
   * missing. The live factory wires it from the run-state produce-plan loader +
   * the real `kaifuu patch` seam (never a second/mock patchback path).
   */
  patchbackProduce?: deps.BoundPatchbackProduceServicePort;
  projectWorkflow: Pick<
    deps.ItotoriProjectWorkflowPort,
    | "listLocaleBranchIdentities"
    | "listPortfolio"
    | "getDashboardStatus"
    | "getDashboardStatusForProject"
    | "getDashboardDecisions"
    | "getRuntimeStatus"
    | "getCostReport"
    | "getCostDrilldown"
    | "getBenchmarkReports"
    | "importBridge"
    | "decodeExtract"
    | "recordFinding"
    | "recordBenchmarkReport"
    | "ingestRuntimeReport"
    | "launchNextLocalizationPass"
    | "pauseLocalizationPass"
    | "resumeLocalizationPass"
  >;
  authSsoSettings: {
    configureSettings(input: deps.ApiConfigureAuthSsoSettingsRequest): Promise<{
      accountId: string;
      provider: deps.ApiConfigureAuthSsoSettingsRequest["provider"];
      security: deps.ApiConfigureAuthSsoSettingsRequest["security"];
      sessionPolicy: deps.ApiConfigureAuthSsoSettingsRequest["sessionPolicy"];
      updatedAt: Date;
    }>;
  };
  modelRouting: {
    loadSettings(projectId: string): Promise<deps.ModelRoutingSettingsRecord>;
    saveRoute(input: deps.SaveModelRoutingSettingsInput): Promise<deps.ModelRoutingSettingsRecord>;
  };
  branchPolicy: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<deps.ApiBranchPolicySettingsResponse>;
    saveSettings(
      input: deps.ApiSaveBranchPolicySettingsRequest,
    ): Promise<deps.ApiBranchPolicySettingsResponse>;
  };
  translationScope: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<deps.ApiTranslationScopeSettingsResponse>;
    saveSettings(
      input: deps.ApiSaveTranslationScopeSettingsRequest,
    ): Promise<deps.ApiTranslationScopeSettingsResponse>;
  };
  localizationRunConfig: {
    saveRunConfig(
      input: deps.ApiSaveLocalizationRunConfigRequest,
    ): Promise<deps.ApiLocalizationRunConfigResponse>;
  };
  authMembers: {
    listMembers(accountId: string): Promise<readonly deps.MemberRecord[]>;
    inviteMember(input: deps.ApiInviteMemberRequest): Promise<deps.MemberInvitationRecord>;
    acceptInvitation(
      invitationId: string,
      input: deps.ApiAcceptMemberInvitationRequest,
    ): Promise<deps.MemberRecord>;
    removeMember(
      membershipId: string,
      input: deps.ApiRemoveMemberRequest,
    ): Promise<deps.MemberRecord>;
  };
  authBilling: {
    loadSeatUsage(accountId: string): Promise<deps.AuthAccountSeatUsageRecord>;
  };
  authPermissions: {
    listPermissionSets(accountId: string): Promise<readonly deps.PermissionSetRecord[]>;
    grantPermissionSet(input: {
      principalId: string;
      permissionSetId: string;
      request: deps.ApiPrincipalPermissionSetGrantRequest;
    }): Promise<deps.MemberRecord>;
    revokePermissionSet(input: {
      principalId: string;
      permissionSetId: string;
      request: deps.ApiPrincipalPermissionSetGrantRequest;
    }): Promise<deps.MemberRecord>;
  };
  authSessions: {
    listPrincipalSessions(principalId: string): Promise<readonly deps.AuthSessionAdminRecord[]>;
    revokePrincipalSession(
      principalId: string,
      sessionId: string,
      input: deps.ApiRevokeAuthSessionRequest,
    ): Promise<deps.AuthSessionAdminRecord>;
  };
  /** play-flag-composer — ManualFeedbackImport creates a context correction. */
  manualFeedback: deps.ManualFeedbackImportPort;
  /** p0-result-revision — actor/artifact-root-bound target edit + delivery read. */
  playTesterResultRevision: PlayTesterResultRevisionApiPort;
};

/**
 * policy — project the full API service surface down to the read-only
 * surface, copying ONLY the read methods. The result reuses the same
 * underlying shared service instances (each method delegates to
 * `services.*`); it never re-wires a repository. Because the returned object
 * literally has no mutation methods, a read handler holding it is unable to
 * reach a mutation at runtime as well as at the type level.
 */
export function readOnlyApiServices(services: ItotoriApiServices): ItotoriReadOnlyApiServices {
  return {
    // The authorization port already exposes only `requirePermission` on the
    // API surface (no mutation methods to strip), so it is reused as-is.
    authorization: services.authorization,
    catalogRepository: {
      catalogConflictReview: (filter) => services.catalogRepository.catalogConflictReview(filter),
      catalogCompletenessBenchmarkPools: (filter) =>
        services.catalogRepository.catalogCompletenessBenchmarkPools(filter),
      catalogBenchmarkSeedFinder: (filter) =>
        services.catalogRepository.catalogBenchmarkSeedFinder(filter),
      catalogContextPanelForWork: (input) =>
        services.catalogRepository.catalogContextPanelForWork(input),
      catalogOpportunityRanking: (filter) =>
        services.catalogRepository.catalogOpportunityRanking(filter),
    },
    terminologyRepository: {
      searchTerms: (input) => services.terminologyRepository.searchTerms(input),
    },
    ...(services.wikiObjectApi === undefined
      ? {}
      : {
          wikiObjectApi: {
            list: (input: { snapshotId: string }) => services.wikiObjectApi!.list(input),
            show: (selector: deps.WikiObjectSelector) => services.wikiObjectApi!.show(selector),
            history: (selector: deps.WikiObjectSelector) =>
              services.wikiObjectApi!.history(selector),
          },
        }),
    assetDecisions: {
      loadActiveDecisions: (projectId, localeBranchId, opts) =>
        services.assetDecisions.loadActiveDecisions(projectId, localeBranchId, opts),
      loadCandidateAssets: (projectId, localeBranchId, opts) =>
        services.assetDecisions.loadCandidateAssets(projectId, localeBranchId, opts),
    },
    projectWorkflow: {
      listLocaleBranchIdentities: (projectId) =>
        services.projectWorkflow.listLocaleBranchIdentities(projectId),
      listPortfolio: () => services.projectWorkflow.listPortfolio(),
      // Scoped reads use a required project id at this boundary, so the
      // read-only façade cannot silently erase a caller's scope.
      getDashboardStatus: (projectId) => services.projectWorkflow.getDashboardStatus(projectId),
      getDashboardStatusForProject: (projectId) =>
        services.projectWorkflow.getDashboardStatusForProject(projectId),
      getProjectOverview: (options) => services.projectWorkflow.getProjectOverview(options),
      getDashboardDecisions: (projectId) =>
        services.projectWorkflow.getDashboardDecisions(projectId),
      getRuntimeStatus: (runtimeRunId, projectId) =>
        services.projectWorkflow.getRuntimeStatus(runtimeRunId, projectId),
      getCostReport: (projectId) => services.projectWorkflow.getCostReport(projectId),
      getCostDrilldown: (filter) => services.projectWorkflow.getCostDrilldown(filter),
      getBenchmarkReports: (projectId) => services.projectWorkflow.getBenchmarkReports(projectId),
    },
    queueHealth: {
      loadQueueHealth: (options) => services.queueHealth.loadQueueHealth(options),
    },
    jobs: {
      loadRunTable: (options) => services.jobs.loadRunTable(options),
    },
    authMembers: {
      listMembers: (accountId) => services.authMembers.listMembers(accountId),
    },
    modelRouting: {
      loadSettings: (projectId) => services.modelRouting.loadSettings(projectId),
    },
    branchPolicy: {
      loadSettings: (input) => services.branchPolicy.loadSettings(input),
    },
    translationScope: {
      loadSettings: (input) => services.translationScope.loadSettings(input),
    },
    authBilling: {
      loadSeatUsage: (accountId) => services.authBilling.loadSeatUsage(accountId),
    },
    authPermissions: {
      listPermissionSets: (accountId) => services.authPermissions.listPermissionSets(accountId),
    },
    authIdentity: {
      loadIdentity: () => services.authIdentity.loadIdentity(),
    },
    playRouteMap: {
      loadRouteMap: (input) => services.playRouteMap.loadRouteMap(input),
    },
    unitFeedback: {
      listUnitFeedback: (query) => services.unitFeedback.listUnitFeedback(query),
    },
    addressableUnits: {
      resolveAddressableBridgeUnits: (actor, input) =>
        services.addressableUnits.resolveAddressableBridgeUnits(actor, input),
    },
    playTesterResultRevision: {
      loadSelectedExport: (input) => services.playTesterResultRevision.loadSelectedExport(input),
      loadSelectedArchive: (input) => services.playTesterResultRevision.loadSelectedArchive(input),
      loadExactPatchExport: (input) =>
        services.playTesterResultRevision.loadExactPatchExport(input),
      loadExactPatchArchive: (input) =>
        services.playTesterResultRevision.loadExactPatchArchive(input),
    },
  };
}

function apiMutationGate(
  mutation: string,
  permissionKey: keyof typeof deps.permissionValues,
): ApiMutationPermissionGate {
  return {
    mutation,
    permissionKey,
    permission: deps.permissionValues[permissionKey],
  };
}
