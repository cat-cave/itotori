// ITOTORI-118 — workspace manual-correction views (pure render).
//
// Stateless renderers for the correction mutation layer. `renderWorkspace-
// CorrectionPreviewView` renders the batched before/after context a reviewer
// sees BEFORE submitting (source / draft / final, runtime + screenshot
// evidence, style-guide policy + glossary), plus a submit form that POSTs to
// `/api/workspace/corrections`. `renderWorkspaceCorrectionSubmitView` renders
// the durable result: one edit-history row per correction with its routing
// disposition + the affected-unit rerun scope.
//
// No fetch, no DOM, no globals — every test exercises a renderer directly.

import type {
  WorkspaceCorrectionDiagnostic,
  WorkspaceCorrectionPreviewReadModel,
  WorkspaceCorrectionPreviewUnit,
  WorkspaceCorrectionSubmitReadModel,
} from "./correction-model.js";

export function renderWorkspaceCorrectionPreviewView(
  model: WorkspaceCorrectionPreviewReadModel,
): string {
  if (!model.permission.canReadQueue) {
    return renderDeniedShell(
      "correction-preview",
      "Batched corrections",
      model.diagnostics,
      "queue.read",
    );
  }
  const canSubmit = model.permission.canManageQueue;
  const units = model.units.map(renderPreviewUnit).join("");
  return `
    <main class="itotori-shell workspace-correction-preview" data-state="ready"
      data-view="correction-preview"
      data-locale-branch-id="${escapeHtml(model.localeBranchId)}"
      data-unit-count="${model.units.length}"
      data-can-submit="${canSubmit ? "true" : "false"}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>Batched corrections</h1>
        <p class="subhead">Locale branch <code>${escapeHtml(model.localeBranchId)}</code> —
          review the source, draft, final, runtime, and style/glossary context for each unit
          before submitting.</p>
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      <section class="correction-units" aria-label="Units to correct">
        ${units === "" ? `<p class="empty">No units selected for correction.</p>` : units}
      </section>
      ${
        canSubmit
          ? `<form class="correction-submit" method="post" action="/api/workspace/corrections"
              data-locale-branch-id="${escapeHtml(model.localeBranchId)}">
              <button type="submit">Submit corrections</button>
            </form>`
          : `<p class="correction-readonly" role="note">Read-only: the
              <code>queue.manage</code> permission is required to submit corrections.</p>`
      }
    </main>
  `;
}

function renderPreviewUnit(unit: WorkspaceCorrectionPreviewUnit): string {
  const glossary = unit.glossary
    .map(
      (entry) => `
      <li class="glossary-ref" data-term-id="${escapeHtml(entry.termId)}"
        data-status="${escapeHtml(entry.status)}">
        <code>${escapeHtml(entry.sourceTerm)}</code> →
        <code>${escapeHtml(entry.preferredTranslation)}</code>
      </li>`,
    )
    .join("");
  const runtime = unit.runtimeEvidenceLinks
    .map(
      (link) => `
      <li class="runtime-evidence-link" data-evidence-kind="${escapeHtml(link.evidenceKind)}"
        data-evidence-tier="${escapeHtml(link.evidenceTier)}">
        <span class="evidence-summary">${escapeHtml(link.summary)}</span>
        ${link.artifactHashes.map((hash) => `<code class="artifact-hash">${escapeHtml(hash)}</code>`).join("")}
      </li>`,
    )
    .join("");
  return `
    <article class="correction-unit" data-review-item-id="${escapeHtml(unit.reviewItemId)}"
      data-bridge-unit-id="${escapeHtml(unit.bridgeUnitId ?? "")}"
      data-source-revision-id="${escapeHtml(unit.sourceRevisionId ?? "")}"
      data-has-final="${unit.finalText === null ? "false" : "true"}">
      ${renderDiagnosticBanner(unit.diagnostics)}
      <div class="correction-cell" data-side="source">
        <h3>Source ${unit.sourceLocale === null ? "" : `(${escapeHtml(unit.sourceLocale)})`}</h3>
        <p lang="${escapeHtml(unit.sourceLocale ?? "")}">${escapeHtml(unit.sourceText ?? "—")}</p>
      </div>
      <div class="correction-cell" data-side="draft">
        <h3>Draft ${unit.targetLocale === null ? "" : `(${escapeHtml(unit.targetLocale)})`}</h3>
        <p lang="${escapeHtml(unit.targetLocale ?? "")}">${escapeHtml(unit.draftText ?? "—")}</p>
      </div>
      <div class="correction-cell" data-side="final">
        <h3>Final ${unit.targetLocale === null ? "" : `(${escapeHtml(unit.targetLocale)})`}</h3>
        <p lang="${escapeHtml(unit.targetLocale ?? "")}">${escapeHtml(unit.finalText ?? "—")}</p>
      </div>
      <div class="correction-context" data-side="style">
        <h4>Style guide</h4>
        ${
          unit.styleGuidePolicyVersionId === null
            ? `<p class="empty">No active style-guide policy.</p>`
            : `<p><code>${escapeHtml(unit.styleGuidePolicyVersionId)}</code>
                (${escapeHtml(unit.styleGuidePolicyStatus ?? "unknown")})</p>`
        }
      </div>
      <div class="correction-context" data-side="glossary">
        <h4>Glossary</h4>
        ${glossary === "" ? `<p class="empty">No glossary references.</p>` : `<ul>${glossary}</ul>`}
      </div>
      <div class="correction-context" data-side="runtime">
        <h4>Runtime / screenshot evidence</h4>
        ${runtime === "" ? `<p class="empty">No runtime evidence linked.</p>` : `<ul>${runtime}</ul>`}
      </div>
    </article>
  `;
}

export function renderWorkspaceCorrectionSubmitView(
  model: WorkspaceCorrectionSubmitReadModel,
): string {
  if (!model.permission.canManageQueue) {
    return renderDeniedShell(
      "correction-submit",
      "Submit corrections",
      model.diagnostics,
      "queue.manage",
    );
  }
  const rows = model.edits
    .map(
      (edit) => `
      <li class="correction-edit" data-correction-edit-id="${escapeHtml(edit.correctionEditId)}"
        data-bridge-unit-id="${escapeHtml(edit.bridgeUnitId)}"
        data-disposition="${escapeHtml(edit.disposition)}"
        data-duplicate="${edit.duplicate ? "true" : "false"}">
        <p class="edit-reason">${escapeHtml(edit.reason)}</p>
        <div class="edit-before-after">
          <span class="before" lang="">${escapeHtml(edit.beforeText ?? "—")}</span>
          <span class="after" lang="">${escapeHtml(edit.afterText)}</span>
        </div>
        <p class="edit-trace">
          <code class="feedback-report">${escapeHtml(edit.feedbackReportId)}</code>
          <code class="triage-label">${escapeHtml(edit.triageLabel)}</code>
          <code class="source-revision">${escapeHtml(edit.sourceRevisionId)}</code>
          <code class="actor">${escapeHtml(edit.actorUserId)}</code>
        </p>
      </li>`,
    )
    .join("");
  return `
    <main class="itotori-shell workspace-correction-submit" data-state="ready"
      data-view="correction-submit"
      data-batch-id="${escapeHtml(model.batchId)}"
      data-locale-branch-id="${escapeHtml(model.localeBranchId)}"
      data-submitted-count="${model.submittedCount}"
      data-affected-unit-count="${model.affectedBridgeUnitIds.length}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>Corrections submitted</h1>
        <p class="subhead">Batch <code>${escapeHtml(model.batchId)}</code> —
          ${model.submittedCount} correction(s) recorded; rerun scope is
          ${model.affectedBridgeUnitIds.length} affected unit(s).</p>
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      <ul class="correction-edits" aria-label="Recorded edit history">
        ${rows === "" ? `<p class="empty">No corrections recorded.</p>` : rows}
      </ul>
      <section class="correction-routing" aria-label="Routing">
        <p data-repair-candidate-count="${model.repairCandidateReportIds.length}">
          ${model.repairCandidateReportIds.length} repair candidate(s)</p>
        <p data-decision-queue-count="${model.decisionQueueReportIds.length}">
          ${model.decisionQueueReportIds.length} decision-queue item(s)</p>
        <p data-needs-context-count="${model.needsContextReportIds.length}">
          ${model.needsContextReportIds.length} needs-context item(s)</p>
      </section>
    </main>
  `;
}

function renderDeniedShell(
  view: string,
  title: string,
  diagnostics: WorkspaceCorrectionDiagnostic[],
  required: string,
): string {
  const reason = diagnostics[0]?.message ?? "Permission denied.";
  return `
    <main class="itotori-shell workspace-correction" data-state="denied" data-view="${escapeHtml(view)}">
      <header class="shell-header">
        <p class="eyebrow">Localization workspace</p>
        <h1>${escapeHtml(title)} — access denied</h1>
      </header>
      <section class="denial-panel" role="alert">
        <p>${escapeHtml(reason)}</p>
        <p class="subhead">The <code>${escapeHtml(required)}</code> permission is required.</p>
      </section>
    </main>
  `;
}

function renderDiagnosticBanner(diagnostics: WorkspaceCorrectionDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const items = diagnostics
    .map(
      (diagnostic) => `
      <li class="diagnostic" data-code="${escapeHtml(diagnostic.code)}">${escapeHtml(diagnostic.message)}</li>`,
    )
    .join("");
  return `<ul class="workspace-diagnostics" role="status">${items}</ul>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
