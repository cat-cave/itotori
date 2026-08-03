import type { ProjectRunProgressStatus } from "@itotori/db";

import type { ItotoriProjectWorkflowPort } from "../services/project-operations-port.js";

export type RunWorkflow = Pick<
  ItotoriProjectWorkflowPort,
  | "createOrResumeRun"
  | "acquireLease"
  | "renewLease"
  | "releaseLease"
  | "advanceRun"
  | "recordProgress"
  | "reserveCost"
  | "settleCost"
  | "releaseCost"
  | "loadLiveReadModel"
> &
  Partial<Pick<ItotoriProjectWorkflowPort, "recordProgressBatch">>;

export type CostScope = {
  readonly unitIds: readonly string[];
  readonly failureStage: string;
};

export type CostReservation = CostScope & { readonly reservationId: string };

export const statusRank: Record<ProjectRunProgressStatus, number> = {
  decoded: 1,
  drafted: 2,
  QA: 3,
  accepted: 4,
  patched: 5,
};
