import {
  bootstrapLocalUser,
  databaseUrlFromEnv,
  ItotoriLlmHumanInputRepository,
  ItotoriLlmCallMemoRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
  migrate,
  permissionBasedLlmContentRead,
  resetDatabase,
  withDatabase,
} from "@itotori/db";

import type { ItotoriApiServices, ItotoriReadOnlyApiServices } from "../api-handlers.js";
import type { ItotoriCliServices } from "../cli-handlers.js";
import {
  createFieldMemoCipher,
  createProductionLiveLocalizationSubstrate,
  productionLocalizeDispatchConfig,
} from "../composition/live/index.js";
import { runWikiBuild } from "../composition/index.js";
import { WikiObjectApiService } from "../wiki/object-api/service.js";

/** The remaining command/API surfaces require a new-pipeline composition
 * substrate. The retired DB factory must never silently reconstruct the old
 * provider/journal graph. */
export type ItotoriApplicationServices = ItotoriCliServices & ItotoriApiServices;

export type ItotoriServiceFactory = <T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
  options?: { sessionId?: string },
) => Promise<T>;

export type ItotoriReadOnlyServiceFactory = <T>(
  callback: (services: ItotoriReadOnlyApiServices) => Promise<T>,
  options?: { sessionId?: string },
) => Promise<T>;

export class ItotoriInvalidAuthSessionError extends Error {
  constructor() {
    super("the requested authenticated service factory is not installed");
    this.name = "ItotoriInvalidAuthSessionError";
  }
}

export async function withDatabaseItotoriServices<T>(
  options: { databaseUrl?: string; bootstrapLocalUser?: boolean; sessionId?: string },
  callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  return await withDatabase(async ({ db, pool }) => {
    const actor = await bootstrapLocalUser(db);
    const config = productionLocalizationConfig(process.env);
    const cipher = createFieldMemoCipher(process.env);
    const wikiObjectApi = new WikiObjectApiService({
      wiki: new ItotoriLlmWikiRepository(pool, cipher),
      humanInputs: new ItotoriLlmHumanInputRepository(pool, cipher),
    });
    const contentAccess = permissionBasedLlmContentRead(db, actor);
    const wikiRepository = new ItotoriLlmWikiRepository(pool, cipher);
    const memoStore = new ItotoriLlmCallMemoRepository(pool, cipher, contentAccess);
    const services = unavailableServiceSurface({
      projectWorkflow: unavailableProjectWorkflow(),
      wikiObjectApi,
      wikiBuild: {
        async run(input) {
          const contextSnapshot = await new ItotoriLlmSnapshotRepository(pool).readContext(
            config.contextSnapshotId,
          );
          if (contextSnapshot === null) {
            throw new Error(`wiki build requires context snapshot ${config.contextSnapshotId}`);
          }
          return await runWikiBuild({
            ...input,
            contextSnapshot,
            repository: wikiRepository,
            memoStore,
            contentAccess,
            dispatch: productionLocalizeDispatchConfig({
              env: process.env,
              maxAttemptExposureUsd: config.maxAttemptExposureUsd,
              confirmedCostCapUsd: config.confirmedCostCapUsd,
            }),
            dispatchSnapshots: {
              decodeRevisionHash: config.decodeRevisionHash,
              glossaryRevisionHash: config.glossaryRevisionHash,
              styleRevisionHash: config.styleRevisionHash,
              acceptedOutputHeadHash: null,
            },
          });
        },
      },
      localizationSubstrate: createProductionLiveLocalizationSubstrate({
        database: db,
        actor,
        pool,
        env: process.env,
        targetLocale: config.targetLocale,
        scope: {
          contextSnapshotId: config.contextSnapshotId,
          localizationSnapshotId: config.localizationSnapshotId,
          schemaHash: config.schemaHash,
          runMode: "production",
          contextScope: "whole-game",
        },
        dispatchSnapshots: {
          decodeRevisionHash: config.decodeRevisionHash,
          glossaryRevisionHash: config.glossaryRevisionHash,
          styleRevisionHash: config.styleRevisionHash,
          acceptedOutputHeadHash: null,
        },
        dispatch: productionLocalizeDispatchConfig({
          env: process.env,
          maxAttemptExposureUsd: config.maxAttemptExposureUsd,
          confirmedCostCapUsd: config.confirmedCostCapUsd,
        }),
        roles: unavailableLiveRoleSeams(),
        finalizeArtifact() {
          throw unavailableAfterCutover("accepted-output finalization");
        },
        draftBudget: { budgetBytes: 16_384, overlapUnits: 1 },
      }),
    });
    return await callback(services);
  }, options.databaseUrl ?? databaseUrlFromEnv());
}

function unavailableProjectWorkflow(): ItotoriApplicationServices["projectWorkflow"] {
  return new Proxy({} as ItotoriApplicationServices["projectWorkflow"], {
    get: () => () => {
      throw unavailableAfterCutover("project workflow");
    },
  });
}

function unavailableLiveRoleSeams() {
  return {
    review: {
      async reviewLane() {
        throw unavailableAfterCutover("live review role seam");
      },
    },
    patchback: {
      buildInput() {
        throw unavailableAfterCutover("native patchback seam");
      },
      translatedBundlePath() {
        throw unavailableAfterCutover("native patchback seam");
      },
      async buildLqa() {
        throw unavailableAfterCutover("Build-LQA role seam");
      },
    },
    adjudicate: {
      buildRefs() {
        throw unavailableAfterCutover("adjudication role seam");
      },
      async readPayload() {
        throw unavailableAfterCutover("adjudication role seam");
      },
      resolveEvidence: () => null,
    },
  };
}

function unavailableServiceSurface(
  installed: Pick<
    ItotoriApplicationServices,
    "projectWorkflow" | "wikiObjectApi" | "wikiBuild" | "localizationSubstrate"
  >,
): ItotoriApplicationServices {
  return new Proxy(installed, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return () => {
        throw unavailableAfterCutover(String(property));
      };
    },
  }) as ItotoriApplicationServices;
}

function unavailableAfterCutover(surface: string): Error {
  return new Error(`${surface} is not available after the legacy cutover`);
}

function productionLocalizationConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly targetLocale: string;
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly decodeRevisionHash: `sha256:${string}`;
  readonly glossaryRevisionHash: `sha256:${string}`;
  readonly styleRevisionHash: `sha256:${string}`;
  readonly maxAttemptExposureUsd: string;
  readonly confirmedCostCapUsd: string;
} {
  requireEnvironmentValue(env, "OPENROUTER_API_KEY");
  return {
    targetLocale: requireEnvironmentValue(env, "ITOTORI_TARGET_LOCALE"),
    contextSnapshotId: requireSha256EnvironmentValue(env, "ITOTORI_CONTEXT_SNAPSHOT_ID"),
    localizationSnapshotId: requireSha256EnvironmentValue(env, "ITOTORI_LOCALIZATION_SNAPSHOT_ID"),
    schemaHash: requireSha256EnvironmentValue(env, "ITOTORI_DRAFT_SCHEMA_HASH"),
    decodeRevisionHash: requireSha256EnvironmentValue(env, "ITOTORI_DECODE_REVISION_HASH"),
    glossaryRevisionHash: requireSha256EnvironmentValue(env, "ITOTORI_GLOSSARY_REVISION_HASH"),
    styleRevisionHash: requireSha256EnvironmentValue(env, "ITOTORI_STYLE_REVISION_HASH"),
    maxAttemptExposureUsd: requireDecimalEnvironmentValue(
      env,
      "ITOTORI_LOCALIZE_MAX_ATTEMPT_EXPOSURE_USD",
    ),
    confirmedCostCapUsd: requireDecimalEnvironmentValue(env, "ITOTORI_LOCALIZE_COST_CAP_USD"),
  };
}

function requireEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`localize production configuration requires ${name}`);
  }
  return value;
}

function requireSha256EnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): `sha256:${string}` {
  const value = requireEnvironmentValue(env, name);
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`localize production configuration requires ${name} to be a sha256 hash`);
  }
  return value as `sha256:${string}`;
}

function requireDecimalEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requireEnvironmentValue(env, name);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u.test(value)) {
    throw new Error(
      `localize production configuration requires ${name} to be an exact decimal USD`,
    );
  }
  return value;
}

export function toReadOnlyServiceFactory(
  factory: ItotoriServiceFactory,
): ItotoriReadOnlyServiceFactory {
  return async (callback, options) =>
    await factory(async (services) => await callback(services), options);
}

export async function migrateItotoriDatabase(databaseUrl = databaseUrlFromEnv()): Promise<void> {
  await migrate(databaseUrl);
}

export async function resetItotoriDatabase(databaseUrl = databaseUrlFromEnv()): Promise<void> {
  await resetDatabase(databaseUrl);
}

export function startDatabaseContextCorrectionWorker(_options?: unknown): { stop(): void } {
  return { stop: () => undefined };
}
