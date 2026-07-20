// The Semantic Repair role, end to end.
//
// It opens a fresh blinded grounded fork for material MEANING defects, drives it
// through the SOLE ZDR boundary once, and proves the returned patch touches the
// failed units only. It is BOUNDED TO ONE repair per defect: the caller carries
// a ledger of defect ids already repaired once, and a SECOND attempt on any of
// them does NOT repair again — it dispatches nothing and routes to adjudication
// (the Q6 adjudicator) or a human. That bound is the whole point of the role:
// one grounded second opinion, then the conflict is escalated, never ground on
// by an unbounded repair loop.

import {
  DraftBatchSchema,
  type CallResult,
  type Draft,
  type DraftBatch,
} from "../../contracts/index.js";
import type { LocalizationTargetPolicy } from "../../gates/index.js";
import { specialistFor, type Specialist } from "../../roster/index.js";
import { buildRepairCall, dispatchRepairCall, type RepairRuntimeBase } from "./call.js";
import { assertBlindedGroundedFork, assertRepairPatchBatch } from "./finalize.js";
import { normalizeRepairRequest, type RepairRequest } from "./normalize.js";
import type { CallSpec } from "../../contracts/index.js";

export interface RepairOptions {
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly runMode: CallSpec["runMode"];
  readonly contextScope: CallSpec["contextScope"];
  /** The target policy the repaired patch must stay encodable under. */
  readonly policy: LocalizationTargetPolicy;
  /** Defect ids already repaired once — a second attempt on any routes out. */
  readonly repairedDefectLedger?: ReadonlySet<string>;
  readonly specialist?: Specialist;
}

export interface RepairedOutcome {
  readonly kind: "repaired";
  /** P3 patches remain candidates until the implicated gates/Q1 rerun accepts
   * them; semantic repair never finalizes output on its own. */
  readonly provisional: true;
  readonly batch: DraftBatch;
  readonly patches: readonly Draft[];
  /** The defect ids this repair consumed — fold them into the ledger. */
  readonly repairedDefectIds: readonly string[];
  readonly result: CallResult;
  readonly resolution: "repair";
}

export interface RoutedOutcome {
  readonly kind: "routed";
  /** A bounded second opinion is spent — hand the conflict to Q6/human. */
  readonly route: "adjudication";
  readonly defectIds: readonly string[];
  readonly reason: string;
  /** Persistable, traceable evidence that the one P3 repair was exhausted. The
   * workflow can give it to Q6 now or surface it to a human if adjudication
   * cannot settle the material defect; P3 itself never starts a second pass. */
  readonly humanReviewArtifact: {
    readonly kind: "semantic-repair-exhausted";
    readonly defectBundleId: string;
    readonly defectIds: readonly string[];
    readonly repairPassLimit: 1;
    readonly reason: string;
  };
  readonly resolution: "adjudication";
}

export type RepairOutcome = RepairedOutcome | RoutedOutcome;

export class RepairDispatchError extends Error {
  constructor(detail: string) {
    super(`p3 repair dispatch-failure: ${detail}`);
    this.name = "RepairDispatchError";
  }
}

function requireBatch(result: CallResult): DraftBatch {
  if (result.status !== "success") {
    throw new RepairDispatchError(`repair dispatch failed: ${result.failureKind}`);
  }
  return DraftBatchSchema.parse(result.value);
}

/**
 * Run one semantic repair. If ANY targeted defect was already repaired once,
 * dispatch nothing and route to adjudication — the role is bounded to one
 * repair. Otherwise open the fresh blinded grounded fork, dispatch it once, and
 * return the failed-ids-only patch.
 */
export async function repairSemanticDefects(
  request: RepairRequest,
  options: RepairOptions,
  runtime: RepairRuntimeBase,
): Promise<RepairOutcome> {
  const normalized = normalizeRepairRequest(request);
  const targetDefectIds = normalized.defects.map((defect) => defect.defectId);

  const ledger = options.repairedDefectLedger ?? new Set<string>();
  const alreadyRepaired = targetDefectIds.filter((defectId) => ledger.has(defectId));
  if (alreadyRepaired.length > 0) {
    // BOUNDED TO ONE: a second attempt on an already-repaired defect never
    // repairs again — it routes to the adjudicator (or a human) instead.
    const reason = `defects already repaired once: ${alreadyRepaired.join(", ")}`;
    return {
      kind: "routed",
      route: "adjudication",
      defectIds: targetDefectIds,
      reason,
      humanReviewArtifact: {
        kind: "semantic-repair-exhausted",
        defectBundleId: normalized.defectBundleId,
        defectIds: targetDefectIds,
        repairPassLimit: 1,
        reason,
      },
      resolution: "adjudication",
    };
  }

  const specialist = options.specialist ?? specialistFor("P3");
  const call = buildRepairCall({
    specialist,
    normalized,
    contextSnapshotId: options.contextSnapshotId,
    localizationSnapshotId: options.localizationSnapshotId,
    runMode: options.runMode,
    contextScope: options.contextScope,
    schemaHash: options.schemaHash,
  });
  // Prove the fork is fresh, blinded, and grounded BEFORE it reaches the model.
  assertBlindedGroundedFork(call);

  const result = await dispatchRepairCall(call, runtime);
  const batch = requireBatch(result);
  const patches = assertRepairPatchBatch(normalized, batch, options.policy);

  return {
    kind: "repaired",
    provisional: true,
    batch,
    patches,
    repairedDefectIds: targetDefectIds,
    result,
    resolution: "repair",
  };
}
