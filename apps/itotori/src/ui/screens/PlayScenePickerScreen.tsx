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
// The scene browse exposes both the unit's `bridgeUnitId` and, when available,
// the reviewer queue `reviewItemId` that owns comparison context. The
// comparison read-model remains review-item keyed; Play never treats
// `bridgeUnitId` as a fabricated review item id.
//
// Rendered INSIDE the shell frame (the shell-frame-ui gate): `App` dispatches
// `/play` here, and the shell frame wraps every routed screen.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered scene summaries + source ↔ draft BiText + loading / empty /
// error states are asserted.

import { useState, type ReactNode } from "react";
import type { RuntimeDashboardStatus } from "@itotori/db";
import {
  Badge,
  BiText,
  DataTable,
  NavPills,
  Pagination,
  Panel,
  ScenePlayer,
  type NavPillItem,
} from "@itotori/ds";
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
import { useApiQuery, useApiQueryWhen } from "../use-api-resource.js";
import { useOffsetPager } from "../use-offset-pager.js";
import { RedactedFrame } from "../redaction-governor.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import "./PlayScenePickerScreen.css";

const PLAY_SCENES_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Route identity — `/play` (bare) plus addressable deep-links
// (`/play/units|scenes|routes/:id` via `routeFromAddressable`). Optional
// `?projectId=&localeBranchId=` scopes the picker; omitted, the screen falls
// back to the project's selected locale branch (same source the reviewer-
// queue screen and the dashboard reviewer panel use). Focus fields come from
// fnd-addressable-routing deep-links so a unit/scene/route URL selects +
// stamps `data-addressable-focus`.
// ---------------------------------------------------------------------------

export const playScenePickerRoutePathRegex = /^\/play\/?$/u;

export type PlayScenePickerRouteParams = {
  projectId: string | null;
  localeBranchId: string | null;
  /** Addressable scene focus (`/play/scenes/:id`). */
  focusSceneId: string | null;
  /** Addressable unit focus (`/play/units/:id` or scene `?unit=`). */
  focusUnitId: string | null;
  /** Addressable narrative-route focus (`/play/routes/:id`). */
  focusRouteId: string | null;
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
  return {
    projectId,
    localeBranchId,
    focusSceneId: null,
    focusUnitId: null,
    focusRouteId: null,
  };
}

/**
 * Map an addressable play deep-link (unit / scene / route) onto the Play
 * scene picker's route params. Used by `App` when `parseAddressableLocation`
 * resolves a play-surface target.
 */
export function playRouteFromAddressable(location: {
  kind: "unit" | "scene" | "route";
  id: string;
  projectId: string | null;
  localeBranchId: string | null;
  unitId: string | null;
}): PlayScenePickerRouteParams {
  return {
    projectId: location.projectId,
    localeBranchId: location.localeBranchId,
    focusSceneId: location.kind === "scene" ? location.id : null,
    focusUnitId:
      location.kind === "unit" ? location.id : location.kind === "scene" ? location.unitId : null,
    focusRouteId: location.kind === "route" ? location.id : null,
  };
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
      <PlayScenePickerForBranch
        projectId={route.projectId}
        localeBranchId={route.localeBranchId}
        focus={playFocusFromRoute(route)}
      />
    );
  }
  return <PlayScenePickerFromStatus focus={playFocusFromRoute(route)} />;
}

type PlayFocus = {
  sceneId: string | null;
  unitId: string | null;
  routeId: string | null;
};

function playFocusFromRoute(route: PlayScenePickerRouteParams): PlayFocus {
  return {
    sceneId: route.focusSceneId,
    unitId: route.focusUnitId,
    routeId: route.focusRouteId,
  };
}

/**
 * No explicit `?projectId=&localeBranchId=` — scope the picker to the
 * project's selected locale branch, read through the typed client.
 */
function PlayScenePickerFromStatus({ focus }: { focus: PlayFocus }): ReactNode {
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
  return (
    <PlayScenePickerForBranch projectId={projectId} localeBranchId={localeBranchId} focus={focus} />
  );
}

function PlayScenePickerForBranch({
  projectId,
  localeBranchId,
  focus,
}: {
  projectId: string;
  localeBranchId: string;
  focus: PlayFocus;
}): ReactNode {
  const scenes = useOffsetPager(
    "workspace.scenes",
    { query: { projectId, localeBranchId }, limit: PLAY_SCENES_PAGE_SIZE },
    `play-scene-picker:scenes:${projectId}:${localeBranchId}`,
  );
  const focusedScene = useApiQueryWhen(
    "workspace.scenes",
    {
      query: {
        projectId,
        localeBranchId,
        sceneId: focus.sceneId ?? "",
        limit: 1,
      },
    },
    `play-scene-picker:focused-scene:${projectId}:${localeBranchId}:${focus.sceneId ?? "none"}`,
    focus.sceneId !== null,
  );
  const focusToken = playFocusToken(focus);
  const screenState =
    scenes.page?.data.scenes.length === 0 && focus.sceneId === null ? "empty" : scenes.phase;
  return (
    <main
      className="itotori-shell play-scene-picker"
      data-screen="play-scene-picker"
      data-state={screenState}
      data-locale-branch-id={localeBranchId}
      data-addressable-focus={focusToken ?? undefined}
      data-addressable-focused={focusToken !== null ? "true" : undefined}
      data-focus-route-id={focus.routeId ?? undefined}
    >
      <ShellHeader eyebrow="Play" title="Scene picker" />
      <PlayScenePickerPage pager={scenes} focus={focus} focusedScene={focusedScene} />
    </main>
  );
}

function PlayScenePickerPage({
  pager,
  focus,
  focusedScene,
}: {
  pager: ReturnType<typeof useOffsetPager<"workspace.scenes">>;
  focus: PlayFocus;
  focusedScene: ApiCallState<ApiWorkspaceSceneBrowseResponse>;
}): ReactNode {
  const page = pager.page;
  if (page === null) {
    if (pager.phase === "error" && pager.error !== null) {
      return <ErrorState title="Scene picker" error={pager.error} />;
    }
    return <LoadingState label="Loading scenes…" />;
  }
  if (page.data.scenes.length === 0 && focus.sceneId === null) {
    return (
      <EmptyState title="Scene picker" message="No scenes were returned for this locale branch." />
    );
  }
  const focusMissing =
    focus.sceneId !== null && !page.data.scenes.some((scene) => scene.sceneId === focus.sceneId);
  if (focusMissing && focusedScene.state === "loading") {
    return <LoadingState label="Loading focused scene…" />;
  }
  if (focusMissing && focusedScene.state === "error") {
    return <ErrorState title="Focused scene" error={focusedScene.error} />;
  }
  const model =
    focusMissing && focusedScene.state === "ready"
      ? prependFocusedScene(page.data, focusedScene.data)
      : page.data;
  const readyKey = `${model.pagination.offset}:${playFocusToken(focus) ?? "none"}:${model.scenes
    .map((scene) => scene.sceneId)
    .join("|")}`;
  return <PlayScenePickerReady key={readyKey} model={model} focus={focus} pager={pager} />;
}

/** Prefer unit focus, then scene, then route — the deepest pin wins. */
function playFocusToken(focus: PlayFocus): string | null {
  if (focus.unitId !== null) {
    return `unit:${focus.unitId}`;
  }
  if (focus.sceneId !== null) {
    return `scene:${focus.sceneId}`;
  }
  if (focus.routeId !== null) {
    return `route:${focus.routeId}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ready — the scene picker (NavPills labeled by the TRANSLATED summary) +
// the unit list + the source ↔ draft BiText pane for the selected unit.
// ---------------------------------------------------------------------------

function PlayScenePickerReady({
  model,
  focus,
  pager,
}: {
  model: ApiWorkspaceSceneBrowseResponse;
  focus: PlayFocus;
  pager: ReturnType<typeof useOffsetPager<"workspace.scenes">>;
}): ReactNode {
  const initial = initialPlaySelection(model, focus);
  const [selectedSceneId, setSelectedSceneId] = useState<string>(initial.sceneId);
  const selectedScene =
    model.scenes.find((scene) => scene.sceneId === selectedSceneId) ?? model.scenes[0] ?? null;

  const [selectedUnitKey, setSelectedUnitKey] = useState<string>(initial.unitKey);
  const selectedUnit =
    selectedScene?.units.find((unit) => unitSelectionKey(unit) === selectedUnitKey) ??
    preferredUnit(selectedScene);

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

  const focusToken = playFocusToken(focus);

  return (
    <section
      className="play-scene-picker__body"
      aria-label="Play scene picker"
      data-selected-scene-id={selectedScene?.sceneId ?? ""}
      data-selected-unit-id={selectedUnit?.bridgeUnitId ?? ""}
      data-addressable-focus={focusToken ?? undefined}
      data-addressable-focused={focusToken !== null ? "true" : undefined}
    >
      <NavPills
        items={sceneItems}
        activeId={selectedScene?.sceneId ?? ""}
        onSelect={selectScene}
        label="Scenes by translated summary"
        className="play-scene-picker__scenes"
      />
      <Pagination
        label="Play scenes pagination"
        page={Math.max(0, model.pagination.page - 1)}
        pageCount={Math.max(1, model.pagination.pageCount)}
        totalItems={model.pagination.total}
        itemName="scene"
        onPrevious={pager.previous}
        onNext={pager.next}
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
  const reviewItemId = unit.reviewItemId;
  const comparison = useApiQueryWhen(
    "workspace.comparison",
    { query: { reviewItemId: reviewItemId ?? "" } },
    `play-scene-picker:comparison:${reviewItemId ?? "none"}`,
    reviewItemId !== null,
  );
  const runtime = useApiQueryWhen(
    "runtime.status",
    {},
    `play-filmstrip-alpha:runtime:${reviewItemId ?? "none"}:${unit.bridgeUnitId}`,
    reviewItemId !== null,
  );
  return (
    <Panel
      title="Source ↔ draft"
      eyebrow="BiText"
      className="play-scene-picker__bitext"
      data-pane-state={comparison.state}
    >
      {reviewItemId === null ? (
        <EmptyState
          title="No source ↔ draft"
          message="This scene unit is not linked to a reviewer queue item, so no comparison context is available."
        />
      ) : (
        <ComparisonBody comparison={comparison} runtime={runtime} unit={unit} />
      )}
    </Panel>
  );
}

function ComparisonBody({
  comparison,
  runtime,
  unit,
}: {
  comparison: ApiCallState<ApiWorkspaceComparisonResponse>;
  runtime: ApiCallState<RuntimeDashboardStatus>;
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
  return (
    <>
      <BiTextFromComparison model={model} unit={unit} />
      <PlayEmbeddedScenePlayer runtime={runtime} model={model} unit={unit} />
    </>
  );
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
// play-sceneplayer-embed — runtime-backed ScenePlayer render.
// ---------------------------------------------------------------------------

export type PlayFilmstripArtifact = RuntimeDashboardStatus["artifacts"][number];
export type PlayFilmstripTraceEvent = RuntimeDashboardStatus["traceEvents"][number];

export type PlayFilmstripFrame = {
  artifact: PlayFilmstripArtifact;
  traceEvent: PlayFilmstripTraceEvent | null;
};

const PLAY_FILMSTRIP_ARTIFACT_KINDS = ["screenshot", "frame_capture"] as const;

/**
 * Resolve the localized textbox copy the alpha filmstrip composites over the
 * captured frame. Prefer final text when present, then draft text; source text
 * is not a localized textbox.
 */
export function localizedTextboxText(model: WorkspaceComparisonReadModel): string | null {
  const finalText = model.cells.find((cell) => cell.side === "final")?.text.trim();
  if (finalText !== undefined && finalText.length > 0) {
    return finalText;
  }
  const draftText = model.cells.find((cell) => cell.side === "draft")?.text.trim();
  return draftText !== undefined && draftText.length > 0 ? draftText : null;
}

/**
 * Runtime-status is the exposed read-model for persisted runtimeEvidenceItems.
 * The alpha filmstrip uses only captured-frame evidence (screenshots and frame
 * captures) for the selected unit, preserving runtime order by frame number
 * when trace rows carry it.
 */
export function filmstripFramesForUnit(
  status: RuntimeDashboardStatus,
  unit: WorkspaceSceneUnit,
): PlayFilmstripFrame[] {
  const traceByArtifact = new Map<string, PlayFilmstripTraceEvent>();
  for (const event of status.traceEvents) {
    for (const artifactId of event.artifactIds) {
      if (!traceByArtifact.has(artifactId)) {
        traceByArtifact.set(artifactId, event);
      }
    }
  }

  return status.artifacts
    .filter((artifact) => isPlayFilmstripArtifact(artifact))
    .filter((artifact) => artifactMatchesUnit(artifact, unit))
    .map((artifact) => ({ artifact, traceEvent: traceByArtifact.get(artifact.artifactId) ?? null }))
    .sort((left, right) => {
      const leftFrame = left.traceEvent?.frame ?? Number.MAX_SAFE_INTEGER;
      const rightFrame = right.traceEvent?.frame ?? Number.MAX_SAFE_INTEGER;
      if (leftFrame !== rightFrame) {
        return leftFrame - rightFrame;
      }
      return left.artifact.artifactId.localeCompare(right.artifact.artifactId);
    });
}

function isPlayFilmstripArtifact(artifact: PlayFilmstripArtifact): boolean {
  return (PLAY_FILMSTRIP_ARTIFACT_KINDS as readonly string[]).includes(artifact.artifactKind);
}

function artifactMatchesUnit(artifact: PlayFilmstripArtifact, unit: WorkspaceSceneUnit): boolean {
  return (
    artifact.bridgeUnitId === unit.bridgeUnitId || artifact.sourceUnitKey === unit.sourceUnitKey
  );
}

function PlayEmbeddedScenePlayer({
  runtime,
  model,
  unit,
}: {
  runtime: ApiCallState<RuntimeDashboardStatus>;
  model: WorkspaceComparisonReadModel;
  unit: WorkspaceSceneUnit;
}): ReactNode {
  const textbox = localizedTextboxText(model);
  const source = model.cells.find((cell) => cell.side === "source") ?? null;
  const draft = model.cells.find((cell) => cell.side === "draft") ?? null;
  return (
    <Panel
      title="Embedded ScenePlayer"
      eyebrow="Utsushi render"
      className="play-filmstrip"
      data-pane-id="play-sceneplayer-embed"
      data-pane-state={runtime.state}
      data-filmstrip-unit-id={unit.bridgeUnitId}
      data-sceneplayer-mode="play"
    >
      {runtime.state === "loading" && <LoadingState label="Loading Utsushi scene render..." />}
      {runtime.state === "error" && (
        <ErrorState title="Embedded ScenePlayer" error={runtime.error} />
      )}
      {runtime.state === "empty" && (
        <EmptyState
          title="No Utsushi render"
          message="The runtime dashboard returned no frame evidence for this unit."
        />
      )}
      {runtime.state === "ready" && textbox === null && (
        <EmptyState
          title="No localized textbox"
          message="No draft or final text was returned for this unit."
        />
      )}
      {runtime.state === "ready" && textbox !== null && (
        <PlayEmbeddedScenePlayerReady
          status={runtime.data}
          unit={unit}
          sourceText={source?.text ?? unit.sourceText}
          translationText={textbox}
          sourceLocale={source?.locale}
          targetLocale={draft?.locale}
        />
      )}
    </Panel>
  );
}

function PlayEmbeddedScenePlayerReady({
  status,
  unit,
  sourceText,
  translationText,
  sourceLocale,
  targetLocale,
}: {
  status: RuntimeDashboardStatus;
  unit: WorkspaceSceneUnit;
  sourceText: string | null;
  translationText: string;
  sourceLocale: string | undefined;
  targetLocale: string | undefined;
}): ReactNode {
  const frames = filmstripFramesForUnit(status, unit);
  if (frames.length === 0) {
    return (
      <EmptyState
        title="No captured frames"
        message="No screenshot or frame-capture evidence matched the selected unit."
      />
    );
  }
  const frame = frames[0]!;
  const frameNode =
    frame.artifact.uri === null ? (
      <div className="play-filmstrip__missing-frame" aria-hidden="true">
        {frame.artifact.artifactKind}
      </div>
    ) : (
      <img className="play-filmstrip__image" src={artifactStoreUrl(frame.artifact.uri)} alt="" />
    );
  return (
    <div
      className="play-sceneplayer-embed"
      data-filmstrip-artifact-id={frame.artifact.artifactId}
      data-filmstrip-artifact-kind={frame.artifact.artifactKind}
      data-filmstrip-artifact-uri={frame.artifact.uri ?? undefined}
      data-sceneplayer-runtime-run-id={status.runtimeRunId ?? undefined}
      data-sceneplayer-runtime-report-id={status.runtimeReportId ?? undefined}
    >
      <ScenePlayer
        unitId={unit.bridgeUnitId}
        mode="play"
        sourceText={sourceText}
        translationText={translationText}
        {...(sourceLocale !== undefined ? { sourceLocale } : {})}
        {...(targetLocale !== undefined ? { targetLocale } : {})}
        speaker={unit.speaker ?? unit.sourceUnitKey}
        status={scenePlayerStatus(status)}
        frame={
          <RedactedFrame sensitive label="Utsushi scene frame · redacted">
            {frameNode}
          </RedactedFrame>
        }
      />
      <p className="play-filmstrip__meta">
        <code>{frame.artifact.artifactId}</code>
        {frame.traceEvent?.frame === null || frame.traceEvent?.frame === undefined
          ? null
          : ` · frame ${frame.traceEvent.frame}`}
      </p>
    </div>
  );
}

export function scenePlayerStatus(status: RuntimeDashboardStatus): string {
  if (status.finalStatus === "runtime_passed") {
    return "runtime-faithful";
  }
  if (status.runtimeStatus === "running") {
    return "running";
  }
  if (status.frameCaptureCount > 0 || status.screenshotArtifactCount > 0) {
    return "captured";
  }
  return status.runtimeStatus ?? "captured";
}

export function artifactStoreUrl(uri: string): string {
  return `/artifact-store/${encodeURIComponent(uri)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the initial scene + unit selection from an addressable focus.
 * - unit focus: select the scene that owns the bridge unit (or first scene)
 * - scene focus: select that scene (+ nested unit when present)
 * - route focus / none: first scene + preferred unit (route is stamped on
 *   the shell via `data-focus-route-id`; scene browse has no route axis yet)
 */
function initialPlaySelection(
  model: ApiWorkspaceSceneBrowseResponse,
  focus: PlayFocus,
): { sceneId: string; unitKey: string } {
  if (focus.unitId !== null) {
    for (const scene of model.scenes) {
      const unit = scene.units.find((entry) => entry.bridgeUnitId === focus.unitId);
      if (unit !== undefined) {
        return { sceneId: scene.sceneId, unitKey: unitSelectionKey(unit) };
      }
    }
  }
  if (focus.sceneId !== null) {
    const scene = model.scenes.find((entry) => entry.sceneId === focus.sceneId) ?? null;
    if (scene !== null) {
      if (focus.unitId !== null) {
        const unit = scene.units.find((entry) => entry.bridgeUnitId === focus.unitId);
        if (unit !== undefined) {
          return { sceneId: scene.sceneId, unitKey: unitSelectionKey(unit) };
        }
      }
      return { sceneId: scene.sceneId, unitKey: unitSelectionKey(preferredUnit(scene)) };
    }
  }
  const firstScene = model.scenes[0] ?? null;
  return {
    sceneId: firstScene?.sceneId ?? "",
    unitKey: unitSelectionKey(preferredUnit(firstScene)),
  };
}

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

function prependFocusedScene(
  pageModel: ApiWorkspaceSceneBrowseResponse,
  focusedModel: ApiWorkspaceSceneBrowseResponse,
): ApiWorkspaceSceneBrowseResponse {
  const focused = focusedModel.scenes[0] ?? null;
  if (focused === null || pageModel.scenes.some((scene) => scene.sceneId === focused.sceneId)) {
    return pageModel;
  }
  return {
    ...pageModel,
    diagnostics: [...pageModel.diagnostics, ...focusedModel.diagnostics],
    scenes: [focused, ...pageModel.scenes],
  };
}
