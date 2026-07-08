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
import { ReviewerQueueScreen, parseReviewerQueueRoute } from "./screens/ReviewerQueueScreen.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { matchLegacyRoute, type LegacyRouteRenderer } from "./legacy-routes.js";
import { RedactionGovernor, RedactionToggle } from "./redaction-governor.js";

export type AppLocation = { pathname: string; search: string };

function currentLocation(): AppLocation {
  if (typeof window === "undefined") {
    return { pathname: "/", search: "" };
  }
  return { pathname: window.location.pathname, search: window.location.search };
}

// shell-redaction-toggle — the global redaction governor wraps EVERY routed
// screen so the cap-gated reveal toggle + share/export redaction govern ALL
// frame/screenshot rendering across the SPA from one shell-level context.
// `revealSensitive` is the cap (the revealSensitive capability); the
// downstream `fnd-caps-context` node will lift this onto a real caps context,
// until then the shell (and tests) pass it explicitly — the same pattern
// `ReviewerDetailScreen.canDecide` uses.
export function App({
  location = currentLocation(),
  revealSensitive = false,
}: {
  location?: AppLocation;
  revealSensitive?: boolean;
}): ReactNode {
  return (
    <RedactionGovernor revealSensitive={revealSensitive}>
      <div className="itotori-shell-toolbar" data-shell-toolbar="true">
        <RedactionToggle />
      </div>
      <RoutedScreen location={location} />
    </RedactionGovernor>
  );
}

function RoutedScreen({ location }: { location: AppLocation }): ReactNode {
  // Legacy (not-yet-ported) routes are checked FIRST so `/reviewer-queue/batch`
  // resolves to the batch renderer before the reviewer-detail regex (which
  // also matches that path) — preserving the original dispatch precedence.
  const legacy = matchLegacyRoute(location.pathname, location.search);
  if (legacy !== null) {
    return <LegacyRoute render={legacy} />;
  }

  // The bare `/reviewer-queue` (the categorized+severity+paginated queue) is
  // matched BEFORE the reviewer-detail regex — the queue regex is
  // trailing-slash-only, so it never captures a `/reviewer-queue/:id` detail
  // path, but keeping it ahead makes the precedence explicit.
  const reviewerQueue = parseReviewerQueueRoute(location.pathname, location.search);
  if (reviewerQueue !== null) {
    return <ReviewerQueueScreen route={reviewerQueue} />;
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
