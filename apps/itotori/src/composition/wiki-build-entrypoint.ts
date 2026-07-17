// Production source-Wiki build composition.
//
// This is the one place that joins the deterministic source-Wiki executor to
// the bespoke A1–A10 roles, the integrity-checked read model, the repository
// ledger, and the sole ZDR dispatch runtime. The CLI only calls `runWikiBuild`;
// it never reaches into source-wiki or an analyst role directly.

import type {
  ItotoriLlmWikiRepository,
  LlmContentReadAuthorizer,
  LlmContextSnapshot,
  LlmCallMemoStore,
} from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import {
  WikiObjectSchema,
  type ContextScopeValue,
  type RoleId,
  type RunModeValue,
  type WikiObject,
} from "../contracts/index.js";
import { dispatch, type DispatchRuntime } from "../llm/dispatch.js";
import { sha256 } from "../llm/canonical-json.js";
import { resolveRoleModelProfile } from "../llm/role-model-profiles.js";
import { buildFactSnapshot } from "../prepass/index.js";
import { buildReadModel, type ReadModel } from "../read-tools/index.js";
import {
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  parseNarrativeStructure,
} from "../structure/index.js";
import {
  createDispatchRuntime,
  type LiveDispatchRuntimeConfig,
  type RunSnapshotRevisions,
} from "./live/dispatch-runtime.js";
import {
  createRepositoryArtifactLedger,
  orchestrateSourceWiki,
  type AnalystRunner,
  type OrchestrateSourceWikiDeps,
  type RunStepInput,
  type SourceWikiRunReport,
} from "../source-wiki/index.js";
import { dispatchStyleLeadModel, runStyleLead, type StylePromptStore } from "../roles/a1/index.js";
import {
  ambiguousTermCandidates,
  dispatchTermAnalystModel,
  runTermAnalyst,
  type TermPromptStore,
} from "../roles/a2/index.js";
import {
  assembleSceneSummary,
  assembleStorySoFar,
  dispatchingA3Caller,
  readCompleteScene,
  type StorySoFarState,
} from "../roles/a3/index.js";
import { dispatchingA4Caller, reconcileRoute } from "../roles/a4/index.js";
import {
  assembleVoiceProfile,
  characterIndex as a5CharacterIndex,
  characterRouteIds,
  counterpartIds as a5CounterpartIds,
  dispatchingA5Caller,
  occurrenceWindow,
  readCharacterVoiceEvidence,
} from "../roles/a5/index.js";
import {
  dispatchingAdaptationModel,
  flaggedAdaptationCandidates,
  runAdaptationNote,
  type AdaptationPromptStore,
} from "../roles/a6/index.js";
import {
  assembleCharacterBio,
  buildCharacterPortrait,
  characterIndex as a7CharacterIndex,
  dispatchingA7Caller,
  readCharacterEvidence as readA7CharacterEvidence,
  type A7PortraitSource,
} from "../roles/a7/index.js";
import {
  assembleCharacterBackground,
  characterIndex as a8CharacterIndex,
  counterpartIds as a8CounterpartIds,
  dispatchingA8Caller,
  readCharacterEvidence as readA8CharacterEvidence,
} from "../roles/a8/index.js";
import {
  assembleCharacterRouteArc,
  characterIndex as a9CharacterIndex,
  dispatchingA9Caller,
  readCharacterRouteEvidence,
  routeOccurrenceWindow,
} from "../roles/a9/index.js";
import {
  assembleSpeakerHypothesis,
  dispatchingA10Caller,
  hindsightCandidateIds,
  hindsightRevealSceneIds,
  readUnknownSpeakerUnits,
  verifyCandidateCharacter,
  verifyRevealScene,
} from "../roles/a10/index.js";

/** Source supplied by the external render/patch-report substrate. Portrait
 * media is not present in a bridge or fact snapshot, so it is explicit input to
 * this build rather than a guessed hash/URI/dimension. */
export type WikiBuildPortraitSources = ReadonlyMap<string, A7PortraitSource>;

/** Invocation data the CLI owns. The service factory supplies the durable DB,
 * authorization, snapshot, and dispatch substrate separately. */
export interface WikiBuildInvocation {
  readonly structureJson: unknown;
  readonly bridge: BridgeBundleV02;
  readonly sourceLanguage: string;
  readonly runMode: RunModeValue;
  readonly concurrency: number;
  readonly roles?: readonly RoleId[];
  readonly portraitSources?: WikiBuildPortraitSources;
}

/** The production dependencies for one source-Wiki build. The service factory
 * owns authentication/repositories; the command owns the invocation's decode
 * artifacts and run selection. */
export interface WikiBuildDeps {
  readonly structureJson: WikiBuildInvocation["structureJson"];
  readonly bridge: WikiBuildInvocation["bridge"];
  readonly contextSnapshot: LlmContextSnapshot;
  readonly sourceLanguage: WikiBuildInvocation["sourceLanguage"];
  readonly runMode: WikiBuildInvocation["runMode"];
  readonly concurrency: WikiBuildInvocation["concurrency"];
  readonly roles?: readonly RoleId[];
  readonly maxAttempts?: number;
  readonly repository: ItotoriLlmWikiRepository;
  readonly memoStore: LlmCallMemoStore;
  readonly contentAccess: LlmContentReadAuthorizer;
  readonly dispatch: Omit<LiveDispatchRuntimeConfig, "memoStore" | "contentAccess" | "snapshots">;
  readonly dispatchSnapshots: RunSnapshotRevisions;
  readonly operatorBrief?: string;
  readonly portraitSources?: WikiBuildPortraitSources;
}

/** Build and execute the full source-language A1–A10 analyst wave. The fact
 * snapshot and read model are rebuilt from the invocation artifacts, then bound
 * to the persisted context snapshot before any model call can occur. */
export async function runWikiBuild(deps: WikiBuildDeps): Promise<SourceWikiRunReport> {
  const structure = parseNarrativeStructure(
    deps.structureJson,
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
  const snapshot = buildFactSnapshot(structure, deps.bridge);
  const model = buildReadModel({
    contextSnapshot: deps.contextSnapshot,
    factSnapshot: snapshot,
    bundle: deps.bridge,
  });
  if (model.sourceLanguage !== deps.sourceLanguage) {
    throw new Error(
      `wiki build source locale ${deps.sourceLanguage} does not match context snapshot ${model.sourceLanguage}`,
    );
  }
  const payloads = new Map<string, string>();
  const runner = createAnalystRunner({
    model,
    runtimeForRole: (role) => createAnalystDispatchRuntime({ deps, payloads, role }),
    payloads,
    repository: deps.repository,
    operatorBrief: deps.operatorBrief ?? "No additional operator brief was supplied.",
    portraitSources: deps.portraitSources ?? new Map(),
  });
  const orchestratorDeps: OrchestrateSourceWikiDeps = {
    snapshot,
    readModel: model,
    sourceLanguage: deps.sourceLanguage,
    runMode: deps.runMode,
    ...(deps.roles === undefined ? {} : { roles: deps.roles }),
    concurrency: deps.concurrency,
    ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }),
    runner,
    ledger: createRepositoryArtifactLedger({
      repository: deps.repository,
      snapshotId: deps.contextSnapshot.snapshotId,
    }),
    portraitCharacterIds: [...(deps.portraitSources?.keys() ?? [])],
  };
  return await orchestrateSourceWiki(orchestratorDeps);
}

interface AnalystRunnerDeps {
  readonly model: ReadModel;
  /** A role gets its own measured profile; the durable dispatch substrate stays shared. */
  readonly runtimeForRole: (role: RoleId) => DispatchRuntime;
  readonly payloads: Map<string, string>;
  readonly repository: ItotoriLlmWikiRepository;
  readonly operatorBrief: string;
  readonly portraitSources: WikiBuildPortraitSources;
}

type AnalystRoleDeps = Omit<AnalystRunnerDeps, "runtimeForRole"> & {
  readonly runtime: DispatchRuntime;
};

/**
 * Construct the dispatch runtime for one analyst role. The localization factory
 * supplies the shared ZDR routing, durable memo, content authorization,
 * snapshots, and spend cap, but P1's measured profile must never be reused for
 * an A-role CallSpec. Keep the deadline posture in lockstep with
 * `productionLocalizeDispatchConfig`: only the certified role profile identity
 * changes here.
 */
export function createAnalystDispatchRuntime(input: {
  readonly deps: Pick<
    WikiBuildDeps,
    "dispatch" | "memoStore" | "contentAccess" | "dispatchSnapshots"
  >;
  readonly payloads: ReadonlyMap<string, string>;
  readonly role: RoleId;
}): DispatchRuntime {
  const roleProfile = resolveRoleModelProfile(input.role);
  const base = createDispatchRuntime({
    ...input.deps.dispatch,
    profile: {
      name: roleProfile.modelProfile,
      version: roleProfile.version,
      deadlines: { normalMs: 30_000, deepMs: 90_000 },
      maxAttemptExposureUsd: input.deps.dispatch.profile.maxAttemptExposureUsd,
    },
    memoStore: input.deps.memoStore,
    contentAccess: input.deps.contentAccess,
    snapshots: input.deps.dispatchSnapshots,
  });
  return {
    ...base,
    readPayload: async (reference) => {
      const payload = input.payloads.get(reference.storageRef);
      if (payload === undefined) {
        throw new Error(`source-Wiki dispatch has no payload for ${reference.storageRef}`);
      }
      return payload;
    },
  };
}

/** Stamp the SYSTEM-owned provenance fields on each source-wiki object with the
 * authoritative run context. The analyst model authors the object CONTENT; the
 * audit-trail identifiers (which snapshot, which scope, which run mode, which
 * role) are deterministic system facts the model must NOT own — it cannot echo
 * the 64-char snapshot hash (it emits zeros) and has authored a wrong runMode.
 * Analyst outputs are always source objects (snapshotKind "context"). */
export function stampSourceProvenance(
  objects: readonly WikiObject[],
  authority: {
    readonly contextSnapshotId: `sha256:${string}`;
    readonly contextScope: ContextScopeValue;
    readonly runMode: RunModeValue;
    readonly authorRoleId: RoleId;
  },
): readonly WikiObject[] {
  return objects.map((object) => {
    // Analyst outputs are always SOURCE objects; a translation object here would
    // be a contract violation, so leave it untouched rather than stamp it.
    if (object.kind === "translation") return object;
    return {
      ...object,
      provenance: {
        ...object.provenance,
        contextSnapshotId: authority.contextSnapshotId,
        contextScope: authority.contextScope,
        runMode: authority.runMode,
        authorRoleId: authority.authorRoleId,
      },
    };
  });
}

/** Build the real exhaustive role dispatcher. Each branch enters that role's
 * certified dispatch helper, then lets the role's own fold/assembly code
 * re-derive citations and structural facts before the orchestrator accepts it. */
export function createAnalystRunner(deps: AnalystRunnerDeps): AnalystRunner {
  const returned = new Map<string, WikiObject>();
  const runtimes = new Map<RoleId, DispatchRuntime>();
  let persisted: readonly WikiObject[] | undefined;
  const runtimeForRole = (role: RoleId): DispatchRuntime => {
    const existing = runtimes.get(role);
    if (existing !== undefined) return existing;
    const runtime = deps.runtimeForRole(role);
    runtimes.set(role, runtime);
    return runtime;
  };
  const remember = (objects: readonly WikiObject[]): readonly WikiObject[] => {
    for (const object of objects) returned.set(object.objectId, object);
    return objects;
  };
  const sourceObjects = async (): Promise<readonly WikiObject[]> => {
    if (persisted === undefined) {
      const records = await deps.repository.listObjects({
        snapshotId: deps.model.snapshotId,
        wikiKind: "source-object",
      });
      persisted = records.map((record) => WikiObjectSchema.parse(JSON.parse(record.objectJson)));
    }
    return [...persisted, ...returned.values()];
  };
  const findObject = async (objectId: string, kind: WikiObject["kind"]): Promise<WikiObject> => {
    const object = (await sourceObjects()).find(
      (candidate) => candidate.objectId === objectId && candidate.kind === kind,
    );
    if (object === undefined) {
      throw new Error(`source-Wiki role dependency ${kind}:${objectId} is not installed`);
    }
    return object;
  };

  const dispatchRole = async (
    input: RunStepInput,
    roleDeps: AnalystRoleDeps,
  ): Promise<readonly WikiObject[]> => {
    switch (input.role) {
      case "A1":
        return runA1(input, roleDeps);
      case "A2":
        return runA2(input, roleDeps);
      case "A3":
        return runA3(input, roleDeps);
      case "A4":
        return runA4(input, roleDeps, findObject);
      case "A5":
        return runA5(input, roleDeps);
      case "A6":
        return runA6(input, roleDeps);
      case "A7":
        return runA7(input, roleDeps);
      case "A8":
        return runA8(input, roleDeps, findObject);
      case "A9":
        return runA9(input, roleDeps);
      case "A10":
        return runA10(input, roleDeps);
      default:
        return assertUnhandledRole(input.role);
    }
  };
  return async (input) => {
    const roleDeps: AnalystRoleDeps = { ...deps, runtime: runtimeForRole(input.role) };
    const produced = await dispatchRole(input, roleDeps);
    // Provenance is a SYSTEM audit fact, not a model judgment: the analyst model
    // cannot reliably echo the 64-char snapshot hash (it emits zeros) and has been
    // observed to author a wrong runMode. Stamp the system-owned provenance fields
    // authoritatively from the run context before the object is accepted/persisted.
    return remember(
      stampSourceProvenance(produced, {
        contextSnapshotId: deps.model.snapshotId,
        contextScope: input.contextScope,
        runMode: input.runMode,
        authorRoleId: input.role,
      }),
    );
  };
}

function assertUnhandledRole(role: RoleId): never {
  throw new Error(`source-Wiki runner has no dispatch mapping for ${String(role)}`);
}

function wholeGameContext(input: RunStepInput) {
  return {
    runMode: input.runMode,
    contextScope: input.contextScope,
    routeVisibility: { kind: "global" as const },
    localeBranchId: null,
  };
}

function requiredSubject(
  input: RunStepInput,
  kind: "game" | "glossary-term" | "scene" | "route" | "character" | "unit",
): string {
  if (input.step.subject.kind !== kind) {
    throw new Error(
      `source-Wiki ${input.role} step ${input.step.stepId} expected ${kind}, got ${input.step.subject.kind}`,
    );
  }
  return input.step.subject.id;
}

function promptStore(
  deps: AnalystRoleDeps,
  input: RunStepInput,
  role: string,
): StylePromptStore & TermPromptStore & AdaptationPromptStore {
  return async (text, channel) => {
    const storageRef = `source-wiki:${role}:${input.step.stepId}:${channel}`;
    deps.payloads.set(storageRef, text);
    return { storageRef, contentHash: sha256(text), encryption: "operator-managed" };
  };
}

async function runA1(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  requiredSubject(input, "game");
  // Take the first dispatched scenes that actually CARRY citeable units — a game's
  // early dispatch order is often unit-less title/menu/system scenes, which would
  // leave A1 with nothing to cite (and no label to resolve).
  const slice = deps.model.factSnapshot.routeTopology.sceneDispatchOrder
    .map((sceneId) => ({
      sceneId: String(sceneId),
      units: deps.model.factSnapshot.orderedUnits
        .filter((unit) => unit.sceneId === sceneId)
        .map((unit) => ({
          factId: unit.factId,
          text: deps.model.bundleUnits.get(unit.bridgeUnitId)?.sourceText ?? "",
        }))
        .filter((unit) => unit.text.length > 0),
    }))
    .filter((scene) => scene.units.length > 0)
    .slice(0, 3);
  const result = await runStyleLead(
    {
      contextSnapshotId: deps.model.snapshotId,
      sourceLanguage: input.sourceLanguage,
      runMode: input.runMode,
      operatorBrief: deps.operatorBrief,
      slice,
      parentEventId: sha256({ snapshotId: deps.model.snapshotId, role: "A1" }),
    },
    {
      model: dispatchStyleLeadModel(dispatch, deps.runtime),
      storePrompt: promptStore(deps, input, "A1"),
      validationModel: deps.model,
    },
  );
  return [result.styleContract];
}

async function runA2(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const termKey = requiredSubject(input, "glossary-term");
  const candidate = ambiguousTermCandidates(deps.model.factSnapshot).find(
    (entry) => entry.termKey === termKey,
  );
  if (candidate === undefined) throw new Error(`A2 term ${termKey} is not an ambiguous candidate`);
  const result = await runTermAnalyst(
    {
      contextSnapshotId: deps.model.snapshotId,
      sourceLanguage: input.sourceLanguage,
      runMode: input.runMode,
      candidate,
      operatorBrief: deps.operatorBrief,
      parentEventId: sha256({ snapshotId: deps.model.snapshotId, role: "A2", termKey }),
    },
    {
      model: dispatchTermAnalystModel(dispatch, deps.runtime),
      storePrompt: promptStore(deps, input, "A2"),
      validationModel: deps.model,
    },
  );
  return [result.termRuling];
}

async function runA3(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const sceneId = Number(requiredSubject(input, "scene"));
  if (!Number.isSafeInteger(sceneId))
    throw new Error(`A3 scene id is not an integer: ${input.step.subject.id}`);
  const context = wholeGameContext(input);
  const scene = readCompleteScene(deps.model, context, sceneId);
  const priorObject = input.priorObjects.find((object) => object.kind === "story-so-far");
  const prior: StorySoFarState | null =
    priorObject?.kind === "story-so-far"
      ? {
          throughSceneId: Number(priorObject.body.throughSceneId),
          summary: priorObject.body.summary,
          openThreads: priorObject.body.openThreads,
        }
      : null;
  const narrative = await dispatchingA3Caller(
    deps.model,
    context,
    deps.runtime,
  )({
    scene,
    priorStory: prior,
    sourceLanguage: input.sourceLanguage,
  });
  return [
    assembleSceneSummary(deps.model, context, scene, narrative),
    assembleStorySoFar(deps.model, context, scene, input.step.scope, narrative, prior),
  ];
}

async function runA4(
  input: RunStepInput,
  deps: AnalystRoleDeps,
  findObject: (objectId: string, kind: WikiObject["kind"]) => Promise<WikiObject>,
): Promise<readonly WikiObject[]> {
  requiredSubject(input, "route");
  const lastScene = deps.model.factSnapshot.routeTopology.sceneDispatchOrder.at(-1);
  if (lastScene === undefined)
    throw new Error("A4 cannot adopt a spine from an empty dispatch order");
  const finalStorySoFar = await findObject(`story-so-far:${lastScene}`, "story-so-far");
  const result = await reconcileRoute(
    deps.model,
    wholeGameContext(input),
    { finalStorySoFar, coveredSceneIds: deps.model.factSnapshot.routeTopology.sceneDispatchOrder },
    dispatchingA4Caller(deps.model, wholeGameContext(input), deps.runtime),
  );
  return [result.routeArc];
}

async function runA5(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const characterId = requiredSubject(input, "character");
  const character = a5CharacterIndex(deps.model).find((entry) => entry.characterId === characterId);
  if (character === undefined)
    throw new Error(`A5 character ${characterId} is absent from the index`);
  const context = wholeGameContext(input);
  const evidence = readCharacterVoiceEvidence(deps.model, context, character);
  const window = occurrenceWindow(deps.model, evidence.sceneIds);
  const draft = await dispatchingA5Caller(
    deps.model,
    context,
    deps.runtime,
  )({
    evidence,
    counterpartIds: a5CounterpartIds(deps.model),
    routeIds: characterRouteIds(deps.model, window),
    occurrenceUnitIds: window.map((unit) => unit.factId),
    sourceLanguage: input.sourceLanguage,
  });
  return [assembleVoiceProfile(deps.model, context, evidence, a5CounterpartIds(deps.model), draft)];
}

async function runA6(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const unitId = requiredSubject(input, "unit");
  const candidate = flaggedAdaptationCandidates(deps.model).find(
    (entry) => entry.unitFactId === unitId,
  );
  if (candidate === undefined) throw new Error(`A6 unit ${unitId} is not pre-pass flagged`);
  const result = await runAdaptationNote(
    {
      contextSnapshotId: deps.model.snapshotId,
      sourceLanguage: input.sourceLanguage,
      operatorBrief: deps.operatorBrief,
      runMode: input.runMode,
      contextScope: input.contextScope,
    },
    candidate,
    {
      model: dispatchingAdaptationModel(deps.runtime),
      storePrompt: promptStore(deps, input, "A6"),
      readModel: deps.model,
    },
  );
  return [result.note];
}

async function runA7(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const characterId = requiredSubject(input, "character");
  const portraitSource = deps.portraitSources.get(characterId);
  if (portraitSource === undefined) throw new Error(`A7 has no portrait source for ${characterId}`);
  const character = a7CharacterIndex(deps.model).find((entry) => entry.characterId === characterId);
  if (character === undefined)
    throw new Error(`A7 character ${characterId} is absent from the index`);
  const context = wholeGameContext(input);
  const evidence = readA7CharacterEvidence(deps.model, context, character);
  const draft = await dispatchingA7Caller(
    deps.model,
    context,
    deps.runtime,
  )({
    character: evidence,
    sourceLanguage: input.sourceLanguage,
    webEnabled: false,
  });
  return [
    assembleCharacterBio(
      deps.model,
      context,
      evidence,
      draft,
      buildCharacterPortrait(characterId, portraitSource),
    ),
  ];
}

async function runA8(
  input: RunStepInput,
  deps: AnalystRoleDeps,
  findObject: (objectId: string, kind: WikiObject["kind"]) => Promise<WikiObject>,
): Promise<readonly WikiObject[]> {
  const characterId = requiredSubject(input, "character");
  const character = a8CharacterIndex(deps.model).find((entry) => entry.characterId === characterId);
  if (character === undefined)
    throw new Error(`A8 character ${characterId} is absent from the index`);
  const context = wholeGameContext(input);
  const evidence = readA8CharacterEvidence(deps.model, context, character);
  const bio = await findObject(`character-bio:${characterId}`, "character-bio");
  const request = {
    character: evidence,
    bio,
    counterpartIds: a8CounterpartIds(deps.model),
    sourceLanguage: input.sourceLanguage,
  };
  const draft = await dispatchingA8Caller(deps.model, context, deps.runtime)(request);
  return [assembleCharacterBackground(deps.model, context, evidence, request, draft)];
}

async function runA9(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const characterId = requiredSubject(input, "character");
  if (input.step.scope.kind !== "route")
    throw new Error(`A9 ${characterId} has no concrete route scope`);
  const character = a9CharacterIndex(deps.model).find((entry) => entry.characterId === characterId);
  if (character === undefined)
    throw new Error(`A9 character ${characterId} is absent from the index`);
  const context = wholeGameContext(input);
  const evidence = readCharacterRouteEvidence(
    deps.model,
    context,
    character,
    input.step.scope.routeId,
  );
  const windowUnitIds = routeOccurrenceWindow(deps.model, evidence.sceneIds, evidence.routeId).map(
    (unit) => unit.factId,
  );
  const draft = await dispatchingA9Caller(
    deps.model,
    context,
    deps.runtime,
  )({
    evidence,
    windowUnitIds,
    sourceLanguage: input.sourceLanguage,
  });
  return [assembleCharacterRouteArc(deps.model, context, character, evidence, draft)];
}

async function runA10(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const unitId = requiredSubject(input, "unit");
  const context = wholeGameContext(input);
  const unit = readUnknownSpeakerUnits(deps.model, context).find(
    (entry) => entry.unitId === unitId,
  );
  if (unit === undefined)
    throw new Error(`A10 unit ${unitId} is not genuinely unknown-speaker evidence`);
  const draft = await dispatchingA10Caller(
    deps.model,
    context,
    deps.runtime,
  )({
    unit,
    sourceLanguage: input.sourceLanguage,
    candidateCharacterIds: hindsightCandidateIds(deps.model),
    revealSceneIds: hindsightRevealSceneIds(deps.model, context),
  });
  return [
    assembleSpeakerHypothesis(
      deps.model,
      context,
      unit,
      draft,
      verifyCandidateCharacter(deps.model, context, draft.candidateCharacterId),
      verifyRevealScene(deps.model, context, draft.revealSceneId),
    ),
  ];
}

/** Exported for a cheap exhaustive-mapping proof without invoking ZDR/DB. */
export const ANALYST_RUNNER_ROLE_IDS: readonly RoleId[] = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
];

export function assertAnalystRunnerCoverage(roles: readonly RoleId[]): void {
  const handled = new Set(ANALYST_RUNNER_ROLE_IDS);
  for (const role of roles) {
    if (!handled.has(role))
      throw new Error(`source-Wiki runner has no dispatch mapping for ${role}`);
  }
}
