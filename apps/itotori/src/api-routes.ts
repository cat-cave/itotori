import type { ItotoriApiRouteId } from "./api-schema.js";
import { apiRoutesFirst } from "./api-routes-first.js";
import { apiRoutesSecond } from "./api-routes-second.js";

// ---------------------------------------------------------------------------
// Route registry — the SINGLE authority for the /api route topology.
// ---------------------------------------------------------------------------

export type ItotoriApiRoute = {
  readonly method: "GET" | "POST";
  /** OpenAPI-style path template (`{param}` placeholders). */
  readonly pathTemplate: string;
  readonly operationId: string;
  readonly summary: string;
  readonly pathParams: readonly string[];
  /** Component name of the request body schema (POST routes with a body). */
  readonly requestSchema?: string;
  /** Component name of the 200 response body schema. */
  readonly responseSchema: string;
};

/** A non-JSON API route published in OpenAPI but intentionally not in the typed JSON client. */
export type ItotoriApiBinaryRoute = {
  /** GET for durable downloads; POST for the produce-and-download mutation. */
  readonly method: "GET" | "POST";
  readonly pathTemplate: string;
  readonly operationId: string;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly contentType: "application/x-tar";
  /** Non-default error statuses beyond the shared 4xx/500 envelope. */
  readonly additionalErrorStatuses?: readonly number[];
};

export type ItotoriApiBinaryRouteId =
  | "play.deliveryArchive"
  | "patchIteration.deliveryArchive"
  | "patchback.produceArchive";

/**
 * Every `/api` route, keyed by {@link ItotoriApiRouteId}. The
 * `Record<ItotoriApiRouteId, …>` type makes this table EXHAUSTIVE against the
 * guard union at compile time — adding or removing a route id without updating
 * this registry fails `tsc`, so the emitted contract can never drift out of the
 * set of routes the guards recognize. The HTTP contract harness drives its
 * method + path from here, and the emitter reflects it into OpenAPI + the
 * JSON-Schema bundle.
 */
export const API_ROUTES: Readonly<Record<ItotoriApiRouteId, ItotoriApiRoute>> = {
  ...apiRoutesFirst,
  ...apiRoutesSecond,
};
/** Stable, sorted list of every route id (deterministic iteration order). */
export const API_ROUTE_IDS: readonly ItotoriApiRouteId[] = Object.keys(
  API_ROUTES,
).sort() as ItotoriApiRouteId[];

/**
 * Binary download topology. This is adjacent to (rather than inside) the JSON
 * route registry because the typed JSON response guard/client must never try
 * to parse archive bytes as an API response body.
 */
export const API_BINARY_ROUTES: Readonly<Record<ItotoriApiBinaryRouteId, ItotoriApiBinaryRoute>> = {
  "play.deliveryArchive": {
    method: "GET",
    pathTemplate: "/api/play/runs/{runId}/delivery/archive",
    operationId: "playDeliveryArchive",
    summary: "Download the selected delivered patch archive for a run.",
    pathParams: ["runId"],
    contentType: "application/x-tar",
  },
  "patchIteration.deliveryArchive": {
    method: "GET",
    pathTemplate: "/api/play/patch-versions/{patchVersionId}/delivery/archive",
    operationId: "patchIterationDeliveryArchive",
    summary: "Download the immutable delivered patch archive for one exact patch version.",
    pathParams: ["patchVersionId"],
    contentType: "application/x-tar",
  },
  // Produce-and-download a playable patched build by driving the native
  // patchback apply over a run's accepted outputs. The mutation both triggers
  // the byte-surgical `kaifuu patch` and streams back the produced tar, so a
  // Studio reviewer gets a playable game out of the app in one action.
  "patchback.produceArchive": {
    method: "POST",
    pathTemplate: "/api/patchback/produce",
    operationId: "patchbackProduceArchive",
    summary: "Produce a playable patched build from a run's accepted outputs and download it.",
    pathParams: [],
    contentType: "application/x-tar",
  },
};

/** Public, encoded URL used by the JSON delivery metadata response. */
export function playDeliveryArchivePath(runId: string): string {
  return `/api/play/runs/${encodeURIComponent(runId)}/delivery/archive`;
}

/** Public, encoded URL for the immutable historical-version archive endpoint. */
export function patchIterationDeliveryArchivePath(patchVersionId: string): string {
  return `/api/play/patch-versions/${encodeURIComponent(patchVersionId)}/delivery/archive`;
}

/** Public URL for the produce-and-download patched-build mutation. */
export function patchbackProduceArchivePath(): string {
  return "/api/patchback/produce";
}

/**
 * Interpolate a route's `{param}` path template with concrete values (used by
 * the HTTP contract harness to build a request URL). Throws if a template
 * placeholder is missing from `params`.
 */
export function interpolateRoutePath(
  routeId: ItotoriApiRouteId,
  params?: Readonly<Record<string, string>>,
): string {
  const template = API_ROUTES[routeId].pathTemplate;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) {
      throw new Error(`route ${routeId} requires path param "${name}"`);
    }
    return value;
  });
}
