// fnd-addressable-routing — focus shell for addressable deep-links. Play unit
// and scene links render the real ScenePlayer target, scroll it into view, and
// focus/highlight that exact target. The resolver is also the shared backbone
// for the shipped Wiki entry surface and cross-surface addressable jumps.
//
// A citation jump from the wiki bible may carry `?returnTo=` back to the
// addressed object; play flag / edit / feedback links then close that loop.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the resolved kind/id/surface focus tokens are asserted.

import { useEffect, useRef, type ReactNode } from "react";
import type { RuntimeDashboardStatus } from "@itotori/db";
import { Panel, ScenePlayer } from "@itotori/ds";
import {
  addressableFocusToken,
  type AddressableLocation,
  type AddressableSurface,
} from "../addressable-routing.js";
import { useApiQuery } from "../use-api-resource.js";
import { ErrorState, LoadingState, ShellHeader } from "../states.js";
import type { ApiCallState } from "../../api-client.js";
import { parseReturnTo } from "../return-to.js";

export { parseReturnTo } from "../return-to.js";

const SURFACE_EYEBROW: Readonly<Record<AddressableSurface, string>> = {
  play: "Play",
  runtime: "Runtime",
  wiki: "Wiki",
  workbench: "Workbench",
};

const KIND_LABEL: Readonly<Record<AddressableLocation["kind"], string>> = {
  unit: "Unit",
  scene: "Scene",
  route: "Route",
  character: "Character",
  term: "Term",
  run: "Run",
  finding: "Finding",
};

export function AddressableFocusScreen({ location }: { location: AddressableLocation }): ReactNode {
  if (location.surface === "play" && (location.kind === "unit" || location.kind === "scene")) {
    return <PlayerAddressableFocusScreen location={location} />;
  }
  if (location.kind === "run") {
    return <RuntimeRunFocusScreen location={location} />;
  }
  return <AddressableFocusContent location={location} />;
}

/**
 * The canonical addressable player surface for a scene/unit. The focus effect
 * targets the rendered player region itself: it scrolls to center, receives
 * DOM focus, and asks ScenePlayer to draw its highlighted state. This makes a
 * citation arrival observable and usable without relying on a marker attr.
 */
function PlayerAddressableFocusScreen({ location }: { location: AddressableLocation }): ReactNode {
  const targetRef = useRef<HTMLElement>(null);
  const returnTo = parseReturnTo(location.search);
  const flagHref = playFlagHref(location, returnTo);
  const focus = location.focus;

  useEffect(() => {
    const target = targetRef.current;
    if (target === null) {
      return;
    }
    target.scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: true });
  }, [focus.id, focus.kind, location.pathname, location.search]);

  const sceneLabel = location.kind === "scene" ? ` in scene ${location.id}` : "";
  return (
    <main
      className="itotori-shell addressable-player"
      data-screen="addressable-player"
      data-player-kind={location.kind}
      data-project-id={location.projectId ?? undefined}
      data-locale-branch-id={location.localeBranchId ?? undefined}
    >
      <ShellHeader eyebrow="Play" title="Addressed player unit" />
      <section
        ref={targetRef}
        className="addressable-player__target"
        tabIndex={-1}
        aria-label={`Focused player ${focus.kind} ${focus.id}`}
      >
        <p role="status" className="addressable-player__arrival">
          Player positioned at {focus.kind} <code>{focus.id}</code>
          {sceneLabel}.
        </p>
        <ScenePlayer unitId={focus.id} mode="play" status="addressed" highlighted />
      </section>
      <PlayerReturnActions flagHref={flagHref} returnTo={returnTo} kind={location.kind} />
    </main>
  );
}

function RuntimeRunFocusScreen({ location }: { location: AddressableLocation }): ReactNode {
  const runtime = useApiQuery(
    "runtime.status",
    { query: { runtimeRunId: location.id } },
    `addressable-runtime-run:${location.id}`,
  );
  return <AddressableFocusContent location={location} runtimeState={runtime} />;
}

function AddressableFocusContent({
  location,
  runtimeState,
}: {
  location: AddressableLocation;
  runtimeState?: ApiCallState<RuntimeDashboardStatus>;
}): ReactNode {
  const focusToken = addressableFocusToken(location.focus);
  const kindLabel = KIND_LABEL[location.kind];
  const returnTo = parseReturnTo(location.search);
  const flagHref = playFlagHref(location, returnTo);
  return (
    <main
      className="itotori-shell addressable-focus"
      data-screen="addressable-focus"
      data-addressable-kind={location.kind}
      data-addressable-id={location.id}
      data-addressable-surface={location.surface}
      data-addressable-focus={focusToken}
      data-addressable-focused="true"
      data-project-id={location.projectId ?? undefined}
      data-locale-branch-id={location.localeBranchId ?? undefined}
      {...(returnTo !== null ? { "data-return-to": returnTo } : {})}
    >
      <ShellHeader eyebrow={SURFACE_EYEBROW[location.surface]} title={`${kindLabel} focus`} />
      <Panel
        title={kindLabel}
        eyebrow="Addressable"
        className="addressable-focus__panel"
        data-addressable-focus={focusToken}
      >
        <p role="status" data-addressable-focus-status="focused">
          Focused {location.kind} <code data-addressable-id-value>{location.id}</code>
        </p>
        {runtimeState !== undefined && <RuntimeRunFocusStatus state={runtimeState} />}
        {location.unitId !== null && location.kind === "scene" && (
          <p data-nested-unit-id={location.unitId}>
            Nested unit <code>{location.unitId}</code>
          </p>
        )}
        <PlayerReturnActions flagHref={flagHref} returnTo={returnTo} kind={location.kind} />
      </Panel>
    </main>
  );
}

function PlayerReturnActions({
  flagHref,
  returnTo,
  kind,
}: {
  flagHref: string | null;
  returnTo: string | null;
  kind: AddressableLocation["kind"];
}): ReactNode {
  if (flagHref === null && returnTo === null) {
    return null;
  }
  return (
    <div className="addressable-player__actions" aria-label="Addressed player actions">
      {flagHref !== null && (
        <p>
          <a href={flagHref}>Flag this {kind}</a>
        </p>
      )}
      {returnTo !== null && (
        <p>
          <a href={returnTo}>Return to addressed wiki object</a>
        </p>
      )}
    </div>
  );
}

function playFlagHref(location: AddressableLocation, returnTo: string | null): string | null {
  if (location.surface !== "play") {
    return null;
  }
  if (location.projectId === null || location.localeBranchId === null) {
    return null;
  }
  const params = new URLSearchParams({
    projectId: location.projectId,
    localeBranchId: location.localeBranchId,
  });
  if (location.kind === "unit") {
    params.set("unitId", location.id);
  } else if (location.kind === "scene") {
    params.set("sceneId", location.id);
    if (location.unitId !== null) {
      params.set("unitId", location.unitId);
    }
  } else {
    return null;
  }
  if (returnTo !== null) {
    params.set("returnTo", returnTo);
  }
  return `/play/flag?${params.toString()}`;
}

function RuntimeRunFocusStatus({
  state,
}: {
  state: ApiCallState<RuntimeDashboardStatus>;
}): ReactNode {
  if (state.state === "loading") {
    return <LoadingState label="Loading runtime evidence…" />;
  }
  if (state.state === "error" && state.error.code === "not_found") {
    return (
      <p role="alert" data-runtime-run-state="stale">
        This runtime evidence link is stale or the run is no longer available.
      </p>
    );
  }
  if (state.state === "error") {
    return <ErrorState title="Runtime evidence" error={state.error} />;
  }
  if (state.state === "ready") {
    return <p data-runtime-run-state="available">Runtime evidence is available.</p>;
  }
  return null;
}
