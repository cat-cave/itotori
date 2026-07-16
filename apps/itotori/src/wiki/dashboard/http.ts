// The Wiki bible dashboard HTTP surface — a thin, self-contained adapter over
// the wiki object read/write API. It resolves the product surface's three
// operations straight from the object API and the deterministic read-model
// builders:
//   GET  overview        → list source objects + renderings, route facets, readiness
//   GET  object detail   → show one object's view, history, and dependents
//   POST edit / feedback → append a non-blocking human input and return the
//                          durable receipt addressing the SAME object (loop-close)
//
// It imports ONLY the wiki object API and the pure read-model — never the old
// context-artifact worker, never an agent surface. The write path is the
// non-blocking edit/feedback append (no inference is awaited), so it returns an
// immediate receipt the surface uses to return the tester to their object.

import {
  WikiObjectApiError,
  type WikiObjectApiService,
  type WikiObjectSelector,
} from "../object-api/index.js";
import {
  WIKI_DASHBOARD_OBJECT_SCHEMA,
  WIKI_DASHBOARD_OVERVIEW_SCHEMA,
  WIKI_DASHBOARD_WRITE_SCHEMA,
  buildRouteFacets,
  computeReadiness,
  partitionViews,
  type WikiDashboardObject,
  type WikiDashboardOverview,
  type WikiDashboardWriteReceipt,
} from "./read-model.js";

/** The wiki kinds the dashboard addresses. A rendering is read-only here; the
 * editable surface targets a source or translation object. */
const WIKI_KINDS = ["source-object", "translation-object", "localized-rendering"] as const;
type DashboardWikiKind = (typeof WIKI_KINDS)[number];

export interface WikiDashboardHttpRequest {
  readonly method: "GET" | "POST";
  /** The context/localization snapshot the surface browses (required for GET overview). */
  readonly snapshotId: string | null;
  /** The addressed object id (present for object detail + writes; null for overview). */
  readonly objectId: string | null;
  /** The addressed object's kind (required for object detail + writes). */
  readonly wikiKind: string | null;
  /** The POST body: `{ input: HumanInput }`. */
  readonly body: unknown;
  /** The wall clock the receipt / read-model is stamped with. */
  readonly now: string;
}

export type WikiDashboardHttpBody =
  | WikiDashboardOverview
  | WikiDashboardObject
  | WikiDashboardWriteReceipt;

export type WikiDashboardHttpResponse =
  | { readonly status: 200; readonly body: WikiDashboardHttpBody }
  | {
      readonly status: 400 | 404;
      readonly body: { readonly code: string; readonly error: string };
    };

/** Resolve one dashboard request against the object API. Throws nothing: every
 * substrate error is mapped to a typed 400/404 body the surface renders. */
export async function handleWikiDashboardRequest(
  service: WikiObjectApiService,
  request: WikiDashboardHttpRequest,
): Promise<WikiDashboardHttpResponse> {
  try {
    if (request.method === "GET" && request.objectId === null) {
      return await overview(service, request);
    }
    if (request.method === "GET") {
      return await objectDetail(service, request);
    }
    return await write(service, request);
  } catch (error: unknown) {
    return mapError(error);
  }
}

async function overview(
  service: WikiObjectApiService,
  request: WikiDashboardHttpRequest,
): Promise<WikiDashboardHttpResponse> {
  const snapshotId = request.snapshotId;
  if (snapshotId === null || snapshotId.length === 0) {
    return badRequest("a snapshotId query parameter is required to browse the wiki bible");
  }
  const list = await service.list({ snapshotId });
  const { sourceObjects, renderings } = partitionViews([...list.sourceObjects, ...list.renderings]);
  const body: WikiDashboardOverview = {
    schemaVersion: WIKI_DASHBOARD_OVERVIEW_SCHEMA,
    generatedAt: request.now,
    snapshotId,
    sourceObjects,
    renderings,
    routes: buildRouteFacets(sourceObjects),
    readiness: computeReadiness(sourceObjects, renderings),
  };
  return { status: 200, body };
}

async function objectDetail(
  service: WikiObjectApiService,
  request: WikiDashboardHttpRequest,
): Promise<WikiDashboardHttpResponse> {
  const selector = parseSelector(request);
  if (selector === null) {
    return badRequest("an objectId and a valid wikiKind are required to read a wiki object");
  }
  const shown = await service.show(selector);
  if (shown === null) {
    return notFound(`wiki object ${selector.objectId} was not found in this snapshot`);
  }
  const body: WikiDashboardObject = {
    schemaVersion: WIKI_DASHBOARD_OBJECT_SCHEMA,
    generatedAt: request.now,
    snapshotId: request.snapshotId ?? "",
    object: shown.view,
    history: shown.history,
    dependents: shown.dependents,
  };
  return { status: 200, body };
}

async function write(
  service: WikiObjectApiService,
  request: WikiDashboardHttpRequest,
): Promise<WikiDashboardHttpResponse> {
  const selector = parseSelector(request);
  if (selector === null) {
    return badRequest("an objectId and a valid wikiKind are required to edit a wiki object");
  }
  const input = readInput(request.body);
  if (input === null) {
    return badRequest("the request body must carry an { input } edit or feedback HumanInput");
  }
  const session = await service.openEditSession(selector);
  const receipt =
    input.kind === "feedback"
      ? await service.feedback(session, input, request.now)
      : await service.edit(session, input, request.now);
  const invalidatedObjectIds = [
    ...new Set(receipt.dependencyImpact.consumers.map((consumer) => consumer.downstreamObjectId)),
  ];
  const body: WikiDashboardWriteReceipt = {
    schemaVersion: WIKI_DASHBOARD_WRITE_SCHEMA,
    generatedAt: request.now,
    inputId: receipt.inputId,
    addressedObjectId: receipt.head.objectId,
    addressedWikiKind: selector.wikiKind,
    head: receipt.head,
    object: receipt.view,
    badges: receipt.badges,
    invalidatedObjectIds,
  };
  return { status: 200, body };
}

function parseSelector(request: WikiDashboardHttpRequest): WikiObjectSelector | null {
  const objectId = request.objectId;
  const wikiKind = request.wikiKind;
  if (objectId === null || objectId.length === 0 || !isWikiKind(wikiKind)) {
    return null;
  }
  return { objectId, wikiKind };
}

function isWikiKind(value: string | null): value is DashboardWikiKind {
  return value !== null && (WIKI_KINDS as readonly string[]).includes(value);
}

/** Read the `{ input }` envelope loosely: the object API parses it strictly
 * through the HumanInput contract, so an ill-formed input becomes a 400 there. */
function readInput(body: unknown): { readonly kind: "edit" | "feedback" } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const input = (body as { input?: unknown }).input;
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const kind = (input as { kind?: unknown }).kind;
  if (kind !== "edit" && kind !== "feedback") {
    return null;
  }
  return input as { kind: "edit" | "feedback" };
}

function mapError(error: unknown): WikiDashboardHttpResponse {
  const message = error instanceof Error ? error.message : "wiki dashboard request failed";
  if (
    error instanceof WikiObjectApiError &&
    /no current head|was not found|has no/u.test(message)
  ) {
    return notFound(message);
  }
  return badRequest(message);
}

function badRequest(error: string): WikiDashboardHttpResponse {
  return { status: 400, body: { code: "bad_request", error } };
}

function notFound(error: string): WikiDashboardHttpResponse {
  return { status: 404, body: { code: "not_found", error } };
}
