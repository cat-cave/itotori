import { STRICT_API_BODY_KEYS } from "./api-schema.js";
import { bool, nullableStr, num, object, str } from "./api-contract-schema.js";
import type { ComponentBuilders } from "./api-contract-components.js";

export const patchComponentBuilders: ComponentBuilders = {
  ApiPatchIterationDeliveryResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationDeliveryResponse,
      properties: {
        patchVersionId: str,
        runId: str,
        parentPatchVersionId: nullableStr,
        origin: { enum: ["run_finalizer", "play_tester_edit", "refinement_run"] },
        status: { const: "playable" },
        playableAt: str,
        artifactHashes: { type: "object", additionalProperties: str },
        downloadUrl: str,
        units: { type: "array", items: ref("ApiPlayDeliveryUnit") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.delivery.v0",
    }),
  ApiPatchIterationQaCallout: () =>
    object({
      required: [
        "journalFindingId",
        "bridgeUnitId",
        "severity",
        "category",
        "note",
        "confidence",
        "contested",
        "informational",
      ],
      properties: { contested: bool, informational: { const: true } },
      additionalProperties: false,
    }),
  ApiPatchIterationUnit: () =>
    object({
      required: [
        "bridgeUnitId",
        "sourceRunId",
        "journalOutcomeId",
        "resultRevisionId",
        "targetBody",
        "memberOrigin",
        "reusedFromPatchVersionId",
        "unitOrdinal",
      ],
      properties: {
        reusedFromPatchVersionId: nullableStr,
        memberOrigin: {
          enum: ["run_written_outcome", "reused_from_base", "play_tester_edit"],
        },
        unitOrdinal: num,
      },
      additionalProperties: false,
    }),
  ApiPatchIterationPatch: (ref) =>
    object({
      required: [
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
      ],
      properties: {
        parentPatchVersionId: nullableStr,
        origin: { enum: ["run_finalizer", "play_tester_edit", "refinement_run"] },
        playableAt: nullableStr,
        selectedAt: nullableStr,
        artifactHashes: { type: "object", additionalProperties: str },
        units: { type: "array", items: ref("ApiPatchIterationUnit") },
        qaCallouts: { type: "array", items: ref("ApiPatchIterationQaCallout") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationVersion: () =>
    object({
      required: [
        "patchVersionId",
        "runId",
        "parentPatchVersionId",
        "origin",
        "status",
        "playableAt",
        "selectedAt",
        "artifactHashes",
        "basePatchVersionId",
      ],
      properties: {
        parentPatchVersionId: nullableStr,
        origin: { enum: ["run_finalizer", "play_tester_edit", "refinement_run"] },
        playableAt: nullableStr,
        selectedAt: nullableStr,
        artifactHashes: { type: "object", additionalProperties: str },
        basePatchVersionId: nullableStr,
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackEvent: () =>
    object({
      required: [
        "feedbackEventId",
        "feedbackBatchId",
        "observedPatchVersionId",
        "playSessionId",
        "actorUserId",
        "eventKind",
        "body",
        "metadata",
        "resultRevisionId",
        "contextArtifactId",
        "contextEntryVersionId",
        "affectedBridgeUnitIds",
        "createdAt",
      ],
      properties: {
        playSessionId: nullableStr,
        eventKind: { enum: ["result_edit", "comment", "added_context", "wiki_edit"] },
        body: nullableStr,
        metadata: { type: "object", additionalProperties: true },
        resultRevisionId: nullableStr,
        contextArtifactId: nullableStr,
        contextEntryVersionId: nullableStr,
        affectedBridgeUnitIds: { type: "array", items: str },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackBatch: (ref) =>
    object({
      required: [
        "feedbackBatchId",
        "observedPatchVersionId",
        "actorUserId",
        "selectionKind",
        "label",
        "createdAt",
        "updatedAt",
        "events",
      ],
      properties: {
        selectionKind: { enum: ["individual", "batch"] },
        label: nullableStr,
        events: { type: "array", items: ref("ApiPatchIterationFeedbackEvent") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackInbox: (ref) =>
    object({
      required: ["observedPatchVersionId", "batches"],
      properties: { batches: { type: "array", items: ref("ApiPatchIterationFeedbackBatch") } },
      additionalProperties: false,
    }),
  ApiPatchIterationSession: (ref) =>
    object({
      required: [
        "playSessionId",
        "observedPatchVersionId",
        "actorUserId",
        "status",
        "startedAt",
        "endedAt",
        "qaCallouts",
      ],
      properties: {
        status: { enum: ["active", "completed", "abandoned"] },
        endedAt: nullableStr,
        qaCallouts: { type: "array", items: ref("ApiPatchIterationQaCallout") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationRefinementMember: () =>
    object({
      required: [
        "bridgeUnitId",
        "strategy",
        "basePatchVersionId",
        "baseSourceRunId",
        "baseJournalOutcomeId",
        "baseResultRevisionId",
      ],
      properties: {
        strategy: { enum: ["reuse", "redraft", "new_scope"] },
        basePatchVersionId: nullableStr,
        baseSourceRunId: nullableStr,
        baseJournalOutcomeId: nullableStr,
        baseResultRevisionId: nullableStr,
      },
      additionalProperties: false,
    }),
  ApiPatchIterationRefinement: (ref) =>
    object({
      required: ["runId", "basePatchVersionId", "feedbackBatchIds", "wikiHeads", "members"],
      properties: {
        feedbackBatchIds: { type: "array", items: str },
        wikiHeads: {
          type: "array",
          items: object({
            required: ["contextArtifactId", "contextEntryVersionId"],
            additionalProperties: false,
          }),
        },
        members: { type: "array", items: ref("ApiPatchIterationRefinementMember") },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationVersionsResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationVersionsResponse,
      properties: { versions: { type: "array", items: ref("ApiPatchIterationVersion") } },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.versions.v0",
    }),
  ApiPatchIterationSurfaceResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationSurfaceResponse,
      properties: {
        patch: ref("ApiPatchIterationPatch"),
        versions: { type: "array", items: ref("ApiPatchIterationVersion") },
        feedback: ref("ApiPatchIterationFeedbackInbox"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.surface.v0",
    }),
  ApiPatchIterationPlayRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationPlayRequest,
      properties: {
        adapterId: { type: "string", minLength: 1 },
        operation: { type: "string", minLength: 1 },
        artifactRoot: str,
        output: str,
        launchDescriptor: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationPlayResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationPlayResponse,
      properties: {
        receipt: {
          oneOf: [
            object({
              required: ["adapterId", "operation", "adapterReceipt"],
              properties: {
                adapterId: { const: "reallive" },
                operation: { const: "replay-validate" },
                adapterReceipt: object({
                  required: ["replay", "scene", "observedTextLineCount"],
                  properties: {
                    replay: { const: "observed" },
                    scene: { type: "integer", minimum: 0 },
                    observedTextLineCount: { type: "integer", minimum: 0 },
                  },
                  additionalProperties: false,
                }),
              },
              additionalProperties: false,
            }),
          ],
        },
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.play.v0",
    }),
  ApiPatchIterationFeedbackBatchRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchRequest,
      properties: { feedbackBatchId: str, label: str },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackBatchResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackBatchResponse,
      properties: { batch: ref("ApiPatchIterationFeedbackBatch") },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.feedback-batch.v0",
    }),
  ApiPatchIterationContextFeedback: () => ({
    oneOf: [
      object({
        required: ["operation", "kind", "title", "body", "reason", "affectedBridgeUnitIds"],
        properties: {
          operation: { const: "add" },
          kind: { enum: ["note", "glossary", "style"] },
          title: str,
          body: str,
          reason: str,
          affectedBridgeUnitIds: { type: "array", items: str },
        },
        additionalProperties: false,
      }),
      object({
        required: ["operation", "contextArtifactId", "body", "reason"],
        properties: {
          operation: { const: "edit" },
          contextArtifactId: str,
          body: str,
          reason: str,
          title: str,
          affectedBridgeUnitIds: { type: "array", items: str },
        },
        additionalProperties: false,
      }),
    ],
  }),
  ApiPatchIterationFeedbackRequest: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackRequest,
      properties: {
        feedbackBatchId: str,
        playSessionId: str,
        eventKind: { enum: ["result_edit", "comment", "added_context", "wiki_edit"] },
        body: str,
        metadata: { type: "object", additionalProperties: true },
        targetBody: str,
        resultRevisionId: str,
        contextArtifactId: str,
        contextEntryVersionId: str,
        contextFeedback: ref("ApiPatchIterationContextFeedback"),
        affectedBridgeUnitIds: { type: "array", items: str },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationFeedbackResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackResponse,
      properties: { feedback: ref("ApiPatchIterationFeedbackEvent") },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.feedback.v0",
    }),
  ApiPatchIterationRefineRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationRefineRequest,
      properties: {
        feedbackBatchIds: { type: "array", items: str },
        feedbackEventIds: { type: "array", items: str },
        scopeUnitIds: { type: "array", items: str },
        targetBodiesByUnit: { type: "object", additionalProperties: str },
        wikiHeads: {
          type: "array",
          items: object({
            required: ["contextArtifactId", "contextEntryVersionId"],
            additionalProperties: false,
          }),
        },
      },
      additionalProperties: false,
    }),
  ApiPatchIterationRefineResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPatchIterationRefineResponse,
      properties: {
        refinement: ref("ApiPatchIterationRefinement"),
        patch: ref("ApiPatchIterationPatch"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.patch-iteration.refine.v0",
    }),
};
