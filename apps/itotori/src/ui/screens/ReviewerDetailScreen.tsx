// fnd-spa-shell — the reviewer-queue item detail screen.
//
// Parity port of the deleted HTML-string `reviewer/detail-view.ts`. Consumes
// `/api/reviewer/queue/:id/detail` THROUGH the typed client and renders the
// same panels: the permission-denial UI, a visible diagnostic banner (missing
// context is never a silent empty panel), the action strip (disabled without
// queue.manage), and the source / draft / comparison / draft-history / policy /
// glossary / branch-reference / QA-findings / runtime-evidence / rationale /
// transitions panels — all with `@itotori/ds` components.
//
// rev-detail-ui — enriches three of those panels from the SAME
// `reviewer.detail` read-model (no new routes, read-only consumer):
//   - DraftHistoryPanel: the draft → approved-patch version progression
//     (v1 draft → patch-v3) with per-version status + attempt metadata,
//     drawn from `context.draft` (`draftText`, `approvedPatchText`,
//     `draftStatus`, `attemptCount`). Distinct from the sibling
//     `RevisionHistoryComparisonPane`, which is the source↔draft↔re-draft
//     DIFF over `workspace.comparison`.
//   - PolicyPanel (policy rules): the style-guide policy identity + status
//     + approval provenance (`context.policy`) folded with the exact
//     branch policy reference the draft was produced under
//     (`context.branchReference.branchPolicyRef` / `versionSequence` /
//     `updateReason`).
//   - GlossaryPanel: the referenced terms + the branch glossary reference
//     provenance (`context.branchReference.glossaryRef` / `versionSequence`),
//     client-paginated with the ds `Pagination` primitive.

import { type ReactNode, useState } from "react";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  type ReviewerQueueAction,
  type ReviewerQueueItemKind,
} from "@itotori/db";
import {
  Badge,
  BiText,
  ComparisonPane,
  DataTable,
  Pagination,
  Panel,
  StatReadout,
} from "@itotori/ds";
import type { ReviewerDetailContext } from "../../reviewer/detail-fixtures.js";
import { CapGatedButton, useCapsOptional } from "../caps-context.js";
import { useApiQuery } from "../use-api-resource.js";
import { apiClient } from "../client.js";
import { ErrorState, LoadingState, ShellHeader } from "../states.js";
import { useWorkflowHandoffToasts } from "../workflow-handoff-toasts.js";
import { CorrectionScopePanel } from "./CorrectionScopePanel.js";
import { RevisionHistoryComparisonPane } from "./RevisionHistoryComparisonPane.js";
// rev-runtime-evidence-ui — the runtime-evidence panel reads the runtime
// dashboard (`runtime.status` + frame-capture) through the typed client, so
// its loading / empty / error surfaces settle independently of the parent.
import { RuntimeEvidencePanel } from "./RuntimeEvidencePanel.js";

// ITOTORI-082 → HI-FI STUDIO EPIC · Review
// (`spec/rev-decide`) — the decide action.
//
// `canDecide` is the hi-fi Studio capability gate for "this user can decide
// a reviewer queue item" (approve-as-is / queue a correction for the next
// pass). fnd-caps-context lifts this onto the CapsProvider (sourced from the
// queue.manage permission grant). Callers may still pass an explicit
// `canDecide` prop (tests); when omitted we prefer the caps context, then
// fall back to `context.permission.canManageQueue` so the legacy detail
// route keeps working when the permission view already carries manage.
export function ReviewerDetailScreen({
  reviewItemId,
  canDecide,
}: {
  reviewItemId: string;
  canDecide?: boolean;
}): ReactNode {
  const caps = useCapsOptional();
  const detail = useApiQuery(
    "reviewer.detail",
    { pathParams: { reviewItemId } },
    `reviewer.detail:${reviewItemId}`,
  );
  if (detail.state === "loading") {
    return (
      <main className="itotori-shell" data-screen="reviewer-detail" data-state="loading">
        <LoadingState label={`Loading reviewer detail for ${reviewItemId}…`} />
      </main>
    );
  }
  if (detail.state === "error") {
    return (
      <main className="itotori-shell" data-screen="reviewer-detail" data-state="error">
        <ErrorState title="Reviewer detail" error={detail.error} />
      </main>
    );
  }
  // reviewer.detail always returns a context (never the collection `empty`
  // state); a denied context has `canReadQueue: false`.
  const context = detail.state === "ready" ? detail.data : null;
  if (context === null) {
    return (
      <main className="itotori-shell" data-screen="reviewer-detail" data-state="empty">
        <Panel title="Reviewer detail" eyebrow="Reviewer">
          <p>No reviewer detail context was returned.</p>
        </Panel>
      </main>
    );
  }
  if (!context.permission.canReadQueue) {
    return <DeniedView context={context} />;
  }
  // Resolution order: explicit prop → caps context → manage permission on
  // the detail view (the pre-caps fallback).
  const resolvedCanDecide = canDecide ?? caps?.canDecide ?? context.permission.canManageQueue;
  const decideDenial =
    caps?.denials.decide ??
    (resolvedCanDecide
      ? null
      : (context.permission.denialReasons.find((r) => r.includes("queue.manage")) ??
        "queue.manage permission required to decide"));
  return (
    <ReadyView
      context={context}
      canDecide={resolvedCanDecide}
      decideDenial={decideDenial}
      canReveal={caps?.canReveal ?? false}
    />
  );
}

function DeniedView({ context }: { context: ReviewerDetailContext }): ReactNode {
  const reason =
    context.permission.denialReasons[0] ??
    `user ${context.permission.actorUserId} cannot read queue`;
  return (
    <main
      className="itotori-shell reviewer-detail"
      data-screen="reviewer-detail"
      data-state="denied"
      data-review-item-id={context.reviewItemId}
    >
      <ShellHeader eyebrow="Reviewer detail" title="Access denied" />
      <Panel title="You do not have permission to view this reviewer item." tone="sakura">
        <p role="alert">{reason}</p>
        <p>
          The detail page withholds the source unit, draft, policy, glossary, QA findings, runtime
          evidence, and rationale until <code>queue.read</code> is granted.
        </p>
      </Panel>
    </main>
  );
}

function ReadyView({
  context,
  canDecide,
  decideDenial,
  canReveal,
}: {
  context: ReviewerDetailContext;
  canDecide: boolean;
  decideDenial: string | null;
  canReveal: boolean;
}): ReactNode {
  const item = context.item;
  return (
    <main
      className="itotori-shell reviewer-detail"
      data-screen="reviewer-detail"
      data-state="ready"
      data-review-item-id={context.reviewItemId}
      data-can-manage={context.permission.canManageQueue ? "true" : "false"}
      data-can-decide={canDecide ? "true" : "false"}
    >
      <ShellHeader
        eyebrow="Reviewer detail"
        title={item === null ? context.reviewItemId : item.summary}
      >
        <ActionStrip context={context} canDecide={canDecide} decideDenial={decideDenial} />
      </ShellHeader>
      <DiagnosticBanner context={context} />
      <section className="itotori-section-grid" aria-label="Reviewer detail panels">
        <SourcePanel context={context} />
        <DraftPanel context={context} />
        <ComparisonPanel context={context} />
        <DraftHistoryPanel context={context} />
        <RevisionHistoryComparisonPane reviewItemId={context.reviewItemId} />
        {/* rev-correction-loop-ui — the correction's scope + which pass (N+1)
            folds it in. Consumes the correction-feedback-loop preview
            read-model directly through the client; mounted only when the
            item's locale-branch identity is available (the preview key). */}
        {item !== null && (
          <CorrectionScopePanel
            reviewItemId={context.reviewItemId}
            localeBranchId={item.localeBranchId}
          />
        )}
        <PolicyPanel context={context} />
        <GlossaryPanel context={context} />
        <BranchReferencePanel context={context} />
        <QaFindingsPanel context={context} />
        <RuntimeEvidencePanel reviewItemId={context.reviewItemId} canRevealSensitive={canReveal} />
        <RationalePanel context={context} />
        <TransitionsPanel context={context} />
      </section>
    </main>
  );
}

function actionButtonsForKind(
  kind: ReviewerQueueItemKind,
): ReadonlyArray<{ action: ReviewerQueueAction; label: string }> {
  const base: Array<{ action: ReviewerQueueAction; label: string }> = [
    { action: reviewerQueueActionValues.approve, label: "Approve" },
    { action: reviewerQueueActionValues.reject, label: "Reject" },
  ];
  if (
    kind === reviewerQueueItemKindValues.qa ||
    kind === reviewerQueueItemKindValues.runtimeEvidence ||
    kind === reviewerQueueItemKindValues.feedback
  ) {
    base.push({ action: reviewerQueueActionValues.requestRepair, label: "Request repair" });
  }
  if (kind === reviewerQueueItemKindValues.glossary) {
    base.push({ action: reviewerQueueActionValues.updateGlossary, label: "Update glossary" });
  }
  if (kind === reviewerQueueItemKindValues.style) {
    base.push({ action: reviewerQueueActionValues.updateStyle, label: "Update style" });
  }
  if (
    kind === reviewerQueueItemKindValues.runtimeEvidence ||
    kind === reviewerQueueItemKindValues.feedback
  ) {
    base.push({
      action: reviewerQueueActionValues.importRuntimeFeedback,
      label: "Import runtime feedback",
    });
  }
  return base;
}

function ActionStrip({
  context,
  canDecide,
  decideDenial,
}: {
  context: ReviewerDetailContext;
  canDecide: boolean;
  decideDenial: string | null;
}): ReactNode {
  if (context.item === null) {
    return null;
  }
  // The legacy per-kind buttons stay disabled + explained without
  // queue.manage; the functional decide-action buttons (DecideActionStrip)
  // are gated on the canDecide capability. Both surfaces share the
  // capability so a denied actor sees disabled controls with reasons.
  const allowedManage = context.permission.canManageQueue;
  const manageDenial =
    context.permission.denialReasons.find((r) => r.includes("queue.manage")) ??
    "queue.manage permission required to take action";
  return (
    <div className="itotori-action-strip" aria-label="Reviewer actions">
      {actionButtonsForKind(context.item.itemKind).map(({ action, label }) => (
        <button
          key={action}
          type="button"
          data-action={action}
          disabled={!allowedManage}
          aria-disabled={!allowedManage}
          title={allowedManage ? undefined : manageDenial}
          aria-description={allowedManage ? undefined : manageDenial}
        >
          {label}
        </button>
      ))}
      <DecideActionStrip context={context} canDecide={canDecide} decideDenial={decideDenial} />
    </div>
  );
}

// HI-FI STUDIO EPIC · Review — the DECIDE action.
// The two buttons a `canDecide` reviewer uses on the detail page:
//
//   - "Approve"            → POST /api/reviewer/queue/:id/action
//                             { action: "approve" } — item becomes accepted
//                             (the "proven" state).
//   - "Queue correction"   → POST /api/reviewer/queue/:id/action
//                             { action: "request_repair", repairHint }
//                             the item is moved to `repair_requested` and
//                             enqueued for the next repair pass (the "next
//                             pass" state) by the SAME action service path
//                             the batch route consumes (ITOTORI-082).
//
// Both fire THROUGH `apiClient.request("reviewer.itemAction", ...)` — the
// typed single-item seam that already exists in the API contract, NOT an
// ad-hoc fetch and NOT a new api-contract route.
//
// fnd-caps-context — a denied decide action is DISABLED + EXPLAINED (not a
// silent no-op). When canDecide is true the functional body mounts; when
// false the strip still renders the buttons disabled with the denial reason
// so the actor sees *why* decide is unavailable.
function DecideActionStrip({
  context,
  canDecide,
  decideDenial,
}: {
  context: ReviewerDetailContext;
  canDecide: boolean;
  decideDenial: string | null;
}): ReactNode {
  if (context.item === null) {
    return null;
  }
  if (!canDecide) {
    const reason = decideDenial ?? "queue.manage permission required to decide";
    return (
      <span className="itotori-decide-strip" data-decide-strip="denied" aria-label="Decide actions">
        <CapGatedButton capability="decide" allowed={false} data-action="approve">
          Approve
        </CapGatedButton>
        <CapGatedButton capability="decide" allowed={false} data-action="queue_correction">
          Queue correction
        </CapGatedButton>
        <span role="note" data-cap-denial="decide">
          {reason}
        </span>
      </span>
    );
  }
  return <DecideActionBody context={context} item={context.item} />;
}

function DecideActionBody({
  context,
  item,
}: {
  context: ReviewerDetailContext;
  item: NonNullable<ReviewerDetailContext["item"]>;
}): ReactNode {
  const { notifyHandoff } = useWorkflowHandoffToasts();
  const [pending, setPending] = useState<null | "approve" | "queue_correction">(null);
  const [error, setError] = useState<{
    action: "approve" | "queue_correction";
    message: string;
  } | null>(null);
  const reviewerUserId = context.permission.actorUserId;
  async function fire(action: "approve" | "queue_correction"): Promise<void> {
    if (pending !== null) {
      return;
    }
    setError(null);
    setPending(action);
    // Wire body — matches the `ApiReviewerSingleActionRequest` schema
    // exactly (no `reviewItemId`; the item id lives on the URL path).
    type DecideRequestBody =
      | { action: "approve"; actorUserId: string; expectedSourceRevisionId: string }
      | {
          action: "request_repair";
          actorUserId: string;
          expectedSourceRevisionId: string;
          repairHint: string;
        };
    const body: DecideRequestBody =
      action === "approve"
        ? {
            action: "approve",
            actorUserId: reviewerUserId,
            expectedSourceRevisionId: item.sourceRevisionId,
          }
        : {
            action: "request_repair",
            actorUserId: reviewerUserId,
            expectedSourceRevisionId: item.sourceRevisionId,
            repairHint: `Reviewer queued for next pass from /reviewer-queue/${context.reviewItemId}`,
          };
    const result = await apiClient.request("reviewer.itemAction", {
      pathParams: { reviewItemId: context.reviewItemId },
      // The wire shape matches `body`; the typed contract includes
      // `reviewItemId` even though the parser takes the id from the URL
      // path — fold it in so the typed client stays in lock-step with the
      // server-side parser without requiring an api-contract edit.
      body: { reviewItemId: context.reviewItemId, ...body },
    });
    if (result.state === "ready" && result.data.applied) {
      // shell-toasts — a successful decide is a workflow handoff: surface it
      // as a legible toast (approved / correction-queued), matching the
      // hi-fi studio store wording. Failures stay in-strip (alert).
      if (action === "approve") {
        notifyHandoff({ kind: "approved" });
      } else {
        notifyHandoff({ kind: "correction-queued" });
      }
      setPending(null);
      return;
    }
    if (result.state === "ready" && !result.data.applied) {
      setError({
        action,
        message: result.data.outcome.kind === "refused" ? result.data.outcome.message : "refused",
      });
    } else if (result.state === "error") {
      const code = result.error.code ?? "unavailable";
      const detail = result.error.message ?? `status ${result.error.status}`;
      setError({ action, message: `${code}: ${detail}` });
    } else {
      setError({ action, message: "Unexpected empty response" });
    }
    setPending(null);
  }
  const busy = pending !== null;
  return (
    <div
      className="itotori-decide-action-strip"
      data-strip="decide-action"
      data-busy={busy ? "true" : "false"}
    >
      <button
        type="button"
        data-action="decide-approve"
        data-decide="approve"
        disabled={busy}
        aria-disabled={busy}
        onClick={() => {
          void fire("approve");
        }}
        title="Approve the item — marks the unit as proven"
      >
        {pending === "approve" ? "Approving…" : "Approve"}
      </button>
      <button
        type="button"
        data-action="decide-queue-correction"
        data-decide="queue_correction"
        disabled={busy}
        aria-disabled={busy}
        onClick={() => {
          void fire("queue_correction");
        }}
        title="Queue a correction — sends the item to the next repair pass"
      >
        {pending === "queue_correction" ? "Queueing…" : "Queue correction"}
      </button>
      {error !== null && (
        <p
          role="alert"
          data-decide-error={error.action}
          className="itotori-decide-action-strip__error"
        >
          <Badge status="failed">{error.action}</Badge> {error.message}
        </p>
      )}
    </div>
  );
}

function DiagnosticBanner({ context }: { context: ReviewerDetailContext }): ReactNode {
  if (context.diagnostics.length === 0) {
    return null;
  }
  return (
    <section className="itotori-diagnostic-banner" role="alert" aria-label="Context diagnostics">
      <ul>
        {context.diagnostics.map((d) => (
          <li key={d.code} data-diagnostic-code={d.code}>
            <Badge status="warning">{d.code}</Badge> {d.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MissingContext({ label }: { label: string }): ReactNode {
  return <p className="itotori-missing-context">{label} — see diagnostic.</p>;
}

function SourcePanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Source unit" eyebrow="Source">
      {context.source === null ? (
        <MissingContext label="No source unit" />
      ) : (
        <>
          <p>
            <code>{context.source.sourceUnitKey}</code> · {context.source.sourceLocale}
          </p>
          <p className="itotori-source-text">{context.source.sourceText}</p>
          {context.source.contextNote !== null && (
            <p className="itotori-context-note">{context.source.contextNote}</p>
          )}
        </>
      )}
    </Panel>
  );
}

function DraftPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Draft" eyebrow="Translation">
      {context.draft === null ? (
        <MissingContext label="No draft" />
      ) : (
        <>
          <p>
            <Badge status={context.draft.draftStatus} /> · {context.draft.targetLocale} · attempt{" "}
            {context.draft.attemptCount}
          </p>
          <p className="itotori-draft-text">{context.draft.draftText}</p>
        </>
      )}
    </Panel>
  );
}

function ComparisonPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  if (context.source === null || context.draft === null) {
    return (
      <Panel title="Comparison" eyebrow="Source vs draft">
        <MissingContext label="Comparison unavailable" />
      </Panel>
    );
  }
  return (
    <Panel title="Comparison" eyebrow="Source vs draft">
      <ComparisonPane
        source={context.source.sourceText}
        draft={context.draft.draftText}
        sourceLabel={context.source.sourceLocale}
        draftLabel={context.draft.targetLocale}
      />
    </Panel>
  );
}

// The draft-history panel renders the version PROGRESSION for the unit under
// review from the `reviewer.detail` draft record: the draft (v1/v2 — the loop
// may have iterated it to `attemptCount`) and the approved patch (patch-v3).
// A `BiText` carries the source ↔ draft version; a `ComparisonPane` carries the
// draft → approved-patch delta once a patch exists. The attempt counter and
// status badge make the iteration visible without leaving the panel.
function DraftHistoryPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  const draft = context.draft;
  return (
    <Panel
      title="Draft history"
      eyebrow="Draft → approved patch"
      className="itotori-panel--draft-history"
    >
      <div className="itotori-draft-history" data-panel-id="draft-history">
        {draft === null ? (
          <MissingContext label="No draft history" />
        ) : (
          <>
            <div className="itotori-metric-row" aria-label="Draft progression">
              <StatReadout label="Target locale" value={<code>{draft.targetLocale}</code>} />
              <StatReadout label="Attempt" value={draft.attemptCount} unit="of draft loop" />
              <StatReadout label="Draft status" value={<Badge status={draft.draftStatus} />} />
            </div>
            <ol className="itotori-draft-history__steps" aria-label="Draft version progression">
              <li className="itotori-draft-history__step" data-draft-stage="draft">
                <BiText
                  source={context.source?.sourceText ?? ""}
                  translation={draft.draftText}
                  sourceLocale={context.source?.sourceLocale ?? "source"}
                  targetLocale={draft.targetLocale}
                  speaker={
                    <span className="itotori-draft-history__version">
                      Draft · attempt {draft.attemptCount}
                    </span>
                  }
                />
              </li>
              <li className="itotori-draft-history__step" data-draft-stage="patch">
                {draft.approvedPatchText === null ? (
                  <p className="itotori-empty-copy">
                    No approved patch yet — draft awaiting review.
                  </p>
                ) : (
                  <ComparisonPane
                    source={draft.draftText}
                    draft={draft.approvedPatchText}
                    sourceLabel={`Draft · ${draft.targetLocale}`}
                    draftLabel={`Approved patch · ${draft.targetLocale}`}
                    draftMeta={<Badge status={draft.draftStatus} />}
                  />
                )}
              </li>
            </ol>
          </>
        )}
      </div>
    </Panel>
  );
}

// The policy panel surfaces the style-guide POLICY the draft was measured
// against: the policy identity + status + approval provenance from
// `context.policy`, folded with the EXACT branch policy reference the draft was
// produced under (`context.branchReference`). The read-model references the
// policy by version identity — it does not decompose it into an enumerated rule
// list — so this is the policy's identity + provenance, not a per-rule table.
function PolicyPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  const policy = context.policy;
  const reference = context.branchReference;
  return (
    <Panel title="Style-guide policy" eyebrow="Policy rules">
      <div className="itotori-policy-rules" data-panel-id="policy-rules">
        {policy === null ? (
          <MissingContext label="No policy" />
        ) : (
          <>
            <p className="itotori-policy-rules__label">
              <Badge status={policy.styleGuidePolicyStatus} /> {policy.policyLabel}
            </p>
            <div className="itotori-metric-row" aria-label="Policy provenance">
              <StatReadout
                label="Policy version"
                value={<code>{policy.styleGuidePolicyVersionId}</code>}
                mono
              />
              <StatReadout
                label="Approved"
                value={policy.approvedAt === null ? "unapproved" : String(policy.approvedAt)}
              />
              <StatReadout label="Approver" value={policy.approverUserId ?? "none"} />
              {reference !== null && (
                <>
                  <StatReadout
                    label="Branch policy ref"
                    value={<code>{reference.branchPolicyRef ?? "none"}</code>}
                    mono
                  />
                  <StatReadout label="Reference version" value={reference.versionSequence} />
                  <StatReadout label="Update reason" value={reference.updateReason} />
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

const GLOSSARY_PAGE_SIZE = 8;

// The glossary panel renders the referenced terms the reviewer must confirm the
// draft honoured, plus the branch glossary reference PROVENANCE (which exact
// glossary snapshot the draft was produced under). Client-paginated with the ds
// `Pagination` primitive when the referenced term list exceeds one page.
function GlossaryPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  const entries = context.glossary;
  const reference = context.branchReference;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(entries.length / GLOSSARY_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const windowStart = safePage * GLOSSARY_PAGE_SIZE;
  const windowed = entries.slice(windowStart, windowStart + GLOSSARY_PAGE_SIZE);
  return (
    <Panel title="Glossary" eyebrow="Terminology">
      <div className="itotori-glossary" data-panel-id="glossary">
        {reference !== null && (
          <div className="itotori-metric-row" aria-label="Glossary provenance">
            <StatReadout label="Glossary ref" value={<code>{reference.glossaryRef}</code>} mono />
            <StatReadout label="Reference version" value={reference.versionSequence} />
          </div>
        )}
        {entries.length === 0 ? (
          <MissingContext label="No glossary entries" />
        ) : (
          <>
            <DataTable
              caption="Glossary entries"
              columns={[
                { key: "term", header: "Term", render: (g) => g.sourceTerm },
                { key: "preferred", header: "Preferred", render: (g) => g.preferredTranslation },
                {
                  key: "status",
                  header: "Status",
                  render: (g) => <Badge status={g.glossaryEntryStatus} />,
                },
              ]}
              rows={windowed}
              getRowKey={(g) => g.termId}
            />
            {entries.length > GLOSSARY_PAGE_SIZE && (
              <Pagination
                page={safePage}
                pageCount={pageCount}
                onPrevious={() => setPage((p) => Math.max(0, p - 1))}
                onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                label="Glossary pages"
                totalItems={entries.length}
                itemName="term"
              />
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

function BranchReferencePanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Branch reference" eyebrow="Provenance">
      {context.branchReference === null ? (
        <MissingContext label="No branch policy/glossary reference" />
      ) : (
        <dl className="itotori-metric-list">
          <div>
            <dt>Glossary ref</dt>
            <dd>
              <code>{context.branchReference.glossaryRef}</code>
            </dd>
          </div>
          <div>
            <dt>Policy ref</dt>
            <dd>
              <code>{context.branchReference.branchPolicyRef ?? "none"}</code>
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{context.branchReference.versionSequence}</dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}

function QaFindingsPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="QA findings" eyebrow="Quality">
      {context.qaFindings.length === 0 ? (
        <p className="itotori-empty-copy">No QA findings.</p>
      ) : (
        <DataTable
          caption="QA findings"
          columns={[
            { key: "category", header: "Category", render: (f) => f.category },
            { key: "severity", header: "Severity", render: (f) => <Badge status={f.severity} /> },
            { key: "summary", header: "Summary", render: (f) => f.summary },
          ]}
          rows={context.qaFindings}
          getRowKey={(f) => f.findingId}
        />
      )}
    </Panel>
  );
}

function RationalePanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Rationale" eyebrow="Upstream">
      {context.rationaleRefs.length === 0 ? (
        <MissingContext label="No rationale references" />
      ) : (
        <ul>
          {context.rationaleRefs.map((r) => (
            <li key={`${r.refKind}:${r.refId}`}>
              {r.label} — <code>{r.refKind}</code> <code>{r.refId}</code>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function TransitionsPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Transitions" eyebrow="History">
      {context.transitions.length === 0 ? (
        <p className="itotori-empty-copy">No transitions recorded.</p>
      ) : (
        <DataTable
          caption="Transition history"
          columns={[
            { key: "action", header: "Action", render: (t) => t.action },
            { key: "prior", header: "From", render: (t) => t.priorState },
            { key: "next", header: "To", render: (t) => t.nextState },
            { key: "actor", header: "Actor", render: (t) => t.actorUserId },
            { key: "at", header: "At", render: (t) => String(t.createdAt) },
          ]}
          rows={context.transitions}
          getRowKey={(t) => t.transitionId}
        />
      )}
    </Panel>
  );
}
