// ITOTORI-040 — localization workspace SPA route loader.
//
// Parses the client-side workspace routes and renders them by fetching
// the corresponding JSON API endpoint and validating the response with
// the shared `assertItotoriApiResponse` contract. This is the concrete
// proof that the workspace reads THROUGH the API: the SPA never touches a
// repository or a local JSON file — it issues an HTTP GET to
// `/api/workspace/...` and renders the typed read-model it gets back.
//
// `fetchJson` is injected so tests drive the loader deterministically
// without a live server.

import type { WorkspaceSearchMode } from "./read-model.js";

export const workspaceRoutePathRegex =
  /^\/workspace(?:\/(projects|scenes|assets|comparison|search|corrections))?$/u;

export type WorkspaceRoute =
  | { kind: "projects" }
  | { kind: "scenes"; projectId: string; localeBranchId: string }
  | { kind: "assets"; projectId: string; localeBranchId: string }
  | { kind: "comparison"; reviewItemId: string }
  | {
      kind: "search";
      projectId: string;
      localeBranchId: string;
      query: string;
      mode: WorkspaceSearchMode | null;
    }
  | { kind: "corrections"; localeBranchId: string; reviewItemIds: string[] };

export function parseWorkspaceRoute(pathname: string, search = ""): WorkspaceRoute | null {
  const match = workspaceRoutePathRegex.exec(pathname);
  if (match === null) {
    return null;
  }
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const resource = match[1] ?? "projects";
  switch (resource) {
    case "projects":
      return { kind: "projects" };
    case "scenes": {
      const scope = requireBranchScope(params);
      return scope === null ? null : { kind: "scenes", ...scope };
    }
    case "assets": {
      const scope = requireBranchScope(params);
      return scope === null ? null : { kind: "assets", ...scope };
    }
    case "comparison": {
      const reviewItemId = nonEmpty(params.get("reviewItemId"));
      return reviewItemId === null ? null : { kind: "comparison", reviewItemId };
    }
    case "search": {
      const scope = requireBranchScope(params);
      const query = params.get("query");
      if (scope === null || query === null) {
        return null;
      }
      const rawMode = params.get("mode");
      const mode =
        rawMode === "exact" || rawMode === "terminology" || rawMode === "all" ? rawMode : null;
      return { kind: "search", ...scope, query, mode };
    }
    case "corrections": {
      const localeBranchId = nonEmpty(params.get("localeBranchId"));
      if (localeBranchId === null) {
        return null;
      }
      const reviewItemIdsRaw = params.get("reviewItemIds");
      const reviewItemIds =
        reviewItemIdsRaw === null
          ? []
          : reviewItemIdsRaw
              .split(",")
              .map((value) => value.trim())
              .filter((value) => value.length > 0);
      return { kind: "corrections", localeBranchId, reviewItemIds };
    }
    default:
      return null;
  }
}

/**
 * Map a parsed route to the JSON API path + the typed route id used by
 * `assertItotoriApiResponse`.
 */
export function workspaceRouteApiTarget(route: WorkspaceRoute): {
  apiPath: string;
  routeId:
    | "workspace.projects"
    | "workspace.scenes"
    | "workspace.assets"
    | "workspace.comparison"
    | "workspace.search"
    | "workspace.correctionPreview";
} {
  switch (route.kind) {
    case "projects":
      return { apiPath: "/api/workspace/projects", routeId: "workspace.projects" };
    case "scenes":
      return {
        apiPath: `/api/workspace/scenes?projectId=${encodeURIComponent(route.projectId)}&localeBranchId=${encodeURIComponent(route.localeBranchId)}`,
        routeId: "workspace.scenes",
      };
    case "assets":
      return {
        apiPath: `/api/workspace/assets?projectId=${encodeURIComponent(route.projectId)}&localeBranchId=${encodeURIComponent(route.localeBranchId)}`,
        routeId: "workspace.assets",
      };
    case "comparison":
      return {
        apiPath: `/api/workspace/comparison?reviewItemId=${encodeURIComponent(route.reviewItemId)}`,
        routeId: "workspace.comparison",
      };
    case "search": {
      const params = new URLSearchParams({
        projectId: route.projectId,
        localeBranchId: route.localeBranchId,
        query: route.query,
      });
      if (route.mode !== null) {
        params.set("mode", route.mode);
      }
      return { apiPath: `/api/workspace/search?${params.toString()}`, routeId: "workspace.search" };
    }
    case "corrections": {
      const params = new URLSearchParams({ localeBranchId: route.localeBranchId });
      if (route.reviewItemIds.length > 0) {
        params.set("reviewItemIds", route.reviewItemIds.join(","));
      }
      return {
        apiPath: `/api/workspace/corrections?${params.toString()}`,
        routeId: "workspace.correctionPreview",
      };
    }
  }
}

function requireBranchScope(
  params: URLSearchParams,
): { projectId: string; localeBranchId: string } | null {
  const projectId = nonEmpty(params.get("projectId"));
  const localeBranchId = nonEmpty(params.get("localeBranchId"));
  if (projectId === null || localeBranchId === null) {
    return null;
  }
  return { projectId, localeBranchId };
}

function nonEmpty(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value;
}
