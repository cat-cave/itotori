// fnd-addressable-routing — focus shell for addressable deep-links whose
// full surface UI is not yet ported (wiki / runtime run / finding). The
// backbone MUST still resolve + focus so cmdk + cross-surface jumps work
// before wiki-entry-ui / xs-deep-jumps land. Renders inside the shell frame
// with a stable `data-addressable-focus` token the acceptance pins.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the resolved kind/id/surface focus tokens are asserted.

import type { ReactNode } from "react";
import type { RuntimeDashboardStatus } from "@itotori/db";
import { Panel } from "@itotori/ds";
import {
  addressableFocusToken,
  type AddressableLocation,
  type AddressableSurface,
} from "../addressable-routing.js";
import { useApiQuery } from "../use-api-resource.js";
import { ErrorState, LoadingState, ShellHeader } from "../states.js";
import type { ApiCallState } from "../../api-client.js";

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
  if (location.kind === "run") {
    return <RuntimeRunFocusScreen location={location} />;
  }
  return <AddressableFocusContent location={location} />;
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
      </Panel>
    </main>
  );
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
