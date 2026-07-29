import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import { ApiAuthSessionRecord, ApiMemberRecord } from "./api-domain-04.js";
import {
  ApiLaunchPassRequest,
  ApiLaunchPassResponse,
  ApiPermissionSetRecord,
  ApiPlayTargetEditRequest,
} from "./api-domain-05.js";
import {
  ApiPatchIterationContextFeedback,
  ApiPatchIterationFeedbackBatchRequest,
  ApiPatchIterationFeedbackRequest,
  ApiPatchIterationPlayRequest,
} from "./api-domain-06.js";
import { ApiValidationError } from "./api-domain-07.js";
import { parseNonBlankApiString, parseNonBlankApiStringArray } from "./api-domain-25.js";
import { asRecord, parseRequest } from "./api-domain-28.js";
import {
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNull,
  assertNullableDateLike,
  assertNullableString,
  assertString,
  assertStringArray,
  optionalString,
} from "./api-domain-29.js";

export function assertMemberRecord(
  value: unknown,
  label: string,
): asserts value is ApiMemberRecord {
  const member = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiMemberRecord);
  assertString(member.membershipId, `${label}.membershipId`);
  assertString(member.accountId, `${label}.accountId`);
  assertString(member.userId, `${label}.userId`);
  assertString(member.principalId, `${label}.principalId`);
  assertNullableString(member.email, `${label}.email`);
  assertString(member.displayName, `${label}.displayName`);
  assertStringArray(member.permissionSetIds, `${label}.permissionSetIds`);
  assertDateLike(member.createdAt, `${label}.createdAt`);
}

export function assertPermissionSetRecord(
  value: unknown,
  label: string,
): asserts value is ApiPermissionSetRecord {
  const permissionSet = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiPermissionSetRecord);
  assertString(permissionSet.permissionSetId, `${label}.permissionSetId`);
  assertString(permissionSet.accountId, `${label}.accountId`);
  assertString(permissionSet.name, `${label}.name`);
  assertStringArray(permissionSet.permissions, `${label}.permissions`);
}

export function assertAuthSessionRecord(
  value: unknown,
  label: string,
): asserts value is ApiAuthSessionRecord {
  const session = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiAuthSessionRecord);
  assertString(session.sessionId, `${label}.sessionId`);
  assertString(session.principalId, `${label}.principalId`);
  assertDateLike(session.createdAt, `${label}.createdAt`);
  assertDateLike(session.expiresAt, `${label}.expiresAt`);
  assertNullableDateLike(session.revokedAt, `${label}.revokedAt`);
  assertBoolean(session.isActive, `${label}.isActive`);
  assertNullableString(session.deviceLabel, `${label}.deviceLabel`);
  assertNullableString(session.userAgent, `${label}.userAgent`);
  assertNullableString(session.ipAddress, `${label}.ipAddress`);
}

// ovw-launch-pass-action — assert the launch-pass response envelope. The
// schemaVersion literal pins the wire shape; `outcome` pins to started/refused.
// A `started` outcome MUST carry a journal run identity + start timestamp and
// no refusal; a `refused` outcome MUST carry a non-empty refusal message and
// null run/timestamp — so a refused launch can NEVER masquerade as a started
// one (or as a silent 200 with empty fields).
export function assertLaunchPassResponse(value: unknown): asserts value is ApiLaunchPassResponse {
  const response = asStrictRecord(
    value,
    "ApiLaunchPassResponse",
    STRICT_API_BODY_KEYS.ApiLaunchPassResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.projects.launch-pass.v1",
    "ApiLaunchPassResponse.schemaVersion",
  );
  assertEnum(response.outcome, ["started", "refused"] as const, "ApiLaunchPassResponse.outcome");
  if (response.outcome === "started") {
    assertString(response.journalRunId, "ApiLaunchPassResponse.journalRunId");
    assertString(response.startedAt, "ApiLaunchPassResponse.startedAt");
    assertNull(response.refusalMessage, "ApiLaunchPassResponse.refusalMessage");
    return;
  }
  assertNull(response.journalRunId, "ApiLaunchPassResponse.journalRunId");
  assertNull(response.startedAt, "ApiLaunchPassResponse.startedAt");
  assertString(response.refusalMessage, "ApiLaunchPassResponse.refusalMessage");
}

/**
 * ovw-launch-pass-action — parse + validate the launch-pass request body. The
 * locale branch is required (the project id lives on the URL path); the server
 * additionally verifies the branch against the project's ownership set before
 * the driver runs. Cancellation fields are rejected: this endpoint launches
 * work and does not expose a worker-abort capability.
 */
export function parseLaunchPassRequest(body: unknown): ApiLaunchPassRequest {
  return parseRequest("ApiLaunchPassRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiLaunchPassRequest",
      STRICT_API_BODY_KEYS.ApiLaunchPassRequest,
    );
    assertString(request.localeBranchId, "ApiLaunchPassRequest.localeBranchId");
    return { localeBranchId: request.localeBranchId };
  });
}

/**
 * p0-result-revision — parse the deliberately narrow play-tester input. The
 * parent patch lives in the path; only the unit identity and replacement
 * target body may cross the public boundary. Strictness rejects actor ids,
 * artifact/file paths, source text, and every other accidental escape hatch.
 */
export function parsePlayTargetEditRequest(body: unknown): ApiPlayTargetEditRequest {
  return parseRequest("ApiPlayTargetEditRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPlayTargetEditRequest",
      STRICT_API_BODY_KEYS.ApiPlayTargetEditRequest,
    );
    assertString(request.bridgeUnitId, "ApiPlayTargetEditRequest.bridgeUnitId");
    assertString(request.targetBody, "ApiPlayTargetEditRequest.targetBody");
    const bridgeUnitId = request.bridgeUnitId.trim();
    if (bridgeUnitId.length === 0) {
      throw new ApiValidationError("ApiPlayTargetEditRequest.bridgeUnitId must be non-empty");
    }
    if (request.targetBody.trim().length === 0) {
      throw new ApiValidationError("ApiPlayTargetEditRequest.targetBody must be non-blank");
    }
    return { bridgeUnitId, targetBody: request.targetBody };
  });
}

/** Node 11 request parsers keep patch identity in the URL and freeze only typed inputs. */
export function parsePatchIterationPlayRequest(body: unknown): ApiPatchIterationPlayRequest {
  return parseRequest("ApiPatchIterationPlayRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationPlayRequest",
      STRICT_API_BODY_KEYS.ApiPatchIterationPlayRequest,
    );
    assertString(request.adapterId, "ApiPatchIterationPlayRequest.adapterId");
    assertString(request.operation, "ApiPatchIterationPlayRequest.operation");
    const artifactRoot = optionalString(
      request.artifactRoot,
      "ApiPatchIterationPlayRequest.artifactRoot",
    );
    const output = optionalString(request.output, "ApiPatchIterationPlayRequest.output");
    return {
      adapterId: request.adapterId,
      operation: request.operation,
      ...(artifactRoot === undefined ? {} : { artifactRoot }),
      ...(output === undefined ? {} : { output }),
      launchDescriptor: { ...asRecord(request.launchDescriptor, "launchDescriptor") },
    };
  });
}

export function parsePatchIterationFeedbackBatchRequest(
  body: unknown,
): ApiPatchIterationFeedbackBatchRequest {
  return parseRequest("ApiPatchIterationFeedbackBatchRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationFeedbackBatchRequest",
      STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchRequest,
    );
    return {
      ...(request.feedbackBatchId === undefined
        ? {}
        : { feedbackBatchId: parseNonBlankApiString(request.feedbackBatchId, "feedbackBatchId") }),
      ...(request.label === undefined
        ? {}
        : { label: parseNonBlankApiString(request.label, "label") }),
    };
  });
}

export const apiPatchIterationFeedbackEventKinds = [
  "result_edit",
  "comment",
  "added_context",
  "wiki_edit",
] as const satisfies readonly ApiPatchIterationFeedbackRequest["eventKind"][];

export const apiPatchIterationContextFeedbackOperations = [
  "add",
  "edit",
] as const satisfies readonly ApiPatchIterationContextFeedback["operation"][];

export function parsePatchIterationContextFeedback(
  value: unknown,
): ApiPatchIterationContextFeedback {
  const contextFeedback = asRecord(value, "contextFeedback");
  assertEnum(
    contextFeedback.operation,
    apiPatchIterationContextFeedbackOperations,
    "contextFeedback.operation",
  );
  if (contextFeedback.operation === "add") {
    const add = asStrictRecord(value, "contextFeedback", [
      "operation",
      "kind",
      "title",
      "body",
      "reason",
      "affectedBridgeUnitIds",
    ]);
    assertEnum(add.kind, ["note", "glossary", "style"] as const, "contextFeedback.kind");
    const affectedBridgeUnitIds = parseNonBlankApiStringArray(
      add.affectedBridgeUnitIds,
      "contextFeedback.affectedBridgeUnitIds",
    );
    if (affectedBridgeUnitIds.length === 0) {
      throw new ApiValidationError(
        "contextFeedback.affectedBridgeUnitIds must contain at least one unit",
      );
    }
    return {
      operation: "add",
      kind: add.kind,
      title: parseNonBlankApiString(add.title, "contextFeedback.title"),
      body: parseNonBlankApiString(add.body, "contextFeedback.body"),
      reason: parseNonBlankApiString(add.reason, "contextFeedback.reason"),
      affectedBridgeUnitIds,
    };
  }

  const edit = asStrictRecord(value, "contextFeedback", [
    "operation",
    "contextArtifactId",
    "body",
    "reason",
    "title",
    "affectedBridgeUnitIds",
  ]);
  const response: Extract<ApiPatchIterationContextFeedback, { operation: "edit" }> = {
    operation: "edit",
    contextArtifactId: parseNonBlankApiString(
      edit.contextArtifactId,
      "contextFeedback.contextArtifactId",
    ),
    body: parseNonBlankApiString(edit.body, "contextFeedback.body"),
    reason: parseNonBlankApiString(edit.reason, "contextFeedback.reason"),
  };
  if (edit.title !== undefined) {
    response.title = parseNonBlankApiString(edit.title, "contextFeedback.title");
  }
  if (edit.affectedBridgeUnitIds !== undefined) {
    response.affectedBridgeUnitIds = parseNonBlankApiStringArray(
      edit.affectedBridgeUnitIds,
      "contextFeedback.affectedBridgeUnitIds",
    );
  }
  return response;
}
