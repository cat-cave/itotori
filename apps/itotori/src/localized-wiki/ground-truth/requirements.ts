// Derive, MECHANICALLY, the bible entries one unit requires.
//
// A unit's required bible entries are a deterministic function of the snapshot
// facts about it — never a model decision. The term rulings it needs are exactly
// the glossary terms whose byte-derived occurrences include the unit (the same
// occurrence relation the glossary-exact gate enforces); its name + voice come
// from the unit's cited speaker; its style is the one global style contract; its
// arc is its route's arc. This is the requirement set the resolver looks up
// against the installed bible — a required entry that is absent BLOCKS drafting.

import type { EntityRef, RouteScope } from "../../contracts/index.js";
import type { FactSnapshot, OrderedUnitFact } from "../../prepass/index.js";
import { CATEGORY_SOURCE_KIND, type RequiredBibleEntry } from "./types.js";

/** Which categories a caller wants enforced. Term + name + voice are induced by
 * the unit's own facts; style + arc are game/route authorities. Defaults require
 * every category the unit's facts support. */
export interface RequirementOptions {
  readonly requireStyle?: boolean;
  readonly requireArc?: boolean;
}

const GLOBAL: RouteScope = { kind: "global" };

/** Normalize a unit's decode route scope into the public route-scope type. */
function toRouteScope(scope: OrderedUnitFact["routeScope"]): RouteScope {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") return { kind: "route-set", routeIds: [...scope.routeIds] };
  return { kind: "global" };
}

/** The cited speaker's character id, or `null` when the unit has no named
 * speaker (a `parser_unknown` / `not_applicable` line needs no name/voice). */
function speakerCharacterId(unit: OrderedUnitFact): string | null {
  const speaker = unit.speaker;
  if (speaker === null) return null;
  if (speaker.knowledgeState === "known" || speaker.knowledgeState === "reader_unknown") {
    return speaker.speakerId;
  }
  return null;
}

function entry(
  category: RequiredBibleEntry["category"],
  subject: EntityRef | null,
  scope: RouteScope,
  reason: string,
): RequiredBibleEntry {
  return { category, sourceKind: CATEGORY_SOURCE_KIND[category], subject, scope, reason };
}

/** The bible entries `unit` requires, in a stable order. Pure in the snapshot. */
export function deriveUnitRequirements(
  unit: OrderedUnitFact,
  snapshot: FactSnapshot,
  options: RequirementOptions = {},
): readonly RequiredBibleEntry[] {
  const required: RequiredBibleEntry[] = [];

  if (options.requireStyle ?? true) {
    required.push(entry("style", null, GLOBAL, "every line honours the global style contract"));
  }

  for (const term of snapshot.terminology) {
    if (!term.occurrenceUnitKeys.includes(unit.sourceUnitKey)) continue;
    required.push(
      entry(
        "term",
        { kind: "glossary-term", id: term.termKey },
        GLOBAL,
        `source term ${term.termKey} occurs in this unit`,
      ),
    );
  }

  const characterId = speakerCharacterId(unit);
  if (characterId !== null) {
    const subject: EntityRef = { kind: "character", id: characterId };
    required.push(entry("name", subject, GLOBAL, `speaker ${characterId} needs a name ruling`));
    required.push(entry("voice", subject, GLOBAL, `speaker ${characterId} needs a voice profile`));
  }

  const scope = toRouteScope(unit.routeScope);
  if ((options.requireArc ?? true) && scope.kind === "route") {
    required.push(
      entry("arc", { kind: "route", id: scope.routeId }, scope, `route ${scope.routeId} arc`),
    );
  }

  return dedupeRequirements(required);
}

/** Collapse duplicate requirements (a term occurring twice, etc.) in stable
 * order so the recorded dependency set is deterministic. */
function dedupeRequirements(
  required: readonly RequiredBibleEntry[],
): readonly RequiredBibleEntry[] {
  const seen = new Set<string>();
  const out: RequiredBibleEntry[] = [];
  for (const item of required) {
    const subject = item.subject ? `${item.subject.kind}:${item.subject.id}` : "*";
    const key = `${item.category}|${item.sourceKind}|${subject}|${JSON.stringify(item.scope)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
