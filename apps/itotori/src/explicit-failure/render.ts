import { applicationFailureResponse } from "./response.js";

export interface ExplicitFailureViewOptions {
  readonly state: string;
  readonly title: string;
  readonly context: string;
}

/** Render only the safe public projection; source error prose never reaches HTML. */
export function renderExplicitFailureHtml(
  error: unknown,
  options: ExplicitFailureViewOptions,
): string {
  const response = applicationFailureResponse(error);
  return [
    `<main class="itotori-shell" data-state="${escapeHtml(options.state)}"`,
    ` data-failure-code="${escapeHtml(response.classification.code)}">`,
    `<h1>${escapeHtml(options.title)}</h1>`,
    `<p>${escapeHtml(options.context)}</p>`,
    `<p role="alert">${escapeHtml(response.message)}</p>`,
    `<p data-next-action="${escapeHtml(response.classification.nextAction)}">`,
    `Next action: ${escapeHtml(response.classification.nextAction)}</p>`,
    "</main>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
