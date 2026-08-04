import type {
  ItotoriCatalogExactExternalIdLinkerPort,
  ItotoriCatalogFuzzyCandidateGeneratorPort,
} from "@itotori/db";
import type { AssetDecisionsCliPort } from "./asset-decisions/cli.js";
import type {
  LocalizationPerRunInput,
  LocalizationProviderBudgetCohorts,
  LocalizationPortSource,
  SourceWikiRunReport,
  WikiBuildInvocation,
} from "./composition/index.js";
import type { PlayEntrypointDeps } from "./composition/play-entrypoint.js";
import type { NativeCliRunner } from "./native-bin/cli-bin-resolver.js";
import type { QueueHealthCliPort } from "./queue/cli.js";
import type { RunPolicyRequest } from "./run-policy/index.js";
import type { EngineCapabilityReportPort } from "./services/engine-capability-report.js";
import type { ItotoriProjectWorkflowPort } from "./services/project-operations-port.js";
import type { InitCommandDeps } from "./init-command.js";
import type { DeploymentStartupContext } from "./config/deployment-config-file.js";
import type { WikiObjectApiService } from "./wiki/object-api/index.js";

export type JsonFileStore = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
  /**
   * Persist a UTF-8 text artifact (e.g. the README-safe Markdown summary). The
   * real CLI store implements it; an in-memory test store may omit it, in which
   * case a handler that needs it throws a clear error rather than silently
   * dropping the artifact.
   */
  writeText?(path: string, contents: string): void;
};

export type ItotoriCliServices = {
  projectWorkflow: ItotoriProjectWorkflowPort;
  catalogExactExternalIdLinker: ItotoriCatalogExactExternalIdLinkerPort;
  catalogFuzzyCandidateGenerator: ItotoriCatalogFuzzyCandidateGeneratorPort;
  engineCapabilityReports: EngineCapabilityReportPort;
  /** Optional so unit suites can omit it. */
  assetDecisions?: AssetDecisionsCliPort;
  /** Optional so unit suites that do not exercise the queue command can omit it. */
  queueHealth?: QueueHealthCliPort;
  /** The `wiki` object's installed-bible API. */
  wikiObjectApi?: WikiObjectApiService;
  /** The production source-Wiki analyst-wave assembler. */
  wikiBuild?: {
    run(input: WikiBuildInvocation): Promise<SourceWikiRunReport>;
  };
  /** The kept `localize` command's new-pipeline substrate. */
  localizationSubstrate?: {
    /** Durable activation/release for the profile's provider-budget members. */
    readonly providerBudgetCohorts?: LocalizationProviderBudgetCohorts;
    resolvePortSource(
      request: RunPolicyRequest,
      perRun: LocalizationPerRunInput,
    ): LocalizationPortSource | Promise<LocalizationPortSource>;
  };
  /** The kept `patch play` command's new-pipeline substrate. */
  patchPlay?: PlayEntrypointDeps;
};

export type ItotoriCliDependencies = {
  io: JsonFileStore;
  migrateDatabase(startup?: DeploymentStartupContext): Promise<void>;
  resetDatabase(startup?: DeploymentStartupContext): Promise<void>;
  withServices<T>(callback: (services: ItotoriCliServices) => Promise<T>): Promise<T>;
  nativeCli?: NativeCliRunner;
  /** Optional override for the `itotori init` guided-setup dependencies. */
  initDeps?: InitCommandDeps;
};
