// ITOTORI-118 — workspace manual-correction views (pure render).
//
// Stateless renderer for the correction mutation layer. `renderWorkspace-
// CorrectionPreviewView` renders the batched before/after context a reviewer
// sees BEFORE submitting (source / draft / final, runtime + screenshot
// evidence, style-guide policy + glossary), plus a submit form that POSTs
// natively to `/api/workspace/corrections`. The POST records feedback and
// applies canonical context corrections; a delivered target edit remains the
// separate play-tester result-revision boundary.
//
// No fetch, no DOM, no globals — every test exercises a renderer directly.

import type {
  WorkspaceCorrectionDiagnostic,
  WorkspaceCorrectionPreviewReadModel,
  WorkspaceCorrectionPreviewUnit,
} from "./correction-model.js";
import { ANNOTATION_SEVERITIES } from "../annotation.js";

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
  const units = model.units.map((unit, index) => renderPreviewUnit(unit, index)).join("");
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
          before submitting feedback corrections.</p>
      </header>
      ${renderDiagnosticBanner(model.diagnostics)}
      <section class="correction-units" aria-label="Units to correct">
        ${
          canSubmit
            ? `<form class="correction-submit" method="post" action="/api/workspace/corrections"
                data-locale-branch-id="${escapeHtml(model.localeBranchId)}"
                data-project-id="${escapeHtml(model.projectId ?? "")}"
                data-target-locale="${escapeHtml(model.targetLocale ?? "")}">
                <input type="hidden" name="projectId" value="${escapeHtml(model.projectId ?? "")}" />
                <input type="hidden" name="localeBranchId" value="${escapeHtml(model.localeBranchId)}" />
                <input type="hidden" name="targetLocale" value="${escapeHtml(model.targetLocale ?? "")}" />
                ${model.sourceBundleId === null ? "" : `<input type="hidden" name="sourceBundleId" value="${escapeHtml(model.sourceBundleId)}" />`}
                <input type="hidden" name="actorUserId" value="${escapeHtml(model.permission.actorUserId)}" />
                ${units === "" ? `<p class="empty">No units selected for correction.</p>` : units}
                <button type="submit">Submit corrections</button>
              </form>`
            : units === ""
              ? `<p class="empty">No units selected for correction.</p>`
              : units
        }
      </section>
      ${
        canSubmit
          ? ""
          : `<p class="correction-readonly" role="note">Read-only: the
              <code>queue.manage</code> permission is required to submit corrections.</p>`
      }
    </main>
  `;
}

function renderPreviewUnit(unit: WorkspaceCorrectionPreviewUnit, index: number): string {
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
      <fieldset class="correction-editor" data-role="annotation-editor">
        <legend>Annotation</legend>
        <input type="hidden" name="corrections[${index}].bridgeUnitId"
          value="${escapeHtml(unit.bridgeUnitId ?? "")}" />
        <input type="hidden" name="corrections[${index}].sourceRevisionId"
          value="${escapeHtml(unit.sourceRevisionId ?? "")}" />
        <input type="hidden" name="corrections[${index}].sourceUnitKey"
          value="${escapeHtml(unit.sourceUnitKey ?? "")}" />
        <label>
          <span>Correction text</span>
          <textarea name="corrections[${index}].correctedText" required rows="3">${escapeHtml(unit.finalText ?? unit.draftText ?? "")}</textarea>
        </label>
        <label>
          <span>Note</span>
          <textarea name="corrections[${index}].reason" required rows="2"></textarea>
        </label>
        <label>
          <span>Severity</span>
          <select name="corrections[${index}].severity" required>
            ${ANNOTATION_SEVERITIES.map(
              (severity) =>
                `<option value="${escapeHtml(severity)}"${severity === "warning" ? " selected" : ""}>${escapeHtml(severity)}</option>`,
            ).join("")}
          </select>
        </label>
        <label>
          <span>Scope</span>
          <select name="corrections[${index}].scope.kind" required>
            <option value="line" selected>line</option>
            <option value="scene">scene</option>
          </select>
        </label>
        <label>
          <span>Scene id</span>
          <input name="corrections[${index}].scope.sceneId" type="text" />
        </label>
      </fieldset>
    </article>
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
