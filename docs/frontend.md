# Itotori frontend — SPA, design system, and typed API client

The Itotori frontend is the React SPA + design-system + typed API client that
replaced the deleted HTML-string dashboard / reviewer-detail / workspace
renderers. It is the surface every downstream Studio screen node inherits, so
the patterns below are the precedent — see each component's README for the
finer-grained conventions.

## Pieces

- **`@itotori/ds`** (`packages/itotori-ds/`) — the Dusk Observatory design
  system. React components (`Panel`, `Badge`, `DataTable`, `ProgressBar`,
  `ComparisonPane`, `LocalizationProgress`, `StatReadout`, `BiText`, `NavPills`,
  `CommandPalette`, `Toast`, …) plus the CSS token set under `tokens/`. The
  canonical CSS entry is `@itotori/ds/styles.css` — consumed once at the SPA
  shell. See [`packages/itotori-ds/README.md`](../packages/itotori-ds/README.md)
  for the layout + the patterns downstream nodes copy (className-based
  styling, closed status vocabulary, tokens over literals, sentence case,
  behaviour-first tests).
- **Typed API client — `fnd-api-client`** (`apps/itotori/src/api-client.ts`).
  A framework-agnostic typed client generated from `api-schema.ts` (the
  `ItotoriApiRouteId` union + the route / response / error types) and
  `api-contract.ts` (the `ITOTORI_API_ROUTES` registry — the single authority
  for method / path / path-params). Every call's request + response types come
  from `api-schema.ts`; every response is validated by the same
  `assertItotoriApiResponse` guard the server + contract harness use; the
  error state carries the typed `ApiErrorResponse` (`{ code, error }`).
  `query()` returns a stateful `ApiResource`; `request()` returns the settled
  `ready | empty | error` states; the shared discriminated union
  `{ loading | ready | empty | error }` is the contract every consumer reads.
  Pagination primitives (`OffsetPager`) walk the offset-paginated route(s)
  per the api-schema `pagination` shape.
- **React app shell — `fnd-spa-shell`** (`apps/itotori/src/ui/`). The single
  SPA served by `apps/itotori/src/server.ts`:
  - `App.tsx` — client-routes off `window.location` and renders one of the
    ported screens. Routes this node does not port (asset-decisions /
    reviewer-batch / style-guide-builder) are bridged to their existing
    renderers via `LegacyRoute` (a tracked, temporary mount, not a dual path
    for a replaced view).
  - `client.ts` — the shared `ItotoriApiClient` instance the SPA screens
    consume. A relative base URL means the client hits the same origin the SPA
    is served from.
  - `use-api-resource.ts` — the React binding for `ApiResource`. Adapts the
    stateful resource to React via `useSyncExternalStore` so a screen
    re-renders on the transition; `useApiQuery` reissues on `depsKey` change.
  - `screens/` — the parity-ported screens (`DashboardScreen`,
    `ReviewerQueueScreen`, `ReviewerDetailScreen`, `WorkspaceScreen`, …).
    Each consumes the typed client and paints with `@itotori/ds`.
  - `legacy-routes.ts` — the honest, temporary bridge for routes that still
    own their own HTML-string renderers (a tracked follow-on screen per
    route, not a dual path for a replaced view).
  - `format.ts` — presentation formatters ported verbatim from the deleted
    string renderers so the SPA keeps byte-for-byte number/label parity.

## How a screen is shaped

```tsx
import "@itotori/ds/styles.css";            // consumed once at the SPA shell
import { Panel, DataTable, Badge } from "@itotori/ds";
import { useApiQuery } from "../use-api-resource.js";

export function ReviewerQueueScreen({ route }) {
  const state = useApiQuery(
    "reviewerQueue:list",
    { params: { branchId: route.branchId }, query: route.query },
    `${route.branchId}/${JSON.stringify(route.query)}`,
  );
  switch (state.state) {
    case "loading":
    case "empty":
      return <Panel title="Review queue" loading={state.state === "loading"} />;
    case "ready":
      return <DataTable rows={state.data.rows} columns={…} />;
    case "error":
      return <Panel title="Review queue" error={state.error} />;
  }
}
```

Every screen reads `/api/*` THROUGH `ItotoriApiClient` — never an ad-hoc
`fetch` — so the loading / ready / empty / error states + response validation
are the ones the data layer already pins. The discriminated-union `switch`
narrows `state.data` (only on `ready`) and `state.error` (only on `error`) at
compile time; that is the type-safety guarantee the client exports.

## Deleted predecessors (historical context only)

The SPA replaced these HTML-string renderers, which are NOT in the tree:

- `apps/itotori/src/dashboard.ts` — the project / runtime / cost / decisions
  workbench dashboard.
- `apps/itotori/src/reviewer/detail-view.ts` — the reviewer detail page.
- `apps/itotori/src/workspace/view.ts` — the workspace view.

Each React screen parity-ports the deleted renderer's layout + presentation
formatters so the SPA keeps byte-for-byte number/label parity (the
`apps/itotori/src/ui/format.ts` module is the centralised home for those
formatters). The legacy error model the deleted `dashboard.ts` exposed
(`DashboardApiError` / `DashboardApiErrorDetail` / `parseTypedApiError`) is
mirrored by the typed client's `ApiClientError` and reuses the SAME
`assertItotoriApiErrorResponse` guard the server uses, so the failure shape
is the one the data layer already pins.

## Patterns every downstream screen inherits

1. **className-based styling, CSS ships separately.** Components render
   semantic DOM with `itotori-*` classes; the visual truth lives in the DS
   token set + co-located component CSS, shipped as one bundle
   (`@itotori/ds/styles.css`). No CSS-in-JS, no CSS modules.
2. **Type-safe API access through `useApiQuery`.** Never an ad-hoc `fetch`;
   always the typed client. The discriminated `loading | ready | empty |
error` states are the contract.
3. **Status is a closed vocabulary → derived tone.** Pass the product status
   to `<Badge status={…} />` / `statusTone(…)`; never pick a badge colour by
   hand.
4. **Tokens, never literals.** Reference `--ito-*` variables; never inline a
   hex value.
5. **Behaviour-first tests.** Render the screen with Testing Library, assert
   the rendered DOM + real interactions, never component internals.
