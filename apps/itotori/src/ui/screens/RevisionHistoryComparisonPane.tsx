// rev-comparison-pane — the reviewer detail REVISION HISTORY pane.
//
// A pane WITHIN the reviewer detail screen (not a new route), wired into the
// existing `ReviewerDetailScreen` so every reviewer detail opens with a side-
// by-side HISTORY comparison: source ↔ draft ↔ re-draft. Backed by the
// `workspace.comparison` read-model — the JSON API route that already maps
// `loadComparisonContext` (the single source of truth, also re-used by the
// `WorkspaceScreen` comparison view) — and consumed THROUGH the typed
// `ItotoriApiClient` (`useApiQuery`). The pane is rendered with the
// `@itotori/ds` `ComparisonPane` + `BiText` + locale-branch identity tokens;
// no literal styles, no ad-hoc fetch, no `App.tsx` route churn.
//
// Layout: when a `final` (re-draft) cell exists, two `ComparisonPane`s are
// stacked (source ↔ draft, draft ↔ re-draft) so the reviewer sees BOTH
// deltas; when no re-draft exists, a single `ComparisonPane` (source ↔
// draft) is shown — matching the existing `ComparisonPanel` semantics in
// `ReviewerDetailScreen`. A `BiText` head bar carries the locale-branch
// identity tokens (`sourceLocale → targetLocale`) as mono code tags so the
// branching history is always owned by an identity, not a free-floating
// pair of strings.

import type { ReactNode } from "react";
import { BiText, ComparisonPane, Panel } from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import type { WorkspaceComparisonReadModel } from "../../workspace/index.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

export interface RevisionHistoryComparisonPaneProps {
  /** Reviewer item the history is scoped to (also the `workspace.comparison` key). */
  reviewItemId: string;
}

/**
 * The reviewer detail revision-history pane. Issues the typed
 * `workspace.comparison` query through the API client and renders source
 * ↔ draft ↔ re-draft from the returned cells. Settles into loading / empty
 * / error independently of the parent screen.
 */
export function RevisionHistoryComparisonPane({
  reviewItemId,
}: RevisionHistoryComparisonPaneProps): ReactNode {
  const comparison = useApiQuery(
    "workspace.comparison",
    { query: { reviewItemId } },
    `workspace.comparison:${reviewItemId}`,
  );
  return (
    <Panel
      title="Revision history"
      eyebrow="Source ↔ draft ↔ re-draft"
      className="itotori-panel--rev-history"
      data-pane-state={comparison.state}
      data-pane-id="rev-history-comparison"
      data-review-item-id={reviewItemId}
    >
      <RevisionHistoryBody comparison={comparison} />
    </Panel>
  );
}

function RevisionHistoryBody({
  comparison,
}: {
  comparison: ApiCallState<WorkspaceComparisonReadModel>;
}): ReactNode {
  if (comparison.state === "loading") {
    return <LoadingState label="Loading revision history…" />;
  }
  if (comparison.state === "error") {
    return <ErrorState title="Revision history" error={comparison.error} />;
  }
  const model = comparison.state === "ready" ? comparison.data : null;
  if (model === null) {
    return (
      <EmptyState
        title="No revision history"
        message="No workspace comparison data was returned for this reviewer item."
      />
    );
  }
  if (!model.permission.canReadQueue) {
    return <DeniedHistory permission={model.permission} />;
  }
  return <RevisionHistoryCells model={model} />;
}

function DeniedHistory({
  permission,
}: {
  permission: WorkspaceComparisonReadModel["permission"];
}): ReactNode {
  const reason = permission.denialReasons[0] ?? `user ${permission.actorUserId} cannot read queue`;
  return (
    <p role="alert" className="itotori-rev-history-denied">
      <code>{reason}</code>
    </p>
  );
}

function RevisionHistoryCells({ model }: { model: WorkspaceComparisonReadModel }): ReactNode {
  const source = model.cells.find((cell) => cell.side === "source") ?? null;
  const draft = model.cells.find((cell) => cell.side === "draft") ?? null;
  const reDraft = model.cells.find((cell) => cell.side === "final") ?? null;
  const unitId = model.bridgeUnitId !== null ? <code>{model.bridgeUnitId}</code> : undefined;
  const localeBranchId = model.localeBranchId !== null ? <code>{model.localeBranchId}</code> : null;
  if (source === null && draft === null) {
    return (
      <EmptyState
        title="Revision history unavailable"
        message="Neither source nor draft text was loaded for this reviewer item."
      />
    );
  }
  const sourceLocale = source?.locale ?? "source";
  const targetLocale = draft?.locale ?? reDraft?.locale ?? "draft";
  return (
    <div className="itotori-rev-history">
      {(localeBranchId !== null || model.contextNote !== null) && (
        <header className="itotori-rev-history__identity">
          <BiText
            sourceLocale={sourceLocale}
            targetLocale={targetLocale}
            source={source?.text ?? ""}
            translation={reDraft?.text ?? draft?.text ?? ""}
            speaker={
              <span className="itotori-rev-history__branch">
                locale branch {localeBranchId ?? "?"}
              </span>
            }
          />
          {model.contextNote !== null && (
            <p className="itotori-rev-history__context-note">{model.contextNote}</p>
          )}
        </header>
      )}
      <ol className="itotori-rev-history__steps" aria-label="Source, draft, re-draft">
        {source !== null && draft !== null && (
          <li className="itotori-rev-history__step" data-step="source-to-draft">
            <ComparisonPane
              {...(unitId !== undefined ? { unit: unitId } : {})}
              source={source.text}
              draft={draft.text}
              sourceLabel={`Source · ${source.locale}`}
              draftLabel={`Draft · ${draft.locale}`}
            />
          </li>
        )}
        {draft !== null && reDraft !== null && (
          <li className="itotori-rev-history__step" data-step="draft-to-redraft">
            <ComparisonPane
              {...(unitId !== undefined ? { unit: unitId } : {})}
              source={draft.text}
              draft={reDraft.text}
              sourceLabel={`Draft · ${draft.locale}`}
              draftLabel={`Re-draft · ${reDraft.locale}`}
            />
          </li>
        )}
        {source !== null && draft === null && (
          <li className="itotori-rev-history__step" data-step="source-only">
            <ComparisonPane
              {...(unitId !== undefined ? { unit: unitId } : {})}
              source={source.text}
              draft={source.text}
              sourceLabel={`Source · ${source.locale}`}
              draftLabel={`Draft · ${source.locale}`}
            />
          </li>
        )}
      </ol>
    </div>
  );
}
