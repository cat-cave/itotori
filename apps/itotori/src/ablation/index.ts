// The pure-MTL ablation baseline — a NAMED, NON-SHIPPABLE benchmark control arm.
//
// It runs on the SAME substrate as the real localization pipeline (the same
// DeepSeek model profile + sole ZDR dispatch boundary via P1, the same source
// bytes, the same native patchback, the same deterministic gates, the same CAS
// durability store) but with the wiki/bible/review machinery stripped: a null
// Wiki, a direct translation, and ~zero model QA. Its lineage/telemetry is tagged
// `ablation` and is isolated from every qualifying (production / pilot) run's
// metrics. It is a CONFIGURATION of the real pipeline — not a fork: the ports are
// the exact ones the production localize entrypoint builds.

import { buildLocalizationPorts } from "../composition/index.js";
import type { WorkflowPortDeps } from "../composition/index.js";
import type { WorkflowPorts } from "../workflow/index.js";

/** Build the ablation's workflow ports from the live substrate. This is EXACTLY
 * the production `buildLocalizationPorts` — the same P1 dispatch boundary, gates,
 * CAS store, and native patchback the real pipeline runs on. The ablation driver
 * then simply never invokes the readiness / review / repair / adjudicate ports.
 * Using the identical factory is the structural proof this baseline is the same
 * substrate, not a parallel implementation. */
export function buildAblationPorts(deps: WorkflowPortDeps): WorkflowPorts {
  return buildLocalizationPorts(deps);
}

export { runPureMtlAblation } from "./driver.js";
export { lineageClassOf, resolveAblationPolicy } from "./policy.js";
export {
  collectAblationLineage,
  foldQualifyingLineage,
  tagLineage,
  EMPTY_QUALIFYING_METRICS,
  type QualifyingMetrics,
} from "./lineage.js";
export {
  AblationLineageIsolationError,
  AblationPolicyError,
  type AblationRunReport,
  type AblationRunRequest,
  type AblationScene,
  type AblationSceneOutcome,
  type LineageClass,
  type TaggedLineage,
} from "./types.js";
