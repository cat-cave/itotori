// The composition root — the thin new-workflow entrypoints the kept localize /
// wiki / play commands and routes construct.
//
// Every kept entrypoint routes ONLY through this barrel into the new pipeline:
// the localize entrypoint resolves a run policy, builds the live `WorkflowPorts`
// that wrap the named pipeline entrypoints, and runs the deterministic driver;
// the wiki entrypoint delegates to the Wiki object-API; the play entrypoint
// drives the runtime launcher; provisioning creates a fresh project/branch in
// place and addresses an exact requested run. Nothing here reaches the legacy
// `ProjectWorkflowService` / provider objects / context-correction worker /
// journal reservation-finalizer / raw-MTL path — the import closure is clean.

export { createWorkflowPorts } from "./workflow-ports.js";
export type { WorkflowPortDeps } from "./deps.js";
export {
  buildLocalizationPorts,
  runLocalization,
  type LocalizationPerRunInput,
  type LocalizationPortSource,
} from "./localize-entrypoint.js";
export {
  addressRequestedRun,
  provisionProjectBranch,
  RequestedRunNotFoundError,
  type AddressableRun,
  type ProvisionedBranch,
  type ProvisionedProject,
  type ProvisioningStore,
  type ProvisionRequest,
  type ProvisionResult,
} from "./provisioning.js";
export {
  runWikiObjectCommand,
  type WikiObjectRequest,
  type WikiObjectResponse,
} from "./wiki-entrypoint.js";
export {
  ANALYST_RUNNER_ROLE_IDS,
  assertAnalystRunnerCoverage,
  createAnalystRunner,
  runWikiBuild,
  type WikiBuildDeps,
  type WikiBuildInvocation,
  type WikiBuildPortraitSources,
} from "./wiki-build-entrypoint.js";
export type { SourceWikiRunReport } from "../source-wiki/index.js";
export {
  runPlaySession,
  type PlayEntrypointDeps,
  type PlayRequest,
  type PlaySurfaceLoader,
} from "./play-entrypoint.js";
