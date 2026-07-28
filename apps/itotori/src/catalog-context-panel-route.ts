import {
  assertBrowserItotoriApiResponse,
  type BrowserCatalogContextPanelResponse,
} from "./api-client-guards.js";
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

function toCatalogContextPanelReadModel(
  value: BrowserCatalogContextPanelResponse,
): CatalogContextPanelReadModel {
  return {
    ...value,
    generatedAt: toDate(value.generatedAt, "generatedAt"),
    releases: value.releases.map((release) => ({
      ...release,
      createdAt: toDate(release.createdAt, "release.createdAt"),
      updatedAt: toDate(release.updatedAt, "release.updatedAt"),
    })),
  };
}
function toDate(text: string, label: string): Date {
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
