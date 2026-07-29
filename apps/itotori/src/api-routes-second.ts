import type { ItotoriApiRoute } from "./api-routes.js";
import type { ItotoriApiRouteId } from "./api-schema.js";

export const apiRoutesSecond = {
  "auth.members.invite": {
    method: "POST",
    pathTemplate: "/api/auth/members/invitations",
    operationId: "authMembersInvite",
    summary: "Invite a member with optional initial permission sets.",
    pathParams: [],
    requestSchema: "ApiInviteMemberRequest",
    responseSchema: "ApiMemberInvitationResponse",
  },
  "auth.members.accept": {
    method: "POST",
    pathTemplate: "/api/auth/members/invitations/{invitationId}/accept",
    operationId: "authMembersAcceptInvitation",
    summary: "Accept a member invitation, creating membership and initial grants transactionally.",
    pathParams: ["invitationId"],
    requestSchema: "ApiAcceptMemberInvitationRequest",
    responseSchema: "ApiMemberResponse",
  },
  "auth.members.remove": {
    method: "POST",
    pathTemplate: "/api/auth/members/{membershipId}/remove",
    operationId: "authMembersRemove",
    summary: "Remove a member and revoke account-scoped permission-set grants.",
    pathParams: ["membershipId"],
    requestSchema: "ApiRemoveMemberRequest",
    responseSchema: "ApiRemoveMemberResponse",
  },
  "auth.permissionSets.list": {
    method: "GET",
    pathTemplate: "/api/auth/permission-sets",
    operationId: "authPermissionSetsList",
    summary: "List account permission sets available for member grants.",
    pathParams: [],
    responseSchema: "ApiPermissionSetsListResponse",
  },
  "auth.permissionSets.grant": {
    method: "POST",
    pathTemplate: "/api/auth/principals/{principalId}/permission-sets/{permissionSetId}/grant",
    operationId: "authPermissionSetsGrant",
    summary: "Grant a permission set to an account principal.",
    pathParams: ["principalId", "permissionSetId"],
    requestSchema: "ApiPrincipalPermissionSetGrantRequest",
    responseSchema: "ApiPrincipalPermissionSetGrantResponse",
  },
  "auth.permissionSets.revoke": {
    method: "POST",
    pathTemplate: "/api/auth/principals/{principalId}/permission-sets/{permissionSetId}/revoke",
    operationId: "authPermissionSetsRevoke",
    summary: "Revoke a permission set from an account principal.",
    pathParams: ["principalId", "permissionSetId"],
    requestSchema: "ApiPrincipalPermissionSetGrantRequest",
    responseSchema: "ApiPrincipalPermissionSetGrantResponse",
  },
  "auth.sessions.list": {
    method: "GET",
    pathTemplate: "/api/auth/principals/{principalId}/sessions",
    operationId: "authSessionsList",
    summary: "List active auth sessions and captured device metadata for a principal.",
    pathParams: ["principalId"],
    responseSchema: "ApiAuthSessionsListResponse",
  },
  "auth.sessions.revoke": {
    method: "POST",
    pathTemplate: "/api/auth/principals/{principalId}/sessions/{sessionId}/revoke",
    operationId: "authSessionsRevoke",
    summary: "Revoke an active auth session for a principal.",
    pathParams: ["principalId", "sessionId"],
    requestSchema: "ApiRevokeAuthSessionRequest",
    responseSchema: "ApiRevokeAuthSessionResponse",
  },
  // ovw-launch-pass-action — the `canSteer`-gated launch-pass HTTP adapter.
  "projects.launchPass": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/launch-pass",
    operationId: "projectsLaunchPass",
    summary: "Launch the next localization pass or cancel an existing durable run.",
    pathParams: ["projectId"],
    requestSchema: "ApiLaunchPassRequest",
    responseSchema: "ApiLaunchPassResponse",
  },
  // play-routemap-ui — Play RouteMap route/choice tree from routeMaps/routeChoices.
  "play.routeMap": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/route-map",
    operationId: "playRouteMap",
    summary: "Play RouteMap route/choice tree with coverage state.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiPlayRouteMapResponse",
  },
  // play-flag-composer — in-the-moment AnnotationComposer note → canonical
  // context correction via ManualFeedbackImport (feedback.import / canFlag).
  "play.flagAnnotation": {
    method: "POST",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/flags",
    operationId: "playFlagAnnotation",
    summary: "Compose a playtest flag (AnnotationComposer) into a context correction.",
    pathParams: ["projectId", "localeBranchId"],
    requestSchema: "ApiPlayFlagAnnotationRequest",
    responseSchema: "ApiPlayFlagAnnotationResponse",
  },
  // Unit-bound feedback retrieval — same ledger the flag composer writes.
  "play.unitFeedback": {
    method: "GET",
    pathTemplate: "/api/projects/{projectId}/locale-branches/{localeBranchId}/unit-feedback",
    operationId: "playUnitFeedback",
    summary: "List durable unit-bound feedback notes for one bridge unit.",
    pathParams: ["projectId", "localeBranchId"],
    responseSchema: "ApiPlayUnitFeedbackResponse",
  },
  "play.addressableUnit": {
    method: "GET",
    pathTemplate:
      "/api/projects/{projectId}/locale-branches/{localeBranchId}/addressable-units/{bridgeUnitId}",
    operationId: "playAddressableUnit",
    summary:
      "Resolve one cited bridge unit against the imported branch and its producer-declared scene.",
    pathParams: ["projectId", "localeBranchId", "bridgeUnitId"],
    responseSchema: "ApiPlayAddressableUnitResponse",
  },
  // p0-result-revision — a target-only play-tester edit creates a selected,
  // delivered child patch revision. The parent patch is path-scoped so the
  // body cannot fabricate patch identity, actor identity, or artifact paths.
  "play.targetEdit": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{parentPatchVersionId}/target-edits",
    operationId: "playTargetEdit",
    summary: "Replace one delivered target line and select its child patch revision.",
    pathParams: ["parentPatchVersionId"],
    requestSchema: "ApiPlayTargetEditRequest",
    responseSchema: "ApiPlayTargetEditResponse",
  },
  // p0-result-revision — production delivery boundary for the selected patch.
  "play.delivery": {
    method: "GET",
    pathTemplate: "/api/play/runs/{runId}/delivery",
    operationId: "playDelivery",
    summary: "Load the selected delivered patch export for a run.",
    pathParams: ["runId"],
    responseSchema: "ApiPlayDeliveryResponse",
  },
  // planning-item — exact-version
  // iteration topology. Historical versions are readable/playable; feedback
  // and refinement mutations remain resource-scoped to the observed base.
  "patchIteration.versions": {
    method: "GET",
    pathTemplate: "/api/play/locale-branches/{localeBranchId}/patch-versions",
    operationId: "patchIterationVersions",
    summary: "List durable patch versions and lineage for one locale branch.",
    pathParams: ["localeBranchId"],
    responseSchema: "ApiPatchIterationVersionsResponse",
  },
  "patchIteration.surface": {
    method: "GET",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}",
    operationId: "patchIterationSurface",
    summary: "Load a historical patch play surface, feedback inbox, and informational QA callouts.",
    pathParams: ["patchVersionId"],
    responseSchema: "ApiPatchIterationSurfaceResponse",
  },
  "patchIteration.delivery": {
    method: "GET",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/delivery",
    operationId: "patchIterationDelivery",
    summary: "Load immutable archive metadata for one exact playable patch version.",
    pathParams: ["patchVersionId"],
    responseSchema: "ApiPatchIterationDeliveryResponse",
  },
  "patchIteration.play": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/sessions",
    operationId: "patchIterationPlay",
    summary: "Start a play session for the exact playable patch version observed.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationPlayRequest",
    responseSchema: "ApiPatchIterationPlayResponse",
  },
  "patchIteration.feedbackBatch": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/feedback-batches",
    operationId: "patchIterationFeedbackBatch",
    summary: "Create a persisted feedback batch for the exact patch version observed.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationFeedbackBatchRequest",
    responseSchema: "ApiPatchIterationFeedbackBatchResponse",
  },
  "patchIteration.feedback": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/feedback",
    operationId: "patchIterationFeedback",
    summary:
      "Persist individual or batched result edits, canonical scoped comments, or canonical context play-test feedback.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationFeedbackRequest",
    responseSchema: "ApiPatchIterationFeedbackResponse",
  },
  "patchIteration.refine": {
    method: "POST",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/refine",
    operationId: "patchIterationRefine",
    summary: "Freeze feedback/wiki inputs and complete a real-byte refinement patch version.",
    pathParams: ["patchVersionId"],
    requestSchema: "ApiPatchIterationRefineRequest",
    responseSchema: "ApiPatchIterationRefineResponse",
  },
} satisfies Readonly<Partial<Record<ItotoriApiRouteId, ItotoriApiRoute>>>;
