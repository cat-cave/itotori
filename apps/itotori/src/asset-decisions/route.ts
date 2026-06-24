import type { AssetDecisionRecord, AssetLocalizationDecisionAssetKind } from "@itotori/db";
import {
  parseAssetDecisionsRoute,
  renderAssetDecisionsView,
  type AssetDecisionsRouteParams,
  type AssetDecisionsViewData,
  type CandidateAsset,
} from "./dashboard-view.js";

export { parseAssetDecisionsRoute };
export type { AssetDecisionsRouteParams };

export type AssetDecisionsRouteEndpoints = {
  /** GET — list active decisions for a project + locale branch. */
  activeDecisions(params: AssetDecisionsRouteParams): string;
  /** GET — list candidate assets that have no active decision yet. */
  candidateAssets(params: AssetDecisionsRouteParams): string;
};

const defaultEndpoints: AssetDecisionsRouteEndpoints = {
  activeDecisions: (params) =>
    `/api/projects/${encodeURIComponent(params.projectId)}/locale-branches/${encodeURIComponent(params.localeBranchId)}/asset-decisions`,
  candidateAssets: (params) =>
    `/api/projects/${encodeURIComponent(params.projectId)}/locale-branches/${encodeURIComponent(params.localeBranchId)}/asset-decisions/candidates`,
};

export async function renderAssetDecisionsRoute(
  root: HTMLElement,
  params: AssetDecisionsRouteParams,
  endpoints: AssetDecisionsRouteEndpoints = defaultEndpoints,
): Promise<void> {
  renderLoading(root, params);
  try {
    const [decisions, candidateAssets] = await Promise.all([
      fetchActiveDecisions(endpoints.activeDecisions(params)),
      params.view === "batch"
        ? fetchCandidateAssets(endpoints.candidateAssets(params))
        : Promise.resolve<CandidateAsset[]>([]),
    ]);
    const data: AssetDecisionsViewData = {
      params,
      decisions,
      candidateAssets,
    };
    root.innerHTML = renderAssetDecisionsView(data);
  } catch (error) {
    renderError(root, params, error);
  }
}

async function fetchActiveDecisions(endpoint: string): Promise<AssetDecisionRecord[]> {
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`failed to load active asset decisions: ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  return parseDecisionsResponse(body);
}

async function fetchCandidateAssets(endpoint: string): Promise<CandidateAsset[]> {
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`failed to load candidate assets: ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  return parseCandidatesResponse(body);
}

function parseDecisionsResponse(body: unknown): AssetDecisionRecord[] {
  if (body === null || typeof body !== "object") {
    throw new Error("active-decisions response must be a JSON object");
  }
  const record = body as { decisions?: unknown };
  if (!Array.isArray(record.decisions)) {
    throw new Error("active-decisions response.decisions must be an array");
  }
  return record.decisions.map(toDecisionRecord);
}

function parseCandidatesResponse(body: unknown): CandidateAsset[] {
  if (body === null || typeof body !== "object") {
    throw new Error("candidate-assets response must be a JSON object");
  }
  const record = body as { candidateAssets?: unknown };
  if (!Array.isArray(record.candidateAssets)) {
    throw new Error("candidate-assets response.candidateAssets must be an array");
  }
  return record.candidateAssets.map(toCandidateAsset);
}

function toDecisionRecord(value: unknown): AssetDecisionRecord {
  if (value === null || typeof value !== "object") {
    throw new Error("asset decision entry must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  return {
    decisionId: requireString(record.decisionId, "decisionId"),
    projectId: requireString(record.projectId, "projectId"),
    localeBranchId: requireString(record.localeBranchId, "localeBranchId"),
    assetRef: requireAssetRef(record.assetRef),
    assetKind: requireString(record.assetKind, "assetKind") as AssetLocalizationDecisionAssetKind,
    decisionPolicy: requireString(
      record.decisionPolicy,
      "decisionPolicy",
    ) as AssetDecisionRecord["decisionPolicy"],
    decisionRationale: nullableString(record.decisionRationale),
    decidedByUserId: nullableString(record.decidedByUserId),
    decidedAt: requireDate(record.decidedAt, "decidedAt"),
    supersededAt:
      record.supersededAt === null || record.supersededAt === undefined
        ? null
        : requireDate(record.supersededAt, "supersededAt"),
    supersededByDecisionId: nullableString(record.supersededByDecisionId),
    createdAt: requireDate(record.createdAt, "createdAt"),
  };
}

function toCandidateAsset(value: unknown): CandidateAsset {
  if (value === null || typeof value !== "object") {
    throw new Error("candidate-asset entry must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const candidate: CandidateAsset = {
    assetRef: requireAssetRef(record.assetRef),
    assetKind: requireString(record.assetKind, "assetKind") as AssetLocalizationDecisionAssetKind,
  };
  if (typeof record.displayLabel === "string") {
    candidate.displayLabel = record.displayLabel;
  }
  return candidate;
}

function requireAssetRef(value: unknown): { kind: string; ref: string } {
  if (value === null || typeof value !== "object") {
    throw new Error("assetRef must be a JSON object with kind+ref");
  }
  const record = value as Record<string, unknown>;
  return {
    kind: requireString(record.kind, "assetRef.kind"),
    ref: requireString(record.ref, "assetRef.ref"),
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("nullable string field must be a string or null");
  }
  return value;
}

function requireDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty ISO date string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a parseable ISO date string`);
  }
  return parsed;
}

function renderLoading(root: HTMLElement, params: AssetDecisionsRouteParams): void {
  root.innerHTML = `
    <main class="itotori-shell" data-state="asset-decisions-loading">
      <p role="status">Loading asset decisions for ${escapeHtml(params.localeBranchId)}…</p>
    </main>
  `;
}

function renderError(root: HTMLElement, params: AssetDecisionsRouteParams, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = `
    <main class="itotori-shell" data-state="asset-decisions-error">
      <h1>Asset decisions unavailable</h1>
      <p role="alert">Could not load asset decisions for ${escapeHtml(params.localeBranchId)}.</p>
      <pre>${escapeHtml(message)}</pre>
    </main>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
