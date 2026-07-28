import { translationScopeValues } from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import {
  ApiAcceptMemberInvitationRequest,
  ApiInviteMemberRequest,
  ApiRemoveMemberRequest,
  ApiRevokeAuthSessionRequest,
  ApiSaveLocalizationRunConfigRequest,
  ApiSaveTranslationScopeSettingsRequest,
  ApiTranslationScope,
} from "./api-domain-04.js";
import { ApiPrincipalPermissionSetGrantRequest } from "./api-domain-05.js";
import { parseNullableExternalIdentityLink, parseRequest } from "./api-domain-28.js";
import {
  asStrictRecord,
  assertDateLike,
  assertEnum,
  assertNullableString,
  assertString,
  assertStringArray,
} from "./api-domain-29.js";

export function parseSaveTranslationScopeSettingsRequest(
  body: unknown,
): ApiSaveTranslationScopeSettingsRequest {
  return parseRequest("ApiSaveTranslationScopeSettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveTranslationScopeSettingsRequest",
      STRICT_API_BODY_KEYS.ApiSaveTranslationScopeSettingsRequest,
    );
    assertString(request.projectId, "ApiSaveTranslationScopeSettingsRequest.projectId");
    assertString(request.localeBranchId, "ApiSaveTranslationScopeSettingsRequest.localeBranchId");
    assertEnum(
      request.scope,
      Object.values(translationScopeValues) as ApiTranslationScope[],
      "ApiSaveTranslationScopeSettingsRequest.scope",
    );
    return {
      projectId: request.projectId,
      localeBranchId: request.localeBranchId,
      scope: request.scope,
    };
  });
}

export function parseSaveLocalizationRunConfigRequest(
  body: unknown,
): ApiSaveLocalizationRunConfigRequest {
  return parseRequest("ApiSaveLocalizationRunConfigRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveLocalizationRunConfigRequest",
      STRICT_API_BODY_KEYS.ApiSaveLocalizationRunConfigRequest,
    );
    const stringFields = [
      "projectId",
      "localeBranchId",
      "configPath",
      "dataRoot",
      "pairPolicyPath",
      "modelId",
      "providerId",
      "runDir",
    ] as const;
    const stringField = (field: (typeof stringFields)[number]): string => {
      const value = request[field];
      assertString(value, `ApiSaveLocalizationRunConfigRequest.${field}`);
      return value;
    };
    return {
      projectId: stringField("projectId"),
      localeBranchId: stringField("localeBranchId"),
      configPath: stringField("configPath"),
      dataRoot: stringField("dataRoot"),
      pairPolicyPath: stringField("pairPolicyPath"),
      modelId: stringField("modelId"),
      providerId: stringField("providerId"),
      runDir: stringField("runDir"),
    };
  });
}

export function parseInviteMemberRequest(body: unknown): ApiInviteMemberRequest {
  return parseRequest("ApiInviteMemberRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiInviteMemberRequest",
      STRICT_API_BODY_KEYS.ApiInviteMemberRequest,
    );
    assertString(request.accountId, "ApiInviteMemberRequest.accountId");
    assertString(request.email, "ApiInviteMemberRequest.email");
    assertStringArray(
      request.initialPermissionSetIds,
      "ApiInviteMemberRequest.initialPermissionSetIds",
    );
    assertDateLike(request.expiresAt, "ApiInviteMemberRequest.expiresAt");
    assertNullableString(request.reason, "ApiInviteMemberRequest.reason");
    assertNullableString(request.requestId, "ApiInviteMemberRequest.requestId");
    const expiresAt =
      request.expiresAt instanceof Date
        ? request.expiresAt.toISOString()
        : String(request.expiresAt);
    return {
      accountId: request.accountId,
      email: request.email,
      initialPermissionSetIds: request.initialPermissionSetIds as string[],
      expiresAt,
      reason: request.reason,
      requestId: request.requestId,
    };
  });
}

export function parseAcceptMemberInvitationRequest(
  body: unknown,
): ApiAcceptMemberInvitationRequest {
  return parseRequest("ApiAcceptMemberInvitationRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiAcceptMemberInvitationRequest",
      STRICT_API_BODY_KEYS.ApiAcceptMemberInvitationRequest,
    );
    assertString(request.userId, "ApiAcceptMemberInvitationRequest.userId");
    assertString(request.principalId, "ApiAcceptMemberInvitationRequest.principalId");
    assertString(request.displayName, "ApiAcceptMemberInvitationRequest.displayName");
    assertString(request.email, "ApiAcceptMemberInvitationRequest.email");
    assertNullableString(request.reason, "ApiAcceptMemberInvitationRequest.reason");
    assertNullableString(request.requestId, "ApiAcceptMemberInvitationRequest.requestId");
    return {
      userId: request.userId,
      principalId: request.principalId,
      displayName: request.displayName,
      email: request.email,
      externalIdentity: parseNullableExternalIdentityLink(
        request.externalIdentity,
        "ApiAcceptMemberInvitationRequest.externalIdentity",
      ),
      reason: request.reason,
      requestId: request.requestId,
    };
  });
}

export function parseRemoveMemberRequest(body: unknown): ApiRemoveMemberRequest {
  return parseRequest("ApiRemoveMemberRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiRemoveMemberRequest",
      STRICT_API_BODY_KEYS.ApiRemoveMemberRequest,
    );
    assertNullableString(request.reason, "ApiRemoveMemberRequest.reason");
    assertNullableString(request.requestId, "ApiRemoveMemberRequest.requestId");
    return { reason: request.reason, requestId: request.requestId };
  });
}

export function parsePrincipalPermissionSetGrantRequest(
  body: unknown,
): ApiPrincipalPermissionSetGrantRequest {
  return parseRequest("ApiPrincipalPermissionSetGrantRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPrincipalPermissionSetGrantRequest",
      STRICT_API_BODY_KEYS.ApiPrincipalPermissionSetGrantRequest,
    );
    assertNullableString(request.reason, "ApiPrincipalPermissionSetGrantRequest.reason");
    assertNullableString(request.requestId, "ApiPrincipalPermissionSetGrantRequest.requestId");
    return { reason: request.reason, requestId: request.requestId };
  });
}

export function parseRevokeAuthSessionRequest(body: unknown): ApiRevokeAuthSessionRequest {
  return parseRequest("ApiRevokeAuthSessionRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiRevokeAuthSessionRequest",
      STRICT_API_BODY_KEYS.ApiRevokeAuthSessionRequest,
    );
    assertNullableString(request.reason, "ApiRevokeAuthSessionRequest.reason");
    assertNullableString(request.requestId, "ApiRevokeAuthSessionRequest.requestId");
    return { reason: request.reason, requestId: request.requestId };
  });
}
