import {
  bootstrapLocalUser,
  databaseUrlFromEnv,
  ItotoriConformanceRepository,
  ItotoriLlmHumanInputRepository,
  ItotoriLlmCallMemoRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  ItotoriProjectRunRepository,
  migrate,
  permissionBasedLlmContentRead,
  resetDatabase,
  type LlmRevisionRef,
  withDatabase,
} from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  WikiObjectSchema,
  type CallSpec,
} from "../contracts/index.js";

import type { ItotoriApiServices, ItotoriReadOnlyApiServices } from "../api-handlers.js";
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
import { buildContextSnapshotInput, buildFactSnapshot } from "../prepass/index.js";
import {
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
} from "../structure/index.js";
import { WikiObjectApiService } from "../wiki/object-api/service.js";
import { createDispatchEnhancementRunner } from "../wiki/human-enhancement/index.js";
import engineCapabilityMatrixJson from "../engine-capability/engine-capability-matrix.v0.1.json" with { type: "json" };
import {
  assertEngineCapabilityMatrixDocument,
  createProjectEngineFamilyRegistry,
} from "./engine-capability-matrix.js";
import { ItotoriProjectWorkflowService } from "./project-workflow-service.js";

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
    const services = unavailableServiceSurface({
      projectWorkflow: new ItotoriProjectWorkflowService({
        actor,
        projects: new ItotoriProjectRepository(db, engineFamilyRegistry),
        runs: new ItotoriProjectRunRepository(db),
        snapshots: snapshotRepository,
        ledger: new ItotoriModelLedgerRepository(db),
        passRunConfig: new ItotoriLocalizationPassRunConfigRepository(db),
        conformance: new ItotoriConformanceRepository(db),
        defaultTargetLocale: process.env.ITOTORI_TARGET_LOCALE ?? "en-US",
      }),
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
            // The CLI currently owns one branch per target locale.
            localeBranchId: config.targetLocale,
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
            roles: unavailableLiveRoleSeams(),
            finalizeArtifact() {
              throw unavailableAfterCutover("accepted-output finalization");
            },
            draftBudget: { budgetBytes: 16_384, overlapUnits: 1 },
          });
          return await substrate.resolvePortSource(request, perRun);
        },
      },
    });
    return await callback(services);
  }, options.databaseUrl ?? databaseUrlFromEnv());
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

function projectEngineRegistry() {
  assertEngineCapabilityMatrixDocument(engineCapabilityMatrixJson);
  return createProjectEngineFamilyRegistry(engineCapabilityMatrixJson);
}

export function unavailableServiceSurface(
  installed: Pick<
    ItotoriApplicationServices,
    | "projectWorkflow"
    | "wikiObjectApi"
    | "wikiApply"
    | "wikiBuild"
    | "localizationSubstrate"
    | "patchbackProduce"
  >,
): ItotoriApplicationServices {
  return new Proxy(installed, {
    // Presence checks must use the Proxy's `has` capability rather than `get`:
    // `get` deliberately supplies a loud retired-surface stub for unbound ports.
    has(target, property) {
      return Reflect.has(target, property);
    },
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return () => {
        throw unavailableAfterCutover(String(property));
      };
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

function unavailableAfterCutover(surface: string): Error {
  return new Error(`${surface} is not available after the legacy cutover`);
}

function productionLocalizationConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly targetLocale: string;
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

function contextSnapshotInputForRun(
  input: {
    readonly structureJson: unknown;
    readonly bridge: BridgeBundleV02;
  },
  config: ReturnType<typeof productionLocalizationConfig>,
  sourceLanguage: string,
) {
  const structure = parseNarrativeStructure(
    input.structureJson,
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
  const factSnapshot = buildFactSnapshot(structure, input.bridge);
  return buildContextSnapshotInput({
    factSnapshot,
    sourceLanguage,
    decodeRef: revisionRef(config.decodeRevisionHash),
    glossaryRef: revisionRef(config.glossaryRevisionHash),
    styleRef: revisionRef(config.styleRevisionHash),
  });
}

function revisionRef(contentHash: `sha256:${string}`): LlmRevisionRef {
  return {
    revisionId: contentHash.slice("sha256:".length),
    contentHash,
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
