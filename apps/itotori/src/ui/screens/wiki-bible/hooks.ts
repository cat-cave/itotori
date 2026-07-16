// Async state hooks for the Wiki bible dashboard. Each hook issues one real
// request through the dashboard data client and settles into a
// loading / ready / empty / error state the surface renders. A changing
// dependency key re-issues the call; a settled result that arrives after the
// inputs changed is dropped, so a stale response never overwrites a newer one.

import { useEffect, useState } from "react";
import {
  fetchWikiBibleObject,
  fetchWikiBibleOverview,
  type WikiBibleObjectRef,
  type WikiBibleScope,
} from "./client.js";
import type {
  WikiDashboardObject,
  WikiDashboardOverview,
} from "../../../wiki/dashboard/read-model.js";

export type AsyncState<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly data: T }
  | { readonly state: "error"; readonly status: number; readonly message: string };

export function useWikiBibleOverview(
  scope: WikiBibleScope,
  refreshKey: number,
): AsyncState<WikiDashboardOverview> {
  const [result, setResult] = useState<AsyncState<WikiDashboardOverview>>({ state: "loading" });
  const key = `${scope.projectId}:${scope.localeBranchId}:${scope.snapshotId}:${refreshKey}`;
  useEffect(() => {
    let active = true;
    setResult({ state: "loading" });
    void fetchWikiBibleOverview(scope).then((outcome) => {
      if (!active) {
        return;
      }
      setResult(
        outcome.ok
          ? { state: "ready", data: outcome.data }
          : { state: "error", status: outcome.error.status, message: outcome.error.message },
      );
    });
    return () => {
      active = false;
    };
    // key is the single cache identity; scope is read once per (re)issue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return result;
}

export function useWikiBibleObject(
  scope: WikiBibleScope,
  ref: WikiBibleObjectRef | null,
  refreshKey: number,
): AsyncState<WikiDashboardObject> {
  const [result, setResult] = useState<AsyncState<WikiDashboardObject>>({ state: "loading" });
  const key =
    ref === null ? null : `${ref.wikiKind}:${ref.objectId}:${scope.snapshotId}:${refreshKey}`;
  useEffect(() => {
    if (ref === null) {
      return;
    }
    let active = true;
    setResult({ state: "loading" });
    void fetchWikiBibleObject(scope, ref).then((outcome) => {
      if (!active) {
        return;
      }
      setResult(
        outcome.ok
          ? { state: "ready", data: outcome.data }
          : { state: "error", status: outcome.error.status, message: outcome.error.message },
      );
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return result;
}
