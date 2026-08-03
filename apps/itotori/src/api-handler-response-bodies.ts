import type {
  AuthAccountSeatUsageRecord,
  AuthSessionAdminRecord,
  ModelRoutingSettingsRecord,
  PermissionSetRecord,
} from "@itotori/db";
import type {
  ApiAuthBillingSeatUsageResponse,
  ApiAuthSessionRecord,
  ApiConfigureAuthSsoSettingsRequest,
  ApiConfigureAuthSsoSettingsResponse,
  ApiLaunchPassResponse,
  ApiMemberInvitationResponse,
  ApiMemberRecord,
  ApiMemberResponse,
  ApiModelRoutingSettingsResponse,
  ApiPatchIterationPlayResponse,
  ApiPermissionSetRecord,
  ApiPermissionSetsListResponse,
  ApiPlayDeliveryResponse,
  ApiPlayTargetEditResponse,
  ApiPrincipalPermissionSetGrantResponse,
  ApiRemoveMemberResponse,
  ApiWikiApplyResponse,
  ApiWikiEditResponse,
} from "./api-schema.js";
import type {
  PlayTesterTargetEditResponse,
  SelectedPatchExportResponse,
} from "./play/result-revision-service.js";
import type { LaunchLocalizationPassResult } from "./services/project-operations-port.js";
import type { PatchRuntimeLaunchReceipt } from "./play/patch-runtime-launcher.js";
import { playDeliveryArchivePath } from "./api-routes.js";
import type {
  WikiApplyReceipt,
  WikiHistoryEntry,
  WikiWriteReceipt,
} from "./wiki/object-api/index.js";

export function launchPassResponseBody(
  outcome: LaunchLocalizationPassResult,
): ApiLaunchPassResponse {
  if (outcome.outcome === "started") {
    return {
      schemaVersion: "itotori.projects.launch-pass.v1",
      outcome: "started",
      journalRunId: outcome.journalRunId,
      startedAt: outcome.startedAt.toISOString(),
      refusalMessage: null,
    };
  }
  return {
    schemaVersion: "itotori.projects.launch-pass.v1",
    outcome: "refused",
    journalRunId: null,
    startedAt: null,
    refusalMessage: outcome.refusalMessage,
  };
}

/** p0-result-revision — map the bound service result to the public mutation envelope. */
export function playTargetEditResponseBody(
  input: PlayTesterTargetEditResponse,
): ApiPlayTargetEditResponse {
  const result = input.result;
  return {
    schemaVersion: "itotori.play.target-edit.v0",
    resultRevisionId: result.resultRevision.resultRevisionId,
    patchVersionId: result.patchVersion.patchVersionId,
    runId: result.patchVersion.runId,
    parentPatchVersionId: result.patchVersion.parentPatchVersionId,
    bridgeUnitId: result.resultRevision.bridgeUnitId,
    targetBody: result.resultRevision.targetBody,
    status: result.patchVersion.status,
    selectedAt: result.patchVersion.selectedAt.toISOString(),
    idempotentReplay: result.idempotentReplay,
  };
}

/** p0-result-revision — map the selected real delivery export to the API view. */
export function playDeliveryResponseBody(
  input: SelectedPatchExportResponse,
): ApiPlayDeliveryResponse {
  if (input.export === null) {
    throw new Error("cannot build a play delivery response without a selected export");
  }
  const selected = input.export;
  return {
    schemaVersion: "itotori.play.delivery.v0",
    patchVersionId: selected.patchVersionId,
    runId: selected.runId,
    parentPatchVersionId: selected.parentPatchVersionId,
    status: selected.status,
    selectedAt: selected.selectedAt.toISOString(),
    artifactHashes: { ...selected.artifactHashes },
    downloadUrl: playDeliveryArchivePath(selected.runId),
    units: selected.units.map((unit) => ({
      bridgeUnitId: unit.bridgeUnitId,
      unitOrdinal: unit.unitOrdinal,
      targetBody: unit.targetBody,
    })),
  };
}

export function patchIterationPlayReceiptResponseBody(
  input: PatchRuntimeLaunchReceipt,
): ApiPatchIterationPlayResponse {
  if (input.operation !== "replay-validate") {
    throw new Error("patch iteration play API only exposes replay-validation receipts");
  }
  return {
    schemaVersion: "itotori.patch-iteration.play.v0",
    receipt: {
      adapterId: input.adapterId,
      operation: input.operation,
      adapterReceipt: { ...input.adapterReceipt },
    },
  };
}

export function wikiObjectWriteResponseBody(
  receipt: WikiWriteReceipt,
  history: readonly WikiHistoryEntry[],
  generatedAt: string,
): ApiWikiEditResponse {
  return {
    schemaVersion: "itotori.wiki.write.v1",
    generatedAt,
    receipt,
    history,
    dependencyImpact: receipt.dependencyImpact,
  };
}

export function wikiObjectApplyResponseBody(
  receipt: WikiApplyReceipt,
  history: readonly WikiHistoryEntry[],
  generatedAt: string,
): ApiWikiApplyResponse {
  return {
    schemaVersion: "itotori.wiki.apply.v1",
    generatedAt,
    receipt,
    history,
    dependencyImpact: receipt.dependencyImpact,
  };
}

export function authSsoSettingsResponseBody(input: {
  accountId: string;
  provider: ApiConfigureAuthSsoSettingsRequest["provider"];
  security: ApiConfigureAuthSsoSettingsRequest["security"];
  sessionPolicy: ApiConfigureAuthSsoSettingsRequest["sessionPolicy"];
  updatedAt: Date;
}): ApiConfigureAuthSsoSettingsResponse {
  return {
    schemaVersion: "itotori.auth.sso-settings.v0",
    accountId: input.accountId,
    provider: input.provider,
    security: input.security,
    sessionPolicy: input.sessionPolicy,
    updatedAt: input.updatedAt.toISOString(),
  };
}

export function memberInvitationResponseBody(input: {
  invitationId: string;
  accountId: string;
  email: string;
  initialPermissionSetIds: readonly string[];
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): ApiMemberInvitationResponse {
  return {
    schemaVersion: "itotori.auth.member-invitation.v0",
    invitationId: input.invitationId,
    accountId: input.accountId,
    email: input.email,
    initialPermissionSetIds: [...input.initialPermissionSetIds],
    expiresAt: input.expiresAt.toISOString(),
    acceptedAt: input.acceptedAt?.toISOString() ?? null,
    revokedAt: input.revokedAt?.toISOString() ?? null,
    createdAt: input.createdAt.toISOString(),
  };
}

export function memberRecordBody(input: {
  membershipId: string;
  accountId: string;
  userId: string;
  principalId: string;
  email: string | null;
  displayName: string;
  permissionSetIds: readonly string[];
  createdAt: Date | string;
}): ApiMemberRecord {
  return {
    membershipId: input.membershipId,
    accountId: input.accountId,
    userId: input.userId,
    principalId: input.principalId,
    email: input.email,
    displayName: input.displayName,
    permissionSetIds: [...input.permissionSetIds],
    createdAt: input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt,
  };
}

export function authSessionRecordBody(input: AuthSessionAdminRecord): ApiAuthSessionRecord {
  return {
    sessionId: input.sessionId,
    principalId: input.principalId,
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    revokedAt: input.revokedAt?.toISOString() ?? null,
    isActive: input.isActive,
    deviceLabel: input.deviceLabel,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  };
}

export function memberResponseBody(input: ApiMemberRecord): ApiMemberResponse {
  return { schemaVersion: "itotori.auth.member.v0", member: input };
}

export function authBillingSeatUsageResponseBody(
  input: AuthAccountSeatUsageRecord,
): ApiAuthBillingSeatUsageResponse {
  return {
    schemaVersion: "itotori.auth.billing-seat-usage.v0",
    accountId: input.accountId,
    planId: input.planId,
    planName: input.planName,
    billingPeriod: input.billingPeriod,
    seatLimit: input.seatLimit,
    includedSeats: input.includedSeats,
    usedSeats: input.usedSeats,
    pendingInvitations: input.pendingInvitations,
    availableSeats: input.availableSeats,
    overSeatLimit: input.overSeatLimit,
    updatedAt: input.updatedAt.toISOString(),
  };
}

export function modelRoutingSettingsResponseBody(
  input: ModelRoutingSettingsRecord,
): ApiModelRoutingSettingsResponse {
  return {
    schemaVersion: "itotori.settings.model-routing.v0",
    projectId: input.projectId,
    generatedAt: input.generatedAt.toISOString(),
    providers: input.providers.map((provider) => ({ ...provider })),
    models: input.models.map((model) => ({ ...model })),
    promptPresets: input.promptPresets.map((preset) => ({ ...preset })),
    routes: input.routes.map((route) => ({
      projectId: route.projectId,
      taskKind: route.taskKind,
      providerId: route.providerId,
      modelId: route.modelId,
      modelRegistryId: route.modelRegistryId,
      fallbackModelIds: [...route.fallbackModelIds],
      promptPresetId: route.promptPresetId,
      promptTemplateVersion: route.promptTemplateVersion,
      updatedAt: route.updatedAt.toISOString(),
    })),
  };
}

export function removeMemberResponseBody(input: ApiMemberRecord): ApiRemoveMemberResponse {
  return { schemaVersion: "itotori.auth.member-removed.v0", removedMember: input };
}

export function permissionSetRecordBody(input: PermissionSetRecord): ApiPermissionSetRecord {
  return {
    permissionSetId: input.permissionSetId,
    accountId: input.accountId,
    name: input.name,
    permissions: [...input.permissions],
  };
}

export function permissionSetsListResponseBody(input: {
  accountId: string;
  permissionSets: readonly PermissionSetRecord[];
}): ApiPermissionSetsListResponse {
  return {
    schemaVersion: "itotori.auth.permission-sets.v0",
    accountId: input.accountId,
    permissionSets: input.permissionSets.map(permissionSetRecordBody),
  };
}

export function principalPermissionSetGrantResponseBody(input: {
  principalId: string;
  permissionSetId: string;
  action: "granted" | "revoked";
  updatedMember: ApiMemberRecord;
}): ApiPrincipalPermissionSetGrantResponse {
  return {
    schemaVersion: "itotori.auth.permission-set-grant.v0",
    principalId: input.principalId,
    permissionSetId: input.permissionSetId,
    action: input.action,
    updatedMember: input.updatedMember,
  };
}

/**
 * policy — the READ-ONLY (query) route handler. It receives ONLY the
 * read-only dependency surface, so it is structurally unable to reach a
 * mutation service. It returns an {@link ApiJsonResponse} for every read route
 * it owns (including the `method not allowed` responses for the pure-GET read
 * paths), and `null` when the request should be handled by the mutation
 * routing in {@link routeItotoriApiRequest}.
 */
