// Dashboard play/refinement surface for the durable patch iteration loop.
//
// This is deliberately a pure view: callers map their read model into the
// exported view types and own the play/refinement mutations. Keeping the
// surface free of API reads makes one panel usable from the dashboard and a
// version-focused page without recreating iteration state.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Panel } from "@itotori/ds";
import "./PatchIterationPanel.css";

/** The durable build state of a patch version. */
export type PatchIterationVersionStatus = "building" | "playable" | "failed";

/**
 * One patch version in oldest-to-newest lineage order. `openHref` is the
 * dashboard/detail destination; `artifactHref` is the generated patch
 * artifact itself when it is available to open or download.
 */
export interface PatchIterationVersionView {
  patchVersionId: string;
  parentPatchVersionId: string | null;
  status: PatchIterationVersionStatus;
  scopeSummary: string;
  openHref: string | null;
  artifactHref: string | null;
}

/** A persisted feedback batch attached to the observed patch version. */
export interface PatchIterationFeedbackBatchView {
  feedbackBatchId: string;
  /** A human-readable status such as `open`, `ready`, or `consumed`. */
  status: string;
  /** Number of persisted feedback events in this batch. */
  eventCount: number;
  /** Whether this batch is part of the pending refinement selection. */
  selected: boolean;
  /** Optional display label; the durable ID remains visible either way. */
  label?: string | null;
}

/** An individually selectable feedback event (not a whole feedback batch). */
export interface PatchIterationFeedbackIndividualEventView {
  feedbackEventId: string;
  feedbackBatchId: string;
  eventKind: string;
  /** A compact human-readable excerpt, never the source of durable identity. */
  summary: string;
  /** Whether this event is part of the initial refinement selection. */
  selected: boolean;
}

/**
 * Feedback inbox aggregate for the currently observed patch version.
 * `individualEventCount` counts events selected individually rather than via
 * a batch, while `eventCount` is the total attached feedback event count.
 */
export interface PatchIterationFeedbackInboxView {
  eventCount: number;
  individualEventCount: number;
  batches: readonly PatchIterationFeedbackBatchView[];
  individualEvents: readonly PatchIterationFeedbackIndividualEventView[];
  selectedFeedbackEventIds: readonly string[];
  selectedFeedbackBatchIds: readonly string[];
}

/**
 * A permanent QA annotation surfaced to a play tester. Confidence is
 * normalized to the inclusive `[0, 1]` range when present.
 */
export interface PatchIterationQaCalloutView {
  id: string;
  contested: boolean;
  confidence: number | null;
  note: string;
}

/** Frozen inputs emitted when the user asks to start a refinement run. */
export interface PatchIterationRefinementRequest {
  basePatchVersionId: string;
  feedbackEventIds: readonly string[];
  feedbackBatchIds: readonly string[];
  /** Complete frozen scope when the tester deliberately broadens it. */
  scopeUnitIds?: readonly string[];
  /** Explicit text for broadened units (or an intentional current-unit override). */
  targetBodiesByUnit?: Readonly<Record<string, string>>;
  /** Explicit canonical wiki heads; omission preserves the backend default. */
  wikiHeads?: readonly { contextArtifactId: string; contextEntryVersionId: string }[];
}

/** Input contract for the reusable dashboard iteration panel. */
export interface PatchIterationPanelProps {
  /** Full oldest-to-newest lineage, including the currently observed version. */
  versions: readonly PatchIterationVersionView[];
  /** Version the play tester is looking at and from which refinement starts. */
  activePatchVersionId: string | null;
  /** Exact base scope, used to preserve existing units when scope is broadened. */
  baseScopeUnitIds: readonly string[];
  feedback: PatchIterationFeedbackInboxView;
  qaCallouts: readonly PatchIterationQaCalloutView[];
  /** Launch/open the active patch version in the caller's play surface. */
  onPlay: (patchVersionId: string) => void;
  /** Start a refinement with the version and selected feedback frozen together. */
  onRefine: (request: PatchIterationRefinementRequest) => void;
}

/** The confidence floor below which an annotation is called out as low confidence. */
export const PATCH_ITERATION_LOW_CONFIDENCE_THRESHOLD = 0.5;

/** Find the active version without assuming a caller's lineage is non-empty. */
export function activePatchIterationVersion(
  versions: readonly PatchIterationVersionView[],
  activePatchVersionId: string | null,
): PatchIterationVersionView | null {
  if (activePatchVersionId === null) return null;
  return versions.find((version) => version.patchVersionId === activePatchVersionId) ?? null;
}

/** Whether a callout is low-confidence according to the normalized confidence scale. */
export function isLowConfidencePatchIterationCallout(
  callout: PatchIterationQaCalloutView,
): boolean {
  return (
    callout.confidence !== null && callout.confidence < PATCH_ITERATION_LOW_CONFIDENCE_THRESHOLD
  );
}

/** Format a normalized QA confidence without leaking implementation precision into the UI. */
export function formatPatchIterationConfidence(confidence: number | null): string {
  if (confidence === null) return "Confidence unavailable";
  return `Confidence ${Math.round(confidence * 100)}%`;
}

/**
 * A first-class dashboard representation of the durable iteration loop:
 * lineage → play → feedback inbox → refinement. QA callouts remain permanent,
 * visible annotations, but never alter either action's enabled state.
 */
export function PatchIterationPanel({
  versions,
  activePatchVersionId,
  baseScopeUnitIds,
  feedback,
  qaCallouts,
  onPlay,
  onRefine,
}: PatchIterationPanelProps): ReactNode {
  const activeVersion = activePatchIterationVersion(versions, activePatchVersionId);
  const feedbackSelectionKey = useMemo(
    () =>
      [
        activePatchVersionId ?? "none",
        `selected-batches:${feedback.selectedFeedbackBatchIds.join(",")}`,
        `selected-events:${feedback.selectedFeedbackEventIds.join(",")}`,
        ...feedback.batches.map((batch) => `batch:${batch.feedbackBatchId}:${batch.selected}`),
        ...feedback.individualEvents.map(
          (event) => `event:${event.feedbackEventId}:${event.selected}`,
        ),
      ].join("|"),
    [activePatchVersionId, feedback.batches, feedback.individualEvents],
  );
  const initialSelection = useMemo(
    () => ({
      feedbackBatchIds: new Set(feedback.selectedFeedbackBatchIds),
      feedbackEventIds: new Set(feedback.selectedFeedbackEventIds),
    }),
    [feedbackSelectionKey],
  );
  const [selectedFeedbackBatchIds, setSelectedFeedbackBatchIds] = useState(
    initialSelection.feedbackBatchIds,
  );
  const [selectedFeedbackEventIds, setSelectedFeedbackEventIds] = useState(
    initialSelection.feedbackEventIds,
  );

  // When a just-recorded event arrives through the refetched inbox, seed a
  // fresh selection from that durable state. The key keeps ordinary pending /
  // outcome rerenders from discarding a tester's in-progress choices.
  useEffect(() => {
    setSelectedFeedbackBatchIds(initialSelection.feedbackBatchIds);
    setSelectedFeedbackEventIds(initialSelection.feedbackEventIds);
  }, [initialSelection]);

  return (
    <Panel
      title="Patch iteration"
      eyebrow="Versions · play · feedback · refine"
      className="itotori-panel--patch-iteration"
      data-pane-id="patch-iteration"
      data-active-patch-version-id={activeVersion?.patchVersionId}
    >
      <div className="patch-iteration-panel">
        <PatchVersionLineage versions={versions} activePatchVersionId={activePatchVersionId} />
        {activeVersion === null ? (
          <p className="patch-iteration-panel__empty" role="status">
            Select a patch version to play it or begin a refinement run.
          </p>
        ) : (
          <>
            <PatchPlaySurface version={activeVersion} onPlay={onPlay} />
            <PatchFeedbackInbox
              feedback={feedback}
              selectedFeedbackBatchIds={selectedFeedbackBatchIds}
              selectedFeedbackEventIds={selectedFeedbackEventIds}
              onToggleBatch={(feedbackBatchId) => {
                setSelectedFeedbackBatchIds((current) =>
                  toggleSelectedId(current, feedbackBatchId),
                );
              }}
              onToggleEvent={(feedbackEventId) => {
                setSelectedFeedbackEventIds((current) =>
                  toggleSelectedId(current, feedbackEventId),
                );
              }}
            />
            <PatchIterationQaCallouts callouts={qaCallouts} />
            <PatchRefinementAction
              basePatchVersionId={activeVersion.patchVersionId}
              baseScopeUnitIds={baseScopeUnitIds}
              feedbackBatchIds={[...selectedFeedbackBatchIds]}
              feedbackEventIds={[...selectedFeedbackEventIds]}
              onRefine={onRefine}
            />
          </>
        )}
      </div>
    </Panel>
  );
}

function PatchVersionLineage({
  versions,
  activePatchVersionId,
}: {
  versions: readonly PatchIterationVersionView[];
  activePatchVersionId: string | null;
}): ReactNode {
  return (
    <section className="patch-iteration-panel__section" aria-labelledby="patch-lineage-heading">
      <h3 id="patch-lineage-heading" className="patch-iteration-panel__heading">
        Patch version lineage
      </h3>
      {versions.length === 0 ? (
        <p className="patch-iteration-panel__empty">No patch versions have been produced yet.</p>
      ) : (
        <ol className="patch-iteration-panel__lineage" aria-label="Patch version lineage">
          {versions.map((version) => {
            const active = version.patchVersionId === activePatchVersionId;
            return (
              <li
                key={version.patchVersionId}
                className="patch-iteration-panel__version"
                data-patch-version-id={version.patchVersionId}
                data-parent-patch-version-id={version.parentPatchVersionId ?? undefined}
                data-active={active ? "true" : "false"}
                aria-current={active ? "step" : undefined}
              >
                <div className="patch-iteration-panel__version-title">
                  <code>{version.patchVersionId}</code>
                  <Badge status={version.status}>{version.status}</Badge>
                </div>
                <dl className="patch-iteration-panel__version-meta">
                  <div>
                    <dt>Parent</dt>
                    <dd>
                      {version.parentPatchVersionId === null ? (
                        "Initial version"
                      ) : (
                        <code>{version.parentPatchVersionId}</code>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>{version.scopeSummary}</dd>
                  </div>
                </dl>
                {(version.openHref !== null || version.artifactHref !== null) && (
                  <div className="patch-iteration-panel__links">
                    {version.openHref !== null && <a href={version.openHref}>Open version</a>}
                    {version.artifactHref !== null && (
                      <a href={version.artifactHref}>Open patch artifact</a>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function PatchPlaySurface({
  version,
  onPlay,
}: {
  version: PatchIterationVersionView;
  onPlay: PatchIterationPanelProps["onPlay"];
}): ReactNode {
  return (
    <section className="patch-iteration-panel__section" aria-labelledby="patch-play-heading">
      <h3 id="patch-play-heading" className="patch-iteration-panel__heading">
        Play this patch
      </h3>
      <p className="patch-iteration-panel__copy">
        Open <code>{version.patchVersionId}</code> in the play surface. QA annotations below are
        informational and never gate playback.
      </p>
      <button
        type="button"
        className="patch-iteration-panel__action"
        data-action="play-patch"
        onClick={() => onPlay(version.patchVersionId)}
      >
        Play this patch
      </button>
    </section>
  );
}

function PatchFeedbackInbox({
  feedback,
  selectedFeedbackBatchIds,
  selectedFeedbackEventIds,
  onToggleBatch,
  onToggleEvent,
}: {
  feedback: PatchIterationFeedbackInboxView;
  selectedFeedbackBatchIds: ReadonlySet<string>;
  selectedFeedbackEventIds: ReadonlySet<string>;
  onToggleBatch: (feedbackBatchId: string) => void;
  onToggleEvent: (feedbackEventId: string) => void;
}): ReactNode {
  const selectedCount = selectedFeedbackEventIds.size + selectedFeedbackBatchIds.size;
  return (
    <section
      className="patch-iteration-panel__section"
      aria-labelledby="patch-feedback-heading"
      data-feedback-event-count={feedback.eventCount}
      data-feedback-batch-count={feedback.batches.length}
    >
      <h3 id="patch-feedback-heading" className="patch-iteration-panel__heading">
        Feedback inbox
      </h3>
      <p className="patch-iteration-panel__copy" data-feedback-selection-count={selectedCount}>
        {feedback.eventCount} event{feedback.eventCount === 1 ? "" : "s"} attached to this version ·{" "}
        {feedback.individualEventCount} individual · {feedback.batches.length} batch
        {feedback.batches.length === 1 ? "" : "es"} · {selectedCount} selected for refinement.
      </p>
      {feedback.batches.length > 0 && (
        <ul className="patch-iteration-panel__batches" aria-label="Feedback batches">
          {feedback.batches.map((batch) => {
            const selected = selectedFeedbackBatchIds.has(batch.feedbackBatchId);
            const label = batch.label ?? batch.feedbackBatchId;
            return (
              <li
                key={batch.feedbackBatchId}
                className="patch-iteration-panel__batch"
                data-feedback-batch-id={batch.feedbackBatchId}
                data-selected={selected ? "true" : "false"}
              >
                <label className="patch-iteration-panel__selection">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleBatch(batch.feedbackBatchId)}
                    aria-label={`Select feedback batch ${label}`}
                  />
                  <span>
                    {label} ({batch.eventCount} event{batch.eventCount === 1 ? "" : "s"})
                  </span>
                </label>
                <Badge status={batch.status}>{batch.status}</Badge>
              </li>
            );
          })}
        </ul>
      )}
      {feedback.individualEvents.length > 0 && (
        <ul className="patch-iteration-panel__batches" aria-label="Individual feedback events">
          {feedback.individualEvents.map((event) => {
            const selected = selectedFeedbackEventIds.has(event.feedbackEventId);
            return (
              <li
                key={event.feedbackEventId}
                className="patch-iteration-panel__batch"
                data-feedback-event-id={event.feedbackEventId}
                data-feedback-batch-id={event.feedbackBatchId}
                data-selected={selected ? "true" : "false"}
              >
                <label className="patch-iteration-panel__selection">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleEvent(event.feedbackEventId)}
                    aria-label={`Select feedback event ${event.feedbackEventId}`}
                  />
                  <span>
                    {event.eventKind}: {event.summary}
                  </span>
                </label>
                <Badge status="draft">individual</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PatchIterationQaCallouts({
  callouts,
}: {
  callouts: readonly PatchIterationQaCalloutView[];
}): ReactNode {
  return (
    <section
      className="patch-iteration-panel__section patch-iteration-panel__callouts"
      aria-labelledby="patch-qa-callouts-heading"
      data-gates-actions="false"
    >
      <h3 id="patch-qa-callouts-heading" className="patch-iteration-panel__heading">
        QA callouts <span className="patch-iteration-panel__informational">Informational</span>
      </h3>
      <p className="patch-iteration-panel__copy">
        Low-confidence and contested annotations help guide play testing; they do not block play or
        refinement.
      </p>
      {callouts.length === 0 ? (
        <p className="patch-iteration-panel__empty">No QA callouts for this version.</p>
      ) : (
        <ul className="patch-iteration-panel__callout-list" aria-label="Informational QA callouts">
          {callouts.map((callout) => {
            const lowConfidence = isLowConfidencePatchIterationCallout(callout);
            return (
              <li
                key={callout.id}
                className="patch-iteration-panel__callout"
                data-qa-callout-id={callout.id}
                data-contested={callout.contested ? "true" : "false"}
                data-low-confidence={lowConfidence ? "true" : "false"}
                role="note"
              >
                <div className="patch-iteration-panel__callout-labels">
                  {lowConfidence && <Badge status="warning">low confidence</Badge>}
                  {callout.contested && <Badge status="warning">contested</Badge>}
                  {!lowConfidence && !callout.contested && <Badge status="warning">QA note</Badge>}
                </div>
                <p>{callout.note}</p>
                <span className="patch-iteration-panel__callout-confidence">
                  {formatPatchIterationConfidence(callout.confidence)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PatchRefinementAction({
  basePatchVersionId,
  baseScopeUnitIds,
  feedbackBatchIds,
  feedbackEventIds,
  onRefine,
}: {
  basePatchVersionId: string;
  baseScopeUnitIds: readonly string[];
  feedbackBatchIds: readonly string[];
  feedbackEventIds: readonly string[];
  onRefine: PatchIterationPanelProps["onRefine"];
}): ReactNode {
  const [additionalScopeUnitIds, setAdditionalScopeUnitIds] = useState("");
  const [targetBodiesJson, setTargetBodiesJson] = useState("");
  const [wikiHeadsJson, setWikiHeadsJson] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const submitRefinement = (): void => {
    try {
      const addedScopeUnitIds = commaSeparatedNonBlank(additionalScopeUnitIds);
      const targetBodiesByUnit = parseOptionalTargetBodies(targetBodiesJson);
      const wikiHeads = parseOptionalWikiHeads(wikiHeadsJson);
      for (const bridgeUnitId of addedScopeUnitIds) {
        if (targetBodiesByUnit?.[bridgeUnitId] === undefined) {
          throw new Error(`Broadened unit ${bridgeUnitId} needs a target body in the JSON map.`);
        }
      }
      setValidationError(null);
      onRefine({
        basePatchVersionId,
        feedbackEventIds,
        feedbackBatchIds,
        ...(addedScopeUnitIds.length === 0
          ? {}
          : { scopeUnitIds: uniqueNonBlank([...baseScopeUnitIds, ...addedScopeUnitIds]) }),
        ...(targetBodiesByUnit === undefined ? {} : { targetBodiesByUnit }),
        ...(wikiHeads === undefined ? {} : { wikiHeads }),
      });
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : "The refinement options are not valid.",
      );
    }
  };

  return (
    <section className="patch-iteration-panel__section" aria-labelledby="patch-refine-heading">
      <h3 id="patch-refine-heading" className="patch-iteration-panel__heading">
        Refinement run
      </h3>
      <p className="patch-iteration-panel__copy">
        Freeze this base version together with the selected feedback. Unaffected results can be
        reused while affected and newly in-scope units are redrafted.
      </p>
      <details className="patch-iteration-panel__refinement-options">
        <summary>Optional scope and wiki inputs</summary>
        <p className="patch-iteration-panel__copy">
          Add bridge-unit IDs to broaden the current {baseScopeUnitIds.length}-unit scope. Existing
          units stay in scope automatically; every new unit needs target text in the JSON map.
        </p>
        <label>
          Additional bridge-unit IDs (comma-separated)
          <input
            value={additionalScopeUnitIds}
            onChange={(event) => setAdditionalScopeUnitIds(event.currentTarget.value)}
            placeholder="bridge-unit-new-1, bridge-unit-new-2"
          />
        </label>
        <label>
          Target bodies JSON (unit ID → target text)
          <textarea
            value={targetBodiesJson}
            onChange={(event) => setTargetBodiesJson(event.currentTarget.value)}
            rows={4}
            placeholder={'{"bridge-unit-new-1":"New target text"}'}
          />
        </label>
        <label>
          Explicit wiki heads JSON (optional)
          <textarea
            value={wikiHeadsJson}
            onChange={(event) => setWikiHeadsJson(event.currentTarget.value)}
            rows={4}
            placeholder={
              '[{"contextArtifactId":"wiki-artifact-1","contextEntryVersionId":"wiki-version-1"}]'
            }
          />
        </label>
      </details>
      <button
        type="button"
        className="patch-iteration-panel__action"
        data-action="refine-patch"
        onClick={submitRefinement}
      >
        Refine selected feedback
      </button>
      {validationError !== null && <p role="alert">{validationError}</p>}
    </section>
  );
}

function toggleSelectedId(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

function commaSeparatedNonBlank(value: string): string[] {
  return uniqueNonBlank(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function uniqueNonBlank(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function parseOptionalTargetBodies(value: string): Record<string, string> | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = parseJsonRecord(value, "Target bodies JSON");
  const normalized: Record<string, string> = {};
  for (const [bridgeUnitId, targetBody] of Object.entries(parsed)) {
    if (
      bridgeUnitId.trim().length === 0 ||
      typeof targetBody !== "string" ||
      targetBody.trim().length === 0
    ) {
      throw new Error("Target bodies JSON must map non-blank bridge-unit IDs to non-blank text.");
    }
    normalized[bridgeUnitId] = targetBody;
  }
  return normalized;
}

function parseOptionalWikiHeads(
  value: string,
): Array<{ contextArtifactId: string; contextEntryVersionId: string }> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Explicit wiki heads JSON must be a JSON array.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Explicit wiki heads JSON must be a JSON array.");
  }
  return parsed.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Explicit wiki head ${index + 1} must be an object.`);
    }
    const head = value as Record<string, unknown>;
    if (
      typeof head.contextArtifactId !== "string" ||
      head.contextArtifactId.trim().length === 0 ||
      typeof head.contextEntryVersionId !== "string" ||
      head.contextEntryVersionId.trim().length === 0
    ) {
      throw new Error(
        `Explicit wiki head ${index + 1} needs non-blank contextArtifactId and contextEntryVersionId.`,
      );
    }
    return {
      contextArtifactId: head.contextArtifactId,
      contextEntryVersionId: head.contextEntryVersionId,
    };
  });
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON object.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
