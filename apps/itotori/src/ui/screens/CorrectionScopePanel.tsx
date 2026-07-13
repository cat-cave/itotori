// rev-correction-loop-ui — the reviewer detail CORRECTION SCOPE panel.
//
// A panel WITHIN the reviewer detail screen (not a new route): for the
// correction under review it shows the correction's SCOPE (which unit / scene
// it affects) and which durable RUN folds it in. It consumes the
// context-correction preview read-model — the `workspace.correctionPreview`
// GET read-model, the read-only leg of the correction feedback loop
// (ITOTORI-118) — DIRECTLY through the typed `ItotoriApiClient`
// (`useApiQuery`, never an ad-hoc fetch), and derives the folding run from
// the durable journal read-model (`projects.overview.journal`): the latest
// recorded localization run is N, so the next run (N+1) is the
// one that folds this correction in. This is a READ-ONLY display — it does
// not depend on the `ovw-launch-pass-action` runtime (it neither launches a
// pass nor submits a correction); it only paints the correction's blast
// radius + landing pass from the existing read-models.
//
// Painted with `@itotori/ds` (`Panel`, `ComparisonPane`, `StatReadout`,
// `Badge`); className-based, ds tokens, no literal styles, no game named.
// [[feedback_behavior_first_code_agnostic_testing]] — the behavior-first test
// mounts the panel over an msw-intercepted read-model and asserts only the
// rendered scope + folding pass + loading / empty / error surfaces.

import type { ReactNode } from "react";
import { Badge, ComparisonPane, Panel, StatReadout } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { ProjectOverviewReadModel } from "../../project-overview-read-model.js";
import type {
  WorkspaceCorrectionPreviewReadModel,
  WorkspaceCorrectionPreviewUnit,
} from "../../workspace/index.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

// ---------------------------------------------------------------------------
// Pure derivation — the folding run (N+1) from the journal count.
// ---------------------------------------------------------------------------

/**
 * The correction's folding run, derived from the durable journal read-model.
 * The latest recorded localization run is `N`; the correction folds into the
 * next run (`N + 1`). When no run has been recorded yet the first run (`1`)
 * folds it in.
 */
export type CorrectionFoldingRun = {
  /** The latest recorded run ordinal (`N`), or `null` when none exists yet. */
  latestRunNumber: number | null;
  /** The run that folds the correction in (`N + 1`, or `1` for the first). */
  foldingRun: number;
};

export function deriveCorrectionFoldingRun(runCount: number): CorrectionFoldingRun {
  if (runCount === 0) {
    return { latestRunNumber: null, foldingRun: 1 };
  }
  return { latestRunNumber: runCount, foldingRun: runCount + 1 };
}

// ---------------------------------------------------------------------------
// Panel — owns its context-correction preview read through the typed client.
// The preview is shared in spirit with the workspace correction flow, but
// each panel issues its own typed query (the api-client's per-depsKey cache
// keeps the reads independent; a re-render does not double-fetch).
// ---------------------------------------------------------------------------

export interface CorrectionScopePanelProps {
  /** Reviewer item the correction is scoped to (the preview `reviewItemIds` key). */
  reviewItemId: string;
  /** Locale branch the correction belongs to (the preview `localeBranchId` key). */
  localeBranchId: string;
}

/**
 * The reviewer detail correction-scope panel. Issues the typed
 * `workspace.correctionPreview` query (the context-correction
 * read-model) + the `projects.overview` query (the repair / execution-journal
 * read-model) through the API client and renders the correction's scope +
 * folding pass. Settles into loading / empty / error independently of the
 * parent screen.
 */
export function CorrectionScopePanel({
  reviewItemId,
  localeBranchId,
}: CorrectionScopePanelProps): ReactNode {
  const preview = useApiQuery(
    "workspace.correctionPreview",
    { query: { localeBranchId, reviewItemIds: reviewItemId } },
    `correction-preview:${reviewItemId}:${localeBranchId}`,
  );
  const overview = useApiQuery("projects.overview", {}, "correction-scope-overview");
  return (
    <CorrectionScopePanelBody
      preview={preview}
      overview={overview}
      reviewItemId={reviewItemId}
      localeBranchId={localeBranchId}
    />
  );
}

/**
 * The state-bound panel body. Exported (and the props are the resolved
 * `ApiCallState`s) so a behavior-first test can mount the panel over a mock
 * read-model without standing up the full msw round-trip.
 */
export function CorrectionScopePanelBody({
  preview,
  overview,
  reviewItemId,
  localeBranchId,
}: {
  preview: ApiCallState<WorkspaceCorrectionPreviewReadModel>;
  overview: ApiCallState<ProjectOverviewReadModel>;
  reviewItemId: string;
  localeBranchId: string;
}): ReactNode {
  return (
    <Panel
      title="Correction scope"
      eyebrow="Correction → next pass"
      className="itotori-panel--correction-scope"
      data-pane-id="correction-scope"
      data-pane-state={preview.state}
      data-review-item-id={reviewItemId}
    >
      <CorrectionScopeBodyContent
        preview={preview}
        overview={overview}
        reviewItemId={reviewItemId}
        localeBranchId={localeBranchId}
      />
    </Panel>
  );
}

function CorrectionScopeBodyContent({
  preview,
  overview,
  reviewItemId,
  localeBranchId,
}: {
  preview: ApiCallState<WorkspaceCorrectionPreviewReadModel>;
  overview: ApiCallState<ProjectOverviewReadModel>;
  reviewItemId: string;
  localeBranchId: string;
}): ReactNode {
  if (preview.state === "loading") {
    return <LoadingState label="Loading correction scope…" />;
  }
  if (preview.state === "error") {
    return <ErrorState title="Correction scope" error={preview.error} />;
  }
  if (preview.state === "empty") {
    return (
      <EmptyState
        title="No correction scope"
        message="No context-correction preview was returned for this reviewer item."
      />
    );
  }
  // `ready` — the preview always carries at least one unit for a requested
  // review item (a unit with null source/draft when the context is
  // unavailable, surfaced through its own diagnostics). Match the requested
  // review item, falling back to the first unit if the server did not echo it.
  const unit =
    preview.data.units.find((entry) => entry.reviewItemId === reviewItemId) ??
    preview.data.units[0] ??
    null;
  if (unit === null) {
    return (
      <EmptyState
        title="No correction scope"
        message="No context-correction preview was returned for this reviewer item."
      />
    );
  }
  return <CorrectionScopeReady unit={unit} overview={overview} localeBranchId={localeBranchId} />;
}

function CorrectionScopeReady({
  unit,
  overview,
  localeBranchId,
}: {
  unit: WorkspaceCorrectionPreviewUnit;
  overview: ApiCallState<ProjectOverviewReadModel>;
  localeBranchId: string;
}): ReactNode {
  const foldingRun = foldingRunFromOverview(overview);
  const targetLocale = unit.targetLocale ?? "target";
  return (
    <div className="itotori-correction-scope" data-correction-scope="ready">
      <div className="itotori-metric-row" aria-label="Correction scope">
        <StatReadout
          label="Folds into"
          value={<Badge status="succeeded">run {foldingRun.foldingRun}</Badge>}
        />
        <StatReadout
          label="Built on"
          value={foldingRun.latestRunNumber === null ? "—" : `run ${foldingRun.latestRunNumber}`}
        />
        <StatReadout label="Bridge unit" value={unit.bridgeUnitId ?? "—"} mono />
        <StatReadout label="Scene / unit key" value={unit.sourceUnitKey ?? "—"} mono />
      </div>

      <CorrectionText unit={unit} draftLocale={targetLocale} />

      <p className="itotori-correction-scope__landing">
        The next localization run <code>run {foldingRun.foldingRun}</code> folds this correction
        into every unit sharing its source on locale branch <code>{localeBranchId}</code>.
      </p>

      {unit.diagnostics.length > 0 && (
        <ul className="itotori-correction-scope__diagnostics" role="alert">
          {unit.diagnostics.map((diagnostic) => (
            <li key={diagnostic.code} data-diagnostic-code={diagnostic.code}>
              <Badge status="warning">{diagnostic.code}</Badge> {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The correction itself: draft → final (the corrected target). Falls back to a
// note when neither a draft nor a corrected text was loaded, mirroring the
// reviewer detail's `MissingContext` copy.
function CorrectionText({
  unit,
  draftLocale,
}: {
  unit: WorkspaceCorrectionPreviewUnit;
  draftLocale: string;
}): ReactNode {
  if (unit.draftText === null && unit.finalText === null) {
    return (
      <p className="itotori-empty-copy">
        No draft or corrected text loaded for this correction — see diagnostic.
      </p>
    );
  }
  return (
    <ComparisonPane
      source={unit.draftText ?? ""}
      draft={unit.finalText ?? unit.draftText ?? ""}
      sourceLabel={`Draft · ${draftLocale}`}
      draftLabel={`Corrected · ${draftLocale}`}
    />
  );
}

function foldingRunFromOverview(
  overview: ApiCallState<ProjectOverviewReadModel>,
): CorrectionFoldingRun {
  if (overview.state !== "ready") {
    // While the journal loads / errors, the next durable run is unknown; show
    // the first-run fallback until the actual run count becomes available.
    return { latestRunNumber: null, foldingRun: 1 };
  }
  return deriveCorrectionFoldingRun(overview.data.journal.pagination.total);
}
