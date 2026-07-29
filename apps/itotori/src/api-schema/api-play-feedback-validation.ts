import { STRICT_API_BODY_KEYS } from "./api-strict-body-keys.js";
import {
  API_PLAY_FLAG_SEVERITIES,
  ApiPatchIterationDeliveryResponse,
  ApiPlayAddressableUnitResponse,
  ApiPlayDeliveryResponse,
  ApiPlayFlagAnnotationRequest,
  ApiPlayFlagAnnotationResponse,
  ApiPlayTargetEditResponse,
  ApiPlayUnitFeedbackResponse,
} from "./api-play-session-types.js";
import { ApiValidationError } from "./api-project-and-catalog-request-parsers.js";
import {
  asRecord,
  assertPatchIterationOrigin,
  assertStringRecord,
  parseRequest,
} from "./api-request-validation-helpers.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertNullableString,
  assertString,
} from "./api-validation-primitives.js";

export function parsePlayFlagAnnotationRequest(body: unknown): ApiPlayFlagAnnotationRequest {
  return parseRequest("ApiPlayFlagAnnotationRequest", () => {
    const request = asStrictRecord(body, "ApiPlayFlagAnnotationRequest", [
      "note",
      "severity",
      "category",
      "bridgeUnitId",
      "sourceUnitKey",
      "sourceBundleId",
      "sourceRevisionId",
      "sceneId",
      "suggestedEdit",
      "actorUserId",
      "actorDisplayName",
    ]);
    assertString(request.note, "ApiPlayFlagAnnotationRequest.note");
    if (request.note.trim().length === 0) {
      throw new ApiValidationError("ApiPlayFlagAnnotationRequest.note must be non-empty");
    }
    assertEnum(request.severity, API_PLAY_FLAG_SEVERITIES, "ApiPlayFlagAnnotationRequest.severity");
    assertString(request.bridgeUnitId, "ApiPlayFlagAnnotationRequest.bridgeUnitId");
    const bridgeUnitId = request.bridgeUnitId.trim();
    if (bridgeUnitId.length === 0) {
      throw new ApiValidationError("ApiPlayFlagAnnotationRequest.bridgeUnitId must be non-empty");
    }
    const parsed: ApiPlayFlagAnnotationRequest = {
      note: request.note.trim(),
      severity: request.severity,
      bridgeUnitId,
    };
    if (request.category !== undefined) {
      assertString(request.category, "ApiPlayFlagAnnotationRequest.category");
      parsed.category = request.category;
    }
    if (request.sourceUnitKey !== undefined) {
      assertString(request.sourceUnitKey, "ApiPlayFlagAnnotationRequest.sourceUnitKey");
      parsed.sourceUnitKey = request.sourceUnitKey;
    }
    if (request.sourceBundleId !== undefined) {
      assertString(request.sourceBundleId, "ApiPlayFlagAnnotationRequest.sourceBundleId");
      parsed.sourceBundleId = request.sourceBundleId;
    }
    if (request.sourceRevisionId !== undefined) {
      assertString(request.sourceRevisionId, "ApiPlayFlagAnnotationRequest.sourceRevisionId");
      parsed.sourceRevisionId = request.sourceRevisionId;
    }
    if (request.sceneId !== undefined) {
      assertString(request.sceneId, "ApiPlayFlagAnnotationRequest.sceneId");
      parsed.sceneId = request.sceneId;
    }
    if (request.suggestedEdit !== undefined) {
      assertString(request.suggestedEdit, "ApiPlayFlagAnnotationRequest.suggestedEdit");
      parsed.suggestedEdit = request.suggestedEdit;
    }
    if (request.actorUserId !== undefined) {
      assertString(request.actorUserId, "ApiPlayFlagAnnotationRequest.actorUserId");
      parsed.actorUserId = request.actorUserId;
    }
    if (request.actorDisplayName !== undefined) {
      assertString(request.actorDisplayName, "ApiPlayFlagAnnotationRequest.actorDisplayName");
      parsed.actorDisplayName = request.actorDisplayName;
    }
    return parsed;
  });
}

export function assertPlayFlagAnnotationResponse(
  value: unknown,
): asserts value is ApiPlayFlagAnnotationResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayFlagAnnotationResponse",
    STRICT_API_BODY_KEYS.ApiPlayFlagAnnotationResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.flag-annotation.v0",
    "ApiPlayFlagAnnotationResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiPlayFlagAnnotationResponse.projectId");
  assertString(response.localeBranchId, "ApiPlayFlagAnnotationResponse.localeBranchId");
  assertString(response.feedbackReportId, "ApiPlayFlagAnnotationResponse.feedbackReportId");
  assertString(response.feedbackEvidenceId, "ApiPlayFlagAnnotationResponse.feedbackEvidenceId");
  assertEnum(response.severity, API_PLAY_FLAG_SEVERITIES, "ApiPlayFlagAnnotationResponse.severity");
  if (response.category !== null) {
    assertString(response.category, "ApiPlayFlagAnnotationResponse.category");
  }
  assertString(response.note, "ApiPlayFlagAnnotationResponse.note");
  assertString(response.triageLabel, "ApiPlayFlagAnnotationResponse.triageLabel");
  assertString(response.contextStatus, "ApiPlayFlagAnnotationResponse.contextStatus");
  assertString(response.contextCorrectionId, "ApiPlayFlagAnnotationResponse.contextCorrectionId");
  assertBoolean(response.duplicate, "ApiPlayFlagAnnotationResponse.duplicate");
}

export function assertPlayUnitFeedbackResponse(
  value: unknown,
): asserts value is ApiPlayUnitFeedbackResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayUnitFeedbackResponse",
    STRICT_API_BODY_KEYS.ApiPlayUnitFeedbackResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.unit-feedback.v0",
    "ApiPlayUnitFeedbackResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiPlayUnitFeedbackResponse.projectId");
  assertString(response.localeBranchId, "ApiPlayUnitFeedbackResponse.localeBranchId");
  assertString(response.bridgeUnitId, "ApiPlayUnitFeedbackResponse.bridgeUnitId");
  if (!Array.isArray(response.notes)) {
    throw new ApiValidationError("ApiPlayUnitFeedbackResponse.notes must be an array");
  }
  for (const [index, note] of response.notes.entries()) {
    assertPlayUnitFeedbackNote(note, `ApiPlayUnitFeedbackResponse.notes[${index}]`);
  }
}

export function assertPlayAddressableUnitResponse(
  value: unknown,
): asserts value is ApiPlayAddressableUnitResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayAddressableUnitResponse",
    STRICT_API_BODY_KEYS.ApiPlayAddressableUnitResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.addressable-unit.v0",
    "ApiPlayAddressableUnitResponse.schemaVersion",
  );
  assertString(response.projectId, "ApiPlayAddressableUnitResponse.projectId");
  assertString(response.localeBranchId, "ApiPlayAddressableUnitResponse.localeBranchId");
  const unit = asRecord(response.unit, "ApiPlayAddressableUnitResponse.unit");
  assertString(unit.bridgeUnitId, "ApiPlayAddressableUnitResponse.unit.bridgeUnitId");
  if (unit.state === "resolved") {
    assertString(unit.sceneId, "ApiPlayAddressableUnitResponse.unit.sceneId");
    assertString(unit.sourceUnitKey, "ApiPlayAddressableUnitResponse.unit.sourceUnitKey");
    return;
  }
  assertLiteral(unit.state, "unresolvable", "ApiPlayAddressableUnitResponse.unit.state");
  assertEnum(
    unit.reason,
    ["not_imported_in_branch", "scene_coordinate_missing"] as const,
    "ApiPlayAddressableUnitResponse.unit.reason",
  );
}

export function assertPlayUnitFeedbackNote(value: unknown, label: string): void {
  const note = asStrictRecord(value, label, [
    "feedbackReportId",
    "feedbackEvidenceId",
    "bridgeUnitId",
    "sceneId",
    "note",
    "severity",
    "category",
    "triageLabel",
    "contextStatus",
    "contextCorrectionId",
    "reportedAt",
    "duplicate",
  ]);
  assertString(note.feedbackReportId, `${label}.feedbackReportId`);
  assertString(note.feedbackEvidenceId, `${label}.feedbackEvidenceId`);
  assertString(note.bridgeUnitId, `${label}.bridgeUnitId`);
  if (note.sceneId !== null) {
    assertString(note.sceneId, `${label}.sceneId`);
  }
  assertString(note.note, `${label}.note`);
  assertString(note.severity, `${label}.severity`);
  if (note.category !== null) {
    assertString(note.category, `${label}.category`);
  }
  assertString(note.triageLabel, `${label}.triageLabel`);
  assertString(note.contextStatus, `${label}.contextStatus`);
  assertString(note.contextCorrectionId, `${label}.contextCorrectionId`);
  assertString(note.reportedAt, `${label}.reportedAt`);
  assertBoolean(note.duplicate, `${label}.duplicate`);
}

export function assertPlayTargetEditResponse(
  value: unknown,
): asserts value is ApiPlayTargetEditResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayTargetEditResponse",
    STRICT_API_BODY_KEYS.ApiPlayTargetEditResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.target-edit.v0",
    "ApiPlayTargetEditResponse.schemaVersion",
  );
  assertString(response.resultRevisionId, "ApiPlayTargetEditResponse.resultRevisionId");
  assertString(response.patchVersionId, "ApiPlayTargetEditResponse.patchVersionId");
  assertString(response.runId, "ApiPlayTargetEditResponse.runId");
  assertString(response.parentPatchVersionId, "ApiPlayTargetEditResponse.parentPatchVersionId");
  assertString(response.bridgeUnitId, "ApiPlayTargetEditResponse.bridgeUnitId");
  assertString(response.targetBody, "ApiPlayTargetEditResponse.targetBody");
  assertLiteral(response.status, "playable", "ApiPlayTargetEditResponse.status");
  assertDateLike(response.selectedAt, "ApiPlayTargetEditResponse.selectedAt");
  assertBoolean(response.idempotentReplay, "ApiPlayTargetEditResponse.idempotentReplay");
}

export function assertPlayDeliveryResponse(
  value: unknown,
): asserts value is ApiPlayDeliveryResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayDeliveryResponse",
    STRICT_API_BODY_KEYS.ApiPlayDeliveryResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.delivery.v0",
    "ApiPlayDeliveryResponse.schemaVersion",
  );
  assertString(response.patchVersionId, "ApiPlayDeliveryResponse.patchVersionId");
  assertString(response.runId, "ApiPlayDeliveryResponse.runId");
  assertNullableString(
    response.parentPatchVersionId,
    "ApiPlayDeliveryResponse.parentPatchVersionId",
  );
  assertString(response.status, "ApiPlayDeliveryResponse.status");
  assertDateLike(response.selectedAt, "ApiPlayDeliveryResponse.selectedAt");
  assertStringRecord(response.artifactHashes, "ApiPlayDeliveryResponse.artifactHashes");
  assertString(response.downloadUrl, "ApiPlayDeliveryResponse.downloadUrl");
  assertPlayDeliveryUnits(response.units, "ApiPlayDeliveryResponse.units");
}

export function assertPlayDeliveryUnits(value: unknown, label: string): void {
  const units = asArray(value, label);
  let previousOrdinal = -1;
  for (const [index, value] of units.entries()) {
    const unit = asStrictRecord(
      value,
      `${label}[${index}]`,
      STRICT_API_BODY_KEYS.ApiPlayDeliveryUnit,
    );
    assertString(unit.bridgeUnitId, `${label}[${index}].bridgeUnitId`);
    assertNonNegativeInteger(unit.unitOrdinal, `${label}[${index}].unitOrdinal`);
    if (unit.unitOrdinal <= previousOrdinal) {
      throw new Error(`${label} must be strictly ordered by unitOrdinal`);
    }
    previousOrdinal = unit.unitOrdinal;
    assertString(unit.targetBody, `${label}[${index}].targetBody`);
  }
}

export function assertPatchIterationDeliveryResponse(
  value: unknown,
): asserts value is ApiPatchIterationDeliveryResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationDeliveryResponse",
    STRICT_API_BODY_KEYS.ApiPatchIterationDeliveryResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.delivery.v0",
    "ApiPatchIterationDeliveryResponse.schemaVersion",
  );
  assertString(response.patchVersionId, "ApiPatchIterationDeliveryResponse.patchVersionId");
  assertString(response.runId, "ApiPatchIterationDeliveryResponse.runId");
  assertNullableString(
    response.parentPatchVersionId,
    "ApiPatchIterationDeliveryResponse.parentPatchVersionId",
  );
  assertPatchIterationOrigin(response.origin, "ApiPatchIterationDeliveryResponse.origin");
  assertLiteral(response.status, "playable", "ApiPatchIterationDeliveryResponse.status");
  assertDateLike(response.playableAt, "ApiPatchIterationDeliveryResponse.playableAt");
  assertStringRecord(response.artifactHashes, "ApiPatchIterationDeliveryResponse.artifactHashes");
  assertString(response.downloadUrl, "ApiPatchIterationDeliveryResponse.downloadUrl");
  assertPlayDeliveryUnits(response.units, "ApiPatchIterationDeliveryResponse.units");
}
