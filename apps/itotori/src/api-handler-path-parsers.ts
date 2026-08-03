import { ApiValidationError } from "./api-schema.js";
import type { WikiObjectSelector } from "./wiki/object-api/index.js";

export type WikiObjectApiRoute =
  | { readonly resource: "list" }
  | {
      readonly resource: "show" | "history" | "edit" | "feedback" | "apply";
      readonly selector: WikiObjectSelector;
    };

/** Parse the WikiObject API. Source facts are addressed by source snapshot and
 * object id; no route has a localeBranchId segment. */
export function parseWikiObjectApiRoute(pathname: string): WikiObjectApiRoute | null {
  if (pathname === "/api/wiki") return { resource: "list" };
  const matched = /^\/api\/wiki\/([^/]+)\/([^/]+)(?:\/(history|edit|feedback|apply))?$/.exec(
    pathname,
  );
  if (matched?.[1] === undefined || matched[2] === undefined) return null;
  const wikiKind = decodeApiPathSegment(matched[1], "wikiKind");
  if (
    wikiKind !== "source-object" &&
    wikiKind !== "translation-object" &&
    wikiKind !== "localized-rendering"
  ) {
    throw new ApiValidationError(
      "wikiKind must be source-object, translation-object, or localized-rendering",
    );
  }
  const selector: WikiObjectSelector = {
    wikiKind,
    objectId: decodeApiPathSegment(matched[2], "objectId"),
  };
  const resource = matched[3] ?? "show";
  if (
    resource === "history" ||
    resource === "edit" ||
    resource === "feedback" ||
    resource === "apply"
  ) {
    return { resource, selector };
  }
  return { resource: "show", selector };
}

export function parseAuthMemberAcceptRoute(pathname: string): { invitationId: string } | null {
  const match = /^\/api\/auth\/members\/invitations\/([^/]+)\/accept$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { invitationId: decodeURIComponent(match[1]) };
}

export function parseAuthMemberRemoveRoute(pathname: string): { membershipId: string } | null {
  const match = /^\/api\/auth\/members\/([^/]+)\/remove$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { membershipId: decodeURIComponent(match[1]) };
}

export function parseAuthSessionsRoute(pathname: string): { principalId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/sessions$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return null;
  }
  return { principalId: decodeURIComponent(match[1]) };
}

export function parseAuthSessionRevokeRoute(
  pathname: string,
): { principalId: string; sessionId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/sessions\/([^/]+)\/revoke$/u.exec(pathname);
  if (
    match === null ||
    match[1] === undefined ||
    match[1].length === 0 ||
    match[2] === undefined ||
    match[2].length === 0
  ) {
    return null;
  }
  return { principalId: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]) };
}

export function parseAuthPermissionSetGrantRoute(
  pathname: string,
): { principalId: string; permissionSetId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/permission-sets\/([^/]+)\/grant$/u.exec(
    pathname,
  );
  if (
    match === null ||
    match[1] === undefined ||
    match[1].length === 0 ||
    match[2] === undefined ||
    match[2].length === 0
  ) {
    return null;
  }
  return {
    principalId: decodeURIComponent(match[1]),
    permissionSetId: decodeURIComponent(match[2]),
  };
}

export function parseAuthPermissionSetRevokeRoute(
  pathname: string,
): { principalId: string; permissionSetId: string } | null {
  const match = /^\/api\/auth\/principals\/([^/]+)\/permission-sets\/([^/]+)\/revoke$/u.exec(
    pathname,
  );
  if (
    match === null ||
    match[1] === undefined ||
    match[1].length === 0 ||
    match[2] === undefined ||
    match[2].length === 0
  ) {
    return null;
  }
  return {
    principalId: decodeURIComponent(match[1]),
    permissionSetId: decodeURIComponent(match[2]),
  };
}

export function parseAssetDecisionApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
  resource: "active" | "candidates";
} | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/asset-decisions(?:\/(candidates))?$/u.exec(
      pathname,
    );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
    resource: match[3] === "candidates" ? "candidates" : "active",
  };
}

export function parseCatalogContextPanelApiRoute(
  pathname: string,
): { projectId: string; localeBranchId: string; workId: string } | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/catalog-context\/([^/]+)$/u.exec(
      pathname,
    );
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
    workId: decodeApiPathSegment(match[3], "workId"),
  };
}

export function parsePlayRouteMapApiRoute(
  pathname: string,
): { projectId: string; localeBranchId: string } | null {
  const match = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/route-map\/?$/u.exec(
    pathname,
  );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

export function parsePlayFlagApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/flags$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

export function parsePlayUnitFeedbackApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match = /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/unit-feedback\/?$/u.exec(
    pathname,
  );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

export function parsePlayAddressableUnitApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
  bridgeUnitId: string;
} | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/addressable-units\/([^/]+)\/?$/u.exec(
      pathname,
    );
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
    bridgeUnitId: decodeApiPathSegment(match[3], "bridgeUnitId"),
  };
}

export function nonEmptySearchParam(search: string, key: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get(key);
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

export function parsePlayTargetEditApiRoute(pathname: string): {
  parentPatchVersionId: string;
} | null {
  const match = /^\/api\/play\/patch-versions\/([^/]+)\/target-edits\/?$/u.exec(pathname);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return {
    parentPatchVersionId: decodeApiPathSegment(match[1], "parentPatchVersionId"),
  };
}

export type PatchIterationApiRoute = {
  patchVersionId: string;
};

/** Parse the node-11 topology once so GET/POST cannot diverge on path identity. */
export function parsePatchIterationApiRoute(pathname: string): PatchIterationApiRoute | null {
  const match = /^\/api\/play\/patch-versions\/([^/]+)\/sessions\/?$/u.exec(pathname);
  if (match === null || match[1] === undefined) return null;
  return { patchVersionId: decodeApiPathSegment(match[1], "patchVersionId") };
}

export function parsePlayDeliveryApiRoute(pathname: string): { runId: string } | null {
  const match = /^\/api\/play\/runs\/([^/]+)\/delivery\/?$/u.exec(pathname);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return { runId: decodeApiPathSegment(match[1], "runId") };
}

export function parseLocalizationPassControlApiRoute(pathname: string): {
  projectId: string;
  journalRunId: string;
  action: "pause" | "resume";
} | null {
  const match = /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/(pause|resume)\/?$/u.exec(pathname);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const action = match[3];
  if (action !== "pause" && action !== "resume") return null;
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    journalRunId: decodeApiPathSegment(match[2], "runId"),
    action,
  };
}

export function parseBranchPolicySettingsApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/settings\/branch-policy\/?$/u.exec(
      pathname,
    );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

export function parseTranslationScopeSettingsApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/settings\/translation-scope\/?$/u.exec(
      pathname,
    );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

export function parseLocalizationRunConfigApiRoute(pathname: string): {
  projectId: string;
  localeBranchId: string;
} | null {
  const match =
    /^\/api\/projects\/([^/]+)\/locale-branches\/([^/]+)\/settings\/localization-run-config\/?$/u.exec(
      pathname,
    );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    projectId: decodeApiPathSegment(match[1], "projectId"),
    localeBranchId: decodeApiPathSegment(match[2], "localeBranchId"),
  };
}

export function decodeApiPathSegment(raw: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new ApiValidationError(`${label} must be URL-encoded`);
  }
  if (decoded.trim().length === 0 || decoded.includes("/")) {
    throw new ApiValidationError(`${label} path segment must be non-empty and contain no slash`);
  }
  return decoded;
}
