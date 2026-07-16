// Read the genuinely-unknown-speaker units, and re-resolve every model-proposed
// candidate + reveal scene, through the strict read-tool surface.
//
// A10 NEVER trusts a caller-supplied unit, candidate, or scene. The unit set is
// read straight from the decode via `decode_get_units` and classified by its
// reveal-safe speaker truth: only `parser-unknown` and `reader-unknown` units are
// hypothesized; a `known` speaker is REFUSED (the decode already fixed it) and a
// null speaker is skipped (narration/choice). The whole-game hindsight pools —
// the candidate character ids and the reveal scene ids — are the decode's index
// and route graph exactly, and a model-proposed candidate or reveal scene is
// re-resolved against them before it can reach a hypothesis.

import {
  decodeGetCharacterOccurrences,
  decodeGetRouteGraph,
  decodeGetUnits,
  ReadToolError,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";
import type { SpeakerTruth, UnitFact } from "../../contracts/index.js";

import {
  A10RoleError,
  A10_ROLE_ID,
  type A10Context,
  type UnknownSpeakerStatus,
  type UnknownSpeakerUnit,
} from "./types.js";

const MAX_ROWS = 100_000;
const MAX_BYTES = 8_388_608;

/** The A10 caller identity for the local read tools. */
export function a10Caller(context: A10Context): ReadToolCaller {
  return {
    roleId: A10_ROLE_ID,
    routeVisibility: context.routeVisibility,
    localeBranchId: context.localeBranchId,
  };
}

/** Classify a unit's reveal-safe speaker truth. `known` is the decode's fixed
 * attribution (refused); `none` is narration/choice (skipped); the two unknown
 * states are the only ones A10 hypothesizes over. */
export function classifySpeaker(
  speaker: SpeakerTruth | null,
): UnknownSpeakerStatus | "known" | "none" {
  if (speaker === null) return "none";
  if (speaker.status === "parser-unknown") return "parser-unknown";
  if (speaker.status === "reader-unknown") return "reader-unknown";
  return "known";
}

/** Read every visible unit fact through `decode_get_units`, paging the cursor to
 * exhaustion so the whole ordered set is examined — none skipped by a page
 * boundary. */
export function readAllUnitFacts(model: ReadModel, context: A10Context): readonly UnitFact[] {
  const caller = a10Caller(context);
  const facts: UnitFact[] = [];
  let cursor: string | undefined;
  do {
    const result = decodeGetUnits(model, caller, {
      selector: { kind: "all" },
      maxRows: MAX_ROWS,
      maxBytes: MAX_BYTES,
      ...(cursor === undefined ? {} : { cursor }),
    });
    facts.push(...result.facts);
    cursor = result.page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return facts;
}

/**
 * Narrow one unit fact into an {@link UnknownSpeakerUnit}, or REFUSE it. A unit
 * whose speaker the decode already fixed (`known`) throws `known-speaker`; a unit
 * with no speaker context throws `no-speaker`. This is the structural refusal of
 * known speakers — A10 cannot be forced to hypothesize a unit the decode owns.
 */
export function toUnknownSpeakerUnit(unit: UnitFact): UnknownSpeakerUnit {
  const status = classifySpeaker(unit.value.speaker);
  if (status === "known") {
    throw new A10RoleError(
      "known-speaker",
      `unit ${unit.value.unitId} has a decoded speaker; A10 hypothesizes only unknown speakers`,
    );
  }
  if (status === "none") {
    throw new A10RoleError(
      "no-speaker",
      `unit ${unit.value.unitId} carries no speaker context to hypothesize`,
    );
  }
  const speaker = unit.value.speaker!;
  return {
    unitId: unit.value.unitId,
    sceneId: unit.value.sceneId,
    playOrderIndex: unit.value.playOrderIndex,
    speakerStatus: status,
    revealSafeLabel: speaker.revealSafeLabel,
    scope: unit.value.routeScopes[0]!,
  };
}

/** The genuinely-unknown-speaker units, in play order. The `known`/`none` units
 * are examined and left un-hypothesized. */
export function readUnknownSpeakerUnits(
  model: ReadModel,
  context: A10Context,
): readonly UnknownSpeakerUnit[] {
  return readAllUnitFacts(model, context)
    .filter((unit) => {
      const status = classifySpeaker(unit.value.speaker);
      return status === "parser-unknown" || status === "reader-unknown";
    })
    .map(toUnknownSpeakerUnit);
}

/** The whole-game candidate pool: the decoded character index, as ids. The model
 * proposes a candidate from precisely this set. */
export function hindsightCandidateIds(model: ReadModel): readonly string[] {
  return model.factSnapshot.characters.map((character) => character.characterId);
}

/** The whole-game reveal-scene pool: every scene in the route graph, as scene
 * ids. A reveal scene the model proposes is re-resolved against this set. */
export function hindsightRevealSceneIds(model: ReadModel, context: A10Context): readonly string[] {
  return routeNodeFacts(model, context).map((node) => node.value.sceneId);
}

type RouteNodeFact = Extract<
  ReturnType<typeof decodeGetRouteGraph>["facts"][number],
  { value: { kind: "route-node" } }
>;

function routeNodeFacts(model: ReadModel, context: A10Context): readonly RouteNodeFact[] {
  const caller = a10Caller(context);
  const nodes: RouteNodeFact[] = [];
  let cursor: string | undefined;
  do {
    const result = decodeGetRouteGraph(model, caller, {
      maxRows: MAX_ROWS,
      maxBytes: MAX_BYTES,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const fact of result.facts) {
      if (fact.value.kind === "route-node") nodes.push(fact as RouteNodeFact);
    }
    cursor = result.page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return nodes;
}

/**
 * Re-resolve a model-proposed candidate character against the decoded index, and
 * return the citeable occurrence fact id. A candidate absent from the index
 * throws `unknown-candidate` — the model cannot hypothesize a character the game
 * does not carry.
 */
export function verifyCandidateCharacter(
  model: ReadModel,
  context: A10Context,
  candidateCharacterId: string,
): string {
  try {
    const result = decodeGetCharacterOccurrences(model, a10Caller(context), {
      characterId: candidateCharacterId,
      maxRows: MAX_ROWS,
      maxBytes: MAX_BYTES,
    });
    return result.facts[0]!.factId;
  } catch (error) {
    if (error instanceof ReadToolError && error.code === "unknown-subject") {
      throw new A10RoleError(
        "unknown-candidate",
        `candidate character ${candidateCharacterId} is absent from the decoded index`,
      );
    }
    throw error;
  }
}

/**
 * Re-resolve a model-proposed reveal scene against the route graph, and return
 * the citeable route-node fact id. A scene absent from the graph throws
 * `unknown-reveal-scene` — the reveal point must be a real scene.
 */
export function verifyRevealScene(
  model: ReadModel,
  context: A10Context,
  revealSceneId: string,
): string {
  const node = routeNodeFacts(model, context).find((fact) => fact.value.sceneId === revealSceneId);
  if (!node) {
    throw new A10RoleError(
      "unknown-reveal-scene",
      `reveal scene ${revealSceneId} is absent from the route graph`,
    );
  }
  return node.factId;
}
