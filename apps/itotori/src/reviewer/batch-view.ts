// ITOTORI-083 — Reviewer batch action preview view (pure render).
//
// Stateless, dependency-free renderer for the batch-preview page.
// Takes a `ReviewerBatchPreview` (computed by the preview service) and
// emits HTML. No `fetch`, no DOM mutation, no globals — every test
// exercises the renderer directly with a fixture.
//
// Acceptance addressed:
//   #1 Preview lists every selected queue item, required permission,
//      affected drafts / exports / rerun jobs / glossary terms / policy
//      versions / benchmark artifacts.
//   #3 Preview rows are computed by the SAME validator the execution
//      path uses (`validateReviewerQueueTransition`). This file is the
//      visible surface for that contract.
//   #4 Empty selection / mixed kinds / conflicting actions / atomic
//      execution all have first-class visible UI: the renderer never
//      collapses any per-item row.

import {
  reviewerBatchPreviewStatusValues,
  type BatchPreviewItem,
  type ReviewerBatchConsequence,
  type ReviewerBatchPreview,
  type ReviewerBatchPreviewStatus,
} from "./batch-preview.js";

export const reviewerBatchRoutePathRegex = /^\/reviewer-queue\/batch$/u;

export type ReviewerBatchRouteParams = {
  // No-op placeholder. The batch route does not parameterize the URL
  // itself; the request body is what selects the items. The type is
  // exported so the SPA bootstrap thread types remain symmetric with
  // the detail route.
  _: never;
};

export function parseReviewerBatchRoute(pathname: string): true | null {
  return reviewerBatchRoutePathRegex.exec(pathname) === null ? null : true;
}

export function renderReviewerBatchPreviewView(preview: ReviewerBatchPreview): string {
  if (preview.permissionDenied) {
    return renderDeniedView(preview);
  }
  return renderReadyView(preview);
}

function renderDeniedView(preview: ReviewerBatchPreview): string {
  const denialReason =
    preview.permission.denialReasons[0] ??
    `user ${preview.permission.actorUserId} cannot read queue`;
  return `
    ${reviewerBatchStyles()}
    <main class="itotori-shell reviewer-batch" data-state="denied"
      data-actor-user-id="${escapeHtml(preview.permission.actorUserId)}"
      data-action="${escapeHtml(preview.request.action)}">
      <header class="shell-header">
        <p class="eyebrow">Reviewer batch preview</p>
        <h1>Access denied</h1>
        <p class="subhead">
          Selected ${preview.request.selections.length} review
          ${preview.request.selections.length === 1 ? "item" : "items"} for action
          <code>${escapeHtml(preview.request.action)}</code>.
        </p>
      </header>
      <section class="denial-panel" role="alert" aria-label="Permission denied">
        <h2>You do not have permission to preview this batch.</h2>
        <p>${escapeHtml(denialReason)}</p>
        <p class="subhead">
          The batch preview intentionally withholds per-item context until the
          <code>queue.read</code> permission is granted; execution additionally requires
          <code>queue.manage</code>.
        </p>
      </section>
    </main>
  `;
}

function renderReadyView(preview: ReviewerBatchPreview): string {
  return `
    ${reviewerBatchStyles()}
    <main class="itotori-shell reviewer-batch" data-state="ready"
      data-actor-user-id="${escapeHtml(preview.permission.actorUserId)}"
      data-action="${escapeHtml(preview.request.action)}"
      data-can-manage="${preview.permission.canManageQueue ? "true" : "false"}"
      data-all-allowed="${preview.allAllowed ? "true" : "false"}">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Reviewer batch preview</p>
          <h1>${escapeHtml(headlineForAction(preview))}</h1>
          <p class="subhead">
            Action <code>${escapeHtml(preview.request.action)}</code> targeting
            ${preview.items.length}
            ${preview.items.length === 1 ? "selection" : "selections"}.
          </p>
        </div>
        <div class="action-strip" aria-label="Batch actions">
          <button type="button" data-batch-action="cancel">Cancel</button>
          <button type="button" data-batch-action="confirm"
            ${preview.allAllowed && preview.permission.canManageQueue ? "" : 'disabled aria-disabled="true"'}>
            Confirm batch
          </button>
        </div>
      </header>
      ${renderAggregateBanner(preview)}
      ${preview.items.length === 0 ? renderEmptySelection() : renderItemsTable(preview)}
    </main>
  `;
}

function headlineForAction(preview: ReviewerBatchPreview): string {
  if (preview.items.length === 0) {
    return "No review items selected";
  }
  if (preview.allAllowed && preview.permission.canManageQueue) {
    return `Confirm ${preview.items.length} ${preview.request.action} actions`;
  }
  if (preview.allAllowed && !preview.permission.canManageQueue) {
    return `Preview only — ${preview.items.length} would apply if queue.manage were granted`;
  }
  return `Review batch — ${preview.aggregate.allowed} of ${preview.aggregate.total} would apply`;
}

function renderAggregateBanner(preview: ReviewerBatchPreview): string {
  if (preview.items.length === 0) {
    return "";
  }
  const segments: string[] = [];
  const { aggregate } = preview;
  segments.push(`${aggregate.allowed} allowed`);
  if (aggregate.stale > 0) segments.push(`${aggregate.stale} stale`);
  if (aggregate.notFound > 0) segments.push(`${aggregate.notFound} not found`);
  if (aggregate.duplicate > 0) segments.push(`${aggregate.duplicate} duplicate`);
  if (aggregate.invalidInput > 0) segments.push(`${aggregate.invalidInput} invalid input`);
  if (aggregate.invalidTransition > 0)
    segments.push(`${aggregate.invalidTransition} invalid transition`);
  if (aggregate.runtimeEvidenceInvariant > 0)
    segments.push(`${aggregate.runtimeEvidenceInvariant} runtime evidence invariant`);
  if (aggregate.permissionDeniedManage > 0)
    segments.push(`${aggregate.permissionDeniedManage} permission denied`);
  return `
    <section class="aggregate-banner" aria-label="Batch outcome summary" data-all-allowed="${preview.allAllowed}">
      <h2>${escapeHtml(segments.join(", "))}</h2>
      ${
        preview.allAllowed
          ? `<p class="subhead">Every selected item passes the shared transition validator.</p>`
          : `<p class="subhead">Refusals fail closed: confirming will mutate zero rows.</p>`
      }
    </section>
  `;
}

function renderEmptySelection(): string {
  return `
    <section class="panel empty-selection" aria-label="Empty selection"
      data-panel-id="empty-selection">
      <h2>No review items selected</h2>
      <p>Select reviewer queue items from the dashboard before previewing a batch action.</p>
    </section>
  `;
}

function renderItemsTable(preview: ReviewerBatchPreview): string {
  const rows = preview.items.map((entry) => renderItemRow(entry)).join("");
  return `
    <section class="panel" aria-label="Per-item preview rows" data-panel-id="items">
      <table>
        <thead>
          <tr>
            <th scope="col">Review item</th>
            <th scope="col">Kind</th>
            <th scope="col">Prior → Next</th>
            <th scope="col">Status</th>
            <th scope="col">Required permission</th>
            <th scope="col">Affected artifacts</th>
            <th scope="col">Consequences</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderItemRow(entry: BatchPreviewItem): string {
  const itemKind = entry.item === null ? "—" : entry.item.itemKind;
  const prior = entry.priorState ?? "—";
  const next = entry.nextState ?? "—";
  const affected =
    entry.item === null
      ? "—"
      : entry.item.affectedArtifactIds.length === 0
        ? "—"
        : entry.item.affectedArtifactIds
            .map(
              (id) =>
                `<code data-affected-artifact-id="${escapeHtml(id)}">${escapeHtml(id)}</code>`,
            )
            .join(" ");
  return `
    <tr data-review-item-id="${escapeHtml(entry.reviewItemId)}"
      data-status="${escapeHtml(entry.status)}"
      data-required-permission="${escapeHtml(entry.requiredPermission)}">
      <td><code>${escapeHtml(entry.reviewItemId)}</code></td>
      <td>${escapeHtml(itemKind)}</td>
      <td>${escapeHtml(prior)} → ${escapeHtml(next)}</td>
      <td>${statusBadge(entry.status)}</td>
      <td><code>${escapeHtml(entry.requiredPermission)}</code></td>
      <td>${affected}</td>
      <td>${renderConsequenceList(entry.consequences)}</td>
      <td>${entry.message === null ? `<span class="empty-copy">—</span>` : escapeHtml(entry.message)}</td>
    </tr>
  `;
}

function renderConsequenceList(consequences: ReviewerBatchConsequence[]): string {
  if (consequences.length === 0) {
    return `<span class="empty-copy">—</span>`;
  }
  const rows = consequences
    .map(
      (entry) =>
        `<li data-consequence-kind="${escapeHtml(entry.kind)}">${renderConsequence(entry)}</li>`,
    )
    .join("");
  return `<ul class="consequence-list">${rows}</ul>`;
}

function renderConsequence(entry: ReviewerBatchConsequence): string {
  switch (entry.kind) {
    case "rerun_job":
      return `Rerun <code data-runtime-target-id="${escapeHtml(entry.runtimeTargetId)}">${escapeHtml(entry.runtimeTargetId)}</code>: ${escapeHtml(entry.jobLabel)}`;
    case "policy_version_write":
      return `Write policy <code data-policy-version-id="${escapeHtml(entry.styleGuidePolicyVersionId)}">${escapeHtml(entry.styleGuidePolicyVersionId)}</code>: ${escapeHtml(entry.ruleLabel)}`;
    case "glossary_term_write":
      return `Write glossary term <code data-glossary-term-id="${escapeHtml(entry.termId)}">${escapeHtml(entry.termId)}</code> → ${escapeHtml(entry.approvedTranslation)}`;
    case "export_artifact":
      return `Affects export <code data-export-artifact-id="${escapeHtml(entry.exportArtifactId)}">${escapeHtml(entry.exportArtifactId)}</code>: ${escapeHtml(entry.artifactLabel)}`;
    case "benchmark_artifact":
      return `Affects benchmark <code data-benchmark-artifact-id="${escapeHtml(entry.benchmarkArtifactId)}">${escapeHtml(entry.benchmarkArtifactId)}</code>: ${escapeHtml(entry.benchmarkLabel)}`;
    case "draft_state_change":
      return `Draft <code data-draft-id="${escapeHtml(entry.draftId)}">${escapeHtml(entry.draftId)}</code> → ${escapeHtml(entry.nextDraftStatus)}`;
    default: {
      const exhaustive: never = entry;
      throw new Error(`unhandled consequence kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function statusBadge(status: ReviewerBatchPreviewStatus): string {
  const tone =
    status === reviewerBatchPreviewStatusValues.allowed
      ? "ok"
      : status === reviewerBatchPreviewStatusValues.permissionDeniedManage
        ? "neutral"
        : "critical";
  return `<span class="badge badge-${tone}" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function reviewerBatchStyles(): string {
  return `
    <style>
      .reviewer-batch {
        min-height: 100vh;
        padding: 24px;
        background: #f6f7f7;
        color: #182026;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }
      .reviewer-batch .shell-header {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) auto;
        gap: 16px;
        align-items: start;
        margin-bottom: 18px;
      }
      .reviewer-batch .eyebrow {
        margin: 0 0 6px;
        color: #56636d;
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
      }
      .reviewer-batch h1 { margin: 0; font-size: 1.6rem; }
      .reviewer-batch h2 { margin: 0; font-size: 1.05rem; }
      .reviewer-batch .subhead { margin: 6px 0 0; color: #56636d; }
      .reviewer-batch .action-strip {
        display: flex; gap: 8px; flex-wrap: wrap;
      }
      .reviewer-batch .action-strip button {
        min-height: 32px;
        padding: 0 12px;
        border: 1px solid #c9d0d6;
        border-radius: 8px;
        background: #ffffff;
        color: #24313a;
        font-weight: 700;
        cursor: pointer;
      }
      .reviewer-batch .action-strip button[disabled] {
        opacity: 0.5; cursor: not-allowed;
      }
      .reviewer-batch .denial-panel,
      .reviewer-batch .aggregate-banner {
        margin-bottom: 18px;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        padding: 18px;
        background: #ffffff;
      }
      .reviewer-batch .aggregate-banner[data-all-allowed="false"] {
        border-color: #e4beb8;
        background: #fff8f7;
      }
      .reviewer-batch .panel {
        min-width: 0;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        padding: 16px;
        background: #ffffff;
        margin-bottom: 16px;
      }
      .reviewer-batch table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 0.88rem;
      }
      .reviewer-batch th,
      .reviewer-batch td {
        border-bottom: 1px solid #e7ebee;
        padding: 8px 6px;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }
      .reviewer-batch th {
        color: #56636d;
        font-size: 0.74rem;
        font-weight: 800;
      }
      .reviewer-batch tr:last-child td { border-bottom: 0; }
      .reviewer-batch .consequence-list {
        margin: 0;
        padding: 0 0 0 18px;
      }
      .reviewer-batch .badge {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 0.74rem;
        font-weight: 800;
      }
      .reviewer-batch .badge-neutral { background: #eef3f7; color: #26333c; }
      .reviewer-batch .badge-ok       { background: #d6efe6; color: #1f5b48; }
      .reviewer-batch .badge-critical { background: #ffe7e1; color: #8a2e1c; }
      .reviewer-batch .empty-copy     { margin: 0; color: #56636d; }
    </style>
  `;
}
