// fnd-spa-shell — the single React app shell served by `src/server.ts`.
//
// ONE SPA, client-routed off `window.location`, that REPLACES the deleted
// HTML-string dashboard / reviewer-detail / workspace renderers with React
// screens consuming `/api/*` through the typed client. Routes this node does
// not port (asset-decisions / reviewer-batch / style-guide-builder) are
// bridged to their existing renderers via `LegacyRoute` — a tracked,
// temporary mount, not a dual path for a replaced view.
//
// This is the app-shell pattern the ~50 downstream screen nodes inherit:
// parse the route → render a screen that reads its data through
// `useApiQuery` and paints with `@itotori/ds`.

import { useEffect, useRef, type ReactNode } from "react";
import { parseReviewerDetailRoute } from "../reviewer/index.js";
import { parseWorkspaceRoute } from "../workspace/route.js";
import { DashboardScreen } from "./screens/DashboardScreen.js";
import { ReviewerDetailScreen } from "./screens/ReviewerDetailScreen.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { matchLegacyRoute, type LegacyRouteRenderer } from "./legacy-routes.js";

export type AppLocation = { pathname: string; search: string };

function currentLocation(): AppLocation {
  if (typeof window === "undefined") {
    return { pathname: "/", search: "" };
  }
  return { pathname: window.location.pathname, search: window.location.search };
}

export function App({ location = currentLocation() }: { location?: AppLocation }): ReactNode {
  // Legacy (not-yet-ported) routes are checked FIRST so `/reviewer-queue/batch`
  // resolves to the batch renderer before the reviewer-detail regex (which
  // also matches that path) — preserving the original dispatch precedence.
  const legacy = matchLegacyRoute(location.pathname, location.search);
  if (legacy !== null) {
    return <LegacyRoute render={legacy} />;
  }

  const reviewerDetail = parseReviewerDetailRoute(location.pathname);
  if (reviewerDetail !== null) {
    return <ReviewerDetailScreen reviewItemId={reviewerDetail.reviewItemId} />;
  }

  const workspaceRoute = parseWorkspaceRoute(location.pathname, location.search);
  if (workspaceRoute !== null) {
    return <WorkspaceScreen route={workspaceRoute} />;
  }

  return <DashboardScreen />;
}

function LegacyRoute({ render }: { render: LegacyRouteRenderer }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    void render(element);
  }, [render]);
  return <div ref={ref} data-legacy-route="true" />;
}
