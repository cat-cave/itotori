// Citation → Utsushi player deep-link. A real citation names the exact source
// entity it witnesses (a unit, a scene, a route); the surface turns that into
// the stable addressable URL the player resolves + HIGHLIGHTS on arrival. A
// unit/scene/route citation lands on the play surface at that exact address; a
// character/term citation resolves to its wiki profile; anything not directly
// addressable yields no jump rather than a misleading link.

import {
  addressableFocusToken,
  hrefForAddressable,
  type AddressableKind,
} from "../../addressable-routing.js";
import type { WikiCitationView } from "../../../wiki/dashboard/read-model.js";

export interface CitationDeepLink {
  /** The stable addressable URL the citation resolves to. */
  readonly href: string;
  /** The surface the link lands on — `play` is the Utsushi player. */
  readonly surface: "play" | "wiki";
  /** The DOM focus token the destination stamps to highlight the entity. */
  readonly focus: string;
  /** Whether the destination is the Utsushi player (a scene/unit/route jump). */
  readonly isPlayer: boolean;
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
  scope: { readonly projectId: string | null; readonly localeBranchId: string | null },
): CitationDeepLink | null {
  const kind = SUBJECT_KIND_TO_ADDRESSABLE[citation.subject.kind];
  if (kind === undefined) {
    return null;
  }
  const href = hrefForAddressable({
    kind,
    id: citation.subject.id,
    projectId: scope.projectId,
    localeBranchId: scope.localeBranchId,
  });
  const isPlayer = PLAYER_KINDS.has(kind);
  return {
    href,
    surface: isPlayer ? "play" : "wiki",
    focus: addressableFocusToken({ kind, id: citation.subject.id }),
    isPlayer,
  };
}
