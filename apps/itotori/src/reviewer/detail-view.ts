// ITOTORI-082 — reviewer detail view (pure render).
//
// Stateless, dependency-free renderer for the reviewer-queue item
// detail page. Accepts a fully-typed `ReviewerDetailContext` (loader's
// responsibility) and emits HTML. No `fetch`, no DOM, no globals —
// every test exercises the renderer directly with a fixture.
//
// Acceptance criteria addressed:
//   #1 — Each panel reads typed data (source unit, draft, policy,
//        findings, runtime evidence, rationale refs).
//   #2 — Runtime evidence rows render evidenceTier, artifactHash,
//        runtimeTargetId, observationEventIds verbatim (no local path).
//   #3 — Denial UI fires when permission.canReadQueue === false, and
//        no evidence payload renders below the denial banner.
//   #4 — Diagnostics render as a visible banner instead of an empty
//        panel; the affected panel reads "missing context — see
//        diagnostic" so the reviewer is never silently shown a blank
//        block.

import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueAction,
  type ReviewerQueueItemKind,
  type ReviewerQueueItemRecord,
  type ReviewerQueueItemState,
} from "@itotori/db";
import {
  reviewerDetailDiagnosticCodeValues,
  type ReviewerDetailBranchReference,
  type ReviewerDetailContext,
  type ReviewerDetailDiagnostic,
  type ReviewerDetailDiagnosticCode,
  type ReviewerDetailDraft,
  type ReviewerDetailGlossaryEntry,
  type ReviewerDetailPolicy,
  type ReviewerDetailQaFinding,
  type ReviewerDetailRationaleRef,
  type ReviewerDetailRuntimeEvidence,
  type ReviewerDetailSourceUnit,
  type ReviewerDetailTransition,
} from "./detail-fixtures.js";

export const reviewerDetailRoutePathRegex = /^\/reviewer-queue\/([^/]+)$/u;

export type ReviewerDetailRouteParams = {
  reviewItemId: string;
};

export function parseReviewerDetailRoute(pathname: string): ReviewerDetailRouteParams | null {
  const match = reviewerDetailRoutePathRegex.exec(pathname);
  if (match === null) {
    return null;
  }
  const reviewItemId = match[1];
  if (reviewItemId === undefined || reviewItemId.length === 0) {
    return null;
  }
  return { reviewItemId: decodeURIComponent(reviewItemId) };
}

/**
 * Render the reviewer-queue detail view. Pure: same input → same
 * output. Used both for live navigation (route loader) and snapshot
 * tests (fixture context → expected HTML).
 */
export function renderReviewerDetailView(context: ReviewerDetailContext): string {
  if (!context.permission.canReadQueue) {
    return renderDeniedView(context);
  }
  return renderReadyView(context);
}

function renderDeniedView(context: ReviewerDetailContext): string {
  const denialReason =
    context.permission.denialReasons[0] ??
    `user ${context.permission.actorUserId} cannot read queue`;
  return `
    ${reviewerDetailStyles()}
    <main class="itotori-shell reviewer-detail" data-state="denied"
      data-review-item-id="${escapeHtml(context.reviewItemId)}">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Reviewer detail</p>
          <h1>Access denied</h1>
          <p class="subhead">Review item: <code>${escapeHtml(context.reviewItemId)}</code></p>
        </div>
      </header>
      <section class="denial-panel" aria-label="Permission denied" role="alert">
        <h2>You do not have permission to view this reviewer item.</h2>
        <p>${escapeHtml(denialReason)}</p>
        <p class="subhead">
          The detail page intentionally withholds the source unit, draft, policy, glossary, QA
          findings, runtime evidence, and rationale until the
          <code>queue.read</code> permission is granted.
        </p>
      </section>
    </main>
  `;
}

function renderReadyView(context: ReviewerDetailContext): string {
  const item = context.item;
  return `
    ${reviewerDetailStyles()}
    <main class="itotori-shell reviewer-detail" data-state="ready"
      data-review-item-id="${escapeHtml(context.reviewItemId)}"
      data-can-manage="${context.permission.canManageQueue ? "true" : "false"}">
      <header class="shell-header">
        <div>
          <p class="eyebrow">Reviewer detail</p>
          <h1>${escapeHtml(item === null ? context.reviewItemId : item.summary)}</h1>
          <p class="subhead">
            Review item: <code>${escapeHtml(context.reviewItemId)}</code>
            ${item === null ? "" : ` — kind <code>${escapeHtml(item.itemKind)}</code> in state <code>${escapeHtml(item.state)}</code>`}
          </p>
        </div>
        ${renderActionStrip(context)}
      </header>
      ${renderDiagnosticBanner(context.diagnostics)}
      <section class="detail-grid" aria-label="Reviewer detail panels">
        ${renderSourcePanel(context.source, context.diagnostics)}
        ${renderDraftPanel(context.draft, context.diagnostics)}
        ${renderComparisonPanel(context.source, context.draft)}
        ${renderPolicyPanel(context.policy, context.diagnostics)}
        ${renderGlossaryPanel(context.glossary, context.diagnostics)}
        ${renderBranchReferencePanel(context.branchReference, context.diagnostics)}
        ${renderQaFindingsPanel(context.qaFindings)}
        ${renderRuntimeEvidencePanel(context.runtimeEvidence, item, context.diagnostics)}
        ${renderRationalePanel(context.rationaleRefs, context.diagnostics)}
        ${renderTransitionsPanel(context.transitions)}
      </section>
    </main>
  `;
}

function renderActionStrip(context: ReviewerDetailContext): string {
  if (context.item === null) {
    return "";
  }
  const allowed = context.permission.canManageQueue;
  const disabled = allowed ? "" : ' disabled aria-disabled="true"';
  const title = allowed ? "" : ' title="queue.manage permission required to take action"';
  const buttons = actionButtonsForKind(context.item.itemKind)
    .map(
      ({ action, label }) => `
        <button type="button" data-action="${escapeHtml(action)}"${disabled}${title}>
          ${escapeHtml(label)}
        </button>
      `,
    )
    .join("");
  return `
    <div class="action-strip" aria-label="Reviewer actions">
      ${buttons}
    </div>
  `;
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

function renderDiagnosticBanner(diagnostics: ReviewerDetailDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const rows = diagnostics
    .map(
      (diagnostic) => `
        <li data-diagnostic-code="${escapeHtml(diagnostic.code)}">
          <code>${escapeHtml(diagnostic.code)}</code>
          <span>${escapeHtml(diagnostic.message)}</span>
        </li>
      `,
    )
    .join("");
  return `
    <section class="diagnostic-banner" aria-label="Reviewer detail diagnostics" role="alert">
      <h2>${diagnostics.length === 1 ? "1 diagnostic" : `${diagnostics.length} diagnostics`}</h2>
      <ul>${rows}</ul>
    </section>
  `;
}

function renderSourcePanel(
  source: ReviewerDetailSourceUnit | null,
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  if (source === null) {
    return missingPanel(
      "source-unit",
      "Source unit",
      reviewerDetailDiagnosticCodeValues.staleSourceRevision,
      diagnostics,
    );
  }
  return panel(
    "source-unit",
    "Source unit",
    `
      <dl class="metric-list">
        <div><dt>Bridge unit</dt><dd><code>${escapeHtml(source.bridgeUnitId)}</code></dd></div>
        <div><dt>Source key</dt><dd><code>${escapeHtml(source.sourceUnitKey)}</code></dd></div>
        <div><dt>Source revision</dt><dd><code>${escapeHtml(source.sourceRevisionId)}</code></dd></div>
        <div><dt>Locale</dt><dd>${escapeHtml(source.sourceLocale)}</dd></div>
      </dl>
      <pre class="source-text">${escapeHtml(source.sourceText)}</pre>
      ${
        source.contextNote === null
          ? ""
          : `<p class="subhead">${escapeHtml(source.contextNote)}</p>`
      }
    `,
  );
}

function renderDraftPanel(
  draft: ReviewerDetailDraft | null,
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  if (draft === null) {
    return missingPanel(
      "draft",
      "Draft",
      reviewerDetailDiagnosticCodeValues.missingDraft,
      diagnostics,
    );
  }
  return panel(
    "draft",
    "Draft",
    `
      <dl class="metric-list">
        <div><dt>Draft id</dt><dd><code>${escapeHtml(draft.draftId)}</code></dd></div>
        <div><dt>Attempt id</dt><dd><code>${escapeHtml(draft.draftAttemptId)}</code></dd></div>
        <div><dt>Status</dt><dd>${statusBadge(draft.draftStatus)}</dd></div>
        <div><dt>Locale</dt><dd>${escapeHtml(draft.targetLocale)}</dd></div>
        <div><dt>Attempts</dt><dd>${draft.attemptCount}</dd></div>
      </dl>
      <pre class="draft-text">${escapeHtml(draft.draftText)}</pre>
      ${
        draft.approvedPatchText === null
          ? `<p class="subhead">No approved patch output recorded yet.</p>`
          : `
            <h3>Approved patch output</h3>
            <pre class="approved-patch">${escapeHtml(draft.approvedPatchText)}</pre>
          `
      }
    `,
  );
}

function renderComparisonPanel(
  source: ReviewerDetailSourceUnit | null,
  draft: ReviewerDetailDraft | null,
): string {
  if (source === null || draft === null) {
    return panel(
      "comparison",
      "Side-by-side comparison",
      `<p class="empty-copy">Comparison requires both the source unit and the draft.</p>`,
    );
  }
  return panel(
    "comparison",
    "Side-by-side comparison",
    `
      <div class="comparison-grid" aria-label="Source vs draft comparison">
        <article class="comparison-cell" data-comparison-side="source">
          <h3>Source (${escapeHtml(source.sourceLocale)})</h3>
          <pre>${escapeHtml(source.sourceText)}</pre>
        </article>
        <article class="comparison-cell" data-comparison-side="draft">
          <h3>Draft (${escapeHtml(draft.targetLocale)})</h3>
          <pre>${escapeHtml(draft.draftText)}</pre>
        </article>
        ${
          draft.approvedPatchText === null
            ? ""
            : `
              <article class="comparison-cell" data-comparison-side="approved-patch">
                <h3>Approved patch output</h3>
                <pre>${escapeHtml(draft.approvedPatchText)}</pre>
              </article>
            `
        }
      </div>
    `,
  );
}

function renderPolicyPanel(
  policy: ReviewerDetailPolicy | null,
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  if (policy === null) {
    return missingPanel(
      "policy",
      "Locale branch policy",
      reviewerDetailDiagnosticCodeValues.missingPolicy,
      diagnostics,
    );
  }
  return panel(
    "policy",
    "Locale branch policy",
    `
      <dl class="metric-list">
        <div><dt>Policy version</dt><dd><code>${escapeHtml(policy.styleGuidePolicyVersionId)}</code></dd></div>
        <div><dt>Status</dt><dd>${statusBadge(policy.styleGuidePolicyStatus)}</dd></div>
        <div><dt>Label</dt><dd>${escapeHtml(policy.policyLabel)}</dd></div>
        <div><dt>Approver</dt><dd>${escapeHtml(policy.approverUserId ?? "—")}</dd></div>
        <div><dt>Approved at</dt><dd>${policy.approvedAt === null ? "—" : formatIso(policy.approvedAt)}</dd></div>
      </dl>
    `,
  );
}

function renderGlossaryPanel(
  glossary: ReviewerDetailGlossaryEntry[],
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  if (glossary.length === 0) {
    return missingPanel(
      "glossary",
      "Glossary references",
      reviewerDetailDiagnosticCodeValues.missingGlossaryRef,
      diagnostics,
    );
  }
  const rows = glossary
    .map(
      (entry) => `
        <tr data-glossary-term-id="${escapeHtml(entry.termId)}">
          <td><code>${escapeHtml(entry.termId)}</code></td>
          <td>${escapeHtml(entry.sourceTerm)}</td>
          <td>${escapeHtml(entry.preferredTranslation)}</td>
          <td>${statusBadge(entry.glossaryEntryStatus)}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "glossary",
    "Glossary references",
    `
      <table>
        <thead>
          <tr>
            <th scope="col">Term id</th>
            <th scope="col">Source term</th>
            <th scope="col">Preferred translation</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

// ITOTORI-139 — surface the exact branch policy + glossary reference the
// draft was produced under, so the reviewer (a non-DB consumer) can read
// the provenance directly instead of trusting the DB. The values are
// echoed verbatim into data-* attributes so tests can pin them.
function renderBranchReferencePanel(
  branchReference: ReviewerDetailBranchReference | null,
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  if (branchReference === null) {
    return missingPanel(
      "branch-reference",
      "Branch policy / glossary reference",
      reviewerDetailDiagnosticCodeValues.missingBranchReference,
      diagnostics,
    );
  }
  return panel(
    "branch-reference",
    "Branch policy / glossary reference",
    `
      <dl class="metric-list"
        data-branch-reference-id="${escapeHtml(branchReference.referenceId)}"
        data-draft-id="${escapeHtml(branchReference.draftId)}"
        data-branch-policy-ref="${escapeHtml(branchReference.branchPolicyRef ?? "")}"
        data-glossary-ref="${escapeHtml(branchReference.glossaryRef)}">
        <div><dt>Reference id</dt><dd><code>${escapeHtml(branchReference.referenceId)}</code></dd></div>
        <div><dt>Version</dt><dd>${branchReference.versionSequence}</dd></div>
        <div><dt>Attached to draft</dt><dd><code>${escapeHtml(branchReference.draftId)}</code></dd></div>
        <div><dt>Branch policy ref</dt><dd><code>${escapeHtml(branchReference.branchPolicyRef ?? "—")}</code></dd></div>
        <div><dt>Glossary ref</dt><dd><code>${escapeHtml(branchReference.glossaryRef)}</code></dd></div>
        <div><dt>Supersedes</dt><dd><code>${escapeHtml(branchReference.supersedesReferenceId ?? "—")}</code></dd></div>
        <div><dt>Update reason</dt><dd>${escapeHtml(branchReference.updateReason)}</dd></div>
      </dl>
    `,
  );
}

function renderQaFindingsPanel(findings: ReviewerDetailQaFinding[]): string {
  if (findings.length === 0) {
    return panel(
      "qa-findings",
      "QA findings",
      `<p class="empty-copy">No QA findings are linked to this reviewer-queue item.</p>`,
    );
  }
  const rows = findings
    .map(
      (finding) => `
        <tr data-finding-id="${escapeHtml(finding.findingId)}">
          <td><code>${escapeHtml(finding.findingId)}</code></td>
          <td>${escapeHtml(finding.category)}</td>
          <td>${statusBadge(finding.severity)}</td>
          <td>${escapeHtml(finding.summary)}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "qa-findings",
    "QA findings",
    `
      <table>
        <thead>
          <tr>
            <th scope="col">Finding</th>
            <th scope="col">Category</th>
            <th scope="col">Severity</th>
            <th scope="col">Summary</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

function renderRuntimeEvidencePanel(
  evidence: ReviewerDetailRuntimeEvidence[],
  item: ReviewerQueueItemRecord | null,
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  if (evidence.length === 0) {
    return missingPanel(
      "runtime-evidence",
      "Runtime evidence",
      reviewerDetailDiagnosticCodeValues.missingRuntimeEvidence,
      diagnostics,
    );
  }
  const persistedHeader =
    item === null || item.itemKind !== reviewerQueueItemKindValues.runtimeEvidence
      ? ""
      : `
        <dl class="metric-list">
          <div>
            <dt>Item evidence tier</dt>
            <dd><code>${escapeHtml(item.evidenceTier ?? "—")}</code></dd>
          </div>
          <div>
            <dt>Item artifact hashes</dt>
            <dd><code>${escapeHtml((item.artifactHashes ?? []).join(", ") || "—")}</code></dd>
          </div>
          <div>
            <dt>Item observation events</dt>
            <dd><code>${escapeHtml((item.observationEventIds ?? []).join(", ") || "—")}</code></dd>
          </div>
        </dl>
      `;
  const rows = evidence
    .map(
      (entry) => `
        <tr data-evidence-kind="${escapeHtml(entry.evidenceKind)}">
          <td>${escapeHtml(entry.evidenceKind)}</td>
          <td><code data-evidence-tier="${escapeHtml(entry.evidenceTier)}">${escapeHtml(entry.evidenceTier)}</code></td>
          <td><code data-runtime-target-id="${escapeHtml(entry.runtimeTargetId)}">${escapeHtml(entry.runtimeTargetId)}</code></td>
          <td>
            <ul class="evidence-list">
              ${entry.observationEventIds
                .map(
                  (id) =>
                    `<li><code data-observation-event-id="${escapeHtml(id)}">${escapeHtml(id)}</code></li>`,
                )
                .join("")}
            </ul>
          </td>
          <td>
            <ul class="evidence-list">
              ${entry.artifactHashes
                .map(
                  (hash) =>
                    `<li><code data-artifact-hash="${escapeHtml(hash)}">${escapeHtml(hash)}</code></li>`,
                )
                .join("")}
            </ul>
          </td>
          <td>
            ${
              entry.providerProofRefs.length === 0
                ? `<span class="empty-copy">—</span>`
                : `<ul class="evidence-list">
                    ${entry.providerProofRefs
                      .map(
                        (ref) =>
                          `<li><code data-provider-proof-ref="${escapeHtml(ref)}">${escapeHtml(ref)}</code></li>`,
                      )
                      .join("")}
                  </ul>`
            }
          </td>
          <td>${escapeHtml(entry.summary)}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "runtime-evidence",
    "Runtime evidence",
    `
      ${persistedHeader}
      <table>
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Evidence tier</th>
            <th scope="col">Runtime target</th>
            <th scope="col">Observation events</th>
            <th scope="col">Artifact hashes</th>
            <th scope="col">Provider proof refs</th>
            <th scope="col">Summary</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

function renderRationalePanel(
  refs: ReviewerDetailRationaleRef[],
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  if (refs.length === 0) {
    return missingPanel(
      "rationale",
      "Rationale refs",
      reviewerDetailDiagnosticCodeValues.missingRationale,
      diagnostics,
    );
  }
  const rows = refs
    .map(
      (ref) => `
        <tr data-rationale-ref-id="${escapeHtml(ref.refId)}">
          <td>${escapeHtml(ref.refKind)}</td>
          <td><code>${escapeHtml(ref.refId)}</code></td>
          <td>${escapeHtml(ref.label)}</td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "rationale",
    "Rationale refs",
    `
      <table>
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Ref id</th>
            <th scope="col">Label</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

function renderTransitionsPanel(transitions: ReviewerDetailTransition[]): string {
  if (transitions.length === 0) {
    return panel(
      "transitions",
      "Transition log",
      `<p class="empty-copy">No prior reviewer actions recorded.</p>`,
    );
  }
  const rows = transitions
    .map(
      (transition) => `
        <tr data-transition-id="${escapeHtml(transition.transitionId)}">
          <td>${escapeHtml(transition.action)}</td>
          <td>${escapeHtml(transition.priorState)} → ${escapeHtml(transition.nextState)}</td>
          <td>${escapeHtml(transition.actorUserId)}</td>
          <td><time datetime="${transition.createdAt.toISOString()}">${escapeHtml(formatIso(transition.createdAt))}</time></td>
        </tr>
      `,
    )
    .join("");
  return panel(
    "transitions",
    "Transition log",
    `
      <table>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Prior → Next</th>
            <th scope="col">Actor</th>
            <th scope="col">Recorded at</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  );
}

function missingPanel(
  id: string,
  title: string,
  diagnosticCode: ReviewerDetailDiagnosticCode,
  diagnostics: ReviewerDetailDiagnostic[],
): string {
  const matching = diagnostics.find((diagnostic) => diagnostic.code === diagnosticCode);
  const message =
    matching === undefined
      ? `Missing context — diagnostic ${diagnosticCode} did not fire.`
      : matching.message;
  return panel(
    id,
    title,
    `
      <section class="missing-context" role="alert" data-missing-context="${escapeHtml(diagnosticCode)}">
        <p><strong>Missing context.</strong> See diagnostic <code>${escapeHtml(diagnosticCode)}</code>:</p>
        <p>${escapeHtml(message)}</p>
      </section>
    `,
  );
}

function panel(id: string, title: string, body: string): string {
  return `
    <section class="panel" id="${escapeHtml(id)}" data-panel-id="${escapeHtml(id)}"
      aria-label="${escapeHtml(title)}">
      <header class="panel-header">
        <h2>${escapeHtml(title)}</h2>
      </header>
      ${body}
    </section>
  `;
}

function statusBadge(value: string): string {
  const tone =
    value.includes("rejected") ||
    value.includes("failed") ||
    value.includes("blocker") ||
    value.includes("stale")
      ? "critical"
      : value.includes("accepted") || value.includes("approved")
        ? "ok"
        : "neutral";
  return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`;
}

function formatIso(value: Date): string {
  return value.toISOString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function reviewerDetailStyles(): string {
  return `
    <style>
      .reviewer-detail {
        min-height: 100vh;
        padding: 24px;
        background: #f6f7f7;
        color: #182026;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }
      .reviewer-detail .shell-header {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) auto;
        gap: 16px;
        align-items: start;
        margin-bottom: 18px;
      }
      .reviewer-detail .eyebrow {
        margin: 0 0 6px;
        color: #56636d;
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
      }
      .reviewer-detail h1 {
        margin: 0;
        font-size: 1.6rem;
      }
      .reviewer-detail h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .reviewer-detail .subhead {
        margin: 6px 0 0;
        color: #56636d;
      }
      .reviewer-detail .action-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .reviewer-detail .action-strip button {
        min-height: 32px;
        padding: 0 12px;
        border: 1px solid #c9d0d6;
        border-radius: 8px;
        background: #ffffff;
        color: #24313a;
        font-weight: 700;
        cursor: pointer;
      }
      .reviewer-detail .action-strip button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .reviewer-detail .denial-panel,
      .reviewer-detail .diagnostic-banner {
        margin-bottom: 18px;
        border: 1px solid #e4beb8;
        border-radius: 8px;
        padding: 18px;
        background: #fff8f7;
      }
      .reviewer-detail .diagnostic-banner ul {
        margin: 8px 0 0;
        padding: 0 0 0 18px;
      }
      .reviewer-detail .diagnostic-banner li {
        margin: 4px 0;
      }
      .reviewer-detail .detail-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }
      .reviewer-detail .panel {
        min-width: 0;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        padding: 16px;
        background: #ffffff;
      }
      .reviewer-detail .metric-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1px;
        overflow: hidden;
        border: 1px solid #d8dee2;
        border-radius: 8px;
        background: #d8dee2;
        margin-bottom: 12px;
      }
      .reviewer-detail .metric-list div {
        padding: 10px;
        background: #ffffff;
      }
      .reviewer-detail dt {
        color: #56636d;
        font-size: 0.74rem;
        font-weight: 700;
      }
      .reviewer-detail dd {
        margin: 4px 0 0;
        font-weight: 700;
      }
      .reviewer-detail table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 0.9rem;
      }
      .reviewer-detail th,
      .reviewer-detail td {
        border-bottom: 1px solid #e7ebee;
        padding: 8px 6px;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }
      .reviewer-detail th {
        color: #56636d;
        font-size: 0.74rem;
        font-weight: 800;
      }
      .reviewer-detail tr:last-child td {
        border-bottom: 0;
      }
      .reviewer-detail pre {
        overflow: auto;
        border: 1px solid #e7ebee;
        border-radius: 8px;
        padding: 12px;
        background: #fafbfc;
        white-space: pre-wrap;
      }
      .reviewer-detail .comparison-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .reviewer-detail .comparison-cell h3 {
        margin: 0 0 6px;
        font-size: 0.85rem;
        color: #56636d;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .reviewer-detail .badge {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 0.76rem;
        font-weight: 800;
      }
      .reviewer-detail .badge-neutral {
        background: #eef3f7;
        color: #26333c;
      }
      .reviewer-detail .badge-ok {
        background: #d6efe6;
        color: #1f5b48;
      }
      .reviewer-detail .badge-critical {
        background: #ffe7e1;
        color: #8a2e1c;
      }
      .reviewer-detail .missing-context {
        border: 1px dashed #e4beb8;
        border-radius: 8px;
        padding: 12px;
        background: #fff8f7;
      }
      .reviewer-detail .evidence-list {
        margin: 0;
        padding: 0 0 0 18px;
      }
      .reviewer-detail .empty-copy {
        margin: 0;
        color: #56636d;
      }
      @media (max-width: 920px) {
        .reviewer-detail .detail-grid,
        .reviewer-detail .comparison-grid,
        .reviewer-detail .metric-list {
          grid-template-columns: 1fr;
        }
        .reviewer-detail .shell-header {
          grid-template-columns: 1fr;
        }
      }
    </style>
  `;
}

// Re-export helper symbols so tests can pin against typed values
// without re-deriving them.
export const reviewerDetailViewInternals = {
  actionButtonsForKind,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
} as const;

// Re-export the closed enums of reviewer state / kind for callers that
// import the detail-view module rather than `@itotori/db` directly. The
// detail-fixtures module already depends on these so this is a
// no-runtime-cost re-export.
export type { ReviewerQueueItemKind, ReviewerQueueItemState };
