// Citation → Utsushi player deep-link. A real citation names the exact source
// entity it witnesses (a unit, a scene, a route); the surface turns that into
// the stable addressable URL the player resolves + HIGHLIGHTS on arrival. The
// deep-link also carries a return path back to the addressed wiki object so a
// play flag / edit / feedback from the player surface can close the loop.

import {
  addressableFocusToken,
  hrefForAddressable,
  type AddressableKind,
} from "../../addressable-routing.js";
import type { WikiCitationView } from "../../../wiki/dashboard/read-model.js";
import type { WikiBibleScope } from "./client.js";

export interface CitationDeepLink {
  /** The stable addressable URL the citation resolves to. */
  readonly href: string;
  /** The surface the link lands on — `play` is the Utsushi player. */
  readonly surface: "play" | "wiki";
  /** The DOM focus token the destination stamps to highlight the entity. */
  readonly focus: string;
  /** Whether the destination is the Utsushi player (a scene/unit/route jump). */
  readonly isPlayer: boolean;
  /** The path back to the addressed wiki object (null when the surface has no object). */
  readonly returnHref: string | null;
}

export interface CitationDeepLinkScope {
  readonly projectId: string | null;
  readonly localeBranchId: string | null;
  /** When set, the deep-link carries a return path to this bible object. */
  readonly snapshotId?: string | null;
  readonly objectId?: string | null;
}

const SUBJECT_KIND_TO_ADDRESSABLE: Readonly<Record<string, AddressableKind | undefined>> = {
  unit: "unit",
  scene: "scene",
  route: "route",
  character: "character",
  "glossary-term": "term",
};

const PLAYER_KINDS: ReadonlySet<AddressableKind> = new Set(["unit", "scene", "route"]);

/** Build the player/wiki deep-link a citation resolves to, or null when the
 * cited subject is not a directly addressable entity. */
export function citationDeepLink(
  citation: WikiCitationView,
  scope: CitationDeepLinkScope,
): CitationDeepLink | null {
  const kind = SUBJECT_KIND_TO_ADDRESSABLE[citation.subject.kind];
  if (kind === undefined) {
    return null;
  }
  const baseHref = hrefForAddressable({
    kind,
    id: citation.subject.id,
    projectId: scope.projectId,
    localeBranchId: scope.localeBranchId,
  });
  const returnHref = bibleObjectHref(scope);
  const href = appendReturnTo(baseHref, returnHref);
  const isPlayer = PLAYER_KINDS.has(kind);
  return {
    href,
    surface: isPlayer ? "play" : "wiki",
    focus: addressableFocusToken({ kind, id: citation.subject.id }),
    isPlayer,
    returnHref,
  };
}

/** Stable `/bible` URL that re-selects the addressed object. */
export function bibleObjectHref(scope: {
  readonly projectId?: string | null;
  readonly localeBranchId?: string | null;
  readonly snapshotId?: string | null;
  readonly objectId?: string | null;
}): string | null {
  const projectId = nonEmpty(scope.projectId ?? null);
  const localeBranchId = nonEmpty(scope.localeBranchId ?? null);
  const snapshotId = nonEmpty(scope.snapshotId ?? null);
  const objectId = nonEmpty(scope.objectId ?? null);
  if (projectId === null || localeBranchId === null || snapshotId === null || objectId === null) {
    return null;
  }
  const params = new URLSearchParams({
    projectId,
    localeBranchId,
    snapshotId,
    objectId,
  });
  return `/bible?${params.toString()}`;
}

/** Build a citation deep-link scope from the dashboard shell scope + selected object. */
export function citationScopeFor(scope: WikiBibleScope, objectId: string): CitationDeepLinkScope {
  return {
    projectId: scope.projectId,
    localeBranchId: scope.localeBranchId,
    snapshotId: scope.snapshotId,
    objectId,
  };
}

function appendReturnTo(href: string, returnHref: string | null): string {
  if (returnHref === null) {
    return href;
  }
  // URLSearchParams encodes once; the destination parses with the same API so
  // the return path round-trips without double-encoding.
  const params = new URLSearchParams(href.includes("?") ? href.slice(href.indexOf("?") + 1) : "");
  params.set("returnTo", returnHref);
  const path = href.includes("?") ? href.slice(0, href.indexOf("?")) : href;
  return `${path}?${params.toString()}`;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}
