// Wiki entry → scene/unit deep-link resolution.
//
// A wiki entry's player targets are derived ONLY from real provenance on the
// object (subject, claim citations, media scene/unit ids) plus an optional
// structure-address index (unit→scene, character→scenes from the fact snapshot
// / structure artifact). Nothing is guessed by text search. When no player
// target is resolvable the surface shows no link — never a broken or approximate
// destination.

import {
  addressableFocusToken,
  hrefForAddressable,
  type AddressableKind,
} from "../../addressable-routing.js";
import type { WikiCitationView, WikiSourceObjectView } from "../../../wiki/dashboard/read-model.js";
import { appendReturnToHref, bibleObjectHref, type CitationDeepLinkScope } from "./player-link.js";

/** One player-addressable target an entry resolves to (scene or unit only). */
export type EntryPlayerTarget = {
  readonly kind: "unit" | "scene";
  readonly id: string;
  /** How the target was derived — never "search". */
  readonly source: "subject" | "citation" | "media" | "structure";
  readonly href: string;
  readonly focus: string;
};

/** Structure-artifact join: turns unit/character identity into scene ids. */
export type StructureAddressIndex = {
  /** unit id (fact id and/or bridge unit id) → scene id. */
  readonly unitToScene: ReadonlyMap<string, string>;
  /** character id → ordered scene ids where the character appears. */
  readonly characterToScenes: ReadonlyMap<string, readonly string[]>;
};

/** Input slice the resolver needs — works for views and sealed WikiObjects. */
export type EntryDeepLinkSource = {
  readonly subject: { readonly kind: string; readonly id: string };
  readonly citations: readonly Pick<WikiCitationView, "subject">[];
  readonly claims?: readonly {
    readonly citations: readonly Pick<WikiCitationView, "subject">[];
  }[];
  readonly media?: readonly {
    readonly kind: string;
    readonly sceneId?: string | null;
    readonly unitId?: string | null;
  }[];
};

/**
 * Resolve the player scene/unit targets a wiki entry addresses. Empty when the
 * entry has no unit/scene provenance and the structure index cannot fill the
 * gap (e.g. a character with no occurrence scenes). Engine-agnostic: works for
 * single-scene streams and multi-scene graphs alike.
 */
export function resolveEntryPlayerTargets(
  entry: EntryDeepLinkSource,
  scope: CitationDeepLinkScope,
  structure: StructureAddressIndex | null = null,
): readonly EntryPlayerTarget[] {
  const seen = new Map<string, EntryPlayerTarget>();
  const returnHref = bibleObjectHref(scope);

  const add = (kind: "unit" | "scene", id: string, source: EntryPlayerTarget["source"]): void => {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      return;
    }
    const key = `${kind}:${trimmed}`;
    if (seen.has(key)) {
      return;
    }
    const baseHref = hrefForAddressable({
      kind,
      id: trimmed,
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
    });
    seen.set(key, {
      kind,
      id: trimmed,
      source,
      href: appendReturnToHref(baseHref, returnHref),
      focus: addressableFocusToken({ kind, id: trimmed }),
    });
  };

  considerEntity(entry.subject.kind, entry.subject.id, "subject", structure, add);

  for (const citation of entry.citations) {
    considerEntity(citation.subject.kind, citation.subject.id, "citation", structure, add);
  }
  for (const claim of entry.claims ?? []) {
    for (const citation of claim.citations) {
      considerEntity(citation.subject.kind, citation.subject.id, "citation", structure, add);
    }
  }

  for (const media of entry.media ?? []) {
    const sceneId = nonEmpty(media.sceneId ?? null);
    if (sceneId !== null) {
      add("scene", sceneId, "media");
    }
    const unitId = nonEmpty(media.unitId ?? null);
    if (unitId !== null) {
      add("unit", unitId, "media");
      const scene = structure?.unitToScene.get(unitId);
      if (scene !== undefined) {
        add("scene", scene, "structure");
      }
    }
  }

  return [...seen.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      // Scenes first — the entry-level jump prefers a scene landing when both exist.
      return left.kind === "scene" ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

/** Primary deep-link: first scene if any, else first unit, else null. */
export function primaryEntryPlayerTarget(
  targets: readonly EntryPlayerTarget[],
): EntryPlayerTarget | null {
  return targets[0] ?? null;
}

/** Whether any player target resolved (used for coverage rate). */
export function entryResolvesToPlayerTarget(targets: readonly EntryPlayerTarget[]): boolean {
  return targets.length > 0;
}

/** Whether any scene target resolved (stricter coverage: scene, not only unit). */
export function entryResolvesToScene(targets: readonly EntryPlayerTarget[]): boolean {
  return targets.some((target) => target.kind === "scene");
}

/** Build a structure index from fact-snapshot-shaped data (engine-agnostic). */
export function structureAddressIndexFromFacts(input: {
  readonly orderedUnits: readonly {
    readonly factId: string;
    readonly bridgeUnitId: string;
    readonly sceneId: string;
  }[];
  readonly characters: readonly {
    readonly characterId: string;
    readonly sceneIds: readonly string[];
  }[];
}): StructureAddressIndex {
  const unitToScene = new Map<string, string>();
  for (const unit of input.orderedUnits) {
    const sceneId = String(unit.sceneId);
    unitToScene.set(unit.factId, sceneId);
    unitToScene.set(unit.bridgeUnitId, sceneId);
  }
  const characterToScenes = new Map<string, readonly string[]>();
  for (const character of input.characters) {
    characterToScenes.set(character.characterId, character.sceneIds.map(String));
  }
  return { unitToScene, characterToScenes };
}

/** Project a sealed WikiObject / source view into the resolver input. */
export function entryDeepLinkSourceFromView(object: WikiSourceObjectView): EntryDeepLinkSource {
  return {
    subject: object.subject,
    citations: object.citations,
    claims: object.claims,
    media: object.media.map((ref) => ({
      kind: ref.kind,
      sceneId: "sceneId" in ref ? (ref.sceneId as string) : null,
      unitId: "unitId" in ref ? ((ref.unitId as string | null | undefined) ?? null) : null,
    })),
  };
}

function considerEntity(
  kind: string,
  id: string,
  source: "subject" | "citation",
  structure: StructureAddressIndex | null,
  add: (kind: "unit" | "scene", id: string, source: EntryPlayerTarget["source"]) => void,
): void {
  if (kind === "unit") {
    add("unit", id, source);
    const scene = structure?.unitToScene.get(id);
    if (scene !== undefined) {
      add("scene", scene, "structure");
    }
    return;
  }
  if (kind === "scene") {
    add("scene", id, source);
    return;
  }
  if (kind === "character" && structure !== null) {
    const scenes = structure.characterToScenes.get(id) ?? [];
    for (const sceneId of scenes) {
      add("scene", sceneId, "structure");
    }
  }
}

function nonEmpty(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

// Re-export AddressableKind for callers that stamp focus tokens.
export type { AddressableKind };
