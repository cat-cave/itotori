import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import {
  ApiPatchIterationFeedbackBatchResponse,
  ApiPatchIterationFeedbackResponse,
  ApiPatchIterationPlayResponse,
  ApiPatchIterationRefineResponse,
  ApiPatchIterationSurfaceResponse,
  ApiPatchIterationVersionsResponse,
} from "./api-domain-06.js";
import {
  asRecord,
  assertPatchIterationFeedbackBatch,
  assertPatchIterationFeedbackEvent,
  assertPatchIterationOrigin,
  assertPatchIterationRefinement,
  assertStringRecord,
} from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertBoolean,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertNullableDateLike,
  assertNullableString,
  assertString,
} from "./api-domain-29.js";

export function assertPatchIterationVersionsResponse(
  value: unknown,
): asserts value is ApiPatchIterationVersionsResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationVersionsResponse",
    STRICT_API_BODY_KEYS.ApiPatchIterationVersionsResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.versions.v0",
    "ApiPatchIterationVersionsResponse.schemaVersion",
  );
  const versions = asArray(response.versions, "ApiPatchIterationVersionsResponse.versions");
  for (const [index, version] of versions.entries()) {
    assertPatchIterationVersion(version, `ApiPatchIterationVersionsResponse.versions[${index}]`);
  }
}

export function assertPatchIterationSurfaceResponse(
  value: unknown,
): asserts value is ApiPatchIterationSurfaceResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationSurfaceResponse",
    STRICT_API_BODY_KEYS.ApiPatchIterationSurfaceResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.surface.v0",
    "ApiPatchIterationSurfaceResponse.schemaVersion",
  );
  assertPatchIterationPatch(response.patch, "ApiPatchIterationSurfaceResponse.patch");
  const versions = asArray(response.versions, "ApiPatchIterationSurfaceResponse.versions");
  for (const [index, version] of versions.entries()) {
    assertPatchIterationVersion(version, `ApiPatchIterationSurfaceResponse.versions[${index}]`);
  }
  assertPatchIterationFeedbackInbox(response.feedback, "ApiPatchIterationSurfaceResponse.feedback");
}

export function assertPatchIterationPlayResponse(
  value: unknown,
): asserts value is ApiPatchIterationPlayResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationPlayResponse",
    STRICT_API_BODY_KEYS.ApiPatchIterationPlayResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.play.v0",
    "ApiPatchIterationPlayResponse.schemaVersion",
  );
  const receipt = asStrictRecord(response.receipt, "ApiPatchIterationPlayResponse.receipt", [
    "adapterId",
    "operation",
    "adapterReceipt",
  ]);
  assertString(receipt.adapterId, "ApiPatchIterationPlayResponse.receipt.adapterId");
  assertString(receipt.operation, "ApiPatchIterationPlayResponse.receipt.operation");
  const adapterReceipt = asRecord(
    receipt.adapterReceipt,
    "ApiPatchIterationPlayResponse.receipt.adapterReceipt",
  );
  assertString(
    adapterReceipt.replay,
    "ApiPatchIterationPlayResponse.receipt.adapterReceipt.replay",
  );
  assertNonNegativeInteger(
    adapterReceipt.scene,
    "ApiPatchIterationPlayResponse.receipt.adapterReceipt.scene",
  );
  assertNonNegativeInteger(
    adapterReceipt.observedTextLineCount,
    "ApiPatchIterationPlayResponse.receipt.adapterReceipt.observedTextLineCount",
  );
}

export function assertPatchIterationFeedbackBatchResponse(
  value: unknown,
): asserts value is ApiPatchIterationFeedbackBatchResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationFeedbackBatchResponse",
    STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.feedback-batch.v0",
    "ApiPatchIterationFeedbackBatchResponse.schemaVersion",
  );
  assertPatchIterationFeedbackBatch(
    response.batch,
    "ApiPatchIterationFeedbackBatchResponse.batch",
    true,
  );
}

export function assertPatchIterationFeedbackResponse(
  value: unknown,
): asserts value is ApiPatchIterationFeedbackResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationFeedbackResponse",
    STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.feedback.v0",
    "ApiPatchIterationFeedbackResponse.schemaVersion",
  );
  assertPatchIterationFeedbackEvent(
    response.feedback,
    "ApiPatchIterationFeedbackResponse.feedback",
  );
}

export function assertPatchIterationRefineResponse(
  value: unknown,
): asserts value is ApiPatchIterationRefineResponse {
  const response = asStrictRecord(
    value,
    "ApiPatchIterationRefineResponse",
    STRICT_API_BODY_KEYS.ApiPatchIterationRefineResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.patch-iteration.refine.v0",
    "ApiPatchIterationRefineResponse.schemaVersion",
  );
  assertPatchIterationRefinement(response.refinement, "ApiPatchIterationRefineResponse.refinement");
  assertPatchIterationPatch(response.patch, "ApiPatchIterationRefineResponse.patch");
}

export function assertPatchIterationPatch(value: unknown, label: string): void {
  const patch = asStrictRecord(value, label, [
    "patchVersionId",
    "runId",
    "parentPatchVersionId",
    "origin",
    "status",
    "playableAt",
    "selectedAt",
    "artifactHashes",
    "units",
    "qaCallouts",
  ]);
  assertString(patch.patchVersionId, `${label}.patchVersionId`);
  assertString(patch.runId, `${label}.runId`);
  assertNullableString(patch.parentPatchVersionId, `${label}.parentPatchVersionId`);
  assertPatchIterationOrigin(patch.origin, `${label}.origin`);
  assertString(patch.status, `${label}.status`);
  assertNullableDateLike(patch.playableAt, `${label}.playableAt`);
  assertNullableDateLike(patch.selectedAt, `${label}.selectedAt`);
  assertStringRecord(patch.artifactHashes, `${label}.artifactHashes`);
  const units = asArray(patch.units, `${label}.units`);
  let priorOrdinal = -1;
  for (const [index, unit] of units.entries()) {
    assertPatchIterationUnit(unit, `${label}.units[${index}]`);
    const unitRecord = unit as { unitOrdinal: number };
    if (unitRecord.unitOrdinal <= priorOrdinal) {
      throw new Error(`${label}.units must be ordered by unitOrdinal`);
    }
    priorOrdinal = unitRecord.unitOrdinal;
  }
  const callouts = asArray(patch.qaCallouts, `${label}.qaCallouts`);
  for (const [index, callout] of callouts.entries()) {
    assertPatchIterationQaCallout(callout, `${label}.qaCallouts[${index}]`);
  }
}

export function assertPatchIterationVersion(value: unknown, label: string): void {
  const version = asStrictRecord(value, label, [
    "patchVersionId",
    "runId",
    "parentPatchVersionId",
    "origin",
    "status",
    "playableAt",
    "selectedAt",
    "artifactHashes",
    "basePatchVersionId",
  ]);
  assertString(version.patchVersionId, `${label}.patchVersionId`);
  assertString(version.runId, `${label}.runId`);
  assertNullableString(version.parentPatchVersionId, `${label}.parentPatchVersionId`);
  assertPatchIterationOrigin(version.origin, `${label}.origin`);
  assertString(version.status, `${label}.status`);
  assertNullableDateLike(version.playableAt, `${label}.playableAt`);
  assertNullableDateLike(version.selectedAt, `${label}.selectedAt`);
  assertStringRecord(version.artifactHashes, `${label}.artifactHashes`);
  assertNullableString(version.basePatchVersionId, `${label}.basePatchVersionId`);
}

export function assertPatchIterationUnit(value: unknown, label: string): void {
  const unit = asStrictRecord(value, label, [
    "bridgeUnitId",
    "sourceRunId",
    "journalOutcomeId",
    "resultRevisionId",
    "targetBody",
    "memberOrigin",
    "reusedFromPatchVersionId",
    "unitOrdinal",
  ]);
  assertString(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(unit.sourceRunId, `${label}.sourceRunId`);
  assertString(unit.journalOutcomeId, `${label}.journalOutcomeId`);
  assertString(unit.resultRevisionId, `${label}.resultRevisionId`);
  assertString(unit.targetBody, `${label}.targetBody`);
  assertEnum(
    unit.memberOrigin,
    ["run_written_outcome", "reused_from_base", "play_tester_edit"] as const,
    `${label}.memberOrigin`,
  );
  assertNullableString(unit.reusedFromPatchVersionId, `${label}.reusedFromPatchVersionId`);
  assertNonNegativeInteger(unit.unitOrdinal, `${label}.unitOrdinal`);
}

export function assertPatchIterationQaCallout(value: unknown, label: string): void {
  const callout = asStrictRecord(value, label, [
    "journalFindingId",
    "bridgeUnitId",
    "severity",
    "category",
    "note",
    "confidence",
    "contested",
    "informational",
  ]);
  assertString(callout.journalFindingId, `${label}.journalFindingId`);
  assertString(callout.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(callout.severity, `${label}.severity`);
  assertString(callout.category, `${label}.category`);
  assertString(callout.note, `${label}.note`);
  assertString(callout.confidence, `${label}.confidence`);
  assertBoolean(callout.contested, `${label}.contested`);
  assertBoolean(callout.informational, `${label}.informational`);
  if (callout.informational !== true) {
    throw new Error(`${label}.informational must be true`);
  }
}

export function assertPatchIterationFeedbackInbox(value: unknown, label: string): void {
  const inbox = asStrictRecord(value, label, ["observedPatchVersionId", "batches"]);
  assertString(inbox.observedPatchVersionId, `${label}.observedPatchVersionId`);
  const batches = asArray(inbox.batches, `${label}.batches`);
  for (const [index, batch] of batches.entries()) {
    assertPatchIterationFeedbackBatch(batch, `${label}.batches[${index}]`, true);
  }
}
