// play-scene-picker-bitext (HI-FI STUDIO EPIC · Play) — the Play scene picker.
//
// A PLAYBACK surface: the user browses the localization by SCENE, navigating
// purely by each scene's TRANSLATED summary (`summaryText`), then reads the
// source ↔ draft BiText for a cited unit. Backed by the two EXISTING
// workspace read-models — `workspace.scenes` (the translated-summary scene
// browse) + `workspace.comparison` (the source / draft / final cells) —
// consumed THROUGH the typed `ItotoriApiClient` (`useApiQuery`, never an
// ad-hoc fetch) and painted with `@itotori/ds` (NavPills / DataTable /
// BiText / Panel), tokens-never-literals.
//
// The scene browse exposes each unit's `bridgeUnitId`; the comparison
// read-model is keyed by `reviewItemId`. This screen is a READ-ONLY consumer
// of the existing routes (no api-contract / api-schema / api-handlers /
// services edits — see the brief), so the selected unit's `bridgeUnitId` is
// passed as the comparison's `reviewItemId` lookup key. The endpoint treats
// it as an opaque key; a unit that has no comparison context settles to the
// structured `empty` state (never a blank panel).
//
// Rendered INSIDE the shell frame (the shell-frame-ui gate): `App` dispatches
// `/play` here, and the shell frame wraps every routed screen.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered scene summaries + source ↔ draft BiText + loading / empty /
// error states are asserted.

import { useState, type ReactNode } from "react";
import { Badge, BiText, DataTable, NavPills, Panel, type NavPillItem } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type {
  ApiWorkspaceComparisonResponse,
  ApiWorkspaceSceneBrowseResponse,
} from "../../api-schema.js";
import type {
  WorkspaceComparisonReadModel,
  WorkspaceSceneContext,
  WorkspaceSceneUnit,
} from "../../workspace/index.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";

// ---------------------------------------------------------------------------
// Route identity — `/play` (bare). An optional `?projectId=&localeBranchId=`
// query scopes the picker explicitly; omitted, the screen falls back to the
// project's selected locale branch (the same source the reviewer-queue screen
// and the dashboard reviewer panel use).
// ---------------------------------------------------------------------------

export const playScenePickerRoutePathRegex = /^\/play\/?$/u;

export type PlayScenePickerRouteParams = {
  projectId: string | null;
  localeBranchId: string | null;
};

export function parsePlayScenePickerRoute(
  pathname: string,
  search: string,
): PlayScenePickerRouteParams | null {
  if (!playScenePickerRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  const projectId = nonEmpty(params.get("projectId"));
  const localeBranchId = nonEmpty(params.get("localeBranchId"));
  return { projectId, localeBranchId };
}

function nonEmpty(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Screen — dispatches on whether a branch scope was supplied explicitly.
// ---------------------------------------------------------------------------

export function PlayScenePickerScreen({ route }: { route: PlayScenePickerRouteParams }): ReactNode {
  if (route.projectId !== null && route.localeBranchId !== null) {
    return (
      <PlayScenePickerForBranch projectId={route.projectId} localeBranchId={route.localeBranchId} />
    );
  }
  return <PlayScenePickerFromStatus />;
}

/**
 * No explicit `?projectId=&localeBranchId=` — scope the picker to the
 * project's selected locale branch, read through the typed client.
 */
function PlayScenePickerFromStatus(): ReactNode {
  const status = useApiQuery("projects.status", {}, "play-scene-picker:status");
  if (status.state === "loading") {
    return (
      <main
        className="itotori-shell play-scene-picker"
        data-screen="play-scene-picker"
        data-state="loading"
      >
        <ShellHeader eyebrow="Play" title="Scene picker" />
        <LoadingState label="Loading project context…" />
      </main>
    );
  }
  if (status.state === "error") {
    return (
      <main
        className="itotori-shell play-scene-picker"
        data-screen="play-scene-picker"
        data-state="error"
      >
        <ShellHeader eyebrow="Play" title="Scene picker" />
        <ErrorState title="Scene picker" error={status.error} />
      </main>
    );
  }
  const projectId = status.state === "ready" ? status.data.projectId : null;
  const localeBranchId = status.state === "ready" ? status.data.selectedLocaleBranchId : null;
  if (projectId === null || localeBranchId === null) {
    return (
      <main
        className="itotori-shell play-scene-picker"
        data-screen="play-scene-picker"
        data-state="empty"
      >
        <ShellHeader eyebrow="Play" title="Scene picker" />
        <EmptyState
          title="No locale branch selected"
          message="Select a locale branch to browse scenes for playback."
        />
      </main>
    );
  }
  return <PlayScenePickerForBranch projectId={projectId} localeBranchId={localeBranchId} />;
}

function PlayScenePickerForBranch({
  projectId,
  localeBranchId,
}: {
  projectId: string;
  localeBranchId: string;
}): ReactNode {
  const scenes = useApiQuery(
    "workspace.scenes",
    { query: { projectId, localeBranchId } },
    `play-scene-picker:scenes:${projectId}:${localeBranchId}`,
  );
  return (
    <main
      className="itotori-shell play-scene-picker"
      data-screen="play-scene-picker"
      data-state={scenes.state}
      data-locale-branch-id={localeBranchId}
    >
      <ShellHeader eyebrow="Play" title="Scene picker" />
      {scenes.state === "loading" && <LoadingState label="Loading scenes…" />}
      {scenes.state === "empty" && (
        <EmptyState
          title="Scene picker"
          message="No scenes were returned for this locale branch."
        />
      )}
      {scenes.state === "error" && <ErrorState title="Scene picker" error={scenes.error} />}
      {scenes.state === "ready" && <PlayScenePickerReady model={scenes.data} />}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Ready — the scene picker (NavPills labeled by the TRANSLATED summary) +
// the unit list + the source ↔ draft BiText pane for the selected unit.
// ---------------------------------------------------------------------------

function PlayScenePickerReady({ model }: { model: ApiWorkspaceSceneBrowseResponse }): ReactNode {
  const firstScene = model.scenes[0] ?? null;
  const [selectedSceneId, setSelectedSceneId] = useState<string>(firstScene?.sceneId ?? "");
  const selectedScene =
    model.scenes.find((scene) => scene.sceneId === selectedSceneId) ?? firstScene;

  const firstUnit = preferredUnit(selectedScene);
  const [selectedUnitKey, setSelectedUnitKey] = useState<string>(unitSelectionKey(firstUnit));
  const selectedUnit =
    selectedScene?.units.find((unit) => unitSelectionKey(unit) === selectedUnitKey) ?? firstUnit;

  const sceneItems: NavPillItem[] = model.scenes.map((scene) => ({
    id: scene.sceneId,
    label: scene.summaryText,
    badge: scene.citedUnitCount,
  }));

  const selectScene = (sceneId: string): void => {
    setSelectedSceneId(sceneId);
    const scene = model.scenes.find((entry) => entry.sceneId === sceneId) ?? null;
    setSelectedUnitKey(unitSelectionKey(preferredUnit(scene)));
  };

  return (
    <section
      className="play-scene-picker__body"
      aria-label="Play scene picker"
      data-selected-scene-id={selectedScene?.sceneId ?? ""}
    >
      <NavPills
        items={sceneItems}
        activeId={selectedScene?.sceneId ?? ""}
        onSelect={selectScene}
        label="Scenes by translated summary"
        className="play-scene-picker__scenes"
      />
      {selectedScene === null ? (
        <EmptyState
          title="No scene selected"
          message="This locale branch has no scenes to browse."
        />
      ) : (
        <SceneDetail
          scene={selectedScene}
          selectedUnit={selectedUnit}
          onSelectUnit={setSelectedUnitKey}
        />
      )}
    </section>
  );
}

function SceneDetail({
  scene,
  selectedUnit,
  onSelectUnit,
}: {
  scene: WorkspaceSceneContext;
  selectedUnit: WorkspaceSceneUnit | null;
  onSelectUnit: (key: string) => void;
}): ReactNode {
  return (
    <Panel
      title={scene.summaryText}
      eyebrow={`${scene.summaryLocale} · ${scene.citedUnitCount} cited unit(s)`}
      className="play-scene-picker__scene"
    >
      {scene.stale && <Badge status="stale">stale summary</Badge>}
      <DataTable
        caption="Cited units"
        columns={[
          { key: "key", header: "Unit", render: (u) => <code>{u.sourceUnitKey}</code> },
          { key: "speaker", header: "Speaker", render: (u) => u.speaker ?? "—" },
          { key: "cited", header: "Cited", render: (u) => (u.cited ? "yes" : "no") },
        ]}
        rows={scene.units}
        getRowKey={(u) => unitSelectionKey(u)}
        onRowActivate={(u) => onSelectUnit(unitSelectionKey(u))}
        emptyLabel="No units were cited for this scene."
      />
      {selectedUnit !== null ? (
        <PlayComparisonPane unit={selectedUnit} />
      ) : (
        <EmptyState
          title="No unit selected"
          message="Select a cited unit to read its source ↔ draft."
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// PlayComparisonPane — issues the typed `workspace.comparison` query for the
// selected unit and renders the source ↔ draft BiText from the returned
// cells. Settles into loading / empty / error independently of the parent.
// ---------------------------------------------------------------------------

function PlayComparisonPane({ unit }: { unit: WorkspaceSceneUnit }): ReactNode {
  // The comparison read-model is keyed by `reviewItemId`; the scene browse
  // exposes each unit's `bridgeUnitId`. This Play surface is a read-only
  // consumer of the existing routes, so the unit's `bridgeUnitId` is passed
  // as the comparison's lookup key (the endpoint treats it as opaque).
  const comparison = useApiQuery(
    "workspace.comparison",
    { query: { reviewItemId: unit.bridgeUnitId } },
    `play-scene-picker:comparison:${unit.bridgeUnitId}`,
  );
  return (
    <Panel
      title="Source ↔ draft"
      eyebrow="BiText"
      className="play-scene-picker__bitext"
      data-pane-state={comparison.state}
    >
      <ComparisonBody comparison={comparison} unit={unit} />
    </Panel>
  );
}

function ComparisonBody({
  comparison,
  unit,
}: {
  comparison: ApiCallState<ApiWorkspaceComparisonResponse>;
  unit: WorkspaceSceneUnit;
}): ReactNode {
  if (comparison.state === "loading") {
    return <LoadingState label="Loading source ↔ draft…" />;
  }
  if (comparison.state === "error") {
    return <ErrorState title="Source ↔ draft" error={comparison.error} />;
  }
  const model = comparison.state === "ready" ? comparison.data : null;
  if (model === null) {
    return (
      <EmptyState
        title="No source ↔ draft"
        message="No workspace comparison was returned for this unit."
      />
    );
  }
  if (!model.permission.canReadQueue) {
    const reason =
      model.permission.denialReasons[0] ?? `user ${model.permission.actorUserId} cannot read queue`;
    return (
      <p role="alert" className="play-scene-picker__denied">
        {reason}
      </p>
    );
  }
  return <BiTextFromComparison model={model} unit={unit} />;
}

function BiTextFromComparison({
  model,
  unit,
}: {
  model: WorkspaceComparisonReadModel;
  unit: WorkspaceSceneUnit;
}): ReactNode {
  const source = model.cells.find((cell) => cell.side === "source") ?? null;
  const draft = model.cells.find((cell) => cell.side === "draft") ?? null;
  if (source === null && draft === null) {
    return (
      <EmptyState
        title="Source ↔ draft unavailable"
        message="Neither source nor draft text was loaded for this unit."
      />
    );
  }
  const sourceLocale = source?.locale ?? "source";
  const targetLocale = draft?.locale ?? "draft";
  return (
    <div className="play-scene-picker__bitext-pair" data-comparison-for={unit.bridgeUnitId}>
      <BiText
        sourceLocale={sourceLocale}
        targetLocale={targetLocale}
        source={source?.text ?? ""}
        translation={draft?.text ?? ""}
        speaker={unit.speaker ?? unit.sourceUnitKey}
      />
      {model.contextNote !== null && (
        <p className="play-scene-picker__context-note">{model.contextNote}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The first CITED unit (the summary's chosen witnesses), falling back to the
 * first unit when none are cited so the BiText pane always opens on a real
 * unit. Returns `null` only when the scene has no units at all.
 */
function preferredUnit(scene: WorkspaceSceneContext | null): WorkspaceSceneUnit | null {
  if (scene === null || scene.units.length === 0) {
    return null;
  }
  const cited = scene.units.find((unit) => unit.cited);
  return cited ?? scene.units[0] ?? null;
}

/** Stable selection key for a scene unit (its bridge unit id). */
function unitSelectionKey(unit: WorkspaceSceneUnit | null): string {
  return unit?.bridgeUnitId ?? "";
}
