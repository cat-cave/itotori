// fnd-spa-shell — the React binding for the server-side `OffsetPager`
// (fnd-api-client). The pager is a stateful, FORWARD-only handle over an
// offset-paginated route (`projects.costDrilldown`, `jobs.runTable`): each
// `next()` advances the offset from the prior page's `nextOffset` until
// `hasMore` is false. `useOffsetPager` adapts that to a React component:
//
//   - it owns ONE pager per `depsKey` (recreated when the key changes, mirroring
//     `useApiQuery`'s single-source-of-cache-identity model),
//   - fetches the first page on mount / on depsKey change,
//   - CACHES every fetched page so `previous` re-renders an already-loaded page
//     with NO refetch (the pager itself is forward-only; the cache gives the
//     back cursor), and
//   - exposes `next` / `previous` + `hasNext` / `hasPrevious` + a `phase`
//     (`loading | ready | error`) so a panel settles into the same
//     loading / ready / error model the typed-resource panels use.
//
// The current page is `pages[index]`; `page` is that page's `ready` result (or
// `null` while loading / errored). A fetch failure does NOT advance the pager
// (the `OffsetPager` re-fetches the same page on retry), so `next` retries the
// failed page rather than skipping it.

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  ApiClientError,
  OffsetPagerOptions,
  OffsetPagerResult,
  OffsetPaginatedRouteId,
} from "../api-client.js";
import { OffsetPager } from "../api-client.js";
import { apiClient } from "./client.js";

export type OffsetPagerPhase = "loading" | "ready" | "error";

/** The `ready` variant of an `OffsetPagerResult` — the only page shape cached. */
export type OffsetPagerReadyResult<R extends OffsetPaginatedRouteId> = Extract<
  OffsetPagerResult<R>,
  { state: "ready" }
>;

export interface OffsetPagerView<R extends OffsetPaginatedRouteId> {
  phase: OffsetPagerPhase;
  /** The `ready` result for the current page, or `null` while loading / errored. */
  page: OffsetPagerReadyResult<R> | null;
  error: ApiClientError | null;
  /** A page fetch is in progress (the current page stays visible while fetching). */
  fetching: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  /** Advance to the next page (cached when already visited, else fetched). */
  next: () => void;
  /** Step back to the previous (always cached) page. */
  previous: () => void;
}

interface PagerState<R extends OffsetPaginatedRouteId> {
  phase: OffsetPagerPhase;
  pages: OffsetPagerReadyResult<R>[];
  /** Index into `pages` of the currently displayed page. */
  index: number;
  error: ApiClientError | null;
  fetching: boolean;
  /** No further pages exist on the server (the last fetched page had `hasMore: false`). */
  exhausted: boolean;
}

type PagerAction<R extends OffsetPaginatedRouteId> =
  | { type: "reset" }
  | { type: "fetch_start" }
  | { type: "fetch_ready"; result: OffsetPagerReadyResult<R> }
  | { type: "fetch_error"; error: ApiClientError }
  | { type: "goto"; index: number };

function init<R extends OffsetPaginatedRouteId>(): PagerState<R> {
  return { phase: "loading", pages: [], index: 0, error: null, fetching: true, exhausted: false };
}

function reducer<R extends OffsetPaginatedRouteId>(
  state: PagerState<R>,
  action: PagerAction<R>,
): PagerState<R> {
  switch (action.type) {
    case "reset":
      return init();
    case "fetch_start":
      // The FIRST fetch keeps `phase: "loading"` (no page to show yet); a
      // later forward fetch keeps the current page visible (`phase: "ready"`).
      return {
        ...state,
        fetching: true,
        phase: state.pages.length === 0 ? "loading" : state.phase,
      };
    case "fetch_ready": {
      // The pager only emits `ready` from `next()`. A failed page was never
      // appended, so an append here is never a duplicate — even on retry.
      const pages = [...state.pages, action.result];
      return {
        ...state,
        pages,
        index: pages.length - 1,
        phase: "ready",
        error: null,
        fetching: false,
        exhausted: !action.result.hasNext,
      };
    }
    case "fetch_error":
      return { ...state, phase: "error", error: action.error, fetching: false };
    case "goto":
      return { ...state, index: action.index, phase: "ready", error: null };
    default:
      return state;
  }
}

export function useOffsetPager<R extends OffsetPaginatedRouteId>(
  routeId: R,
  options: OffsetPagerOptions<R>,
  depsKey: string,
): OffsetPagerView<R> {
  // The pager is recreated ONLY when depsKey changes; `options` is read once
  // per (re)creation (mirroring `useApiQuery` — an inline options literal does
  // not thrash the pager on every render).
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pager = useMemo(
    () => new OffsetPager(apiClient, routeId, optionsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeId, depsKey],
  );

  const [state, dispatch] = useReducer(reducer, undefined, init<R>);

  // Refs mirror state for use inside stable callbacks (no stale closures).
  const pagesRef = useRef(state.pages);
  pagesRef.current = state.pages;
  const indexRef = useRef(state.index);
  indexRef.current = state.index;
  const fetchingRef = useRef(state.fetching);
  fetchingRef.current = state.fetching;
  const exhaustedRef = useRef(state.exhausted);
  exhaustedRef.current = state.exhausted;

  // A monotonic token so a fetch from a STALE pager (superseded by a depsKey
  // change) is ignored rather than appended to the new cache.
  const tokenRef = useRef(0);

  const fetchNextPage = useCallback(async (pagerInstance: OffsetPager<R>): Promise<void> => {
    const token = ++tokenRef.current;
    dispatch({ type: "fetch_start" });
    const result = await pagerInstance.next();
    if (token !== tokenRef.current) {
      return;
    }
    if (result.state === "ready") {
      dispatch({ type: "fetch_ready", result });
    } else if (result.state === "error") {
      dispatch({ type: "fetch_error", error: result.error });
    }
    // The pager's `empty` state only occurs when `next()` is called on an
    // already-exhausted pager; the cache + `exhausted` guard below prevents
    // that call, so it is not dispatched here.
  }, []);

  // Reset + fetch the first page whenever the pager identity changes.
  useEffect(() => {
    dispatch({ type: "reset" });
    void fetchNextPage(pager);
  }, [pager, fetchNextPage]);

  const next = useCallback(() => {
    if (fetchingRef.current) {
      return;
    }
    const pages = pagesRef.current;
    const index = indexRef.current;
    if (index < pages.length - 1) {
      dispatch({ type: "goto", index: index + 1 });
      return;
    }
    if (exhaustedRef.current) {
      return;
    }
    void fetchNextPage(pager);
  }, [pager, fetchNextPage]);

  const previous = useCallback(() => {
    if (indexRef.current > 0) {
      dispatch({ type: "goto", index: indexRef.current - 1 });
    }
  }, []);

  const current = state.pages[state.index] ?? null;
  const hasNext = state.index < state.pages.length - 1 || !state.exhausted;
  const hasPrevious = state.index > 0;

  return {
    phase: state.phase,
    page: current,
    error: state.error,
    fetching: state.fetching,
    hasNext,
    hasPrevious,
    next,
    previous,
  };
}
