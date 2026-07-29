import type { DispatchRuntime } from "../llm/dispatch.js";
import { dispatch } from "../llm/dispatch.js";
import { sha256 } from "../llm/canonical-json.js";
import type { RoleId, WikiObject } from "../contracts/index.js";
import type { ReadModel } from "../read-tools/index.js";
import { deriveWorkSource, type RunStepInput } from "../source-wiki/index.js";
import {
  dispatchStyleLeadModel,
  readRepresentativeStyleSlice,
  runStyleLead,
  type StylePromptStore,
} from "../roles/a1/index.js";
import {
  ambiguousTermCandidates,
  dispatchingTermAnalystModel,
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
  verifyA8CharacterBackground,
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
import type { WikiBuildPortraitSources } from "./wiki-build-entrypoint.js";

interface AnalystRoleDeps {
  readonly model: ReadModel;
  readonly runtime: DispatchRuntime;
  readonly payloads: Map<string, string>;
  readonly operatorBrief: string;
  readonly portraitSources: WikiBuildPortraitSources;
}

type FindObject = (objectId: string, kind: WikiObject["kind"]) => Promise<WikiObject>;

export async function runAnalystRole(
  input: RunStepInput,
  deps: AnalystRoleDeps,
  findObject: FindObject,
): Promise<readonly WikiObject[]> {
  switch (input.role) {
    case "A1":
      return runA1(input, deps);
    case "A2":
      return runA2(input, deps);
    case "A3":
      return runA3(input, deps);
    case "A4":
      return runA4(input, deps, findObject);
    case "A5":
      return runA5(input, deps);
    case "A6":
      return runA6(input, deps);
    case "A7":
      return runA7(input, deps);
    case "A8":
      return runA8(input, deps, findObject);
    case "A9":
      return runA9(input, deps, findObject);
    case "A10":
      return runA10(input, deps);
    default:
      return assertUnhandledRole(input.role);
  }
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
  const slice = readRepresentativeStyleSlice(deps.model);
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
      model: dispatchingTermAnalystModel(deps.runtime, dispatch),
      storePrompt: promptStore(deps, input, "A2"),
      validationModel: deps.model,
    },
  );
  return [result.termRuling];
}

async function runA3(input: RunStepInput, deps: AnalystRoleDeps): Promise<readonly WikiObject[]> {
  const sceneId = requiredSubject(input, "scene");
  const context = wholeGameContext(input);
  const scene = readCompleteScene(deps.model, context, sceneId);
  const priorObject = input.priorObjects.find((object) => object.kind === "story-so-far");
  const prior: StorySoFarState | null =
    priorObject?.kind === "story-so-far"
      ? {
          throughSceneId: priorObject.body.throughSceneId,
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
  findObject: FindObject,
): Promise<readonly WikiObject[]> {
  const routeId = requiredSubject(input, "route");
  const route = deriveWorkSource(deps.model.factSnapshot).routes.find(
    (candidate) => candidate.routeId === routeId,
  );
  if (route === undefined)
    throw new Error(`A4 route ${routeId} is absent from the deterministic route work source`);
  const lastScene = route.sceneIds.at(-1);
  if (lastScene === undefined)
    throw new Error(`A4 route ${routeId} cannot adopt a spine from an empty dispatch order`);
  const finalStorySoFar = await findObject(`story-so-far:${lastScene}`, "story-so-far");
  const result = await reconcileRoute(
    deps.model,
    wholeGameContext(input),
    {
      finalStorySoFar,
      coveredSceneIds: route.sceneIds,
      expectedSceneIds: route.sceneIds,
    },
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
  findObject: FindObject,
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

async function runA9(
  input: RunStepInput,
  deps: AnalystRoleDeps,
  findObject: FindObject,
): Promise<readonly WikiObject[]> {
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
  const background = verifyA8CharacterBackground(
    deps.model,
    characterId,
    await findObject(`character-background:${characterId}`, "character-background"),
  );
  const draft = await dispatchingA9Caller(
    deps.model,
    context,
    deps.runtime,
  )({
    evidence,
    background,
    windowUnitIds,
    sourceLanguage: input.sourceLanguage,
  });
  return [assembleCharacterRouteArc(deps.model, context, character, evidence, background, draft)];
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
