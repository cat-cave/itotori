// fnd-spa-shell — the single React app shell served by `src/server.ts`.
//
// ONE SPA, client-routed off `window.location`, that REPLACES the deleted
// HTML-string dashboard / reviewer-detail / workspace renderers with React
// screens consuming `/api/*` through the typed client. Routes this node does
// not port (asset-decisions / reviewer-batch / style-guide-builder) are
// bridged to their existing renderers via `LegacyRoute` — a tracked,
// temporary mount, not a dual path for a replaced view.
//
// fnd-addressable-routing — entity deep-links (unit/scene/route/character/
// term/run/finding) resolve BEFORE surface roots so a stable URL focuses
// its entity (play selects the unit/scene; wiki renders the WikiEntry
// profile; runtime lands on the focus shell until its full screen ships).
//
// This is the app-shell pattern the ~50 downstream screen nodes inherit:
// parse the route → render a screen that reads its data through
// `useApiQuery` and paints with `@itotori/ds`.

import { useEffect, useRef, type ReactNode } from "react";
import type { StudioCapabilityPermissionView } from "../auth.js";
import { parseReviewerDetailRoute } from "../reviewer/index.js";
import { parseWorkspaceRoute } from "../workspace/route.js";
import { parseAddressableLocation } from "./addressable-routing.js";
import { CapsProvider, useCapsOptional } from "./caps-context.js";
import {
  BenchmarkCockpitScreen,
  isBenchmarkCockpitRoute,
} from "./screens/BenchmarkCockpitScreen.js";
import { AddressableFocusScreen } from "./screens/AddressableFocusScreen.js";
import { DashboardScreen } from "./screens/DashboardScreen.js";
import {
  PlayScenePickerScreen,
  parsePlayScenePickerRoute,
  playRouteFromAddressable,
} from "./screens/PlayScenePickerScreen.js";
import { PlayRouteMapScreen, parsePlayRouteMapRoute } from "./screens/PlayRouteMapScreen.js";
import {
  PlayFlagComposerScreen,
  parsePlayFlagComposerRoute,
} from "./screens/PlayFlagComposerScreen.js";
import { ReviewerDetailScreen } from "./screens/ReviewerDetailScreen.js";
import { ReviewerQueueScreen, parseReviewerQueueRoute } from "./screens/ReviewerQueueScreen.js";
import {
  WikiEntryScreen,
  parseWikiRoute,
  wikiRouteFromAddressable,
} from "./screens/WikiEntryScreen.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { matchLegacyRoute, type LegacyRouteRenderer } from "./legacy-routes.js";
import { RedactionGovernor } from "./redaction-governor.js";
import { ShellFrame, defaultNavigate } from "./shell-frame.js";
import { ToastProvider } from "./toast-host.js";

export type AppLocation = { pathname: string; search: string };

function currentLocation(): AppLocation {
  if (typeof window === "undefined") {
    return { pathname: "/", search: "" };
  }
  return { pathname: window.location.pathname, search: window.location.search };
}

// shell-frame-ui — the persistent shell frame (nav + status bar) wraps EVERY
// routed screen so the app chrome (Project+branch context, ZDR posture,
// source->branch, live cost) is consistent across surfaces.
//
// fnd-caps-context — the CapsProvider resolves the actor's Studio capability
// permission VIEW (canFlag / canDecide / canSteer / canReveal) from exact
// permission grants via GET `/api/auth/capabilities`. RedactionGovernor
// reads canReveal from that context (an explicit `revealSensitive` prop
// still overrides for tests / partial mounts).
export function App({
  location = currentLocation(),
  revealSensitive,
  caps,
  navigate,
}: {
  location?: AppLocation;
  /**
   * Explicit revealSensitive override. When omitted, the shell reads
   * `canReveal` from the CapsProvider (the resolved catalog.read grant).
   */
  revealSensitive?: boolean;
  /**
   * Explicit Studio capability view (tests / partial mounts). When omitted
   * the CapsProvider fetches `/api/auth/capabilities`.
   */
  caps?: StudioCapabilityPermissionView;
  /** Navigation handler for the shell nav (defaults to window.location.assign). */
  navigate?: (path: string) => void;
}): ReactNode {
  // exactOptionalPropertyTypes: only pass optional props when defined.
  return (
    <CapsProvider {...(caps !== undefined ? { value: caps } : {})}>
      <AppWithCaps
        location={location}
        {...(revealSensitive !== undefined ? { revealSensitive } : {})}
        navigate={navigate ?? defaultNavigate}
      />
    </CapsProvider>
  );
}

function AppWithCaps({
  location,
  revealSensitive,
  navigate,
}: {
  location: AppLocation;
  revealSensitive?: boolean;
  navigate: (path: string) => void;
}): ReactNode {
  const caps = useCapsOptional();
  // Explicit prop wins (tests); otherwise the resolved canReveal capability.
  const resolvedReveal = revealSensitive ?? caps?.canReveal ?? false;
  return (
    <RedactionGovernor revealSensitive={resolvedReveal}>
      <ToastProvider>
        <ShellFrame location={location} navigate={navigate}>
          <RoutedScreen location={location} />
        </ShellFrame>
      </ToastProvider>
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

  // fnd-addressable-routing — entity deep-links resolve next so a stable
  // unit/scene/route/character/term/run/finding URL focuses its entity
  // before surface-root parsers (bare `/play`, `/wiki`) claim the path.
  const addressable = parseAddressableLocation(location.pathname, location.search);
  if (addressable !== null) {
    if (
      addressable.surface === "play" &&
      (addressable.kind === "unit" || addressable.kind === "scene" || addressable.kind === "route")
    ) {
      return (
        <PlayScenePickerScreen
          route={playRouteFromAddressable({
            kind: addressable.kind,
            id: addressable.id,
            projectId: addressable.projectId,
            localeBranchId: addressable.localeBranchId,
            unitId: addressable.unitId,
          })}
        />
      );
    }
    // wiki-entry-ui — character / term deep-links render the real WikiEntry
    // profile (with CrossRef jumps to scenes) instead of the focus shell.
    if (addressable.surface === "wiki" && addressable.kind === "character") {
      return (
        <WikiEntryScreen
          route={wikiRouteFromAddressable({
            kind: "character",
            id: addressable.id,
            projectId: addressable.projectId,
            localeBranchId: addressable.localeBranchId,
          })}
        />
      );
    }
    if (addressable.surface === "wiki" && addressable.kind === "term") {
      return (
        <WikiEntryScreen
          route={wikiRouteFromAddressable({
            kind: "term",
            id: addressable.id,
            projectId: addressable.projectId,
            localeBranchId: addressable.localeBranchId,
          })}
        />
      );
    }
    return <AddressableFocusScreen location={addressable} />;
  }

  // The bare `/reviewer-queue` (the categorized+severity+paginated queue) is
  // matched BEFORE the reviewer-detail regex — the queue regex is
  // trailing-slash-only, so it never captures a `/reviewer-queue/:id` detail
  // path, but keeping it ahead makes the precedence explicit.
  const reviewerQueue = parseReviewerQueueRoute(location.pathname, location.search);
  if (reviewerQueue !== null) {
    return <ReviewerQueueScreen route={reviewerQueue} />;
  }

  // `/play/routemap` — Play RouteMap with per-scene coverage (mark validated).
  // Matched BEFORE bare `/play` so the more specific path wins.
  const playRouteMap = parsePlayRouteMapRoute(location.pathname, location.search);
  if (playRouteMap !== null) {
    return <PlayRouteMapScreen route={playRouteMap} />;
  }

  // `/play/flag` — AnnotationComposer flag → reviewer queue (canFlag).
  const playFlag = parsePlayFlagComposerRoute(location.pathname, location.search);
  if (playFlag !== null) {
    return <PlayFlagComposerScreen route={playFlag} />;
  }

  // `/play` — the Play scene picker (translated-summary navigation + source ↔
  // draft BiText). Rendered inside the shell frame like every other screen.
  const playScenePicker = parsePlayScenePickerRoute(location.pathname, location.search);
  if (playScenePicker !== null) {
    return <PlayScenePickerScreen route={playScenePicker} />;
  }

  const reviewerDetail = parseReviewerDetailRoute(location.pathname);
  if (reviewerDetail !== null) {
    return <ReviewerDetailScreen reviewItemId={reviewerDetail.reviewItemId} />;
  }

  const workspaceRoute = parseWorkspaceRoute(location.pathname, location.search);
  if (workspaceRoute !== null) {
    return <WorkspaceScreen route={workspaceRoute} />;
  }

  // `/wiki` — the Wiki entry surface (character + term profiles with CrossRef
  // jumps to scenes). Rendered inside the shell frame like every other screen.
  const wikiRoute = parseWikiRoute(location.pathname, location.search);
  if (wikiRoute !== null) {
    return <WikiEntryScreen route={wikiRoute} />;
  }

  // `/benchmark` — the benchmark cockpit (contestants + confidence + the
  // actionable backlog diagnostic). Rendered inside the shell frame.
  if (isBenchmarkCockpitRoute(location.pathname)) {
    return <BenchmarkCockpitScreen />;
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
