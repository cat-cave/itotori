// p3-wire-or-explicitly-retire-localizationpassdriverport + itotori-db-draft-route-provider-not-wired
//
// The DB-backed application-service factory (`withDatabaseItotoriServices`)
// used to hand `ItotoriProjectWorkflowService` `undefined` for BOTH the draft
// model provider AND the localization-pass driver, so the shipped `projects.draft`
// route and the Overview "Launch pass" action threw `DraftProviderNotConfiguredError`
// / `LocalizationPassDriverNotConfiguredError` — dead buttons against the live
// DB-backed server.
//
// This module builds the REAL ports the factory now injects, following the same
// live-provider pattern the scene-summary path in `database-services.ts` uses:
//   - the draft provider is a DEFERRED, pinned-pair live OpenRouter provider —
//     it constructs the real `OpenRouterModelProvider` (account-wide ZDR
//     assertion + missing-key refusal fire in that constructor) LAZILY on the
//     first `invoke()`, so merely opening the DB services for a read route never
//     requires an LLM key. A draft therefore drives a REAL call at real
//     `usage.cost`, never a fake, zero-cost provider;
//   - the pass driver is a real `LocalizationPassDriverPort` that does a real DB
//     branch-ownership read and either DRIVES the whole-project live pass (when a
//     run config resolves) or returns an in-band DOMAIN refusal (not a thrown
//     misconfiguration) for the pure-HTTP install that carries no game bytes.

import type { AuthorizationActor, ItotoriProjectRepositoryPort } from "@itotori/db";
import { LocalProviderRunArtifactRecorder } from "../providers/artifacts.js";
import {
  DEV_PAIR,
  getModelCapabilities,
  OpenRouterModelProvider,
  type OpenRouterHttpClient,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelProvider,
  type ProviderDescriptor,
  type ProviderRunArtifactRecorder,
} from "../providers/index.js";
import { DEFAULT_COST_CAP_USD } from "../providers/openrouter.js";
import type {
  LaunchLocalizationPassInput,
  LaunchLocalizationPassResult,
  LocalizationPassDriverPort,
} from "./project-workflow.js";

// ---------------------------------------------------------------------------
// Draft provider — deferred, pinned-pair live OpenRouter.
// ---------------------------------------------------------------------------

export type DbBackedDraftProviderOptions = {
  /** Per-process USD cap threaded into the live provider. Default $0.50. */
  costCapUsd?: number;
  /**
   * Provider-run artifact recorder the live call persists routing posture +
   * usage into. Defaults to the on-disk recorder; a test injects a stub.
   */
  artifactRecorder?: ProviderRunArtifactRecorder;
  /** Test-only env source (mirrors `OpenRouterModelProviderOptions.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Test-only transport injection (mirrors `OpenRouterModelProviderOptions.httpClient`). */
  httpClient?: OpenRouterHttpClient;
  /** Test-only base-URL override (mirrors `OpenRouterModelProviderOptions.baseUrl`). */
  baseUrl?: string;
  /**
   * Test-only override for the deferred real-provider builder. Production never
   * sets this — it lets a deterministic test assert the wiring reaches the real
   * provider without constructing the live OpenRouter transport.
   */
  buildProvider?: () => ModelProvider;
};

/**
 * The DB-backed draft model provider: a DEFERRED wrapper that pins the request
 * to the ZDR `DEV_PAIR` (`deepseek/deepseek-v4-flash` via `fireworks`) and only
 * constructs the real, ZDR-gated `OpenRouterModelProvider` on the first
 * `invoke()`. Deferral is load-bearing: `withDatabaseItotoriServices` opens
 * these services for EVERY route (including read-only ones), and eagerly
 * constructing the live provider would make every route require an
 * `OPENROUTER_API_KEY` + the account-wide ZDR assertion just to serve a read.
 *
 * The descriptor is a concrete pinned pair (never the multi-model `"openrouter"`
 * sentinel), so `draftProject` builds a real request whose `modelId` /
 * `providerId` name a routable, capability-registered pair. On invoke the real
 * provider's constructor asserts the account ZDR posture and refuses on a
 * missing key — so a misconfigured server fails LOUDLY on the real provider, not
 * on a fake draft.
 */
export class DbBackedDraftModelProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private inner: ModelProvider | undefined;

  constructor(private readonly buildInner: () => ModelProvider) {
    this.descriptor = {
      family: "openrouter",
      endpointFamily: "chat-completions",
      // draftProject pins `request.providerId = descriptor.providerName` and
      // `request.modelId = descriptor.defaultModelId`; the ZDR DEV_PAIR is the
      // routable, capability-registered pair the live provider serves.
      providerName: DEV_PAIR.providerId,
      defaultModelId: DEV_PAIR.modelId,
      capabilities: getModelCapabilities(DEV_PAIR),
    };
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    this.inner ??= this.buildInner();
    return await this.inner.invoke(request);
  }
}

/**
 * Build the deferred, pinned-pair live draft provider the DB-backed workflow
 * injects. Production passes no `buildProvider`, so the first draft constructs
 * the real `OpenRouterModelProvider` (ZDR assertion + missing-key refusal in its
 * constructor, cost from real `usage.cost`).
 */
export function createDbBackedDraftModelProvider(
  options: DbBackedDraftProviderOptions = {},
): DbBackedDraftModelProvider {
  const buildInner =
    options.buildProvider ??
    (() =>
      new OpenRouterModelProvider({
        costCapUsd: options.costCapUsd ?? DEFAULT_COST_CAP_USD,
        artifactRecorder: options.artifactRecorder ?? new LocalProviderRunArtifactRecorder(),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.httpClient !== undefined ? { httpClient: options.httpClient } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      }));
  return new DbBackedDraftModelProvider(buildInner);
}

// ---------------------------------------------------------------------------
// Localization-pass driver.
// ---------------------------------------------------------------------------

/**
 * The run inputs the whole-project live pass driver needs but the HTTP route
 * (`{ projectId, localeBranchId }`) does not carry: the on-disk config path (the
 * extracted bridge + pinned pair-policy) + the run directory, and optionally the
 * source/target game roots for the patch-apply seam. A pure-HTTP install has no
 * registry mapping a project to these, so `resolveRunConfig` returns null and
 * the driver refuses in-band.
 */
export type DbBackedPassRunConfig = {
  configPath: string;
  runDir: string;
  sourceRoot?: string;
  patchTargetRoot?: string;
};

export type DbBackedLocalizationPassDriverDeps = {
  actor: AuthorizationActor;
  projectRepository: Pick<ItotoriProjectRepositoryPort, "listLocaleBranchIdentities">;
  /**
   * Resolve the whole-project run config for a launch. A pure-HTTP install has
   * no game-bytes registry, so this is absent (or returns null) and the driver
   * returns an in-band domain refusal. An install that DOES register a project's
   * data-root + pair-policy supplies it, and the driver drives a real pass.
   */
  resolveRunConfig?: (
    input: LaunchLocalizationPassInput,
  ) => Promise<DbBackedPassRunConfig | null> | DbBackedPassRunConfig | null;
  /**
   * Drive the whole-project live pass for a resolved config. Injected so
   * production binds it to `runLocalizeFullProjectLive` (LIVE OpenRouter + real
   * Postgres) while a test binds a deterministic double.
   */
  runLive?: (
    config: DbBackedPassRunConfig,
    input: LaunchLocalizationPassInput & { actor: AuthorizationActor },
  ) => Promise<LaunchLocalizationPassResult>;
};

/**
 * Real `LocalizationPassDriverPort` for the DB-backed server. `launchNextPass`
 * does a real DB branch-ownership read, then either DRIVES the whole-project
 * live pass (when a run config resolves) or returns an in-band DOMAIN refusal —
 * never the thrown `LocalizationPassDriverNotConfiguredError` misconfiguration.
 * The refusal is a first-class launch outcome the HTTP boundary surfaces
 * in-band, distinct from a 500.
 */
export class DbBackedLocalizationPassDriver implements LocalizationPassDriverPort {
  constructor(private readonly deps: DbBackedLocalizationPassDriverDeps) {}

  async launchNextPass(
    input: LaunchLocalizationPassInput & { actor: AuthorizationActor },
  ): Promise<LaunchLocalizationPassResult> {
    // Real DB read: confirm the branch belongs to the project before driving.
    const branches = await this.deps.projectRepository.listLocaleBranchIdentities(input.projectId);
    if (!branches.some((branch) => branch.localeBranchId === input.localeBranchId)) {
      return {
        outcome: "refused",
        refusalMessage: `locale branch ${input.localeBranchId} does not belong to project ${input.projectId}`,
      };
    }

    const config =
      this.deps.resolveRunConfig === undefined ? null : await this.deps.resolveRunConfig(input);
    if (config === null || config === undefined) {
      return {
        outcome: "refused",
        refusalMessage:
          "no game-bytes localization pipeline is registered for this project on the DB-backed " +
          "server: a live pass drives the whole project through the agentic loop over the source " +
          "game bytes (data-root + pinned model/provider pair), which the pure-HTTP install does " +
          "not carry. Launch a live pass with the `itotori localize --config <project>.localize.json` " +
          "driver, which supplies the data-root + pair-policy.",
      };
    }

    if (this.deps.runLive === undefined) {
      return {
        outcome: "refused",
        refusalMessage:
          "a run config resolved but no whole-project pass runner is wired for this driver",
      };
    }
    return await this.deps.runLive(config, input);
  }
}

/** Build the DB-backed localization-pass driver the workflow injects. */
export function createDbBackedLocalizationPassDriver(
  deps: DbBackedLocalizationPassDriverDeps,
): DbBackedLocalizationPassDriver {
  return new DbBackedLocalizationPassDriver(deps);
}
