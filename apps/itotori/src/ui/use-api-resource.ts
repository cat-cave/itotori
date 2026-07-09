// fnd-spa-shell — the React binding for `ApiResource` (fnd-api-client).
//
// `ApiResource` is a stateful handle: it starts in `loading` and fires its
// subscribers once when the underlying call settles into ready / empty /
// error. `useApiResource` adapts that to React via `useSyncExternalStore`
// so a screen re-renders on the transition. The resource is (re)created by
// `useApiQuery` whenever its dependency key changes, so a route param change
// issues a fresh typed call.

import { useMemo, useSyncExternalStore } from "react";
import type { ApiCallState, ApiResource } from "../api-client.js";
import type { ApiRequestOptionsFor, ApiRouteResponse } from "../api-client.js";
import type { ItotoriApiRouteId } from "../api-schema.js";
import { apiClient } from "./client.js";

type ApiResourceHandle<T> = Pick<ApiResource<T>, "read" | "subscribe">;

class StaticApiResource<T> implements ApiResourceHandle<T> {
  constructor(private readonly state: ApiCallState<T>) {}

  read(): ApiCallState<T> {
    return this.state;
  }

  subscribe(): () => void {
    return () => {};
  }
}

/** Subscribe a component to an `ApiResource`'s settle transition. */
export function useApiResource<T>(resource: ApiResourceHandle<T>): ApiCallState<T> {
  return useSyncExternalStore(
    (onChange) => resource.subscribe(onChange),
    () => resource.read(),
    () => resource.read(),
  );
}

/**
 * Issue a typed `client.query(routeId, options)` and subscribe to its state.
 * `depsKey` is the cache key: change it (e.g. a route param) to re-issue the
 * call. The options object is read once per (re)issue.
 */
export function useApiQuery<R extends ItotoriApiRouteId>(
  routeId: R,
  options: ApiRequestOptionsFor<R>,
  depsKey: string,
): ApiCallState<ApiRouteResponse<R>> {
  // The resource is created once per depsKey. `options` is intentionally not
  // in the dep list — depsKey is the single source of cache identity so an
  // inline options literal does not thrash the query on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo(() => apiClient.query(routeId, options), [routeId, depsKey]);
  return useApiResource(resource);
}

export function useApiQueryWhen<R extends ItotoriApiRouteId>(
  routeId: R,
  options: ApiRequestOptionsFor<R>,
  depsKey: string,
  enabled: boolean,
  disabledState: ApiCallState<ApiRouteResponse<R>> = { state: "empty" },
): ApiCallState<ApiRouteResponse<R>> {
  // Keep hook call order stable while avoiding invalid network requests for
  // panes whose backing identity is absent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo<ApiResourceHandle<ApiRouteResponse<R>>>(
    () => (enabled ? apiClient.query(routeId, options) : new StaticApiResource(disabledState)),
    [routeId, depsKey, enabled],
  );
  return useApiResource(resource);
}
