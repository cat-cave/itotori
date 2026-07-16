// The Wiki bible dashboard data client — the surface's typed reader/writer over
// the wiki object read/write API. It is a purpose-built data layer (not an
// ad-hoc component fetch): every request carries the shell's selected-account
// scope and validates the response envelope through the dashboard guards before
// the surface trusts it. The three operations mirror the server adapter:
// overview, object detail, and the non-blocking edit/feedback write.

import {
  assertWikiDashboardObject,
  assertWikiDashboardOverview,
  assertWikiDashboardWriteReceipt,
} from "../../../wiki/dashboard/guards.js";
import type {
  WikiDashboardObject,
  WikiDashboardOverview,
  WikiDashboardWriteReceipt,
} from "../../../wiki/dashboard/read-model.js";
import { withSelectedAccountScope } from "../../shell-account-scope.js";

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

/** The edit / feedback envelope the surface posts. `input` is the strict
 * HumanInput the object API validates server-side. */
export interface WikiBibleWriteInput {
  readonly input: unknown;
}

function basePath(scope: Pick<WikiBibleScope, "projectId" | "localeBranchId">): string {
  return `/api/projects/${encodeURIComponent(scope.projectId)}/locale-branches/${encodeURIComponent(
    scope.localeBranchId,
  )}/wiki-objects`;
}

export async function fetchWikiBibleOverview(
  scope: WikiBibleScope,
): Promise<WikiBibleResult<WikiDashboardOverview>> {
  const url = `${basePath(scope)}?snapshotId=${encodeURIComponent(scope.snapshotId)}`;
  return request(url, { method: "GET" }, assertWikiDashboardOverview);
}

export async function fetchWikiBibleObject(
  scope: WikiBibleScope,
  ref: WikiBibleObjectRef,
): Promise<WikiBibleResult<WikiDashboardObject>> {
  const url = `${basePath(scope)}/${encodeURIComponent(ref.objectId)}?snapshotId=${encodeURIComponent(
    scope.snapshotId,
  )}&wikiKind=${encodeURIComponent(ref.wikiKind)}`;
  return request(url, { method: "GET" }, assertWikiDashboardObject);
}

export async function writeWikiBibleInput(
  scope: WikiBibleScope,
  ref: WikiBibleObjectRef,
  payload: WikiBibleWriteInput,
): Promise<WikiBibleResult<WikiDashboardWriteReceipt>> {
  const url = `${basePath(scope)}/${encodeURIComponent(ref.objectId)}?snapshotId=${encodeURIComponent(
    scope.snapshotId,
  )}&wikiKind=${encodeURIComponent(ref.wikiKind)}`;
  return request(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    assertWikiDashboardWriteReceipt,
  );
}

async function request<T>(
  url: string,
  init: RequestInit,
  assert: (value: unknown) => asserts value is T,
): Promise<WikiBibleResult<T>> {
  let response: Response;
  try {
    response = await globalThis.fetch(url, withSelectedAccountScope(init));
  } catch (error: unknown) {
    return { ok: false, error: { status: 0, message: transportMessage(error) } };
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      error: { status: response.status, message: errorMessage(payload, response.status) },
    };
  }
  try {
    assert(payload);
  } catch (error: unknown) {
    return { ok: false, error: { status: response.status, message: transportMessage(error) } };
  }
  return { ok: true, data: payload };
}

function errorMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
  }
  return `wiki bible request failed with status ${String(status)}`;
}

function transportMessage(error: unknown): string {
  return error instanceof Error ? error.message : "wiki bible request failed";
}
