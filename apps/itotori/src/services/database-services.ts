import {
  databaseUrlFromEnv,
  ItotoriCatalogRepository,
  ItotoriConformanceRepository,
  ItotoriFeedbackRepository,
  ItotoriLlmHumanInputRepository,
  ItotoriLlmCallMemoRepository,
  ItotoriJobsRunTableRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  ItotoriProjectRunRepository,
  ItotoriSourceUnitRepository,
  localUserId,
  migrate,
  permissionBasedLlmContentRead,
  resetDatabase,
  withDatabase,
} from "@itotori/db";
import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  WikiObjectSchema,
  type CallSpec,
} from "../contracts/index.js";

import type { ItotoriApiServices, ItotoriReadOnlyApiServices } from "../api-handlers.js";
import { readOnlyApiServices } from "../api-handler-contracts.js";
import type { ItotoriCliServices } from "../cli-handlers.js";
import {
  createFieldMemoCipher,
  createDispatchRuntime,
  createProductionLiveLocalizationSubstrate,
  productionLocalizeDispatchConfig,
  type RunSnapshotRevisions,
} from "../composition/live/index.js";
import { runWikiBuild } from "../composition/index.js";
import { canonicalJson, sha256 } from "../llm/canonical-json.js";
import { resolveRoleModelProfile } from "../llm/role-model-profiles.js";
import { DatabasePatchbackProduceInputLoader } from "../play/database-patchback-produce-input-loader.js";
import {
  bindPatchbackProduceService,
  PatchbackProduceService,
} from "../play/patchback-produce-service.js";
import { createRepositoryUnitFeedbackPort } from "../play/unit-feedback-adapter.js";
import { WikiObjectApiService } from "../wiki/object-api/service.js";
import { createDispatchEnhancementRunner } from "../wiki/human-enhancement/index.js";
import engineCapabilityMatrixJson from "../engine-capability/engine-capability-matrix.v0.1.json" with { type: "json" };
import { configuredServicePort } from "./configured-port.js";
import {
  assertEngineCapabilityMatrixDocument,
  createProjectEngineFamilyRegistry,
} from "./engine-capability-matrix.js";
import {
  createDetachedLocalizationPassRunner,
  defaultReadJson,
  defaultWriteJson,
} from "./launch-localization-pass.js";
import {
  contextSnapshotInputForRun,
  decimalUsdToExactMicros,
  productionLocalizationConfig,
} from "./localization-production-config.js";
import { ItotoriProjectWorkflowService } from "./project-workflow-service.js";
import { ItotoriAuthorizationService } from "../auth.js";

/** The remaining command/API surfaces require a new-pipeline composition
 * substrate. The retired DB factory must never silently reconstruct the old
 * provider/journal graph. */
export type ItotoriApplicationServices = ItotoriCliServices & ItotoriApiServices;

export type ItotoriServiceFactoryOptions = {
  sessionId?: string;
};

export type ItotoriServiceFactory = <T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
  options?: ItotoriServiceFactoryOptions,
) => Promise<T>;

export type ItotoriReadOnlyServiceFactory = <T>(
  callback: (services: ItotoriReadOnlyApiServices) => Promise<T>,
  options?: ItotoriServiceFactoryOptions,
) => Promise<T>;

export class ItotoriInvalidAuthSessionError extends Error {
  constructor() {
    super("the requested authenticated service factory is not installed");
    this.name = "ItotoriInvalidAuthSessionError";
  }
}

/** Raised at the service boundary before a caller can dereference an unbound port. */
export class ItotoriMissingServiceError extends Error {
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(`retired service port '${serviceName}' has no installed binding`);
    this.name = "ItotoriMissingServiceError";
    this.serviceName = serviceName;
  }
}

export async function withDatabaseItotoriServices<T>(
  options: { databaseUrl?: string } & ItotoriServiceFactoryOptions,
  callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  return await withDatabase(async ({ db, pool }) => {
    // Migration owns setup-time seeding. Request handling never writes a
    // fallback authorization substrate: an unmigrated installation fails
    // explicitly through its normal database error boundary.
    const actor = { userId: localUserId };
    const cipher = createFieldMemoCipher(process.env);
    let config: ReturnType<typeof productionLocalizationConfig> | undefined;
    const localizationConfig = () => (config ??= productionLocalizationConfig(process.env));
    const wikiObjectApi = new WikiObjectApiService({
      wiki: new ItotoriLlmWikiRepository(pool, cipher),
      humanInputs: new ItotoriLlmHumanInputRepository(pool, cipher),
    });
    const contentAccess = permissionBasedLlmContentRead(db, actor);
    const wikiRepository = new ItotoriLlmWikiRepository(pool, cipher);
    const memoStore = new ItotoriLlmCallMemoRepository(pool, cipher, contentAccess);
    const snapshotRepository = new ItotoriLlmSnapshotRepository(pool);
    const engineFamilyRegistry = projectEngineRegistry();
    const catalogRepository = new ItotoriCatalogRepository(db);
    const unitBoundFeedback = createRepositoryUnitFeedbackPort({
      repository: new ItotoriFeedbackRepository(db),
      actor,
    });
    // Launch-pass opens a detached DB session so the HTTP mutation can return
    // as soon as the durable project run is admitted. Nested
    // withDatabaseItotoriServices reuses the same options (database URL, etc.).
    const passRunner = createDetachedLocalizationPassRunner({
      openSession: async (run) => {
        await withDatabaseItotoriServices(options, async (session) => {
          const substrate = configuredServicePort(session, "localizationSubstrate");
          if (substrate === undefined) {
            throw new Error(
              "launch-pass refused: localizationSubstrate is not installed on the detached session",
            );
          }
          await run({
            readJson: defaultReadJson,
            writeJson: defaultWriteJson,
            projectWorkflow: session.projectWorkflow,
            resolvePortSource: (request, perRun) => substrate.resolvePortSource(request, perRun),
          });
        });
      },
    });
    const services = retiredServiceSurface({
      authorization: new ItotoriAuthorizationService(db, actor),
      catalogRepository: {
        catalogConflictReview: (filter) => catalogRepository.catalogConflictReview(actor, filter),
        catalogCompletenessBenchmarkPools: (filter) =>
          catalogRepository.catalogCompletenessBenchmarkPools(actor, filter),
        catalogBenchmarkSeedFinder: (filter) =>
          catalogRepository.catalogBenchmarkSeedFinder(actor, filter),
        catalogContextPanelForWork: (input) =>
          catalogRepository.catalogContextPanelForWork(actor, input),
        catalogOpportunityRanking: (filter) =>
          catalogRepository.catalogOpportunityRanking(actor, filter),
      },
      jobs: {
        loadRunTable: (options) =>
          new ItotoriJobsRunTableRepository(db).loadRunTable(actor, options),
      },
      projectWorkflow: new ItotoriProjectWorkflowService({
        actor,
        projects: new ItotoriProjectRepository(db, engineFamilyRegistry),
        runs: new ItotoriProjectRunRepository(db),
        snapshots: snapshotRepository,
        ledger: new ItotoriModelLedgerRepository(db),
        passRunConfig: new ItotoriLocalizationPassRunConfigRepository(db),
        passRunner,
        conformance: new ItotoriConformanceRepository(db),
        defaultTargetLocale: "en-US",
      }),
      manualFeedback: unitBoundFeedback,
      unitFeedback: unitBoundFeedback,
      addressableUnits: new ItotoriSourceUnitRepository(db),
      wikiObjectApi,
      wikiApply: {
        runner: createLiveWikiEnhancementRunner({
          dispatchConfig: () => {
            const config = localizationConfig();
            return productionLocalizeDispatchConfig({
              env: process.env,
              maxAttemptExposureUsd: config.maxAttemptExposureUsd,
              confirmedCostCapUsd: config.confirmedCostCapUsd,
            });
          },
          memoStore,
          contentAccess,
          snapshots: () => {
            const config = localizationConfig();
            return {
              decodeRevisionHash: config.decodeRevisionHash,
              glossaryRevisionHash: config.glossaryRevisionHash,
              styleRevisionHash: config.styleRevisionHash,
              acceptedOutputHeadHash: null,
            };
          },
        }),
        decodedFacts: [],
      },
      patchbackProduce: bindPatchbackProduceService(
        new PatchbackProduceService({
          loader: new DatabasePatchbackProduceInputLoader({
            database: db,
            pool,
            cipher,
          }),
        }),
        actor,
      ),
      wikiBuild: {
        async run(input) {
          const config = localizationConfig();
          if (input.sourceLanguage !== input.bridge.sourceLocale) {
            throw new Error(
              `wiki build source locale ${input.sourceLanguage} does not match bridge ${input.bridge.sourceLocale}`,
            );
          }
          const contextSnapshot = await snapshotRepository.putContext(
            contextSnapshotInputForRun(input, config, input.sourceLanguage),
          );
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
      localizationSubstrate: {
        async resolvePortSource(request, perRun) {
          const config = localizationConfig();
          const contextSnapshot = await snapshotRepository.putContext(
            contextSnapshotInputForRun(perRun, config, perRun.bridge.sourceLocale),
          );
          const localizationSnapshot = await snapshotRepository.putLocalization({
            contextSnapshotId: contextSnapshot.snapshotId,
            targetLocale: config.targetLocale,
            // The immutable snapshot must be bound to the same composite
            // branch identity the project-run row will reference. The target
            // locale is display/configuration data, not the branch key.
            localeBranchId: perRun.projectRun?.localeBranchId ?? config.targetLocale,
            acceptedBibleHead: null,
            acceptedTargetOutputHead: null,
          });
          const substrate = createProductionLiveLocalizationSubstrate({
            database: db,
            actor,
            pool,
            env: process.env,
            targetLocale: config.targetLocale,
            scope: {
              contextSnapshotId: contextSnapshot.snapshotId,
              localizationSnapshotId: localizationSnapshot.snapshotId,
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
            roles: productionRoleBindings(),
            draftBudget: { budgetBytes: 16_384, overlapUnits: 1 },
          });
          const source = await substrate.resolvePortSource(request, perRun);
          if (perRun.projectRun === undefined) return source;
          return {
            ...source,
            runPlane: {
              ...perRun.projectRun,
              contextSnapshotId: contextSnapshot.snapshotId,
              localizationSnapshotId: localizationSnapshot.snapshotId,
              capMicrosUsd: decimalUsdToExactMicros(
                config.confirmedCostCapUsd,
                "ITOTORI_LOCALIZE_COST_CAP_USD",
              ),
            },
          };
        },
      },
    });
    return await callback(services);
  }, options.databaseUrl ?? databaseUrlFromEnv());
}

function productionRoleBindings() {
  return {
    review: {
      async reviewLane() {
        throw new Error("production review role binding has not been installed");
      },
    },
    adjudicate: {
      buildRefs() {
        throw new Error("production adjudication role binding has not been installed");
      },
      async readPayload() {
        throw new Error("production adjudication role binding has not been installed");
      },
      resolveEvidence: () => null,
    },
  };
}

function projectEngineRegistry() {
  assertEngineCapabilityMatrixDocument(engineCapabilityMatrixJson);
  return createProjectEngineFamilyRegistry(engineCapabilityMatrixJson);
}

export function retiredServiceSurface(
  installed: Pick<
    ItotoriApplicationServices,
    | "projectWorkflow"
    | "authorization"
    | "catalogRepository"
    | "jobs"
    | "wikiObjectApi"
    | "wikiApply"
    | "wikiBuild"
    | "localizationSubstrate"
    | "patchbackProduce"
    | "manualFeedback"
    | "unitFeedback"
    | "addressableUnits"
  >,
): ItotoriApplicationServices {
  return new Proxy(installed, {
    // Presence checks use the Proxy's `has` capability rather than `get`,
    // because `get` fails immediately for every unbound port.
    has(target, property) {
      return Reflect.has(target, property);
    },
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      throw new ItotoriMissingServiceError(String(property));
    },
  }) as ItotoriApplicationServices;
}

/** Bind the explicit human-apply boundary to the same live, memoized ZDR
 * dispatch substrate as the production workflow.  The payload is held only in
 * this request-local resolver; the persisted physical-step ledger sees the
 * content hash and durable memo identity, never a provider-specific path. */
function createLiveWikiEnhancementRunner(input: {
  readonly dispatchConfig: () => ReturnType<typeof productionLocalizeDispatchConfig>;
  readonly memoStore: ItotoriLlmCallMemoRepository;
  readonly contentAccess: ReturnType<typeof permissionBasedLlmContentRead>;
  readonly snapshots: () => RunSnapshotRevisions;
}) {
  return createDispatchEnhancementRunner({
    async plan(request) {
      const object = WikiObjectSchema.parse(request.priorObjectJson);
      const p2 = resolveRoleModelProfile("P2");
      const payload = canonicalJson({
        kind: "wiki-human-enhancement",
        priorObject: request.priorObjectJson,
        humanAppliedObject: request.humanAppliedJson,
        humanDelta: request.delta,
        decodedFactConflicts: request.decodedFactConflicts,
      });
      const contentHash = sha256(payload);
      const storageRef = `wiki-enhancement-${contentHash.slice("sha256:".length, "sha256:".length + 24)}`;
      const spec: CallSpec = {
        schemaVersion: CALL_SPEC_SCHEMA_VERSION,
        purpose: "repair",
        roleId: "P2",
        modelProfile: p2.modelProfile,
        modelProfileVersion: p2.version,
        requestedModel: p2.model,
        providerPolicy: p2.providerPolicy,
        parentEventId: sha256({
          kind: "wiki-human-enhancement",
          objectId: object.objectId,
          baseVersion: object.version,
          inputIds: request.delta.inputs.map((humanInput) => humanInput.inputId),
        }),
        contextSnapshotId: object.provenance.contextSnapshotId,
        localizationSnapshotId:
          object.provenance.snapshotKind === "localization"
            ? object.provenance.localizationSnapshotId
            : null,
        messages: [
          {
            kind: "text",
            eventId: sha256({ kind: "wiki-human-enhancement", contentHash }),
            role: "user",
            contentEncrypted: { storageRef, contentHash, encryption: "operator-managed" },
          },
        ],
        tools: [],
        output: {
          name: "wiki-object",
          schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
          schemaHash: sha256(WIKI_OBJECT_SCHEMA_VERSION),
        },
        promptVersion: "wiki-human-enhancement.v1",
        reasoning: { effort: "none" },
        sampling: { temperature: 0, topP: 1, seed: null },
        limits: {
          maxSteps: 1,
          maxToolCalls: 0,
          maxParallelTools: 1,
          maxOutputTokens: 2_048,
          timeoutClass: "normal",
        },
        sampleId: null,
        runMode: object.provenance.runMode,
        contextScope: object.provenance.contextScope,
      };
      const dispatchConfig = input.dispatchConfig();
      const runtime = createDispatchRuntime({
        ...dispatchConfig,
        profile: {
          name: p2.modelProfile,
          version: p2.version,
          deadlines: { normalMs: 30_000, deepMs: 300_000 },
          maxAttemptExposureUsd: dispatchConfig.profile.maxAttemptExposureUsd,
        },
        memoStore: input.memoStore,
        contentAccess: input.contentAccess,
        snapshots: input.snapshots(),
      });
      return {
        spec,
        runtime: {
          ...runtime,
          async readPayload(reference) {
            if (reference.storageRef !== storageRef || reference.contentHash !== contentHash) {
              throw new Error("wiki enhancement received an unknown payload reference");
            }
            return payload;
          },
        },
      };
    },
  });
}

export function toReadOnlyServiceFactory(
  factory: ItotoriServiceFactory,
): ItotoriReadOnlyServiceFactory {
  return async (callback, options) =>
    await factory(async (services) => await callback(readOnlyApiServices(services)), {
      ...options,
    });
}

export async function migrateItotoriDatabase(databaseUrl = databaseUrlFromEnv()): Promise<void> {
  await migrate(databaseUrl);
}

export async function resetItotoriDatabase(databaseUrl = databaseUrlFromEnv()): Promise<void> {
  await resetDatabase(databaseUrl);
}
