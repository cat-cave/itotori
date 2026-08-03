// The live localization factory — source the concrete workflow substrate for a
// single, already-admitted run. It deliberately builds no bible: missing source
// objects or renderings remain absent from the installed bible, so readiness
// reports the blocking requirement instead of inventing a fallback.

import {
  ItotoriLlmAcceptedOutputRepository,
  ItotoriLlmCallMemoRepository,
  ItotoriLlmWikiRepository,
  permissionBasedLlmContentRead,
  type AuthorizationActor,
  type ItotoriDatabase,
  type LlmCallMemoStore,
  type LlmContentReadAuthorizer,
  type LlmWikiObjectRecord,
} from "@itotori/db";
import type { BridgeBundleV02, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";

import {
  LocalizedRenderingSchema,
  WikiObjectSchema,
  type WikiObject,
} from "../../contracts/index.js";
import type { AdjudicateDeps, PatchbackDeps, ReviewDeps, WorkflowPortDeps } from "../deps.js";
import { resolveTargetPolicyForAdapter } from "../../gates/index.js";
import { buildFactSnapshot } from "../../prepass/index.js";
import {
  buildInstalledBible,
  resolveUnitBibleGroundTruth,
  type InstalledBibleEntry,
} from "../../localized-wiki/ground-truth/index.js";
import {
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  parseNarrativeStructure,
} from "../../structure/index.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";
import type { RunPolicyRequest } from "../../run-policy/index.js";
import type { LocalizationPerRunInput } from "../localize-entrypoint.js";
import {
  createAdjudicateDeps,
  createDraftDeps,
  createGateDeps,
  createReadinessDeps,
  createRepairDeps,
  decodeFactSourceFrom,
  type DecodeFactSource,
  type DraftRealizationConfig,
  type GateSideInputs,
  type InstalledBible,
  type RunScopeConfig,
} from "./assemblers/index.js";
import {
  createCertifiedDispatch,
  createDispatchRuntime,
  type DispatchRuntimeBase,
  type LiveDispatchRuntimeConfig,
  type PayloadResolver,
  type RunSnapshotRevisions,
} from "./dispatch-runtime.js";
import { createFieldMemoCipher } from "./field-cipher.js";
import {
  createLiveWorkflowArtifactStore,
  type AcceptedOutputCas,
  type FinalizeArtifactResolver,
  type WorkflowStepCache,
} from "./artifact-store.js";
import {
  createAcceptedTargetHistoryReader,
  type AcceptedTargetHistoryReader,
  type AcceptedTargetRecord,
} from "./accepted-target-history.js";
import { createCapturedDraftFinalizer, LiveWorkflowFactoryError } from "./factory-finalizer.js";

export { LiveWorkflowFactoryError } from "./factory-finalizer.js";

/** The durable wiki read surface required to install the target bible. */
export type InstalledBibleSource = Pick<ItotoriLlmWikiRepository, "listObjects">;

/** The already-built persistence and authorization substrate for an offline
 * proof or a host that owns its repositories. */
export interface LiveWorkflowStores {
  readonly memoStore: LlmCallMemoStore;
  readonly contentAccess: LlmContentReadAuthorizer;
  readonly accepted: AcceptedOutputCas;
  /** Verified decrypted final heads for the Q2/Q4 accepted-target context. */
  readonly acceptedTargets: AcceptedTargetHistoryReader;
  readonly wiki: InstalledBibleSource;
}

/** The concrete role seams for one run. The render/OCR-backed Build-LQA path
 * remains a live-only source; this factory carries it through as `patchback`,
 * and never synthesizes a frame. */
export interface BoundLiveWorkflowRoleSeams {
  readonly review: ReviewDeps;
  /** The default patchback is a concrete accepted-output → PatchExportV02
   * binder. Hosts may replace it only when they own a stricter artifact sink. */
  readonly patchback?: PatchbackDeps;
  readonly adjudicate: {
    readonly buildRefs: AdjudicateDeps["buildRefs"];
    readonly readPayload: PayloadResolver;
    readonly resolveEvidence: (evidenceId: string) => string | null | undefined;
    /** Production role bindings supply Q6's independently profiled dispatch. */
    readonly dispatch?: AdjudicateDeps["dispatch"];
  };
}

/** The facts that do not exist until this factory has materialized the exact
 * run. Production review/adjudication must bind here rather than at a service
 * lifetime: their prompts and evidence resolvers are snapshot-specific. */
export interface LiveWorkflowRoleBindingInput {
  readonly facts: DecodeFactSource;
  readonly bible: InstalledBible;
  /** Source/rendering pairs preserve the granular source authority that the
   * installed-bible lookup indexes away (for example A5's scoped voice rules). */
  readonly bibleEntries: readonly InstalledBibleEntry[];
  /** Current verified final heads, loaded once before any role binding sees text. */
  readonly acceptedTargets: readonly AcceptedTargetRecord[];
  readonly targetLocale: string;
  readonly scope: RunScopeConfig;
  readonly runtime: DispatchRuntimeBase;
}

/** Defers role installation until the per-run facts, bible, and certified
 * dispatch runtime all exist. This is the production composition shape. */
export interface LiveWorkflowRoleBindingFactory {
  bind(input: LiveWorkflowRoleBindingInput): BoundLiveWorkflowRoleSeams;
}

/** A host may either provide already-bound seams (offline proofs) or defer
 * their construction until the live run substrate is available. */
export type LiveWorkflowRoleSeams = BoundLiveWorkflowRoleSeams | LiveWorkflowRoleBindingFactory;

/** All run-specific input that is not owned by the deterministic workflow.
 * Snapshot identities and the spend admission must already be durable and
 * confirmed; the factory never derives either from a default. */
export interface LiveWorkflowFactoryConfig {
  readonly structureJson: unknown;
  readonly bridge: BridgeBundleV02;
  readonly targetLocale: string;
  readonly scope: RunScopeConfig;
  readonly dispatchSnapshots: RunSnapshotRevisions;
  readonly dispatch: Omit<LiveDispatchRuntimeConfig, "memoStore" | "contentAccess" | "snapshots">;
  readonly stores: LiveWorkflowStores;
  readonly roles: LiveWorkflowRoleSeams;
  /** Hosts with an external accepted-output authority may override the standard
   * live finalizer. Production normally uses the built-in P1 receipt-backed
   * finalizer below. */
  readonly finalizeArtifact?: FinalizeArtifactResolver;
  readonly draftBudget: DraftRealizationConfig;
  readonly gateSideInputs?: Omit<GateSideInputs, "glossary" | "policy">;
  readonly stepCache?: WorkflowStepCache;
  readonly maxStepAttempts?: number;
}

/** Build the P1-measured dispatch posture used by the long-lived production
 * substrate. The certified role profile is the model-routing authority; the
 * operator supplies the bounded spend values and OpenRouter credential at the
 * environment boundary rather than through a command flag. */
export function productionLocalizeDispatchConfig(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly maxAttemptExposureUsd: string;
  readonly confirmedCostCapUsd: string;
  /** A deterministic HTTP transport is an integration-proof seam only; normal
   * production composition omits it and uses the platform fetch boundary. */
  readonly fetcher?: LiveDispatchRuntimeConfig["fetcher"];
}): Pick<LiveWorkflowFactoryConfig, "dispatch">["dispatch"] {
  const apiKey = input.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new LiveWorkflowFactoryError("OPENROUTER_API_KEY is required for a live localize run");
  }
  const draftProfile = resolveRoleModelProfile("P1");
  return {
    profile: {
      name: draftProfile.modelProfile,
      version: draftProfile.version,
      deadlines: { normalMs: 30_000, deepMs: 300_000 },
      maxAttemptExposureUsd: input.maxAttemptExposureUsd,
    },
    admission: {
      scope: `localize:${draftProfile.profileId}`,
      confirmedCostCapUsd: input.confirmedCostCapUsd,
    },
    env: input.env,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  };
}

/** Build the installed target bible from the persisted source objects and target
 * renderings. Renderings for another locale are excluded; missing renderings
 * are deliberately not fabricated. */
export async function loadInstalledBible(input: {
  readonly wiki: InstalledBibleSource;
  readonly contextSnapshotId: string;
  readonly localizationSnapshotId: string;
  readonly targetLocale: string;
}): Promise<InstalledBible> {
  return (await loadInstalledBibleMaterial(input)).bible;
}

async function loadInstalledBibleMaterial(input: {
  readonly wiki: InstalledBibleSource;
  readonly contextSnapshotId: string;
  readonly localizationSnapshotId: string;
  readonly targetLocale: string;
}): Promise<{ readonly bible: InstalledBible; readonly entries: readonly InstalledBibleEntry[] }> {
  const [sourceRows, renderingRows] = await Promise.all([
    input.wiki.listObjects({ snapshotId: input.contextSnapshotId, wikiKind: "source-object" }),
    input.wiki.listObjects({
      snapshotId: input.localizationSnapshotId,
      wikiKind: "localized-rendering",
    }),
  ]);
  const sources = new Map<string, WikiObject>();
  for (const row of sourceRows) {
    const source = parseSourceObject(row);
    sources.set(source.objectId, source);
  }
  const entries: InstalledBibleEntry[] = renderingRows.flatMap((row) => {
    const rendering = LocalizedRenderingSchema.parse(JSON.parse(row.objectJson));
    if (rendering.targetLanguage !== input.targetLocale) return [];
    const sourceObject = sources.get(rendering.sourceObjectId);
    if (sourceObject === undefined) {
      throw new LiveWorkflowFactoryError(
        `rendering ${rendering.renderingId} has no source object in the context snapshot`,
      );
    }
    if (sourceObject.kind !== rendering.sourceObjectKind) {
      throw new LiveWorkflowFactoryError(
        `rendering ${rendering.renderingId} disagrees with source object ${sourceObject.objectId}`,
      );
    }
    return [{ sourceObject, rendering }];
  });
  return { bible: buildInstalledBible(entries), entries };
}

/** Source every deterministic assembler and durable adapter into the complete
 * dependency shape consumed by `runLocalization`. No port is omitted. */
export async function createLiveWorkflowPortDeps(
  config: LiveWorkflowFactoryConfig,
): Promise<WorkflowPortDeps> {
  const structure = parseNarrativeStructure(
    config.structureJson,
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
  const snapshot = buildFactSnapshot(structure, config.bridge);
  const facts = decodeFactSourceFrom(
    snapshot,
    bridgeUnitsByUnitKey(snapshot.orderedUnits, config.bridge),
  );
  const installedBible = await loadInstalledBibleMaterial({
    wiki: config.stores.wiki,
    contextSnapshotId: config.scope.contextSnapshotId,
    localizationSnapshotId: config.scope.localizationSnapshotId,
    targetLocale: config.targetLocale,
  });
  const runtime = createDispatchRuntime({
    ...config.dispatch,
    memoStore: config.stores.memoStore,
    contentAccess: config.stores.contentAccess,
    snapshots: config.dispatchSnapshots,
  });
  const acceptedTargets = await config.stores.acceptedTargets.listFinalUnits({
    localizationSnapshotId: config.scope.localizationSnapshotId,
  });
  const roles = bindRoleSeams(config.roles, {
    facts,
    bible: installedBible.bible,
    bibleEntries: installedBible.entries,
    acceptedTargets,
    targetLocale: config.targetLocale,
    scope: config.scope,
    runtime,
  });
  const bibleRenderingIds = (unitId: string): readonly string[] =>
    resolveUnitBibleGroundTruth(facts.orderedFact(unitId), facts.snapshot, installedBible.bible)
      .bibleRenderingIds;
  // The extract/patch adapter that produced this bridge selects the target
  // policy (codec, layout, control grammar, evidence channels) via the registry.
  const policy = resolveTargetPolicyForAdapter(config.bridge.extractor.name);
  const side: GateSideInputs = {
    ...config.gateSideInputs,
    glossary: installedBible.bible.canonicalForms,
    policy,
  };
  const capturedFinalizer = createCapturedDraftFinalizer(
    config.scope,
    config.bridge,
    snapshot,
    config.targetLocale,
  );
  const finalizeArtifact = config.finalizeArtifact ?? capturedFinalizer.resolve;
  const draft = createDraftDeps({
    facts,
    config: config.scope,
    budget: config.draftBudget,
    runtime,
  });

  return {
    readiness: createReadinessDeps({ facts, bible: installedBible.bible }),
    draft: {
      ...draft,
      recordFinalizationData: capturedFinalizer.record,
    },
    gates: createGateDeps({ facts, side }),
    review: roles.review,
    repair: createRepairDeps({
      facts,
      config: config.scope,
      editRuntime: runtime,
      repairRuntime: runtime,
      policy,
    }),
    adjudicate: createAdjudicateDeps({
      config: config.scope,
      resolveEvidence: roles.adjudicate.resolveEvidence,
      resolveBibleRenderingIds: bibleRenderingIds,
      buildRefs: roles.adjudicate.buildRefs,
      dispatch:
        roles.adjudicate.dispatch ?? createCertifiedDispatch(runtime, roles.adjudicate.readPayload),
    }),
    patchback: roles.patchback ?? capturedFinalizer.patchback,
    store: createLiveWorkflowArtifactStore({
      accepted: config.stores.accepted,
      snapshotId: config.scope.localizationSnapshotId,
      resolveFinalizeArtifact: finalizeArtifact,
      ...(config.stepCache === undefined ? {} : { stepCache: config.stepCache }),
      ...(config.maxStepAttempts === undefined ? {} : { maxStepAttempts: config.maxStepAttempts }),
    }),
  };
}

function bindRoleSeams(
  roles: LiveWorkflowRoleSeams,
  input: LiveWorkflowRoleBindingInput,
): BoundLiveWorkflowRoleSeams {
  return "bind" in roles ? roles.bind(input) : roles;
}

/** Adapt a long-lived service substrate into the `localizationSubstrate` port
 * used by the thin localize command/route. Decode artifacts and the policy
 * posture belong to one invocation, so they are bound only when that invocation
 * asks for its ports; the driver remains the policy authority before any call. */
export function createLiveLocalizationSubstrate(
  config: Omit<LiveWorkflowFactoryConfig, "structureJson" | "bridge">,
): {
  resolvePortSource(
    request: RunPolicyRequest,
    perRun: LocalizationPerRunInput,
  ): Promise<{ readonly deps: WorkflowPortDeps }>;
} {
  return {
    async resolvePortSource(request, perRun) {
      return {
        deps: await createLiveWorkflowPortDeps({
          ...config,
          ...perRun,
          scope: {
            ...config.scope,
            runMode: request.runMode,
            contextScope: request.contextScope as RunScopeConfig["contextScope"],
          },
        }),
      };
    },
  };
}

/** Production convenience wrapper. It is the one place a host turns the field
 * cipher, Postgres memo/CAS repositories, and permission-gated content reads
 * into the store surface above. */
export async function createProductionLiveWorkflowPortDeps(
  config: Omit<LiveWorkflowFactoryConfig, "stores"> & {
    readonly database: ItotoriDatabase;
    readonly actor: AuthorizationActor;
    readonly pool: ConstructorParameters<typeof ItotoriLlmWikiRepository>[0];
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<WorkflowPortDeps> {
  const cipher = createFieldMemoCipher(config.env);
  const contentAccess = permissionBasedLlmContentRead(config.database, config.actor);
  return createLiveWorkflowPortDeps({
    ...config,
    stores: {
      memoStore: new ItotoriLlmCallMemoRepository(config.pool, cipher, contentAccess),
      contentAccess,
      accepted: new ItotoriLlmAcceptedOutputRepository(config.pool, cipher),
      acceptedTargets: createAcceptedTargetHistoryReader({
        pool: config.pool,
        cipher,
        contentAccess,
      }),
      wiki: new ItotoriLlmWikiRepository(config.pool, cipher),
    },
  });
}

/** Bind the Postgres-backed stores once for a service lifetime, while leaving
 * the structure and bridge to the invocation that actually owns them. */
export function createProductionLiveLocalizationSubstrate(
  config: Omit<LiveWorkflowFactoryConfig, "structureJson" | "bridge" | "stores"> & {
    readonly database: ItotoriDatabase;
    readonly actor: AuthorizationActor;
    readonly pool: ConstructorParameters<typeof ItotoriLlmWikiRepository>[0];
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): ReturnType<typeof createLiveLocalizationSubstrate> {
  const cipher = createFieldMemoCipher(config.env);
  const contentAccess = permissionBasedLlmContentRead(config.database, config.actor);
  const { database: _database, actor: _actor, pool: _pool, env: _env, ...liveConfig } = config;
  return createLiveLocalizationSubstrate({
    ...liveConfig,
    stores: {
      memoStore: new ItotoriLlmCallMemoRepository(config.pool, cipher, contentAccess),
      contentAccess,
      accepted: new ItotoriLlmAcceptedOutputRepository(config.pool, cipher),
      acceptedTargets: createAcceptedTargetHistoryReader({
        pool: config.pool,
        cipher,
        contentAccess,
      }),
      wiki: new ItotoriLlmWikiRepository(config.pool, cipher),
    },
  });
}

function parseSourceObject(
  row: LlmWikiObjectRecord,
): Exclude<WikiObject, { readonly kind: "translation" }> {
  const source = WikiObjectSchema.parse(JSON.parse(row.objectJson));
  if (source.kind === "translation") {
    throw new LiveWorkflowFactoryError(`source row ${row.objectId} is a translation object`);
  }
  return source;
}

// Key by BOTH the provenance factId (`unit:<id>`) and the bare bridgeUnitId, for
// the same reason `decodeFactSourceFrom` keys its ordered-fact map both ways: the
// draft sequence (projectDecodeStructure scene.units) queries by the BARE unit
// id, so keying by factId alone misses every lookup the drafter actually makes.
export function bridgeUnitsByUnitKey(
  orderedUnits: readonly { readonly factId: string; readonly bridgeUnitId: string }[],
  bridge: BridgeBundleV02,
): ReadonlyMap<string, LocalizationUnitV02> {
  const byBridgeId = new Map(bridge.units.map((unit) => [unit.bridgeUnitId, unit]));
  const byUnitKey = new Map<string, LocalizationUnitV02>();
  for (const unit of orderedUnits) {
    const bridgeUnit = byBridgeId.get(unit.bridgeUnitId);
    if (bridgeUnit === undefined) {
      const detail = `fact ${unit.factId} has no bridge unit ${unit.bridgeUnitId}`;
      throw new LiveWorkflowFactoryError(detail);
    }
    byUnitKey.set(unit.factId, bridgeUnit);
    byUnitKey.set(unit.bridgeUnitId, bridgeUnit);
  }
  return byUnitKey;
}
