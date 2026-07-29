import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import {
  ApiAuthBillingSeatUsageResponse,
  ApiAuthCapabilitiesResponse,
  ApiAuthIdentityAccount,
  ApiAuthIdentityResponse,
  ApiAuthSessionsListResponse,
  ApiMemberInvitationResponse,
  ApiMemberResponse,
  ApiMembersListResponse,
  ApiModelRoutingRoute,
  ApiRevokeAuthSessionResponse,
} from "./api-domain-04.js";
import {
  ApiPermissionSetsListResponse,
  ApiPrincipalPermissionSetGrantResponse,
  ApiRemoveMemberResponse,
} from "./api-domain-05.js";
import {
  assertAuthSessionRecord,
  assertMemberRecord,
  assertPermissionSetRecord,
} from "./api-domain-24.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertNullableDateLike,
  assertNullableString,
  assertPositiveInteger,
  assertString,
  assertStringArray,
} from "./api-domain-29.js";

export function assertModelRoutingRoute(
  value: unknown,
  label: string,
): asserts value is ApiModelRoutingRoute {
  const route = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiModelRoutingRoute);
  assertString(route.projectId, `${label}.projectId`);
  assertString(route.taskKind, `${label}.taskKind`);
  assertString(route.providerId, `${label}.providerId`);
  assertString(route.modelId, `${label}.modelId`);
  assertString(route.modelRegistryId, `${label}.modelRegistryId`);
  assertStringArray(route.fallbackModelIds, `${label}.fallbackModelIds`);
  assertString(route.promptPresetId, `${label}.promptPresetId`);
  assertString(route.promptTemplateVersion, `${label}.promptTemplateVersion`);
  assertDateLike(route.updatedAt, `${label}.updatedAt`);
}

export function assertMemberInvitationResponse(
  value: unknown,
): asserts value is ApiMemberInvitationResponse {
  const response = asStrictRecord(
    value,
    "ApiMemberInvitationResponse",
    STRICT_API_BODY_KEYS.ApiMemberInvitationResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.member-invitation.v0",
    "ApiMemberInvitationResponse.schemaVersion",
  );
  assertString(response.invitationId, "ApiMemberInvitationResponse.invitationId");
  assertString(response.accountId, "ApiMemberInvitationResponse.accountId");
  assertString(response.email, "ApiMemberInvitationResponse.email");
  assertStringArray(
    response.initialPermissionSetIds,
    "ApiMemberInvitationResponse.initialPermissionSetIds",
  );
  assertDateLike(response.expiresAt, "ApiMemberInvitationResponse.expiresAt");
  assertNullableDateLike(response.acceptedAt, "ApiMemberInvitationResponse.acceptedAt");
  assertNullableDateLike(response.revokedAt, "ApiMemberInvitationResponse.revokedAt");
  assertDateLike(response.createdAt, "ApiMemberInvitationResponse.createdAt");
}

export function assertMemberResponse(value: unknown): asserts value is ApiMemberResponse {
  const response = asStrictRecord(
    value,
    "ApiMemberResponse",
    STRICT_API_BODY_KEYS.ApiMemberResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.member.v0",
    "ApiMemberResponse.schemaVersion",
  );
  assertMemberRecord(response.member, "ApiMemberResponse.member");
}

export function assertMembersListResponse(value: unknown): asserts value is ApiMembersListResponse {
  const response = asStrictRecord(
    value,
    "ApiMembersListResponse",
    STRICT_API_BODY_KEYS.ApiMembersListResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.members.v0",
    "ApiMembersListResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiMembersListResponse.accountId");
  const members = asArray(response.members, "ApiMembersListResponse.members");
  for (const [index, member] of members.entries()) {
    assertMemberRecord(member, `ApiMembersListResponse.members[${index}]`);
  }
}

export function assertAuthBillingSeatUsageResponse(
  value: unknown,
): asserts value is ApiAuthBillingSeatUsageResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthBillingSeatUsageResponse",
    STRICT_API_BODY_KEYS.ApiAuthBillingSeatUsageResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.billing-seat-usage.v0",
    "ApiAuthBillingSeatUsageResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiAuthBillingSeatUsageResponse.accountId");
  assertString(response.planId, "ApiAuthBillingSeatUsageResponse.planId");
  assertString(response.planName, "ApiAuthBillingSeatUsageResponse.planName");
  assertEnum(
    response.billingPeriod,
    ["monthly", "annual", "manual"] as const,
    "ApiAuthBillingSeatUsageResponse.billingPeriod",
  );
  assertPositiveInteger(response.seatLimit, "ApiAuthBillingSeatUsageResponse.seatLimit");
  assertNonNegativeInteger(response.includedSeats, "ApiAuthBillingSeatUsageResponse.includedSeats");
  assertNonNegativeInteger(response.usedSeats, "ApiAuthBillingSeatUsageResponse.usedSeats");
  assertNonNegativeInteger(
    response.pendingInvitations,
    "ApiAuthBillingSeatUsageResponse.pendingInvitations",
  );
  assertNonNegativeInteger(
    response.availableSeats,
    "ApiAuthBillingSeatUsageResponse.availableSeats",
  );
  assertBoolean(response.overSeatLimit, "ApiAuthBillingSeatUsageResponse.overSeatLimit");
  assertDateLike(response.updatedAt, "ApiAuthBillingSeatUsageResponse.updatedAt");
}

export function assertPermissionSetsListResponse(
  value: unknown,
): asserts value is ApiPermissionSetsListResponse {
  const response = asStrictRecord(
    value,
    "ApiPermissionSetsListResponse",
    STRICT_API_BODY_KEYS.ApiPermissionSetsListResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.permission-sets.v0",
    "ApiPermissionSetsListResponse.schemaVersion",
  );
  assertString(response.accountId, "ApiPermissionSetsListResponse.accountId");
  const permissionSets = asArray(
    response.permissionSets,
    "ApiPermissionSetsListResponse.permissionSets",
  );
  for (const [index, permissionSet] of permissionSets.entries()) {
    assertPermissionSetRecord(
      permissionSet,
      `ApiPermissionSetsListResponse.permissionSets[${index}]`,
    );
  }
}

export function assertPrincipalPermissionSetGrantResponse(
  value: unknown,
): asserts value is ApiPrincipalPermissionSetGrantResponse {
  const response = asStrictRecord(
    value,
    "ApiPrincipalPermissionSetGrantResponse",
    STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.permission-set-grant.v0",
    "ApiPrincipalPermissionSetGrantResponse.schemaVersion",
  );
  assertString(response.principalId, "ApiPrincipalPermissionSetGrantResponse.principalId");
  assertString(response.permissionSetId, "ApiPrincipalPermissionSetGrantResponse.permissionSetId");
  assertEnum(
    response.action,
    ["granted", "revoked"] as const,
    "ApiPrincipalPermissionSetGrantResponse.action",
  );
  assertMemberRecord(
    response.updatedMember,
    "ApiPrincipalPermissionSetGrantResponse.updatedMember",
  );
}

export function assertAuthSessionsListResponse(
  value: unknown,
): asserts value is ApiAuthSessionsListResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthSessionsListResponse",
    STRICT_API_BODY_KEYS.ApiAuthSessionsListResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.sessions.v0",
    "ApiAuthSessionsListResponse.schemaVersion",
  );
  assertString(response.principalId, "ApiAuthSessionsListResponse.principalId");
  const sessions = asArray(response.sessions, "ApiAuthSessionsListResponse.sessions");
  for (const [index, session] of sessions.entries()) {
    assertAuthSessionRecord(session, `ApiAuthSessionsListResponse.sessions[${index}]`);
  }
}

export function assertRevokeAuthSessionResponse(
  value: unknown,
): asserts value is ApiRevokeAuthSessionResponse {
  const response = asStrictRecord(
    value,
    "ApiRevokeAuthSessionResponse",
    STRICT_API_BODY_KEYS.ApiRevokeAuthSessionResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.session-revoked.v0",
    "ApiRevokeAuthSessionResponse.schemaVersion",
  );
  assertAuthSessionRecord(response.revokedSession, "ApiRevokeAuthSessionResponse.revokedSession");
}

export function assertAuthIdentityResponse(
  value: unknown,
): asserts value is ApiAuthIdentityResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthIdentityResponse",
    STRICT_API_BODY_KEYS.ApiAuthIdentityResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.identity.v0",
    "ApiAuthIdentityResponse.schemaVersion",
  );
  assertString(response.actorUserId, "ApiAuthIdentityResponse.actorUserId");
  assertString(response.userId, "ApiAuthIdentityResponse.userId");
  assertNullableString(response.principalId, "ApiAuthIdentityResponse.principalId");
  assertNullableString(response.email, "ApiAuthIdentityResponse.email");
  assertString(response.displayName, "ApiAuthIdentityResponse.displayName");
  const accounts = asArray(response.accounts, "ApiAuthIdentityResponse.accounts");
  for (const [index, account] of accounts.entries()) {
    assertAuthIdentityAccount(account, `ApiAuthIdentityResponse.accounts[${index}]`);
  }
}

export function assertAuthCapabilitiesResponse(
  value: unknown,
): asserts value is ApiAuthCapabilitiesResponse {
  const response = asStrictRecord(
    value,
    "ApiAuthCapabilitiesResponse",
    STRICT_API_BODY_KEYS.ApiAuthCapabilitiesResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.capabilities.v0",
    "ApiAuthCapabilitiesResponse.schemaVersion",
  );
  assertString(response.actorUserId, "ApiAuthCapabilitiesResponse.actorUserId");
  assertBoolean(response.canFlag, "ApiAuthCapabilitiesResponse.canFlag");
  assertBoolean(response.canSteer, "ApiAuthCapabilitiesResponse.canSteer");
  assertBoolean(response.canReveal, "ApiAuthCapabilitiesResponse.canReveal");
  const denials = asStrictRecord(
    response.denials,
    "ApiAuthCapabilitiesResponse.denials",
    STRICT_API_BODY_KEYS.ApiStudioCapabilityDenials,
  );
  assertNullableString(denials.flag, "ApiAuthCapabilitiesResponse.denials.flag");
  assertNullableString(denials.steer, "ApiAuthCapabilitiesResponse.denials.steer");
  assertNullableString(denials.reveal, "ApiAuthCapabilitiesResponse.denials.reveal");
  const denialReasons = asArray(
    response.denialReasons,
    "ApiAuthCapabilitiesResponse.denialReasons",
  );
  for (const [index, reason] of denialReasons.entries()) {
    assertString(reason, `ApiAuthCapabilitiesResponse.denialReasons[${index}]`);
  }
}

export function assertRemoveMemberResponse(
  value: unknown,
): asserts value is ApiRemoveMemberResponse {
  const response = asStrictRecord(
    value,
    "ApiRemoveMemberResponse",
    STRICT_API_BODY_KEYS.ApiRemoveMemberResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.auth.member-removed.v0",
    "ApiRemoveMemberResponse.schemaVersion",
  );
  assertMemberRecord(response.removedMember, "ApiRemoveMemberResponse.removedMember");
}

export function assertAuthIdentityAccount(
  value: unknown,
  label: string,
): asserts value is ApiAuthIdentityAccount {
  const account = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiAuthIdentityAccount);
  assertString(account.membershipId, `${label}.membershipId`);
  assertString(account.accountId, `${label}.accountId`);
  assertString(account.accountSlug, `${label}.accountSlug`);
  assertString(account.accountName, `${label}.accountName`);
  assertStringArray(account.permissionSetIds, `${label}.permissionSetIds`);
  assertDateLike(account.createdAt, `${label}.createdAt`);
}
