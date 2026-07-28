import { STRICT_API_BODY_KEYS } from "./api-domain-02.js";
import {
  ApiPlayRouteMapCounts,
  ApiPlayRouteMapEdge,
  ApiPlayRouteMapNode,
  ApiPlayRouteMapResponse,
} from "./api-domain-05.js";
import {
  ApiPatchIterationFeedbackRequest,
  ApiPatchIterationRefineRequest,
} from "./api-domain-06.js";
import { ApiValidationError } from "./api-domain-07.js";
import {
  apiPatchIterationFeedbackEventKinds,
  parsePatchIterationContextFeedback,
} from "./api-domain-24.js";
import { asRecord, parseRequest } from "./api-domain-28.js";
import {
  asArray,
  asStrictRecord,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertString,
} from "./api-domain-29.js";

export function parsePatchIterationFeedbackRequest(
  body: unknown,
): ApiPatchIterationFeedbackRequest {
  return parseRequest("ApiPatchIterationFeedbackRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationFeedbackRequest",
      STRICT_API_BODY_KEYS.ApiPatchIterationFeedbackRequest,
    );
    assertEnum(request.eventKind, apiPatchIterationFeedbackEventKinds, "eventKind");
    const response: ApiPatchIterationFeedbackRequest = { eventKind: request.eventKind };
    if (request.feedbackBatchId !== undefined) {
      response.feedbackBatchId = parseNonBlankApiString(request.feedbackBatchId, "feedbackBatchId");
    }
    if (request.playSessionId !== undefined) {
      response.playSessionId = parseNonBlankApiString(request.playSessionId, "playSessionId");
    }
    if (request.body !== undefined) response.body = parseNonBlankApiString(request.body, "body");
    if (request.metadata !== undefined)
      response.metadata = { ...asRecord(request.metadata, "metadata") };
    if (request.targetBody !== undefined) {
      response.targetBody = parseNonBlankApiString(request.targetBody, "targetBody");
    }
    if (request.resultRevisionId !== undefined) {
      response.resultRevisionId = parseNonBlankApiString(
        request.resultRevisionId,
        "resultRevisionId",
      );
    }
    if (request.contextArtifactId !== undefined) {
      response.contextArtifactId = parseNonBlankApiString(
        request.contextArtifactId,
        "contextArtifactId",
      );
    }
    if (request.contextEntryVersionId !== undefined) {
      response.contextEntryVersionId = parseNonBlankApiString(
        request.contextEntryVersionId,
        "contextEntryVersionId",
      );
    }
    if (request.contextFeedback !== undefined) {
      response.contextFeedback = parsePatchIterationContextFeedback(request.contextFeedback);
    }
    if (request.affectedBridgeUnitIds !== undefined) {
      response.affectedBridgeUnitIds = parseNonBlankApiStringArray(
        request.affectedBridgeUnitIds,
        "affectedBridgeUnitIds",
      );
    }
    if (response.eventKind === "comment") {
      if (response.body === undefined) {
        throw new ApiValidationError(
          "comment feedback requires a non-blank body for its canonical context correction",
        );
      }
      if (
        response.affectedBridgeUnitIds === undefined ||
        response.affectedBridgeUnitIds.length === 0
      ) {
        throw new ApiValidationError(
          "comment feedback requires at least one affectedBridgeUnitId for its canonical context correction",
        );
      }
    }
    return response;
  });
}

export function parsePatchIterationRefineRequest(body: unknown): ApiPatchIterationRefineRequest {
  return parseRequest("ApiPatchIterationRefineRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiPatchIterationRefineRequest",
      STRICT_API_BODY_KEYS.ApiPatchIterationRefineRequest,
    );
    const response: ApiPatchIterationRefineRequest = {};
    if (request.feedbackBatchIds !== undefined) {
      response.feedbackBatchIds = parseNonBlankApiStringArray(
        request.feedbackBatchIds,
        "feedbackBatchIds",
      );
    }
    if (request.feedbackEventIds !== undefined) {
      response.feedbackEventIds = parseNonBlankApiStringArray(
        request.feedbackEventIds,
        "feedbackEventIds",
      );
    }
    if (request.scopeUnitIds !== undefined) {
      response.scopeUnitIds = parseNonBlankApiStringArray(request.scopeUnitIds, "scopeUnitIds");
    }
    if (request.targetBodiesByUnit !== undefined) {
      const targetBodies = asRecord(request.targetBodiesByUnit, "targetBodiesByUnit");
      const normalized: Record<string, string> = {};
      for (const [unitId, targetBody] of Object.entries(targetBodies)) {
        if (unitId.trim().length === 0) {
          throw new ApiValidationError("targetBodiesByUnit keys must be non-blank");
        }
        normalized[unitId] = parseNonBlankApiString(targetBody, `targetBodiesByUnit.${unitId}`);
      }
      response.targetBodiesByUnit = normalized;
    }
    if (request.wikiHeads !== undefined) {
      const values = asArray(request.wikiHeads, "wikiHeads");
      response.wikiHeads = values.map((value, index) => {
        const head = asStrictRecord(value, `wikiHeads[${index}]`, [
          "contextArtifactId",
          "contextEntryVersionId",
        ]);
        return {
          contextArtifactId: parseNonBlankApiString(
            head.contextArtifactId,
            `wikiHeads[${index}].contextArtifactId`,
          ),
          contextEntryVersionId: parseNonBlankApiString(
            head.contextEntryVersionId,
            `wikiHeads[${index}].contextEntryVersionId`,
          ),
        };
      });
    }
    return response;
  });
}

export function parseNonBlankApiString(value: unknown, label: string): string {
  assertString(value, label);
  const normalized = value.trim();
  if (normalized.length === 0) throw new ApiValidationError(`${label} must be non-blank`);
  return normalized;
}

export function parseNonBlankApiStringArray(value: unknown, label: string): string[] {
  const values = asArray(value, label);
  const seen = new Set<string>();
  return values.map((entry, index) => {
    const normalized = parseNonBlankApiString(entry, `${label}[${index}]`);
    if (seen.has(normalized))
      throw new ApiValidationError(`${label} contains duplicate ${normalized}`);
    seen.add(normalized);
    return normalized;
  });
}

export function assertPlayRouteMapResponse(
  value: unknown,
): asserts value is ApiPlayRouteMapResponse {
  const response = asStrictRecord(
    value,
    "ApiPlayRouteMapResponse",
    STRICT_API_BODY_KEYS.ApiPlayRouteMapResponse,
  );
  assertLiteral(
    response.schemaVersion,
    "itotori.play.route-map.v0",
    "ApiPlayRouteMapResponse.schemaVersion",
  );
  assertString(response.generatedAt, "ApiPlayRouteMapResponse.generatedAt");
  assertString(response.projectId, "ApiPlayRouteMapResponse.projectId");
  assertString(response.localeBranchId, "ApiPlayRouteMapResponse.localeBranchId");
  if (!Array.isArray(response.nodes)) {
    throw new ApiValidationError("ApiPlayRouteMapResponse.nodes must be an array");
  }
  if (!Array.isArray(response.edges)) {
    throw new ApiValidationError("ApiPlayRouteMapResponse.edges must be an array");
  }
  for (let i = 0; i < response.nodes.length; i += 1) {
    assertPlayRouteMapNode(response.nodes[i], `ApiPlayRouteMapResponse.nodes[${i}]`);
  }
  for (let i = 0; i < response.edges.length; i += 1) {
    assertPlayRouteMapEdge(response.edges[i], `ApiPlayRouteMapResponse.edges[${i}]`);
  }
  assertPlayRouteMapCounts(response.counts, "ApiPlayRouteMapResponse.counts");
}

export function assertPlayRouteMapNode(
  value: unknown,
  label: string,
): asserts value is ApiPlayRouteMapNode {
  const node = asRecord(value, label);
  assertString(node.routeKey, `${label}.routeKey`);
  assertString(node.routeMapId, `${label}.routeMapId`);
  assertString(node.label, `${label}.label`);
  assertString(node.summary, `${label}.summary`);
  assertNonNegativeInteger(node.col, `${label}.col`);
  assertNonNegativeInteger(node.row, `${label}.row`);
  assertEnum(node.state, ["fresh", "stale"] as const, `${label}.state`);
  assertEnum(node.coverage, ["fresh", "stale"] as const, `${label}.coverage`);
  assertNonNegativeInteger(node.issues, `${label}.issues`);
}

export function assertPlayRouteMapEdge(
  value: unknown,
  label: string,
): asserts value is ApiPlayRouteMapEdge {
  const edge = asRecord(value, label);
  assertString(edge.fromRouteKey, `${label}.fromRouteKey`);
  assertString(edge.toRouteKey, `${label}.toRouteKey`);
  assertString(edge.choiceKey, `${label}.choiceKey`);
  assertString(edge.choiceKind, `${label}.choiceKind`);
  assertString(edge.label, `${label}.label`);
}

export function assertPlayRouteMapCounts(
  value: unknown,
  label: string,
): asserts value is ApiPlayRouteMapCounts {
  const counts = asRecord(value, label);
  assertNonNegativeInteger(counts.fresh, `${label}.fresh`);
  assertNonNegativeInteger(counts.stale, `${label}.stale`);
  assertNonNegativeInteger(counts.total, `${label}.total`);
  assertNonNegativeInteger(counts.choiceCount, `${label}.choiceCount`);
}
