import { STRICT_API_BODY_KEYS } from "./api-schema.js";
import { bool, num, obj, object, str } from "./api-contract-schema.js";
import type { ComponentBuilders } from "./api-contract-components.js";

export const authComponentBuilders: ComponentBuilders = {
  ApiConfigureAuthSsoSettingsRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsRequest,
      properties: {
        accountId: str,
        provider: obj,
        security: obj,
        sessionPolicy: obj,
      },
      additionalProperties: false,
    }),
  ApiConfigureAuthSsoSettingsResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsResponse,
      properties: {
        accountId: str,
        provider: obj,
        security: obj,
        sessionPolicy: obj,
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.sso-settings.v0",
    }),
  ApiInviteMemberRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiInviteMemberRequest,
      properties: {
        accountId: str,
        email: str,
        initialPermissionSetIds: { type: "array", items: str },
        expiresAt: str,
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiMemberInvitationResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiMemberInvitationResponse,
      properties: {
        invitationId: str,
        accountId: str,
        email: str,
        initialPermissionSetIds: { type: "array", items: str },
        expiresAt: str,
        acceptedAt: { oneOf: [str, { type: "null" }] },
        revokedAt: { oneOf: [str, { type: "null" }] },
        createdAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.member-invitation.v0",
    }),
  ApiAcceptMemberInvitationRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAcceptMemberInvitationRequest,
      properties: {
        userId: str,
        principalId: str,
        displayName: str,
        email: str,
        externalIdentity: { oneOf: [obj, { type: "null" }] },
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiMemberRecord: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiMemberRecord,
      properties: {
        membershipId: str,
        accountId: str,
        userId: str,
        principalId: str,
        email: { oneOf: [str, { type: "null" }] },
        displayName: str,
        permissionSetIds: { type: "array", items: str },
        createdAt: str,
      },
      additionalProperties: false,
    }),
  ApiMemberResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiMemberResponse,
      properties: { member: ref("ApiMemberRecord") },
      additionalProperties: false,
      schemaVersion: "itotori.auth.member.v0",
    }),
  ApiMembersListResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiMembersListResponse,
      properties: {
        accountId: str,
        members: { type: "array", items: ref("ApiMemberRecord") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.members.v0",
    }),
  ApiAuthBillingSeatUsageResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAuthBillingSeatUsageResponse,
      properties: {
        accountId: str,
        planId: str,
        planName: str,
        billingPeriod: { enum: ["monthly", "annual", "manual"] },
        seatLimit: num,
        includedSeats: num,
        usedSeats: num,
        pendingInvitations: num,
        availableSeats: num,
        overSeatLimit: bool,
        updatedAt: str,
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.billing-seat-usage.v0",
    }),
  ApiRemoveMemberRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiRemoveMemberRequest,
      properties: {
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiAuthSessionRecord: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAuthSessionRecord,
      properties: {
        sessionId: str,
        principalId: str,
        createdAt: str,
        expiresAt: str,
        revokedAt: { oneOf: [str, { type: "null" }] },
        isActive: bool,
        deviceLabel: { oneOf: [str, { type: "null" }] },
        userAgent: { oneOf: [str, { type: "null" }] },
        ipAddress: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiAuthSessionsListResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAuthSessionsListResponse,
      properties: {
        principalId: str,
        sessions: { type: "array", items: ref("ApiAuthSessionRecord") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.sessions.v0",
    }),
  ApiRevokeAuthSessionRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiRevokeAuthSessionRequest,
      properties: {
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiRevokeAuthSessionResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiRevokeAuthSessionResponse,
      properties: { revokedSession: ref("ApiAuthSessionRecord") },
      additionalProperties: false,
      schemaVersion: "itotori.auth.session-revoked.v0",
    }),
  ApiRemoveMemberResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiRemoveMemberResponse,
      properties: { removedMember: ref("ApiMemberRecord") },
      additionalProperties: false,
      schemaVersion: "itotori.auth.member-removed.v0",
    }),
  ApiPermissionSetRecord: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPermissionSetRecord,
      properties: {
        permissionSetId: str,
        accountId: str,
        name: str,
        permissions: { type: "array", items: str },
      },
      additionalProperties: false,
    }),
  ApiPermissionSetsListResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPermissionSetsListResponse,
      properties: {
        accountId: str,
        permissionSets: { type: "array", items: ref("ApiPermissionSetRecord") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.permission-sets.v0",
    }),
  ApiPrincipalPermissionSetGrantRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantRequest,
      properties: {
        reason: { oneOf: [str, { type: "null" }] },
        requestId: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiPrincipalPermissionSetGrantResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantResponse,
      properties: {
        principalId: str,
        permissionSetId: str,
        action: { enum: ["granted", "revoked"] },
        updatedMember: ref("ApiMemberRecord"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.permission-set-grant.v0",
    }),
  ApiAuthIdentityAccount: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAuthIdentityAccount,
      properties: {
        membershipId: str,
        accountId: str,
        accountSlug: str,
        accountName: str,
        permissionSetIds: { type: "array", items: str },
        createdAt: str,
      },
      additionalProperties: false,
    }),
  ApiAuthIdentityResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAuthIdentityResponse,
      properties: {
        actorUserId: str,
        userId: str,
        principalId: { oneOf: [str, { type: "null" }] },
        email: { oneOf: [str, { type: "null" }] },
        displayName: str,
        accounts: { type: "array", items: ref("ApiAuthIdentityAccount") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.identity.v0",
    }),
  // fnd-caps-context — Studio capability permission view wire schemas.
  ApiStudioCapabilityDenials: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiStudioCapabilityDenials,
      properties: {
        flag: { oneOf: [str, { type: "null" }] },
        steer: { oneOf: [str, { type: "null" }] },
        reveal: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: false,
    }),
  ApiAuthCapabilitiesResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiAuthCapabilitiesResponse,
      properties: {
        actorUserId: str,
        canFlag: bool,
        canSteer: bool,
        canReveal: bool,
        denials: ref("ApiStudioCapabilityDenials"),
        denialReasons: { type: "array", items: str },
      },
      additionalProperties: false,
      schemaVersion: "itotori.auth.capabilities.v0",
    }),
};
