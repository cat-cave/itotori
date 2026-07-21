// The thin localize entrypoint — the kept `localize` command/route's SOLE path
// into the new pipeline.
//
// It does exactly three things, in order: resolve the run policy (via the driver,
// which gates the whole run on it), build the live `WorkflowPorts` that wrap the
// named entrypoints, and run the deterministic driver. It constructs NOTHING from
// the legacy service graph — no retired project-workflow surface, no provider object, no
// context-correction worker, no journal reservation/finalizer, no raw-MTL path.
//
// The port SUBSTRATE (decode facts, ZDR runtimes, the CAS store) is injected as
// `WorkflowPortDeps`; production builds it, an offline proof drives the driver
// with fake ports. `runLocalization` takes a ports factory so a proof can inject
// fake ports while production passes `createWorkflowPorts`.

import { runLocalizationWorkflow } from "../workflow/index.js";
import type { RunPolicyRequest } from "../run-policy/index.js";
import type {
  WorkflowOptions,
  WorkflowPorts,
  WorkflowRunReport,
  WorkflowScene,
} from "../workflow/index.js";
import { createWorkflowPorts } from "./workflow-ports.js";
import type { WorkflowPortDeps } from "./deps.js";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { PhysicalAttemptCostObserver } from "../llm/physical-attempt-policy.js";

/** Per-invocation decode artifacts. The live service owns DB/auth/dispatch;
 * callers must provide the matching structure and bridge for each run. */
export interface LocalizationPerRunInput {
  readonly structureJson: unknown;
  readonly bridge: BridgeBundleV02;
  /**
   * The durable identity the CLI has assigned to this invocation. The live
   * factory binds it to the snapshots it creates; offline/API callers that do
   * not own a project-run omit it.
   */
  readonly projectRun?: {
    readonly projectId: string;
    readonly runId: string;
    readonly localeBranchId: string;
    readonly leaseOwnerId: string;
  };
}

/** Durable run-plane coordinates returned by a live localization substrate.
 * The command owns the lifecycle; the substrate owns the snapshot and bounded
 * physical-call data that are only knowable after it has been assembled. */
export interface LocalizationRunPlane {
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
  readonly contextSnapshotId: string;
  readonly localizationSnapshotId: string;
  readonly capMicrosUsd: number | null;
  readonly leaseOwnerId: string;
}

/** Build the live workflow ports that wrap the named pipeline entrypoints. This
 * is the production ports factory `runLocalization` composes by default. */
export function buildLocalizationPorts(deps: WorkflowPortDeps): WorkflowPorts {
  return createWorkflowPorts(deps);
}

/** How a localize request reaches its ports. Production passes the live substrate
 * (`{ deps }`); a proof passes fake ports (`{ ports }`) to drive the driver
 * without constructing the decode/ZDR/CAS substrate. Exactly one is given. */
export type LocalizationPortSource =
  | {
      readonly deps: WorkflowPortDeps;
      readonly ports?: undefined;
      readonly runPlane?: LocalizationRunPlane;
      readonly attachRunCostObserver?: undefined;
    }
  | {
      readonly ports: WorkflowPorts;
      readonly deps?: undefined;
      readonly runPlane?: LocalizationRunPlane;
      /** Recorded/offline providers can receive the same physical-attempt
       * observer as live dispatch before their port is invoked. */
      readonly attachRunCostObserver?: (observer: PhysicalAttemptCostObserver) => WorkflowPorts;
    };

/** Resolve the ports for a request from either the live substrate or an injected
 * fake ports object. */
function resolvePorts(source: LocalizationPortSource): WorkflowPorts {
  return source.ports ?? buildLocalizationPorts(source.deps);
}

/**
 * Run one localization request through the new pipeline. The policy is resolved
 * first (inside the driver); the scenes are driven; the finalized units flow to
 * patchback and the downstream Build-LQA. This is the ONLY function the kept
 * `localize` command/route calls — the old orchestrator/service path is
 * unreachable from here.
 */
export async function runLocalization(
  request: RunPolicyRequest,
  scenes: readonly WorkflowScene[],
  source: LocalizationPortSource,
  options: WorkflowOptions = {},
): Promise<WorkflowRunReport> {
  return await runLocalizationWorkflow(request, scenes, resolvePorts(source), options);
}
