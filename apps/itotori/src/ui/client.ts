// fnd-spa-shell — the shared typed API client instance the SPA screens
// consume. Every screen reads `/api/*` THROUGH `ItotoriApiClient`
// (fnd-api-client) — never an ad-hoc `fetch` — so the loading / ready /
// empty / error states + response validation are the ones the data layer
// already pins. A relative base URL means the client hits the same origin
// the SPA is served from (the server in `src/server.ts`).

import { ItotoriApiClient } from "../api-client.js";
import { withSelectedAccountScope } from "./shell-account-scope.js";

// The fetch is bound LAZILY (call `globalThis.fetch` at request time rather
// than capturing a reference at construction) so the long-lived app singleton
// always uses the current global — correct for a swapped fetch (SSR / tests
// where an interceptor replaces `globalThis.fetch` after this module loads).
export const apiClient = new ItotoriApiClient({
  fetch: (input, init) => globalThis.fetch(input, withSelectedAccountScope(init)),
});
