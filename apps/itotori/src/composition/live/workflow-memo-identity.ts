// Live composition of the workflow's durable logical memo identity.
//
// A caller may provide an explicit identity for an offline proof. Normal live
// composition derives it only from the admitted project-run plus immutable run
// configuration; notably, the renewable lease owner never enters the key.

import type { LocalizationPerRunInput } from "../localize-entrypoint.js";
import {
  createWorkflowMemoIdentity,
  createWorkflowMemoRoleRoutes,
  type WorkflowMemoIdentity,
} from "../../workflow/memo-identity.js";
import type { DraftRealizationConfig, RunScopeConfig } from "./assemblers/index.js";
import { LiveWorkflowFactoryError } from "./factory-finalizer.js";
import type { ProductionRenderEvidencePlan } from "./render-evidence-adapter.js";

export function resolveLiveWorkflowMemoIdentity(input: {
  readonly memoIdentity?: WorkflowMemoIdentity;
  readonly projectRun?: LocalizationPerRunInput["projectRun"];
  readonly scope: RunScopeConfig;
  readonly targetLocale: string;
  readonly draftBudget: DraftRealizationConfig;
  readonly renderEvidence?: ProductionRenderEvidencePlan;
}): WorkflowMemoIdentity {
  if (input.memoIdentity !== undefined) return input.memoIdentity;
  if (input.projectRun === undefined) {
    throw new LiveWorkflowFactoryError(
      "live workflow composition requires project/run/branch identity for durable memoization",
    );
  }
  return createWorkflowMemoIdentity({
    projectId: input.projectRun.projectId,
    runId: input.projectRun.runId,
    localeBranchId: input.projectRun.localeBranchId,
    contextSnapshotId: input.scope.contextSnapshotId,
    localizationSnapshotId: input.scope.localizationSnapshotId,
    schemaHash: input.scope.schemaHash,
    targetLocale: input.targetLocale,
    draftBudget: input.draftBudget,
    ...(input.renderEvidence === undefined
      ? {}
      : {
          renderPlan: {
            sourceRoot: input.renderEvidence.sourceRoot,
            buildRoot: input.renderEvidence.buildRoot,
            patchScope: input.renderEvidence.patchScope,
            runId: input.renderEvidence.runId,
            backgroundAsset: input.renderEvidence.backgroundAsset ?? null,
          },
        }),
    roleRoutes: createWorkflowMemoRoleRoutes(),
  });
}
