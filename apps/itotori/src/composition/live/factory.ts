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
import { buildFactSnapshot } from "../../prepass/index.js";
import {
  buildInstalledBible,
  resolveUnitBibleGroundTruth,
} from "../../localized-wiki/ground-truth/index.js";
import {
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  parseNarrativeStructure,
} from "../../structure/index.js";
import type { RunPolicyRequest } from "../../run-policy/index.js";
import {
  createAdjudicateDeps,
  createDraftDeps,
  createGateDeps,
  createReadinessDeps,
  createRepairDeps,
  decodeFactSourceFrom,
  type DraftRealizationConfig,
  type GateSideInputs,
  type RunScopeConfig,
} from "./assemblers/index.js";
import {
  createCertifiedDispatch,
  createDispatchRuntime,
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

/** The durable wiki read surface required to install the target bible. */
export type InstalledBibleSource = Pick<ItotoriLlmWikiRepository, "listObjects">;

/** The already-built persistence and authorization substrate for an offline
 * proof or a host that owns its repositories. */
export interface LiveWorkflowStores {
  readonly memoStore: LlmCallMemoStore;
  readonly contentAccess: LlmContentReadAuthorizer;
  readonly accepted: AcceptedOutputCas;
  readonly wiki: InstalledBibleSource;
}

/** The unbuilt role and patch seams that are intentionally supplied by the
 * caller. The render/OCR-backed Build-LQA path remains a live-only source; this
 * factory carries it through as `patchback`, and never synthesizes a frame. */
export interface LiveWorkflowRoleSeams {
  readonly review: ReviewDeps;
  readonly patchback: PatchbackDeps;
  readonly adjudicate: {
    readonly buildRefs: AdjudicateDeps["buildRefs"];
    readonly readPayload: PayloadResolver;
    readonly resolveEvidence: (evidenceId: string) => string | null | undefined;
  };
}

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
  readonly finalizeArtifact: FinalizeArtifactResolver;
  readonly draftBudget: DraftRealizationConfig;
  readonly gateSideInputs?: Omit<GateSideInputs, "glossary">;
  readonly stepCache?: WorkflowStepCache;
  readonly maxStepAttempts?: number;
}

/** A malformed persisted bible relation is a factory fault. A merely missing
 * bible entry is not: it is represented by an incomplete installed bible and
 * blocks unit readiness through the normal workflow port. */
export class LiveWorkflowFactoryError extends Error {
  constructor(detail: string) {
    super(`live workflow factory refused: ${detail}`);
    this.name = "LiveWorkflowFactoryError";
  }
}

/** Build the installed target bible from the persisted source objects and target
 * renderings. Renderings for another locale are excluded; missing renderings
 * are deliberately not fabricated. */
export async function loadInstalledBible(input: {
  readonly wiki: InstalledBibleSource;
  readonly contextSnapshotId: string;
  readonly localizationSnapshotId: string;
  readonly targetLocale: string;
}) {
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
  const entries = renderingRows.flatMap((row) => {
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
  return buildInstalledBible(entries);
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
    bridgeUnitsByFactId(snapshot.orderedUnits, config.bridge),
  );
  const bible = await loadInstalledBible({
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
  const bibleRenderingIds = (unitId: string): readonly string[] =>
    resolveUnitBibleGroundTruth(facts.orderedFact(unitId), facts.snapshot, bible).bibleRenderingIds;
  const side: GateSideInputs = {
    ...config.gateSideInputs,
    glossary: bible.canonicalForms,
  };

  return {
    readiness: createReadinessDeps({ facts, bible }),
    draft: createDraftDeps({ facts, config: config.scope, budget: config.draftBudget, runtime }),
    gates: createGateDeps({ facts, side }),
    review: config.roles.review,
    repair: createRepairDeps({
      facts,
      config: config.scope,
      editRuntime: runtime,
      repairRuntime: runtime,
    }),
    adjudicate: createAdjudicateDeps({
      config: config.scope,
      resolveEvidence: config.roles.adjudicate.resolveEvidence,
      resolveBibleRenderingIds: bibleRenderingIds,
      buildRefs: config.roles.adjudicate.buildRefs,
      dispatch: createCertifiedDispatch(runtime, config.roles.adjudicate.readPayload),
    }),
    patchback: config.roles.patchback,
    store: createLiveWorkflowArtifactStore({
      accepted: config.stores.accepted,
      snapshotId: config.scope.localizationSnapshotId,
      resolveFinalizeArtifact: config.finalizeArtifact,
      ...(config.stepCache === undefined ? {} : { stepCache: config.stepCache }),
      ...(config.maxStepAttempts === undefined ? {} : { maxStepAttempts: config.maxStepAttempts }),
    }),
  };
}

/** Adapt a bound factory into the `localizationSubstrate` port used by the thin
 * localize command/route. The run-mode check prevents a production-bound
 * substrate from being reused for a different policy posture. */
export function createLiveLocalizationSubstrate(config: LiveWorkflowFactoryConfig): {
  resolvePortSource(request: RunPolicyRequest): Promise<{ readonly deps: WorkflowPortDeps }>;
} {
  return {
    async resolvePortSource(request) {
      if (request.runMode !== config.scope.runMode) {
        throw new LiveWorkflowFactoryError(
          `run mode ${request.runMode} does not match bound mode ${config.scope.runMode}`,
        );
      }
      return { deps: await createLiveWorkflowPortDeps(config) };
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

function bridgeUnitsByFactId(
  orderedUnits: readonly { readonly factId: string; readonly bridgeUnitId: string }[],
  bridge: BridgeBundleV02,
): ReadonlyMap<string, LocalizationUnitV02> {
  const byBridgeId = new Map(bridge.units.map((unit) => [unit.bridgeUnitId, unit]));
  const byFactId = new Map<string, LocalizationUnitV02>();
  for (const unit of orderedUnits) {
    const bridgeUnit = byBridgeId.get(unit.bridgeUnitId);
    if (bridgeUnit === undefined) {
      throw new LiveWorkflowFactoryError(
        `fact ${unit.factId} has no bridge unit ${unit.bridgeUnitId}`,
      );
    }
    byFactId.set(unit.factId, bridgeUnit);
  }
  return byFactId;
}
