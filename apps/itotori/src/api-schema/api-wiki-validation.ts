import { WikiWriteAssertion } from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-strict-body-keys.js";
import {
  ApiWikiApplyRequest,
  ApiWikiApplyResponse,
  ApiWikiEditResponse,
  ApiWikiHistoryResponse,
  ApiWikiListResponse,
  ApiWikiShowResponse,
  ApiWikiWriteRequest,
} from "./api-response-types.js";
import {
  assertImpactSet,
  assertWikiBadges,
  assertWikiCitation,
  assertWikiClaim,
  assertWikiDependent,
  assertWikiHead,
  assertWikiHistory,
  assertWikiWriteReceipt,
} from "./api-wiki-and-catalog-validation.js";
import { asRecord, parseRequest } from "./api-request-validation-helpers.js";
import {
  asArray,
  asStrictRecord,
  assertDateLike,
  assertEnum,
  assertLiteral,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertString,
} from "./api-validation-primitives.js";

export function assertWikiObjectListResponse(
  value: unknown,
  label = "ApiWikiObjectListResponse",
): asserts value is ApiWikiListResponse {
  const response = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiWikiObjectListResponse);
  assertLiteral(response.schemaVersion, "itotori.wiki.objects.v1", `${label}.schemaVersion`);
  assertDateLike(response.generatedAt, `${label}.generatedAt`);
  assertString(response.snapshotId, `${label}.snapshotId`);
  for (const [index, view] of asArray(response.sourceObjects, `${label}.sourceObjects`).entries()) {
    assertWikiObjectView(view, `${label}.sourceObjects[${index}]`, "source");
  }
  for (const [index, view] of asArray(response.renderings, `${label}.renderings`).entries()) {
    assertWikiObjectView(view, `${label}.renderings[${index}]`, "rendering");
  }
}

export function assertWikiObjectShowResponse(
  value: unknown,
  label = "ApiWikiObjectShowResponse",
): asserts value is ApiWikiShowResponse {
  const response = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiWikiObjectShowResponse);
  assertLiteral(response.schemaVersion, "itotori.wiki.object.v1", `${label}.schemaVersion`);
  assertDateLike(response.generatedAt, `${label}.generatedAt`);
  assertWikiObjectView(response.view, `${label}.view`);
  assertWikiHistory(response.history, `${label}.history`);
  const impact = asStrictRecord(response.dependencyImpact, `${label}.dependencyImpact`, [
    "dependents",
  ]);
  for (const [index, dependent] of asArray(
    impact.dependents,
    `${label}.dependencyImpact.dependents`,
  ).entries()) {
    assertWikiDependent(dependent, `${label}.dependencyImpact.dependents[${index}]`);
  }
}

export function assertWikiObjectHistoryResponse(
  value: unknown,
  label = "ApiWikiObjectHistoryResponse",
): asserts value is ApiWikiHistoryResponse {
  const response = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiWikiObjectHistoryResponse);
  assertLiteral(response.schemaVersion, "itotori.wiki.history.v1", `${label}.schemaVersion`);
  assertDateLike(response.generatedAt, `${label}.generatedAt`);
  assertWikiObjectView(response.view, `${label}.view`);
  assertWikiHistory(response.history, `${label}.history`);
}

export function assertWikiObjectWriteResponse(
  value: unknown,
  label = "ApiWikiObjectWriteResponse",
): asserts value is ApiWikiEditResponse {
  const response = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiWikiObjectWriteResponse);
  assertLiteral(response.schemaVersion, "itotori.wiki.write.v1", `${label}.schemaVersion`);
  assertDateLike(response.generatedAt, `${label}.generatedAt`);
  assertWikiWriteReceipt(response.receipt, `${label}.receipt`);
  assertWikiHistory(response.history, `${label}.history`);
  assertImpactSet(response.dependencyImpact, `${label}.dependencyImpact`);
}

export function assertWikiApplyResponse(
  value: unknown,
  label = "ApiWikiObjectApplyResponse",
): asserts value is ApiWikiApplyResponse {
  const response = asStrictRecord(value, label, STRICT_API_BODY_KEYS.ApiWikiObjectApplyResponse);
  assertLiteral(response.schemaVersion, "itotori.wiki.apply.v1", `${label}.schemaVersion`);
  assertDateLike(response.generatedAt, `${label}.generatedAt`);
  const receipt = asStrictRecord(response.receipt, `${label}.receipt`, [
    "enhancementLaunched",
    "head",
    "view",
    "badges",
    "coalescedInputCount",
    "resolvedConflictCount",
    "dependencyImpact",
  ]);
  if (receipt.enhancementLaunched !== true) {
    throw new Error(`${label}.receipt.enhancementLaunched must be true`);
  }
  assertWikiHead(receipt.head, `${label}.receipt.head`);
  assertWikiObjectView(receipt.view, `${label}.receipt.view`);
  assertWikiBadges(receipt.badges, `${label}.receipt.badges`);
  assertNonNegativeInteger(receipt.coalescedInputCount, `${label}.receipt.coalescedInputCount`);
  assertNonNegativeInteger(receipt.resolvedConflictCount, `${label}.receipt.resolvedConflictCount`);
  assertImpactSet(receipt.dependencyImpact, `${label}.receipt.dependencyImpact`);
  assertWikiHistory(response.history, `${label}.history`);
  assertImpactSet(response.dependencyImpact, `${label}.dependencyImpact`);
}

export function parseWikiWriteRequest(body: unknown): ApiWikiWriteRequest {
  return parseRequest("ApiWikiWriteRequest", () => {
    const request = asStrictRecord(body, "ApiWikiWriteRequest", ["input", "assertion"]);
    asRecord(request.input, "ApiWikiWriteRequest.input");
    if (request.assertion === undefined)
      throw new Error("ApiWikiWriteRequest.assertion is required");
    return {
      input: request.input,
      assertion: parseWikiWriteAssertion(request.assertion, "ApiWikiWriteRequest.assertion"),
    };
  });
}

export function parseWikiApplyRequest(body: unknown): ApiWikiApplyRequest {
  return parseRequest("ApiWikiApplyRequest", () => {
    const request = asStrictRecord(body, "ApiWikiApplyRequest", ["inputIds", "assertion"]);
    const inputIds = asArray(request.inputIds, "ApiWikiApplyRequest.inputIds").map(
      (value, index) => {
        assertString(value, `ApiWikiApplyRequest.inputIds[${index}]`);
        if (value.trim().length === 0)
          throw new Error(`ApiWikiApplyRequest.inputIds[${index}] must be non-blank`);
        return value;
      },
    );
    if (inputIds.length === 0) throw new Error("ApiWikiApplyRequest.inputIds must be non-empty");
    if (new Set(inputIds).size !== inputIds.length)
      throw new Error("ApiWikiApplyRequest.inputIds must be unique");
    if (request.assertion === undefined)
      throw new Error("ApiWikiApplyRequest.assertion is required");
    return {
      inputIds,
      assertion: parseWikiWriteAssertion(request.assertion, "ApiWikiApplyRequest.assertion"),
    };
  });
}

export function parseWikiWriteAssertion(value: unknown, label: string): WikiWriteAssertion {
  const assertion = asStrictRecord(value, label, ["category", "contextSnapshotId", "routeScope"]);
  const result: {
    category?: string;
    contextSnapshotId?: string;
    routeScope?: NonNullable<WikiWriteAssertion["routeScope"]>;
  } = {};
  assertString(assertion.category, `${label}.category`);
  assertEnum(
    assertion.category,
    [
      "style-contract",
      "term-ruling",
      "scene-summary",
      "story-so-far",
      "route-arc",
      "voice-profile",
      "adaptation-note",
      "character-bio",
      "character-background",
      "character-route-arc",
      "speaker-hypothesis",
      "translation",
    ] as const,
    `${label}.category`,
  );
  result.category = assertion.category;
  assertString(assertion.contextSnapshotId, `${label}.contextSnapshotId`);
  result.contextSnapshotId = assertion.contextSnapshotId;
  if (assertion.routeScope !== undefined)
    result.routeScope = parseWikiRouteScope(assertion.routeScope, `${label}.routeScope`);
  return result;
}

export function parseWikiRouteScope(
  value: unknown,
  label: string,
): NonNullable<WikiWriteAssertion["routeScope"]> {
  const scope = asRecord(value, label);
  assertString(scope.kind, `${label}.kind`);
  if (scope.kind === "global") {
    asStrictRecord(scope, label, ["kind"]);
    return { kind: "global" };
  }
  if (scope.kind === "route") {
    const route = asStrictRecord(scope, label, ["kind", "routeId"]);
    assertString(route.routeId, `${label}.routeId`);
    return { kind: "route", routeId: route.routeId };
  }
  if (scope.kind === "route-set") {
    const routes = asStrictRecord(scope, label, ["kind", "routeIds"]);
    const routeIds = asArray(routes.routeIds, `${label}.routeIds`);
    if (routeIds.length === 0) throw new Error(`${label}.routeIds must be non-empty`);
    routeIds.forEach((routeId, index) => assertString(routeId, `${label}.routeIds[${index}]`));
    return { kind: "route-set", routeIds: routeIds as string[] };
  }
  throw new Error(`${label}.kind must be global, route, or route-set`);
}

export function assertWikiObjectView(
  value: unknown,
  label: string,
  expectedKind?: "source" | "rendering",
): void {
  const view = asRecord(value, label);
  assertString(view.kind, `${label}.kind`);
  if (expectedKind !== undefined) assertLiteral(view.kind, expectedKind, `${label}.kind`);
  if (view.kind === "source") {
    const source = asStrictRecord(view, label, [
      "kind",
      "objectId",
      "wikiKind",
      "category",
      "version",
      "lang",
      "subject",
      "routeScope",
      "badges",
      "claims",
      "citations",
      "media",
    ]);
    assertString(source.objectId, `${label}.objectId`);
    assertString(source.wikiKind, `${label}.wikiKind`);
    assertString(source.category, `${label}.category`);
    assertPositiveInteger(source.version, `${label}.version`);
    assertString(source.lang, `${label}.lang`);
    asRecord(source.subject, `${label}.subject`);
    assertWikiRouteScope(source.routeScope, `${label}.routeScope`);
    assertWikiBadges(source.badges, `${label}.badges`);
    asArray(source.claims, `${label}.claims`).forEach((claim, index) =>
      assertWikiClaim(claim, `${label}.claims[${index}]`),
    );
    asArray(source.citations, `${label}.citations`).forEach((citation, index) =>
      assertWikiCitation(citation, `${label}.citations[${index}]`),
    );
    asArray(source.media, `${label}.media`).forEach((media, index) =>
      asRecord(media, `${label}.media[${index}]`),
    );
    return;
  }
  if (view.kind === "rendering") {
    const rendering = asStrictRecord(view, label, [
      "kind",
      "renderingId",
      "sourceObjectId",
      "category",
      "version",
      "targetLanguage",
      "routeScope",
      "badges",
      "claimRenderings",
    ]);
    assertString(rendering.renderingId, `${label}.renderingId`);
    assertString(rendering.sourceObjectId, `${label}.sourceObjectId`);
    assertString(rendering.category, `${label}.category`);
    assertPositiveInteger(rendering.version, `${label}.version`);
    assertString(rendering.targetLanguage, `${label}.targetLanguage`);
    assertWikiRouteScope(rendering.routeScope, `${label}.routeScope`);
    assertWikiBadges(rendering.badges, `${label}.badges`);
    asArray(rendering.claimRenderings, `${label}.claimRenderings`).forEach((claim, index) => {
      const entry = asStrictRecord(claim, `${label}.claimRenderings[${index}]`, [
        "claimId",
        "text",
      ]);
      assertString(entry.claimId, `${label}.claimRenderings[${index}].claimId`);
      assertString(entry.text, `${label}.claimRenderings[${index}].text`);
    });
    return;
  }
  throw new Error(`${label}.kind must be source or rendering`);
}

export function assertWikiRouteScope(value: unknown, label: string): void {
  parseWikiRouteScope(value, label);
}
