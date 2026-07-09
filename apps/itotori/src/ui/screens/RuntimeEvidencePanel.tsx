// rev-runtime-evidence-ui — the reviewer detail RUNTIME EVIDENCE panel.
//
// A panel WITHIN the reviewer detail screen (not a new route) that renders the
// runtime-evidence surface — TRACE / FINDINGS / ARTIFACTS (screenshot +
// recording) — with the fidelity / evidence TIER + REDACTION. It consumes the
// `runtime.status` read-model — the runtime-dashboard read-model that exposes
// `traceEvents`, `findings`, `artifacts` (`screenshot` / `recording` /
// `trace_log` / `frame_capture` / `reference_comparison` kinds), the
// `evidenceTier` ceiling per row + the run-level `fidelityTier` /
// `evidenceTier`, and the `frameCaptureCount` aggregate — DIRECTLY through
// the typed `ItotoriApiClient` (`useApiQuery`, never an ad-hoc fetch).
//
// Sensitive frames — every `screenshot` and `recording` artifact — render
// inside the ds `RedactionFrame`, which blurs them by default
// ([[feedback_redaction_is_a_toggle]]): a sensitive frame is redacted unless
// the viewer has cap-gated `canReveal` AND we are not in share/export mode.
// Non-sensitive artifacts (trace logs, frame captures, reference comparisons)
// are NOT wrapped — redaction is a TOGGLE for sensitive content only.
//
// Painted with `@itotori/ds` (`Panel`, `DataTable`, `Badge`, `StatReadout`,
// `RedactionFrame`); className-based, ds tokens, no literal styles, no game
// named. [[feedback_behavior_first_code_agnostic_testing]] — the
// behavior-first test mounts the panel over an msw-intercepted read-model and
// asserts only the rendered trace / findings / artifacts + tier + redaction +
// loading / empty / error surfaces.

import type { ReactNode } from "react";
import type { RuntimeDashboardStatus } from "@itotori/db";
import {
  Badge,
  DataTable,
  Panel,
  RedactionFrame,
  StatReadout,
  shouldRedactFrame,
} from "@itotori/ds";
import type { ApiCallState } from "../../api-client.js";
import { AddressableJump } from "../addressable-jump.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState } from "../states.js";

// ---------------------------------------------------------------------------
// Public type aliases — derived from the runtime-status read model so we do
// not have to expand the `@itotori/db` barrel just to name the nested rows.
// The runtime status is the single source of truth (it carries
// `traceEvents` / `findings` / `artifacts` + the tier ceilings); the panel
// only repaints it.
// ---------------------------------------------------------------------------

/** One trace event row from the runtime dashboard. */
export type RuntimeEvidenceTraceEvent = NonNullable<RuntimeDashboardStatus["traceEvents"]>[number];

/** One finding row from the runtime dashboard. */
export type RuntimeEvidenceFinding = NonNullable<RuntimeDashboardStatus["findings"]>[number];

/** One managed artifact row from the runtime dashboard. */
export type RuntimeEvidenceArtifact = NonNullable<RuntimeDashboardStatus["artifacts"]>[number];

// ---------------------------------------------------------------------------
// Artifact-kind taxonomy + sensitivity classification.
// ---------------------------------------------------------------------------

/**
 * The artifact kinds the runtime dashboard surfaces. The brief identifies
 * `screenshot` + `recording` as the SENSITIVE frames; non-sensitive kinds
 * (`trace_log`, `frame_capture`, `reference_comparison`) render as plain
 * metadata — redaction is a TOGGLE for sensitive content only.
 */
export const RUNTIME_EVIDENCE_SENSITIVE_ARTIFACT_KINDS = ["screenshot", "recording"] as const;
export type RuntimeEvidenceSensitiveArtifactKind =
  (typeof RUNTIME_EVIDENCE_SENSITIVE_ARTIFACT_KINDS)[number];

/**
 * Whether an artifact is sensitive. An artifact is sensitive when its
 * `artifactKind` is `screenshot` or `recording`. The `runtime.status`
 * response is the source of truth: the server's per-artifact `artifactKind`
 * is the only signal a sensitive frame carries (no separate `sensitive`
 * flag — the kind IS the sensitivity classification).
 */
export function isSensitiveRuntimeEvidenceArtifact(artifact: RuntimeEvidenceArtifact): boolean {
  return (RUNTIME_EVIDENCE_SENSITIVE_ARTIFACT_KINDS as readonly string[]).includes(
    artifact.artifactKind,
  );
}

// ---------------------------------------------------------------------------
// Pure derivation — split the artifacts by sensitivity so the panel can
// paint each class from the right surface. Exported so the behavior-first
// test can pin the split from a fixture without mounting React.
// ---------------------------------------------------------------------------

/**
 * The runtime-status artifacts split into the sensitive (screenshot /
 * recording) and non-sensitive (trace log / frame capture / reference
 * comparison) buckets the panel renders separately. Pure + deterministic.
 */
export type RuntimeEvidenceArtifactsSplit = {
  sensitive: RuntimeEvidenceArtifact[];
  nonSensitive: RuntimeEvidenceArtifact[];
};

export function splitRuntimeEvidenceArtifacts(
  artifacts: readonly RuntimeEvidenceArtifact[],
): RuntimeEvidenceArtifactsSplit {
  const sensitive: RuntimeEvidenceArtifact[] = [];
  const nonSensitive: RuntimeEvidenceArtifact[] = [];
  for (const artifact of artifacts) {
    if (isSensitiveRuntimeEvidenceArtifact(artifact)) {
      sensitive.push(artifact);
    } else {
      nonSensitive.push(artifact);
    }
  }
  return { sensitive, nonSensitive };
}

// ---------------------------------------------------------------------------
// Public panel — owns its runtime-status read through the typed client.
// Mounted by the ReviewerDetailScreen with the review item id so the
// depsKey keys the resource per review item (a re-mount re-issues the fetch).
// ---------------------------------------------------------------------------

export interface RuntimeEvidencePanelProps {
  /** The reviewer item the runtime evidence is being painted for. */
  reviewItemId: string;
  /**
   * Cap-gated authority to reveal sensitive frames locally. Default `false`
   * — sensitive frames render redacted. Pass `true` only for an actor who
   * has the explicit cap (e.g. the owner with `revealSensitive`). Share /
   * export mode ALWAYS forces redaction regardless of this prop, via
   * `shareRedaction` on the `RedactionFrame`.
   */
  canRevealSensitive?: boolean;
}

/**
 * The reviewer detail runtime-evidence panel. Issues the typed
 * `runtime.status` query (the runtime-dashboard read-model) through the API
 * client and renders trace / findings / artifacts + the fidelity / evidence
 * TIER. Sensitive artifacts (screenshot + recording) render inside the ds
 * `RedactionFrame` (blurred unless `canRevealSensitive`). Settles into
 * loading / empty / error independently of the parent screen.
 */
export function RuntimeEvidencePanel({
  reviewItemId,
  canRevealSensitive = false,
}: RuntimeEvidencePanelProps): ReactNode {
  const status = useApiQuery("runtime.status", {}, `runtime-evidence:${reviewItemId}`);
  return (
    <RuntimeEvidencePanelBody
      status={status}
      canRevealSensitive={canRevealSensitive}
      reviewItemId={reviewItemId}
    />
  );
}

/**
 * The state-bound panel body. Exported (and the props are the resolved
 * `ApiCallState`) so a behavior-first test can mount the panel over a
 * mock read-model without standing up the full msw round-trip.
 */
export function RuntimeEvidencePanelBody({
  status,
  canRevealSensitive,
  reviewItemId,
}: {
  status: ApiCallState<RuntimeDashboardStatus>;
  canRevealSensitive: boolean;
  reviewItemId: string;
}): ReactNode {
  return (
    <Panel
      title="Runtime evidence"
      eyebrow="Trace · findings · artifacts"
      className="itotori-panel--runtime-evidence"
      data-pane-id="runtime-evidence"
      data-pane-state={status.state}
      data-review-item-id={reviewItemId}
    >
      <RuntimeEvidenceBodyContent status={status} canRevealSensitive={canRevealSensitive} />
    </Panel>
  );
}

function RuntimeEvidenceBodyContent({
  status,
  canRevealSensitive,
}: {
  status: ApiCallState<RuntimeDashboardStatus>;
  canRevealSensitive: boolean;
}): ReactNode {
  if (status.state === "loading") {
    return <LoadingState label="Loading runtime evidence…" />;
  }
  if (status.state === "error") {
    return <ErrorState title="Runtime evidence" error={status.error} />;
  }
  if (status.state === "empty") {
    return (
      <EmptyState
        title="No runtime evidence"
        message="The runtime dashboard returned no trace, findings, or artifacts for this reviewer item."
      />
    );
  }
  return <RuntimeEvidenceReady status={status.data} canRevealSensitive={canRevealSensitive} />;
}

// ---------------------------------------------------------------------------
// Ready view — the trace / findings / artifacts surfaces + the fidelity /
// evidence TIER readouts. Renders the three read-model sections the brief
// enumerates, plus the sensitive/non-sensitive artifact split.
// ---------------------------------------------------------------------------

function RuntimeEvidenceReady({
  status,
  canRevealSensitive,
}: {
  status: RuntimeDashboardStatus;
  canRevealSensitive: boolean;
}): ReactNode {
  const split = splitRuntimeEvidenceArtifacts(status.artifacts);
  const totalArtifacts = status.artifacts.length;
  const sensitiveCount = split.sensitive.length;
  const nonSensitiveCount = split.nonSensitive.length;
  return (
    <div className="itotori-runtime-evidence" data-runtime-evidence="ready">
      <div className="itotori-metric-row" aria-label="Runtime evidence tiers">
        {/* xs-deep-jumps — the runtime RUN is the addressable "frame": a
            deep-link to /runs/:runtimeRunId lands on the runtime focus
            surface so a reviewer can jump frame -> run from this panel. */}
        <StatReadout
          label="Run"
          value={
            <AddressableJump
              kind="run"
              id={status.runtimeRunId}
              fallback={<span>{status.runtimeRunId ?? "—"}</span>}
              className="itotori-runtime-evidence__run-jump"
            />
          }
        />
        <StatReadout
          label="Fidelity tier"
          value={
            status.fidelityTier === null ? (
              "—"
            ) : (
              <Badge status="neutral">{status.fidelityTier}</Badge>
            )
          }
        />
        <StatReadout
          label="Evidence tier"
          value={
            status.evidenceTier === null ? (
              "—"
            ) : (
              <Badge status="neutral">{status.evidenceTier}</Badge>
            )
          }
        />
        <StatReadout label="Frame captures" value={status.frameCaptureCount} />
        <StatReadout label="Text events" value={status.textEventCount} />
        <StatReadout label="Findings" value={status.validationFindingCount} />
        <StatReadout
          label="Artifacts"
          value={
            <span data-runtime-evidence-artifact-count>
              {totalArtifacts} ({sensitiveCount} sensitive · {nonSensitiveCount} non-sensitive)
            </span>
          }
        />
      </div>

      <RuntimeEvidenceTraceTable traceEvents={status.traceEvents} />
      <RuntimeEvidenceFindingsTable findings={status.findings} />
      <RuntimeEvidenceArtifacts
        status={status}
        split={split}
        canRevealSensitive={canRevealSensitive}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trace events — every observed text / hook / branch event the runtime
// emitted, with the per-row evidence tier + frame number + text preview
// (already redacted to null by the unprivileged runtime-status path — see
// `assertRedactedRuntimeDashboardStatus`).
// ---------------------------------------------------------------------------

function RuntimeEvidenceTraceTable({
  traceEvents,
}: {
  traceEvents: readonly RuntimeEvidenceTraceEvent[];
}): ReactNode {
  if (traceEvents.length === 0) {
    return (
      <section className="itotori-runtime-evidence__trace" aria-label="Trace events">
        <h3 className="itotori-runtime-evidence__heading">Trace</h3>
        <p className="itotori-empty-copy">No trace events recorded.</p>
      </section>
    );
  }
  return (
    <section
      className="itotori-runtime-evidence__trace"
      aria-label="Trace events"
      data-runtime-evidence-section="trace"
    >
      <h3 className="itotori-runtime-evidence__heading">Trace</h3>
      <DataTable
        caption="Trace events"
        columns={[
          {
            key: "eventKind",
            header: "Event",
            render: (event) => <code>{event.eventKind}</code>,
          },
          {
            key: "tier",
            header: "Tier",
            render: (event) =>
              event.evidenceTier === null ? (
                "—"
              ) : (
                <Badge status="neutral">{event.evidenceTier}</Badge>
              ),
          },
          {
            key: "frame",
            header: "Frame",
            render: (event) => (event.frame === null ? "—" : String(event.frame)),
          },
          {
            key: "sourceUnitKey",
            header: "Source unit",
            render: (event) => (
              <AddressableJump
                kind="unit"
                id={event.bridgeUnitId ?? event.sourceUnitKey}
                fallback={event.sourceUnitKey === null ? "—" : <code>{event.sourceUnitKey}</code>}
                className="itotori-runtime-evidence__line-jump"
              >
                <code>{event.sourceUnitKey ?? event.bridgeUnitId}</code>
              </AddressableJump>
            ),
          },
          {
            key: "textPreview",
            header: "Text preview",
            render: (event) =>
              event.textPreview === null ? (
                <span className="itotori-runtime-evidence__redacted">[redacted]</span>
              ) : (
                <span>{event.textPreview}</span>
              ),
          },
          {
            key: "artifactIds",
            header: "Artifacts",
            render: (event) => event.artifactIds.join(", ") || "none",
          },
        ]}
        rows={traceEvents}
        getRowKey={(event) => event.runtimeEventId}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Findings — every QA finding the runtime raised, with the per-row evidence
// tier ceiling. A finding's `message` is redacted to the sentinel on the
// unprivileged runtime-status path (see `REDACTED_RUNTIME_FINDING_MESSAGE`).
// ---------------------------------------------------------------------------

function RuntimeEvidenceFindingsTable({
  findings,
}: {
  findings: readonly RuntimeEvidenceFinding[];
}): ReactNode {
  if (findings.length === 0) {
    return (
      <section className="itotori-runtime-evidence__findings" aria-label="Findings">
        <h3 className="itotori-runtime-evidence__heading">Findings</h3>
        <p className="itotori-empty-copy">No findings recorded.</p>
      </section>
    );
  }
  return (
    <section
      className="itotori-runtime-evidence__findings"
      aria-label="Findings"
      data-runtime-evidence-section="findings"
    >
      <h3 className="itotori-runtime-evidence__heading">Findings</h3>
      <DataTable
        caption="Findings"
        columns={[
          // xs-deep-jumps — the finding id is itself addressable: a deep-link
          // to /findings/:findingId (the finding -> line -> frame chain entry).
          {
            key: "finding",
            header: "Finding",
            render: (finding) => (
              <AddressableJump
                kind="finding"
                id={finding.findingId}
                className="itotori-runtime-evidence__finding-jump"
              >
                <code>{finding.findingId}</code>
              </AddressableJump>
            ),
          },
          { key: "kind", header: "Kind", render: (finding) => finding.findingKind },
          {
            key: "severity",
            header: "Severity",
            render: (finding) => <Badge status={finding.severity}>{finding.severity}</Badge>,
          },
          {
            key: "tier",
            header: "Tier",
            render: (finding) => <Badge status="neutral">{finding.evidenceTier}</Badge>,
          },
          // xs-deep-jumps — the finding's bridge unit is the player LINE: a
          // deep-link to /play/units/:bridgeUnitId (finding -> line).
          {
            key: "sourceUnitKey",
            header: "Source unit",
            render: (finding) => (
              <AddressableJump
                kind="unit"
                id={finding.bridgeUnitId ?? finding.sourceUnitKey}
                fallback={
                  finding.sourceUnitKey === null ? "—" : <code>{finding.sourceUnitKey}</code>
                }
                className="itotori-runtime-evidence__line-jump"
              >
                <code>{finding.sourceUnitKey ?? finding.bridgeUnitId}</code>
              </AddressableJump>
            ),
          },
          { key: "message", header: "Message", render: (finding) => finding.message },
        ]}
        rows={findings}
        getRowKey={(finding) => finding.findingId}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Artifacts — split into SENSITIVE (screenshot + recording → wrapped in the
// ds `RedactionFrame`) and NON-SENSITIVE (trace log / frame capture /
// reference comparison → plain metadata). Each card carries the artifact id,
// kind, hash, media type, byte size, and bridge-unit / source-unit keys.
// ---------------------------------------------------------------------------

function RuntimeEvidenceArtifacts({
  status,
  split,
  canRevealSensitive,
}: {
  status: RuntimeDashboardStatus;
  split: RuntimeEvidenceArtifactsSplit;
  canRevealSensitive: boolean;
}): ReactNode {
  return (
    <section
      className="itotori-runtime-evidence__artifacts"
      aria-label="Artifacts"
      data-runtime-evidence-section="artifacts"
    >
      <h3 className="itotori-runtime-evidence__heading">Artifacts</h3>
      {split.sensitive.length === 0 && split.nonSensitive.length === 0 ? (
        <p className="itotori-empty-copy">No artifacts recorded.</p>
      ) : (
        <>
          {split.sensitive.length > 0 && (
            <RuntimeEvidenceSensitiveArtifacts
              artifacts={split.sensitive}
              canRevealSensitive={canRevealSensitive}
            />
          )}
          {split.nonSensitive.length > 0 && (
            <RuntimeEvidenceNonSensitiveArtifacts
              artifacts={split.nonSensitive}
              evidenceTier={status.evidenceTier}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * Sensitive artifacts (screenshot + recording) — wrapped in the ds
 * `RedactionFrame` per [[feedback_redaction_is_a_toggle]]. Redaction is the
 * DEFAULT for committed frames; `canRevealSensitive` is the cap-gated
 * unblur and is honored here as the prop the parent (today: the test;
 * tomorrow: the fnd-caps-context wiring) supplies.
 */
function RuntimeEvidenceSensitiveArtifacts({
  artifacts,
  canRevealSensitive,
}: {
  artifacts: readonly RuntimeEvidenceArtifact[];
  canRevealSensitive: boolean;
}): ReactNode {
  return (
    <div
      className="itotori-runtime-evidence__sensitive-artifacts"
      data-runtime-evidence-section="artifacts-sensitive"
    >
      <h4 className="itotori-runtime-evidence__subheading">
        Sensitive <Badge status="warning">redacted by default</Badge>
      </h4>
      <ul className="itotori-runtime-evidence__artifact-list">
        {artifacts.map((artifact) => (
          <li
            key={artifact.artifactId}
            className="itotori-runtime-evidence__artifact"
            data-runtime-evidence-artifact-id={artifact.artifactId}
            data-runtime-evidence-artifact-kind={artifact.artifactKind}
          >
            <RedactionFrame
              sensitive={true}
              canReveal={canRevealSensitive}
              label={`${artifact.artifactKind} · redacted`}
            >
              <div className="itotori-runtime-evidence__artifact-surface" aria-hidden="true">
                <span className="itotori-runtime-evidence__artifact-kind">
                  {artifact.artifactKind}
                </span>
                <span className="itotori-runtime-evidence__artifact-id">{artifact.artifactId}</span>
              </div>
            </RedactionFrame>
            <dl className="itotori-runtime-evidence__artifact-meta">
              <div>
                <dt>Hash</dt>
                <dd>
                  <code>{artifact.hash ?? "—"}</code>
                </dd>
              </div>
              <div>
                <dt>Media</dt>
                <dd>{artifact.mediaType ?? "—"}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{artifact.byteSize === null ? "—" : `${artifact.byteSize} B`}</dd>
              </div>
              <div>
                <dt>Source unit</dt>
                <dd>
                  <AddressableJump
                    kind="unit"
                    id={artifact.bridgeUnitId ?? artifact.sourceUnitKey}
                    fallback={<code>{artifact.sourceUnitKey ?? "—"}</code>}
                    className="itotori-runtime-evidence__line-jump"
                  >
                    <code>{artifact.sourceUnitKey ?? artifact.bridgeUnitId ?? "—"}</code>
                  </AddressableJump>
                </dd>
              </div>
              <div>
                <dt>Redacted</dt>
                <dd
                  data-runtime-evidence-redacted={
                    shouldRedactFrame({
                      sensitive: true,
                      canReveal: canRevealSensitive,
                      shareRedaction: false,
                    })
                      ? "true"
                      : "false"
                  }
                >
                  {shouldRedactFrame({
                    sensitive: true,
                    canReveal: canRevealSensitive,
                    shareRedaction: false,
                  })
                    ? "yes"
                    : "no"}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Non-sensitive artifacts (trace log / frame capture / reference
 * comparison) — plain metadata; redaction does not apply.
 */
function RuntimeEvidenceNonSensitiveArtifacts({
  artifacts,
  evidenceTier,
}: {
  artifacts: readonly RuntimeEvidenceArtifact[];
  evidenceTier: string | null;
}): ReactNode {
  return (
    <div
      className="itotori-runtime-evidence__non-sensitive-artifacts"
      data-runtime-evidence-section="artifacts-non-sensitive"
    >
      <h4 className="itotori-runtime-evidence__subheading">
        Non-sensitive{" "}
        {evidenceTier === null ? null : <Badge status="neutral">{evidenceTier}</Badge>}
      </h4>
      <DataTable
        caption="Non-sensitive artifacts"
        columns={[
          { key: "kind", header: "Kind", render: (artifact) => artifact.artifactKind },
          {
            key: "id",
            header: "Artifact",
            render: (artifact) => <code>{artifact.artifactId}</code>,
          },
          {
            key: "sourceUnitKey",
            header: "Source unit",
            render: (artifact) => (
              <AddressableJump
                kind="unit"
                id={artifact.bridgeUnitId ?? artifact.sourceUnitKey}
                fallback={
                  artifact.sourceUnitKey === null ? "—" : <code>{artifact.sourceUnitKey}</code>
                }
                className="itotori-runtime-evidence__line-jump"
              >
                <code>{artifact.sourceUnitKey ?? artifact.bridgeUnitId}</code>
              </AddressableJump>
            ),
          },
          {
            key: "hash",
            header: "Hash",
            render: (artifact) => (artifact.hash === null ? "—" : <code>{artifact.hash}</code>),
          },
          { key: "media", header: "Media", render: (artifact) => artifact.mediaType ?? "—" },
          {
            key: "size",
            header: "Size",
            render: (artifact) => (artifact.byteSize === null ? "—" : `${artifact.byteSize} B`),
          },
        ]}
        rows={artifacts}
        getRowKey={(artifact) => artifact.artifactId}
      />
    </div>
  );
}
