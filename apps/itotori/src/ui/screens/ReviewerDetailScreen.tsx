// fnd-spa-shell — the reviewer-queue item detail screen.
//
// Parity port of the deleted HTML-string `reviewer/detail-view.ts`. Consumes
// `/api/reviewer/queue/:id/detail` THROUGH the typed client and renders the
// same panels: the permission-denial UI, a visible diagnostic banner (missing
// context is never a silent empty panel), the action strip (disabled without
// queue.manage), and the source / draft / comparison / policy / glossary /
// branch-reference / QA-findings / runtime-evidence / rationale / transitions
// panels — all with `@itotori/ds` components.

import type { ReactNode } from "react";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  type ReviewerQueueAction,
  type ReviewerQueueItemKind,
} from "@itotori/db";
import { Badge, ComparisonPane, DataTable, Panel } from "@itotori/ds";
import type { ReviewerDetailContext } from "../../reviewer/detail-fixtures.js";
import { useApiQuery } from "../use-api-resource.js";
import { ErrorState, LoadingState, ShellHeader } from "../states.js";

export function ReviewerDetailScreen({ reviewItemId }: { reviewItemId: string }): ReactNode {
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
  return <ReadyView context={context} />;
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

function ReadyView({ context }: { context: ReviewerDetailContext }): ReactNode {
  const item = context.item;
  return (
    <main
      className="itotori-shell reviewer-detail"
      data-screen="reviewer-detail"
      data-state="ready"
      data-review-item-id={context.reviewItemId}
      data-can-manage={context.permission.canManageQueue ? "true" : "false"}
    >
      <ShellHeader
        eyebrow="Reviewer detail"
        title={item === null ? context.reviewItemId : item.summary}
      >
        <ActionStrip context={context} />
      </ShellHeader>
      <DiagnosticBanner context={context} />
      <section className="itotori-section-grid" aria-label="Reviewer detail panels">
        <SourcePanel context={context} />
        <DraftPanel context={context} />
        <ComparisonPanel context={context} />
        <PolicyPanel context={context} />
        <GlossaryPanel context={context} />
        <BranchReferencePanel context={context} />
        <QaFindingsPanel context={context} />
        <RuntimeEvidencePanel context={context} />
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

function ActionStrip({ context }: { context: ReviewerDetailContext }): ReactNode {
  if (context.item === null) {
    return null;
  }
  const allowed = context.permission.canManageQueue;
  return (
    <div className="itotori-action-strip" aria-label="Reviewer actions">
      {actionButtonsForKind(context.item.itemKind).map(({ action, label }) => (
        <button
          key={action}
          type="button"
          data-action={action}
          disabled={!allowed}
          aria-disabled={!allowed}
          title={allowed ? undefined : "queue.manage permission required to take action"}
        >
          {label}
        </button>
      ))}
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

function PolicyPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Style-guide policy" eyebrow="Policy">
      {context.policy === null ? (
        <MissingContext label="No policy" />
      ) : (
        <p>
          <Badge status={context.policy.styleGuidePolicyStatus} /> {context.policy.policyLabel} ·{" "}
          <code>{context.policy.styleGuidePolicyVersionId}</code>
        </p>
      )}
    </Panel>
  );
}

function GlossaryPanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Glossary" eyebrow="Terminology">
      {context.glossary.length === 0 ? (
        <MissingContext label="No glossary entries" />
      ) : (
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
          rows={context.glossary}
          getRowKey={(g) => g.termId}
        />
      )}
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

function RuntimeEvidencePanel({ context }: { context: ReviewerDetailContext }): ReactNode {
  return (
    <Panel title="Runtime evidence" eyebrow="Fidelity">
      {context.runtimeEvidence.length === 0 ? (
        <MissingContext label="No runtime evidence" />
      ) : (
        <DataTable
          caption="Runtime evidence"
          columns={[
            { key: "kind", header: "Kind", render: (e) => e.evidenceKind },
            { key: "tier", header: "Tier", render: (e) => e.evidenceTier },
            {
              key: "target",
              header: "Runtime target",
              render: (e) => <code>{e.runtimeTargetId}</code>,
            },
            {
              key: "events",
              header: "Observation events",
              render: (e) => e.observationEventIds.join(", ") || "none",
            },
            {
              key: "hashes",
              header: "Artifact hashes",
              render: (e) => e.artifactHashes.join(", ") || "none",
            },
          ]}
          rows={context.runtimeEvidence}
          getRowKey={(e, i) => `${e.runtimeTargetId}:${i}`}
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
