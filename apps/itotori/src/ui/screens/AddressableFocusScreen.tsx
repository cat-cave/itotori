// fnd-addressable-routing — focus shell for addressable deep-links whose
// full surface UI is not yet ported (wiki / runtime run / finding). The
// backbone MUST still resolve + focus so cmdk + cross-surface jumps work
// before wiki-entry-ui / xs-deep-jumps land. Renders inside the shell frame
// with a stable `data-addressable-focus` token the acceptance pins.
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the resolved kind/id/surface focus tokens are asserted.

import type { ReactNode } from "react";
import { Panel } from "@itotori/ds";
import {
  addressableFocusToken,
  type AddressableLocation,
  type AddressableSurface,
} from "../addressable-routing.js";
import { ShellHeader } from "../states.js";

const SURFACE_EYEBROW: Readonly<Record<AddressableSurface, string>> = {
  play: "Play",
  review: "Review",
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
        {location.unitId !== null && location.kind === "scene" && (
          <p data-nested-unit-id={location.unitId}>
            Nested unit <code>{location.unitId}</code>
          </p>
        )}
      </Panel>
    </main>
  );
}
