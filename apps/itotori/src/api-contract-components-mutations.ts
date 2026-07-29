import { STRICT_API_BODY_KEYS } from "./api-schema.js";
import { extractRequestVariants, extractResponseVariants } from "./api-contract-components-base.js";
import { arr, bool, nullableStr, num, obj, object, str } from "./api-contract-schema.js";
import type { ComponentBuilders } from "./api-contract-components.js";

export const mutationComponentBuilders: ComponentBuilders = {
  ApiProjectDecodeExtractResponse: () => ({ oneOf: extractResponseVariants() }),
  ApiProjectImportResponse: () =>
    object({
      required: ["project", "status"],
      properties: { project: obj, status: obj },
      additionalProperties: true,
    }),
  ApiDraftBranchResponse: () =>
    object({
      required: ["outcome", "project", "status", "refusalMessage"],
      properties: {
        outcome: { enum: ["drafted", "refused"] },
        project: { oneOf: [obj, { type: "null" }] },
        status: { oneOf: [obj, { type: "null" }] },
        refusalMessage: { oneOf: [str, { type: "null" }] },
      },
      additionalProperties: true,
    }),
  ApiRecordFindingResponse: () =>
    object({
      required: ["findingId", "status"],
      properties: { findingId: str, status: { enum: ["open", "resolved", "superseded"] } },
      additionalProperties: true,
    }),
  ApiRecordBenchmarkResponse: () =>
    object({
      required: ["benchmarkRunId", "artifactId", "status", "systemCount", "findingCount"],
      properties: {
        benchmarkRunId: str,
        artifactId: str,
        status: { enum: ["passed", "failed", "partial"] },
        systemCount: num,
        findingCount: num,
      },
      additionalProperties: true,
    }),
  ApiRuntimeEvidenceResponse: () =>
    object({
      required: [
        "status",
        "bridgeId",
        "localeBranchId",
        "patchResultId",
        "runtimeReportId",
        "dashboard",
      ],
      properties: {
        status: { enum: ["hello_world_passed", "hello_world_failed"] },
        bridgeId: str,
        localeBranchId: str,
        patchResultId: str,
        runtimeReportId: str,
        patchExportId: str,
        dashboard: obj,
      },
      additionalProperties: true,
    }),

  // Request bodies ---------------------------------------------------------
  ApiProjectDecodeExtractRequest: () => ({ oneOf: extractRequestVariants() }),
  ApiProjectImportRequest: () =>
    object({
      required: ["bridge"],
      properties: { bridge: obj, bootstrapSelection: obj },
      additionalProperties: true,
    }),
  ApiDraftBranchRequest: () =>
    object({
      required: ["project", "targetLocale"],
      properties: { project: obj, targetLocale: str },
      additionalProperties: true,
    }),
  ApiRecordFindingRequest: () =>
    object({
      required: ["finding"],
      properties: {
        finding: obj,
        localeBranchId: str,
        status: { enum: ["open", "resolved", "superseded"] },
      },
      additionalProperties: true,
    }),
  ApiRecordBenchmarkRequest: () =>
    object({
      required: ["benchmarkReport"],
      properties: { benchmarkReport: obj },
      additionalProperties: true,
    }),
  ApiRuntimeEvidenceRequest: () =>
    object({
      required: ["project", "runtimeReport"],
      properties: { project: obj, runtimeReport: obj },
      additionalProperties: true,
    }),
  // Launch-pass (ovw-launch-pass-action) ----------------------------------
  ApiLaunchPassRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiLaunchPassRequest,
      properties: { localeBranchId: str },
      additionalProperties: false,
    }),
  ApiLaunchPassResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiLaunchPassResponse,
      properties: { outcome: { enum: ["started", "refused"] } },
      additionalProperties: false,
      schemaVersion: "itotori.projects.launch-pass.v1",
    }),

  // play-routemap-ui — route/choice tree envelope -------------------------
  ApiPlayRouteMapNode: () =>
    object({
      required: [
        "routeKey",
        "routeMapId",
        "label",
        "summary",
        "col",
        "row",
        "state",
        "coverage",
        "issues",
      ],
      properties: {
        routeKey: str,
        routeMapId: str,
        label: str,
        summary: str,
        col: num,
        row: num,
        state: { enum: ["fresh", "stale"] },
        coverage: { enum: ["fresh", "stale"] },
        issues: num,
      },
      additionalProperties: false,
    }),
  ApiPlayRouteMapEdge: () =>
    object({
      required: ["fromRouteKey", "toRouteKey", "choiceKey", "choiceKind", "label"],
      properties: {
        fromRouteKey: str,
        toRouteKey: str,
        choiceKey: str,
        choiceKind: str,
        label: str,
      },
      additionalProperties: false,
    }),
  ApiPlayRouteMapCounts: () =>
    object({
      required: ["fresh", "stale", "total", "choiceCount"],
      properties: {
        fresh: num,
        stale: num,
        total: num,
        choiceCount: num,
      },
      additionalProperties: false,
    }),
  ApiPlayRouteMapResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayRouteMapResponse,
      properties: {
        nodes: { type: "array", items: ref("ApiPlayRouteMapNode") },
        edges: { type: "array", items: ref("ApiPlayRouteMapEdge") },
        counts: ref("ApiPlayRouteMapCounts"),
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.route-map.v0",
    }),

  // play-flag-composer — AnnotationComposer submit envelopes
  ApiPlayFlagAnnotationRequest: () =>
    object({
      required: ["note", "severity", "bridgeUnitId"],
      properties: {
        note: str,
        severity: { enum: ["blocker", "critical", "warning", "note"] },
        category: str,
        bridgeUnitId: str,
        sourceUnitKey: str,
        sourceBundleId: str,
        sourceRevisionId: str,
        sceneId: str,
        suggestedEdit: str,
        actorUserId: str,
        actorDisplayName: str,
      },
      additionalProperties: false,
    }),
  ApiPlayFlagAnnotationResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayFlagAnnotationResponse,
      properties: {
        severity: { enum: ["blocker", "critical", "warning", "note"] },
        category: { anyOf: [{ type: "string" }, { type: "null" }] },
        contextCorrectionId: str,
        duplicate: bool,
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.flag-annotation.v0",
    }),
  ApiPlayUnitFeedbackNote: () =>
    object({
      required: [
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
      ],
      properties: {
        feedbackReportId: str,
        feedbackEvidenceId: str,
        bridgeUnitId: str,
        sceneId: { anyOf: [{ type: "string" }, { type: "null" }] },
        note: str,
        severity: str,
        category: { anyOf: [{ type: "string" }, { type: "null" }] },
        triageLabel: str,
        contextStatus: str,
        contextCorrectionId: str,
        reportedAt: str,
        duplicate: bool,
      },
      additionalProperties: false,
    }),
  ApiPlayUnitFeedbackResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayUnitFeedbackResponse,
      properties: {
        bridgeUnitId: str,
        notes: { type: "array", items: ref("ApiPlayUnitFeedbackNote") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.unit-feedback.v0",
    }),
  ApiPlayAddressableUnitResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayAddressableUnitResponse,
      properties: {
        unit: {
          oneOf: [
            object({
              required: ["bridgeUnitId", "state", "sceneId", "sourceUnitKey"],
              properties: {
                bridgeUnitId: str,
                state: { const: "resolved" },
                sceneId: str,
                sourceUnitKey: str,
              },
              additionalProperties: false,
            }),
            object({
              required: ["bridgeUnitId", "state", "reason"],
              properties: {
                bridgeUnitId: str,
                state: { const: "unresolvable" },
                reason: { enum: ["not_imported_in_branch", "scene_coordinate_missing"] },
              },
              additionalProperties: false,
            }),
          ],
        },
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.addressable-unit.v0",
    }),

  // p0-result-revision — target-only play-tester edit and selected delivery
  // inspection. Actor identity, source text, and artifact-root paths are
  // deliberately absent from the mutation request contract.
  ApiPlayTargetEditRequest: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayTargetEditRequest,
      properties: { bridgeUnitId: str, targetBody: str },
      additionalProperties: false,
    }),
  ApiPlayTargetEditResponse: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayTargetEditResponse,
      properties: {
        resultRevisionId: str,
        patchVersionId: str,
        runId: str,
        parentPatchVersionId: str,
        bridgeUnitId: str,
        targetBody: str,
        status: { const: "playable" },
        selectedAt: str,
        idempotentReplay: bool,
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.target-edit.v0",
    }),
  ApiPlayDeliveryUnit: () =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayDeliveryUnit,
      properties: { bridgeUnitId: str, unitOrdinal: num, targetBody: str },
      additionalProperties: false,
    }),
  ApiPlayDeliveryResponse: (ref) =>
    object({
      required: STRICT_API_BODY_KEYS.ApiPlayDeliveryResponse,
      properties: {
        patchVersionId: str,
        runId: str,
        parentPatchVersionId: nullableStr,
        status: str,
        selectedAt: str,
        artifactHashes: { type: "object", additionalProperties: str },
        downloadUrl: str,
        units: { type: "array", items: ref("ApiPlayDeliveryUnit") },
      },
      additionalProperties: false,
      schemaVersion: "itotori.play.delivery.v0",
    }),
};
