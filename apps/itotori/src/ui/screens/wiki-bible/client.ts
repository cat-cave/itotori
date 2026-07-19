// The Wiki bible dashboard data client — a typed reader/writer over the
// WikiObject API (`/api/wiki`). Every call goes through the shell's
// ItotoriApiClient so responses are validated by the same browser wire guards
// the rest of the SPA uses. Pure adapters project the object-API envelopes
// into the product-surface dashboard read-models (overview with readiness +
// route facets, object detail, write receipt that addresses the same object).

import { apiClient } from "../../client.js";
import type {
  WikiDashboardObject,
  WikiDashboardOverview,
  WikiDashboardWriteReceipt,
  WikiRouteScope,
  WikiSourceObjectView,
} from "../../../wiki/dashboard/read-model.js";
import { objectFromWikiShow, overviewFromWikiList, writeReceiptFromWikiWrite } from "./adapt.js";

/** A settled dashboard call: the validated body, or a typed transport error the
 * surface can render without crashing. */
export type WikiBibleResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: WikiBibleError };

export interface WikiBibleError {
  readonly status: number;
  readonly message: string;
}

export interface WikiBibleScope {
  readonly projectId: string;
  readonly localeBranchId: string;
  readonly snapshotId: string;
}

export interface WikiBibleObjectRef {
  readonly objectId: string;
  readonly wikiKind: string;
}

/** The edit / feedback payload the surface posts. `input` is the strict
 * HumanInput; `assertion` is the anti-forgery head claim the object API checks
 * against the substrate (category + context snapshot + route scope). */
export interface WikiBibleWriteInput {
  readonly input: { readonly kind: "edit" | "feedback"; readonly [key: string]: unknown };
  readonly assertion: {
    readonly category: string;
    readonly contextSnapshotId: string;
    readonly routeScope: WikiRouteScope;
  };
}

export async function fetchWikiBibleOverview(
  scope: WikiBibleScope,
): Promise<WikiBibleResult<WikiDashboardOverview>> {
  // Source truth is snapshot-addressed; locale branch is shell scope only.
  const result = await apiClient.request("wiki.list", {
    query: { snapshotId: scope.snapshotId },
    // An empty source bible is a valid overview (zero readiness), not an empty
    // surface state — the screen still renders the readiness band.
    isEmpty: () => false,
  });
  if (result.state === "error") {
    return fromClientError(result.error);
  }
  if (result.state === "empty") {
    return {
      ok: true,
      data: overviewFromWikiList({
        schemaVersion: "itotori.wiki.objects.v1",
        generatedAt: new Date(0).toISOString(),
        snapshotId: scope.snapshotId,
        sourceObjects: [],
        renderings: [],
      }),
    };
  }
  return { ok: true, data: overviewFromWikiList(result.data) };
}

export async function fetchWikiBibleObject(
  scope: WikiBibleScope,
  ref: WikiBibleObjectRef,
): Promise<WikiBibleResult<WikiDashboardObject>> {
  const result = await apiClient.request("wiki.show", {
    pathParams: { wikiKind: ref.wikiKind, objectId: ref.objectId },
  });
  if (result.state === "error") {
    return fromClientError(result.error);
  }
  if (result.state === "empty") {
    return {
      ok: false,
      error: { status: 404, message: `wiki object ${ref.objectId} was not found` },
    };
  }
  return { ok: true, data: objectFromWikiShow(result.data, scope.snapshotId) };
}

export async function writeWikiBibleInput(
  scope: WikiBibleScope,
  ref: WikiBibleObjectRef,
  payload: WikiBibleWriteInput,
): Promise<WikiBibleResult<WikiDashboardWriteReceipt>> {
  const routeId = payload.input.kind === "feedback" ? "wiki.feedback" : "wiki.edit";
  const result = await apiClient.request(routeId, {
    pathParams: { wikiKind: ref.wikiKind, objectId: ref.objectId },
    body: {
      input: payload.input,
      assertion: payload.assertion,
    },
  });
  if (result.state === "error") {
    return fromClientError(result.error);
  }
  if (result.state === "empty") {
    return {
      ok: false,
      error: { status: 500, message: "wiki write returned an empty body" },
    };
  }
  return { ok: true, data: writeReceiptFromWikiWrite(result.data, ref.wikiKind) };
}

/** Build the anti-forgery assertion a write carries, from the surface's known
 * object view + the snapshot it is browsing. */
export function writeAssertionFor(
  object: Pick<WikiSourceObjectView, "category" | "routeScope">,
  scope: Pick<WikiBibleScope, "snapshotId">,
): WikiBibleWriteInput["assertion"] {
  return {
    category: object.category,
    contextSnapshotId: scope.snapshotId,
    routeScope: object.routeScope,
  };
}

function fromClientError(error: {
  status: number;
  message: string | null;
}): WikiBibleResult<never> {
  return {
    ok: false,
    error: {
      status: error.status,
      message: error.message ?? `wiki bible request failed with status ${String(error.status)}`,
    },
  };
}
