import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import * as responses from "./api-handler-responses.js";
import * as shared from "./api-handler-shared.js";

export async function routeSettingsAndAuthMutations(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriApiServices,
): Promise<contracts.ApiJsonResponse | null> {
  if (request.method === "POST" && request.pathname === "/api/projects/decode-extract") {
    // p3-in-studio-decode-extract-trigger — run the REAL identify -> inventory ->
    // extract decode pipeline from a game source path/handle and return the
    // produced v0.2 bridge. Same `project.import` gate as the bridge upload it
    // replaces (it produces the same import artifact). No status echo here — the
    // decode is pure (touches no project/cost ledger), so there is nothing to
    // redact; the returned bridge feeds the sibling `imports.bridge` route.
    const body = deps.parseProjectDecodeExtractRequest(request.body);
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.decodeExtract);
    const outcome = await services.projectWorkflow.decodeExtract(body);
    return responses.ok("projects.decodeExtract", outcome);
  }

  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    const body = deps.parseProjectImportRequest(request.body);
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.bridgeImport);
    const project = await services.projectWorkflow.importBridge(body.bridge);
    const status = await services.projectWorkflow.getDashboardStatus();
    // gate-mutation-route-status-echo — the success body echoes the full
    // dashboard status, which embeds cost.recentRuns (provider/model/routing
    // internals) + translation-memory reuse events. REDACT that echo to the
    // public summary UNLESS the caller holds catalog.read, the same gate the
    // sibling read routes (/api/projects, /status, /cost) enforce — so the
    // HTTP boundary agrees regardless of which route carries the status.
    const canReadStatus = await shared.resolveProjectReadPermission(services);
    return responses.ok("imports.bridge", {
      project,
      status: canReadStatus ? status : shared.redactProjectDashboardStatus(status),
    });
  }

  if (request.method === "POST" && request.pathname === "/api/settings/security/sso") {
    const body = deps.parseConfigureAuthSsoSettingsRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.ssoSettingsConfigure,
    );
    const result = await services.authSsoSettings.configureSettings(body);
    return responses.ok("auth.ssoSettings.configure", deps.authSsoSettingsResponseBody(result));
  }

  if (request.method === "POST" && request.pathname === "/api/settings/model-routing") {
    const body = deps.parseSaveModelRoutingSettingsRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.modelRoutingSave,
    );
    return responses.ok(
      "settings.modelRouting.save",
      deps.modelRoutingSettingsResponseBody(await services.modelRouting.saveRoute(body)),
    );
  }

  const branchPolicyRoute = deps.parseBranchPolicySettingsApiRoute(request.pathname);
  if (request.method === "POST" && branchPolicyRoute !== null) {
    const body = deps.parseSaveBranchPolicySettingsRequest(request.body);
    if (
      body.projectId !== branchPolicyRoute.projectId ||
      body.localeBranchId !== branchPolicyRoute.localeBranchId
    ) {
      throw new deps.ApiValidationError("branch policy path and body scope must match");
    }
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.branchPolicySave,
    );
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: branchPolicyRoute.projectId,
      localeBranchId: branchPolicyRoute.localeBranchId,
    });
    return responses.ok(
      "settings.branchPolicy.save",
      await services.branchPolicy.saveSettings({
        ...body,
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      }),
    );
  }

  const translationScopePostRoute = deps.parseTranslationScopeSettingsApiRoute(request.pathname);
  if (request.method === "POST" && translationScopePostRoute !== null) {
    const body = deps.parseSaveTranslationScopeSettingsRequest(request.body);
    if (
      body.projectId !== translationScopePostRoute.projectId ||
      body.localeBranchId !== translationScopePostRoute.localeBranchId
    ) {
      throw new deps.ApiValidationError("translation scope path and body scope must match");
    }
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.translationScopeSave,
    );
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: translationScopePostRoute.projectId,
      localeBranchId: translationScopePostRoute.localeBranchId,
    });
    return responses.ok(
      "settings.translationScope.save",
      await services.translationScope.saveSettings({
        ...body,
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      }),
    );
  }

  const localizationRunConfigRoute = deps.parseLocalizationRunConfigApiRoute(request.pathname);
  if (request.method === "POST" && localizationRunConfigRoute !== null) {
    const body = deps.parseSaveLocalizationRunConfigRequest(request.body);
    if (
      body.projectId !== localizationRunConfigRoute.projectId ||
      body.localeBranchId !== localizationRunConfigRoute.localeBranchId
    ) {
      throw new deps.ApiValidationError("localization run config path and body scope must match");
    }
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.localizationRunConfigSave,
    );
    const scope = await deps.requireOwnedBranchScope(services.projectWorkflow, {
      projectId: localizationRunConfigRoute.projectId,
      localeBranchId: localizationRunConfigRoute.localeBranchId,
    });
    return responses.ok(
      "settings.localizationRunConfig.save",
      await services.localizationRunConfig.saveRunConfig({
        ...body,
        projectId: scope.projectId,
        localeBranchId: scope.localeBranchId,
      }),
    );
  }

  if (request.pathname === "/api/settings/security/sso") {
    return responses.methodNotAllowed(["POST"]);
  }
  if (request.pathname === "/api/settings/model-routing") {
    return responses.methodNotAllowed(["GET", "POST"]);
  }
  if (branchPolicyRoute !== null) {
    return responses.methodNotAllowed(["GET", "POST"]);
  }
  if (translationScopePostRoute !== null) {
    return responses.methodNotAllowed(["GET", "POST"]);
  }
  if (localizationRunConfigRoute !== null) {
    return responses.methodNotAllowed(["POST"]);
  }

  if (request.method === "POST" && request.pathname === "/api/auth/members/invitations") {
    const body = deps.parseInviteMemberRequest(request.body);
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.membersInvite);
    return responses.ok(
      "auth.members.invite",
      deps.memberInvitationResponseBody(await services.authMembers.inviteMember(body)),
    );
  }

  const memberAcceptRoute = deps.parseAuthMemberAcceptRoute(request.pathname);
  if (request.method === "POST" && memberAcceptRoute !== null) {
    const body = deps.parseAcceptMemberInvitationRequest(request.body);
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.membersAccept);
    return responses.ok(
      "auth.members.accept",
      deps.memberResponseBody(
        deps.memberRecordBody(
          await services.authMembers.acceptInvitation(memberAcceptRoute.invitationId, body),
        ),
      ),
    );
  }

  const memberRemoveRoute = deps.parseAuthMemberRemoveRoute(request.pathname);
  if (request.method === "POST" && memberRemoveRoute !== null) {
    const body = deps.parseRemoveMemberRequest(request.body);
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.membersRemove);
    return responses.ok(
      "auth.members.remove",
      deps.removeMemberResponseBody(
        deps.memberRecordBody(
          await services.authMembers.removeMember(memberRemoveRoute.membershipId, body),
        ),
      ),
    );
  }

  const permissionSetGrantRoute = deps.parseAuthPermissionSetGrantRoute(request.pathname);
  if (request.method === "POST" && permissionSetGrantRoute !== null) {
    const body = deps.parsePrincipalPermissionSetGrantRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.permissionSetsGrant,
    );
    const updatedMember = await services.authPermissions.grantPermissionSet({
      principalId: permissionSetGrantRoute.principalId,
      permissionSetId: permissionSetGrantRoute.permissionSetId,
      request: body,
    });
    return responses.ok(
      "auth.permissionSets.grant",
      deps.principalPermissionSetGrantResponseBody({
        principalId: permissionSetGrantRoute.principalId,
        permissionSetId: permissionSetGrantRoute.permissionSetId,
        action: "granted",
        updatedMember: deps.memberRecordBody(updatedMember),
      }),
    );
  }

  const permissionSetRevokeRoute = deps.parseAuthPermissionSetRevokeRoute(request.pathname);
  if (request.method === "POST" && permissionSetRevokeRoute !== null) {
    const body = deps.parsePrincipalPermissionSetGrantRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.permissionSetsRevoke,
    );
    const updatedMember = await services.authPermissions.revokePermissionSet({
      principalId: permissionSetRevokeRoute.principalId,
      permissionSetId: permissionSetRevokeRoute.permissionSetId,
      request: body,
    });
    return responses.ok(
      "auth.permissionSets.revoke",
      deps.principalPermissionSetGrantResponseBody({
        principalId: permissionSetRevokeRoute.principalId,
        permissionSetId: permissionSetRevokeRoute.permissionSetId,
        action: "revoked",
        updatedMember: deps.memberRecordBody(updatedMember),
      }),
    );
  }

  if (
    request.pathname === "/api/auth/members/invitations" ||
    memberAcceptRoute !== null ||
    memberRemoveRoute !== null ||
    permissionSetGrantRoute !== null ||
    permissionSetRevokeRoute !== null
  ) {
    return responses.methodNotAllowed(["POST"]);
  }

  const authSessionsRoute = deps.parseAuthSessionsRoute(request.pathname);
  if (request.method === "GET" && authSessionsRoute !== null) {
    await shared.requireApiPermission(services, contracts.apiMutationPermissionGates.sessionsList);
    return responses.ok("auth.sessions.list", {
      schemaVersion: "itotori.auth.sessions.v0",
      principalId: authSessionsRoute.principalId,
      sessions: (
        await services.authSessions.listPrincipalSessions(authSessionsRoute.principalId)
      ).map(deps.authSessionRecordBody),
    });
  }

  const authSessionRevokeRoute = deps.parseAuthSessionRevokeRoute(request.pathname);
  if (request.method === "POST" && authSessionRevokeRoute !== null) {
    const body = deps.parseRevokeAuthSessionRequest(request.body);
    await shared.requireApiPermission(
      services,
      contracts.apiMutationPermissionGates.sessionsRevoke,
    );
    return responses.ok("auth.sessions.revoke", {
      schemaVersion: "itotori.auth.session-revoked.v0",
      revokedSession: deps.authSessionRecordBody(
        await services.authSessions.revokePrincipalSession(
          authSessionRevokeRoute.principalId,
          authSessionRevokeRoute.sessionId,
          body,
        ),
      ),
    });
  }

  if (authSessionsRoute !== null || authSessionRevokeRoute !== null) {
    return responses.methodNotAllowed(authSessionRevokeRoute !== null ? ["POST"] : ["GET"]);
  }

  return null;
}
