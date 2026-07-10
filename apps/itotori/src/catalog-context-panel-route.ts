import type {
  CatalogBenchmarkSeedRow,
  CatalogReleaseRecord,
  LocaleBranchStatus,
} from "@itotori/db";
import { assertBrowserItotoriApiResponse } from "./api-client-guards.js";
import {
  catalogContextPanelViewFromReadModel,
  renderCatalogContextPanel,
  type CatalogContextPanelReadModel,
} from "./catalog-context-panel.js";

export const catalogContextPanelRoutePathRegex =
  /^\/projects\/([^/]+)\/locale-branches\/([^/]+)\/catalog-context\/([^/]+)$/u;

export type CatalogContextPanelRouteParams = {
  projectId: string;
  localeBranchId: string;
  workId: string;
};

export type CatalogContextPanelRouteEndpoints = {
  /** GET — DB-backed catalog context panel read model. */
  catalogContext(params: CatalogContextPanelRouteParams): string;
};

const defaultEndpoints: CatalogContextPanelRouteEndpoints = {
  catalogContext: (params) =>
    `/api/projects/${encodeURIComponent(params.projectId)}/locale-branches/${encodeURIComponent(
      params.localeBranchId,
    )}/catalog-context/${encodeURIComponent(params.workId)}`,
};

export function parseCatalogContextPanelRoute(
  pathname: string,
): CatalogContextPanelRouteParams | null {
  const match = catalogContextPanelRoutePathRegex.exec(pathname);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1]),
    localeBranchId: decodeURIComponent(match[2]),
    workId: decodeURIComponent(match[3]),
  };
}

export async function renderCatalogContextPanelRoute(
  root: HTMLElement,
  params: CatalogContextPanelRouteParams,
  endpoints: CatalogContextPanelRouteEndpoints = defaultEndpoints,
): Promise<void> {
  renderLoading(root, params);
  try {
    const model = await fetchCatalogContextPanel(endpoints.catalogContext(params));
    root.innerHTML = renderCatalogContextPanel(catalogContextPanelViewFromReadModel(model));
  } catch (error) {
    renderError(root, params, error);
  }
}

async function fetchCatalogContextPanel(endpoint: string): Promise<CatalogContextPanelReadModel> {
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`failed to load catalog context panel: ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  assertBrowserItotoriApiResponse("catalog.contextPanel", body);
  return toCatalogContextPanelReadModel(body);
}

function toCatalogContextPanelReadModel(value: unknown): CatalogContextPanelReadModel {
  const record = requireRecord(value, "catalog-context response");
  return {
    schemaVersion: requireLiteral(
      record.schemaVersion,
      "catalog.context_panel_route.v0.1",
      "schemaVersion",
    ),
    generatedAt: requireDate(record.generatedAt, "generatedAt"),
    params: toParams(record.params),
    row: requireRecord(record.row, "row") as unknown as CatalogBenchmarkSeedRow,
    releases: requireArray(record.releases, "releases").map(toReleaseRecord),
    projectState: toProjectState(record.projectState),
  };
}

function toParams(value: unknown): CatalogContextPanelRouteParams {
  const record = requireRecord(value, "params");
  return {
    projectId: requireString(record.projectId, "params.projectId"),
    localeBranchId: requireString(record.localeBranchId, "params.localeBranchId"),
    workId: requireString(record.workId, "params.workId"),
  };
}

function toReleaseRecord(value: unknown): CatalogReleaseRecord {
  const record = requireRecord(value, "release");
  return {
    ...(record as unknown as Omit<CatalogReleaseRecord, "createdAt" | "updatedAt">),
    createdAt: requireDate(record.createdAt, "release.createdAt"),
    updatedAt: requireDate(record.updatedAt, "release.updatedAt"),
  };
}

function toProjectState(value: unknown): CatalogContextPanelReadModel["projectState"] {
  const record = requireRecord(value, "projectState");
  return {
    targetLanguage: requireString(record.targetLanguage, "projectState.targetLanguage"),
    localeBranch:
      record.localeBranch === null
        ? null
        : (requireRecord(
            record.localeBranch,
            "projectState.localeBranch",
          ) as unknown as LocaleBranchStatus),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireDate(value: unknown, label: string): Date {
  const text = requireString(value, label);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a parseable ISO date string`);
  }
  return parsed;
}

function renderLoading(root: HTMLElement, params: CatalogContextPanelRouteParams): void {
  root.innerHTML = `
    <main class="itotori-shell" data-state="catalog-context-loading">
      <p role="status">Loading catalog context for ${escapeHtml(params.workId)}...</p>
    </main>
  `;
}

function renderError(
  root: HTMLElement,
  params: CatalogContextPanelRouteParams,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = `
    <main class="itotori-shell" data-state="catalog-context-error">
      <h1>Catalog context unavailable</h1>
      <p role="alert">Could not load catalog context for ${escapeHtml(params.workId)}.</p>
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
