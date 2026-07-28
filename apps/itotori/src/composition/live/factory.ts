// The live localization factory — source the concrete workflow substrate for a
// single, already-admitted run. It deliberately builds no bible: missing source
// objects or renderings remain absent from the installed bible, so readiness
// reports the blocking requirement instead of inventing a fallback.

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  type AcceptedOutput,
  type WikiObject,
} from "../../contracts/index.js";
import type { AdjudicateDeps, PatchbackDeps, ReviewDeps, WorkflowPortDeps } from "../deps.js";
import { resolveTargetPolicyForAdapter } from "../../gates/index.js";
import { buildFactSnapshot } from "../../prepass/index.js";
import {
  buildInstalledBible,
  resolveUnitBibleGroundTruth,
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
import type { FinalizedUnit } from "../../workflow/index.js";
import type { NativePatchbackInput } from "../../patchback/index.js";

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
  /** The default patchback is a concrete accepted-output → PatchExportV02
   * binder. Hosts may replace it only when they own a stricter artifact sink. */
  readonly patchback?: PatchbackDeps;
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
  };
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
    bridgeUnitsByUnitKey(snapshot.orderedUnits, config.bridge),
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
  // The extract/patch adapter that produced this bridge selects the target
  // policy (codec, layout, control grammar, evidence channels) via the registry.
  const policy = resolveTargetPolicyForAdapter(config.bridge.extractor.name);
  const side: GateSideInputs = {
    ...config.gateSideInputs,
    glossary: bible.canonicalForms,
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
    readiness: createReadinessDeps({ facts, bible }),
    draft: {
      ...draft,
      recordFinalizationData: capturedFinalizer.record,
    },
    gates: createGateDeps({ facts, side }),
    review: config.roles.review,
    repair: createRepairDeps({
      facts,
      config: config.scope,
      editRuntime: runtime,
      repairRuntime: runtime,
      policy,
    }),
    adjudicate: createAdjudicateDeps({
      config: config.scope,
      resolveEvidence: config.roles.adjudicate.resolveEvidence,
      resolveBibleRenderingIds: bibleRenderingIds,
      buildRefs: config.roles.adjudicate.buildRefs,
      dispatch: createCertifiedDispatch(runtime, config.roles.adjudicate.readPayload),
    }),
    patchback: config.roles.patchback ?? capturedFinalizer.patchback,
    store: createLiveWorkflowArtifactStore({
      accepted: config.stores.accepted,
      snapshotId: config.scope.localizationSnapshotId,
      resolveFinalizeArtifact: finalizeArtifact,
      ...(config.stepCache === undefined ? {} : { stepCache: config.stepCache }),
      ...(config.maxStepAttempts === undefined ? {} : { maxStepAttempts: config.maxStepAttempts }),
    }),
  };
}

/**
 * P1 owns draft validation; the CAS finalizer owns sealing that validated draft
 * as the accepted unit output. Keeping the short-lived receipt index inside the
 * per-run factory gives the finalizer the actual target text and verified model
 * memo keys instead of attempting to reconstruct either from a content hash.
 */
function createCapturedDraftFinalizer(
  scope: RunScopeConfig,
  rawBridge: BridgeBundleV02,
  snapshot: import("../../prepass/index.js").FactSnapshot,
  targetLocale: string,
): {
  readonly record: (localized: import("../../roles/p1/index.js").SceneLocalization) => void;
  readonly resolve: FinalizeArtifactResolver;
  readonly patchback: PatchbackDeps;
} {
  const byUnit = new Map<
    string,
    {
      readonly draft: import("../../contracts/index.js").Draft;
      readonly parentDraftBatchId: string;
      readonly memoKeys: readonly string[];
    }
  >();
  const acceptedByUnit = new Map<
    string,
    Extract<AcceptedOutput, { readonly subjectType: "unit" }>
  >();
  const record = (localized: import("../../roles/p1/index.js").SceneLocalization): void => {
    const memoKeys = localized.results.flatMap((result) =>
      result.status === "success" ? [result.memoKey] : [],
    );
    for (const draft of localized.finalizedDrafts) {
      const parent = localized.batches.find((batch) =>
        batch.drafts.some((candidate) => candidate.unitId === draft.unitId),
      );
      if (parent === undefined) {
        throw new LiveWorkflowFactoryError(`draft ${draft.unitId} has no parent P1 batch`);
      }
      byUnit.set(draft.unitId, { draft, parentDraftBatchId: parent.batchId, memoKeys });
    }
  };
  const resolve: FinalizeArtifactResolver = (input) => {
    const captured = byUnit.get(input.unitId);
    if (captured === undefined) {
      throw new LiveWorkflowFactoryError(
        `cannot finalize ${input.unitId}: no validated P1 draft was captured for this run`,
      );
    }
    if (captured.memoKeys.length === 0) {
      throw new LiveWorkflowFactoryError(
        `cannot finalize ${input.unitId}: P1 produced no verified physical memo receipt`,
      );
    }
    if (input.stage !== "final" && input.stage !== "build-lqa") {
      throw new LiveWorkflowFactoryError(
        `cannot finalize ${input.unitId}: stage ${input.stage} is not a final-stage output`,
      );
    }
    const version = (input.priorHead?.version ?? 0) + 1;
    const output = acceptedOutputForCapturedDraft({
      unitId: input.unitId,
      stage: input.stage,
      version,
      priorOutputId: input.priorHead?.outputId,
      draft: captured.draft,
      parentDraftBatchId: captured.parentDraftBatchId,
      memoKeys: captured.memoKeys,
      scope,
      shippable: input.shippable,
    });
    acceptedByUnit.set(input.unitId, output);
    return {
      outputId: output.outputId,
      semanticKey: sha256(`${input.unitId}:${input.stage}`),
      schemaVersion: output.schemaVersion,
      outputJson: JSON.stringify(output),
      memoKeys: output.memoKeys,
      sourceHash: output.sourceHash,
    };
  };
  const patchDirectory = mkdtempSync(join(tmpdir(), "itotori-native-patch-"));
  const patchback: PatchbackDeps = {
    buildInput(finalized: readonly FinalizedUnit[]): NativePatchbackInput {
      const accepted = finalized.map((unit) => {
        const output = acceptedByUnit.get(unit.unitId);
        if (output === undefined || output.stage !== "final") {
          throw new LiveWorkflowFactoryError(
            `cannot export patch: ${unit.unitId} has no captured final accepted output`,
          );
        }
        return output;
      });
      return {
        snapshot,
        accepted,
        rawBridge,
        workScope: {
          inScopeUnitFactIds: finalized.map((unit) => unit.unitId),
        },
        sourceLocale: rawBridge.sourceLocale,
        targetLocale,
      };
    },
    translatedBundlePath(finalized: readonly FinalizedUnit[]): string {
      const suffix = sha256(
        finalized
          .map((unit) => unit.unitId)
          .sort()
          .join(","),
      ).slice(7, 23);
      return join(patchDirectory, `translated-${suffix}.json`);
    },
    async buildLqa() {
      throw new LiveWorkflowFactoryError(
        "Build-LQA requires a patched-byte render/OCR adapter; no render evidence adapter is configured",
      );
    },
  };
  return { record, resolve, patchback };
}

function acceptedOutputForCapturedDraft(input: {
  readonly unitId: string;
  readonly stage: "final" | "build-lqa";
  readonly version: number;
  readonly priorOutputId: string | undefined;
  readonly draft: import("../../contracts/index.js").Draft;
  readonly parentDraftBatchId: string;
  readonly memoKeys: readonly string[];
  readonly scope: RunScopeConfig;
  readonly shippable: boolean;
}): Extract<AcceptedOutput, { readonly subjectType: "unit" }> {
  const releaseEligibility = input.shippable
    ? {
        kind: "shippable" as const,
        runMode: input.scope.runMode as "production" | "pilot",
        contextScope: input.scope.contextScope as "whole-game" | "external-augmented",
        basis: "wiki-first" as const,
      }
    : {
        kind: "artifact-only" as const,
        runMode: input.scope.runMode,
        contextScope: input.scope.contextScope,
        reason:
          input.draft.basis.kind === "pure-mtl-ablation"
            ? ("pure-mtl-ablation" as const)
            : input.scope.runMode === "test-dev"
              ? ("test-dev" as const)
              : ("not-final" as const),
      };
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: `accepted:${input.unitId}:${input.stage}:v${input.version}`,
    version: input.version,
    ...(input.priorOutputId === undefined ? {} : { supersedesOutputId: input.priorOutputId }),
    parentOutputIds: input.priorOutputId === undefined ? [] : [input.priorOutputId],
    memoKeys: [...new Set(input.memoKeys)],
    evidenceIds: [...input.draft.evidenceIds],
    acceptedAt: new Date().toISOString(),
    releaseEligibility,
    subjectType: "unit",
    subjectId: input.unitId,
    localizationSnapshotId: input.scope.localizationSnapshotId,
    stage: input.stage,
    sourceHash: input.draft.sourceHash,
    value: {
      targetSkeleton: input.draft.targetSkeleton,
      targetHash: sha256(input.draft.targetSkeleton),
      translationObjectId: `translation:${input.parentDraftBatchId}`,
      translationObjectVersion: 1,
      parentDraftBatchId: input.parentDraftBatchId,
      basis: input.draft.basis,
      // P1 validates protected spans before a draft reaches this boundary.
      gateReceipts: [
        {
          gate: "protected-spans",
          evidenceHash: sha256(input.draft.targetSkeleton),
          status: "PASS",
        },
      ],
      reviewVerdictIds: [],
    },
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
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
