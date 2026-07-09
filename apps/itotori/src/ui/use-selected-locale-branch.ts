// fnd-spa-shell — shared selected-locale-branch resolution for branch-scoped
// screens. Explicit route scope wins; otherwise the hook falls back to the
// project's `projects.status.selectedLocaleBranchId` through the typed client.

import type { ProjectDashboardStatus } from "@itotori/db";
import type { ApiCallState } from "../api-client.js";
import { useApiQueryWhen } from "./use-api-resource.js";

export type SelectedLocaleBranch = {
  projectId: string | null;
  localeBranchId: string;
};

export type UseSelectedLocaleBranchOptions = {
  explicitProjectId?: string | null;
  explicitLocaleBranchId?: string | null;
  /**
   * Existing `projects.status` state supplied by a parent. When omitted, the
   * hook reads status only if no explicit branch was supplied.
   */
  status?: ApiCallState<ProjectDashboardStatus>;
  depsKey?: string;
};

export function useSelectedLocaleBranch({
  explicitProjectId = null,
  explicitLocaleBranchId = null,
  status: statusOverride,
  depsKey = "selected-locale-branch",
}: UseSelectedLocaleBranchOptions = {}): ApiCallState<SelectedLocaleBranch> {
  const explicitBranch = nonEmpty(explicitLocaleBranchId);
  const shouldReadStatus = explicitBranch === null && statusOverride === undefined;
  const statusQuery = useApiQueryWhen(
    "projects.status",
    {},
    `${depsKey}:projects.status`,
    shouldReadStatus,
  );
  if (explicitBranch !== null) {
    return {
      state: "ready",
      data: {
        projectId: nonEmpty(explicitProjectId),
        localeBranchId: explicitBranch,
      },
    };
  }

  const status = statusOverride ?? statusQuery;
  if (status.state === "loading" || status.state === "error" || status.state === "empty") {
    return status;
  }
  const selectedLocaleBranchId = nonEmpty(status.data.selectedLocaleBranchId);
  if (selectedLocaleBranchId === null) {
    return { state: "empty" };
  }
  return {
    state: "ready",
    data: {
      projectId: status.data.projectId,
      localeBranchId: selectedLocaleBranchId,
    },
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}
