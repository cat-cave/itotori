// fe-api-openapi-emit — the deterministic OpenAPI + JSON-Schema CONTRACT that is
// emitted FROM the api-schema.ts type-guard authority.
//
// DECISION (Trevor 2026-07-07): the hand-rolled type-guards in `api-schema.ts`
// remain the API contract AUTHORITY (declared in
// `docs/format-stability-and-compatibility-policy.md`; the server + client
// already assert through them). This module does NOT re-implement or migrate
// those guards to zod/valibot — a zod revisit is an evidence-gated deferred
// follow-up, NOT this node. Instead it hosts the SINGLE co-located route
// registry (`API_ROUTES`) + a JSON-Schema `COMPONENT` table that BOTH
// the guards' world (the HTTP contract harness, which drives method/path from
// this registry AND validates responses against these schemas) AND the emitter
// consume. There is exactly one authority for the route topology (the
// `Record<ItotoriApiRouteId, …>` registry, compile-time-exhaustive against the
// guard union) and one emitted wire-contract artifact derived from it.
//
// Altitude of the emitted schema: it pins the WIRE ENVELOPE — the route
// topology (method / path / operationId / path params), the typed error shape,
// each body's top-level required keys, the `schemaVersion` const markers, and
// (for strict `asStrictRecord` bodies) `additionalProperties: false` so a
// renamed / leaked top-level field fails. The DEEP field-by-field contract
// stays with the guards (`assertItotoriApiResponse`), which the harness runs
// ALONGSIDE this schema.
//
// fe-openapi-parity-all-routes: every strict (`additionalProperties:false`)
// body's `required` list is GENERATED from `STRICT_API_BODY_KEYS` — the
// SAME array the guard passes to `asStrictRecord`. There is no hand-authored
// second source for a strict body's envelope, so it cannot fork from the guard
// for every strict route. The loose
// (`additionalProperties:true`) bodies keep their guard<->schema parity proven
// by real response fixtures. The parity suite adds per-route teeth for all
// routes (a dropped required key or a leaked strict field fails).
import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import { type ItotoriApiRouteId } from "./api-schema.js";
import { API_BINARY_ROUTES, API_ROUTE_IDS, API_ROUTES } from "./api-routes.js";
import { materializeComponents } from "./api-contract-components.js";
import { serializeJsonDocument, type JsonValue } from "./api-contract-json.js";

export { type JsonValue, serializeJsonDocument, sortJsonDeep } from "./api-contract-json.js";

export {
  API_BINARY_ROUTES,
  API_ROUTE_IDS,
  API_ROUTES,
  interpolateRoutePath,
  patchIterationDeliveryArchivePath,
  playDeliveryArchivePath,
  type ItotoriApiBinaryRoute,
  type ItotoriApiBinaryRouteId,
  type ItotoriApiRoute,
} from "./api-routes.js";

// ---------------------------------------------------------------------------
// Emitted artifacts — the OpenAPI document + the JSON-Schema bundle.
// ---------------------------------------------------------------------------

const ERROR_STATUS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "400": "Malformed request (bad_request).",
  "403": "Permission denied (forbidden).",
  "404": "Route or resource not found (not_found).",
  "405": "Method not allowed (method_not_allowed).",
  "409": "Workflow conflicts with the current state (workflow_failed).",
  "422": "Workflow input or operation cannot be processed (workflow_failed).",
  "429": "Exact cost allowance is exhausted (workflow_failed).",
  "500": "Internal error (internal_error).",
  "503": "Service unavailable (database_unreachable or workflow_failed).",
  "504": "Declared provider deadline reached (workflow_failed).",
};

function openApiErrorResponses(): Record<string, JsonValue> {
  const responses: Record<string, JsonValue> = {};
  for (const [status, description] of Object.entries(ERROR_STATUS_DESCRIPTIONS)) {
    responses[status] = {
      description,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ApiErrorResponse" } },
      },
    };
  }
  return responses;
}

/**
 * Build the deterministic OpenAPI 3.1 document derived from
 * {@link API_ROUTES} + the component table. Carries the product version
 * (`ITOTORI_PRODUCT_VERSION`) per the format-stability policy. Serialize with
 * {@link serializeJsonDocument} for the committed artifact.
 */
export function buildItotoriOpenApiDocument(): JsonValue {
  const paths: Record<string, Record<string, JsonValue>> = {};
  for (const routeId of API_ROUTE_IDS) {
    const route = API_ROUTES[routeId];
    const operation: Record<string, JsonValue> = {
      operationId: route.operationId,
      summary: route.summary,
      "x-itotoriRouteId": routeId,
      responses: {
        "200": {
          description: "Success.",
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${route.responseSchema}` },
            },
          },
        },
        ...openApiErrorResponses(),
      },
    };
    if (route.pathParams.length > 0) {
      operation.parameters = route.pathParams.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }
    if (route.requestSchema !== undefined) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${route.requestSchema}` } },
        },
      };
    }
    const pathItem = paths[route.pathTemplate] ?? (paths[route.pathTemplate] = {});
    pathItem[route.method.toLowerCase()] = operation;
  }
  for (const [routeId, route] of Object.entries(API_BINARY_ROUTES)) {
    const responses: Record<string, JsonValue> = {
      "200": {
        description: "Selected delivered patch archive.",
        content: {
          [route.contentType]: {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      ...openApiErrorResponses(),
    };
    for (const status of route.additionalErrorStatuses ?? []) {
      responses[String(status)] = {
        description: "Error (internal_error).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ApiErrorResponse" } },
        },
      };
    }
    const operation: Record<string, JsonValue> = {
      operationId: route.operationId,
      summary: route.summary,
      "x-itotoriBinaryRouteId": routeId,
      responses,
    };
    if (route.pathParams.length > 0) {
      operation.parameters = route.pathParams.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }
    const pathItem = paths[route.pathTemplate] ?? (paths[route.pathTemplate] = {});
    pathItem[route.method.toLowerCase()] = operation;
  }

  const document: JsonValue = {
    openapi: "3.1.0",
    info: {
      title: "Itotori /api contract",
      version: ITOTORI_PRODUCT_VERSION,
      description:
        "Emitted deterministically FROM the api-schema.ts type-guard authority " +
        "(fe-api-openapi-emit). Do not hand-edit; regenerate with the openapi " +
        "emitter. The guards remain the deep contract authority; this document " +
        "pins the wire envelope + route topology.",
    },
    paths,
    components: { schemas: materializeComponents("#/components/schemas/") },
  };
  return document;
}

/**
 * Build the standalone JSON-Schema bundle (draft-07 `definitions`) — the
 * committed `api-jsonschema.json`. Every request/response component is a named
 * definition; {@link jsonSchemaForRoute} slices out a validatable per-route
 * schema.
 */
export function buildItotoriJsonSchemaBundle(): JsonValue {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://itotori.dev/api/json-schema/v${ITOTORI_PRODUCT_VERSION}`,
    title: "Itotori /api JSON-Schema bundle",
    description:
      "Emitted deterministically FROM api-schema.ts (fe-api-openapi-emit). Wire " +
      "envelope + route-body definitions; the guards remain the deep authority.",
    "x-itotoriProductVersion": ITOTORI_PRODUCT_VERSION,
    definitions: materializeComponents("#/definitions/"),
  };
}

/**
 * A validatable JSON-Schema (draft-07) for one route's request or response
 * body: a `$ref` into the full `definitions` bundle. Returns `null` when the
 * route has no body of that kind (e.g. a GET request). Used by the HTTP
 * contract harness (validates real responses) and the parity test.
 */
export function jsonSchemaForRoute(
  routeId: ItotoriApiRouteId,
  kind: "request" | "response",
): JsonValue | null {
  const route = API_ROUTES[routeId];
  const name = kind === "request" ? route.requestSchema : route.responseSchema;
  if (name === undefined) {
    return null;
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $ref: `#/definitions/${name}`,
    definitions: materializeComponents("#/definitions/"),
  };
}

/** The JSON-Schema for the typed {@link ApiErrorResponse} body (any route may emit one). */
export function jsonSchemaForApiError(): JsonValue {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $ref: "#/definitions/ApiErrorResponse",
    definitions: materializeComponents("#/definitions/"),
  };
}

/** Serialized committed OpenAPI document (deterministic). */
export function serializeItotoriOpenApiDocument(): string {
  return serializeJsonDocument(buildItotoriOpenApiDocument());
}

/** Serialized committed JSON-Schema bundle (deterministic). */
export function serializeItotoriJsonSchemaBundle(): string {
  return serializeJsonDocument(buildItotoriJsonSchemaBundle());
}
