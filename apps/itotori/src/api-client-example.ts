// fnd-api-client — minimal TYPE-SAFE CONSUMPTION example.
//
// This is NOT the SPA shell (that's fnd-spa-shell, downstream). It proves a
// consumer can drive the client through the discriminated `loading | ready |
// empty | error` states type-safely, and sketches the hook + renderer shape
// the Studio shell will wire. The discriminated-union `switch` narrows
// `state.data` (only on `ready`) and `state.error` (only on `error`) at
// compile time — that is the type-safety guarantee the client exports.
//
// Shell-wiring follow-on: fnd-spa-shell will bind `createApiQueryHook` to a
// real framework lifecycle (React `useSyncExternalStore`, Solid, Svelte, or
// the vanilla-DOM pattern `dashboard.ts` already uses) and feed
// `renderApiResourceState` into the screen renderers. No framework is pinned
// here so the data layer stays framework-agnostic.

import {
  ItotoriApiClient,
  type ApiClientError,
  type ApiCallState,
  type ApiResource,
  type ApiRequestOptionsFor,
  type ApiRouteResponse,
  type ItotoriApiRouteId,
} from "./api-client.js";

/** Per-state renderer for {@link renderApiResourceState}. */
export type ApiResourceRenderer<T> = {
  loading: () => string;
  ready: (data: T) => string;
  empty: () => string;
  error: (error: ApiClientError) => string;
};

/**
 * Render an `ApiResource`'s current state through a typed renderer. The
 * `switch` on `state.state` is the compile-time proof that a consumer
 * handles every branch and only touches `data` / `error` in their narrowed
 * state — the type-safety contract the client exports.
 */
export function renderApiResourceState<T>(
  resource: ApiResource<T>,
  renderer: ApiResourceRenderer<T>,
): string {
  const state: ApiCallState<T> = resource.read();
  switch (state.state) {
    case "loading":
      return renderer.loading();
    case "ready":
      return renderer.ready(state.data);
    case "empty":
      return renderer.empty();
    case "error":
      return renderer.error(state.error);
  }
}

/**
 * Build a `useApiQuery` hook bound to a client. Returns a function that, given
 * a route id + typed options, yields the `ApiResource` the shell subscribes
 * to. The options are `ApiRequestOptionsFor<R>`: `pathParams` / `body` are
 * REQUIRED only for routes that need them and FORBIDDEN for routes that do
 * not, so the call site cannot mis-shape a request.
 */
export function createApiQueryHook(client: ItotoriApiClient): {
  useApiQuery<R extends ItotoriApiRouteId>(
    routeId: R,
    options: ApiRequestOptionsFor<R>,
  ): ApiResource<ApiRouteResponse<R>>;
} {
  return {
    useApiQuery<R extends ItotoriApiRouteId>(
      routeId: R,
      options: ApiRequestOptionsFor<R>,
    ): ApiResource<ApiRouteResponse<R>> {
      return client.query(routeId, options);
    },
  };
}
