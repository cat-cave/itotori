// Make the per-target localized bible the GROUND TRUTH — shared types.
//
// The localized bible (the per-target renderings + their installed canonical
// forms) is not advice a production line may reinterpret: it is the authority
// every unit's drafting/review RESOLVES against. This module binds each unit to
// the exact bible entries it depends on, records those dependencies so a later
// bible change finds its consumers, enforces that a line contradicting an
// installed canonical form is a DEFECT (never an alternate style), and blocks a
// unit whose required entry is absent. The binding + enforcement + invalidation
// is strictly deterministic; the line CONTENT it binds is best-effort model
// output this module never re-proves.

import type {
  EntityRef,
  LocalizedRendering,
  RouteScope,
  WikiObject,
} from "../../contracts/index.js";
import type { GlossaryApprovedForm } from "../../gates/index.js";
import type { LlmWikiDependency } from "@itotori/db";

/** Which bible authority a unit depends on. `term`/`name` are canonical-form
 * decisions (the glossary-exact authority); `style`/`voice`/`arc` are the
 * descriptive renderings a draft grounds tone/voice/continuity on. */
export type BibleCategory = "term" | "name" | "style" | "voice" | "arc";

/** The source-object kind that carries each category's authority. */
export const CATEGORY_SOURCE_KIND: Readonly<
  Record<BibleCategory, Exclude<WikiObject["kind"], "translation">>
> = {
  term: "term-ruling",
  name: "term-ruling",
  style: "style-contract",
  voice: "voice-profile",
  arc: "route-arc",
};

/** One bible entry a unit REQUIRES to be drafted. Derived mechanically from the
 * snapshot facts for the unit (term occurrences, speaker, route) — never a model
 * re-decision. `subject === null` means "the single entry of this kind in scope"
 * (e.g. the one global style contract). */
export interface RequiredBibleEntry {
  readonly category: BibleCategory;
  readonly sourceKind: Exclude<WikiObject["kind"], "translation">;
  readonly subject: EntityRef | null;
  readonly scope: RouteScope;
  /** Why this entry is required — the snapshot fact that induced it. */
  readonly reason: string;
}

/** One installed bible entry: the source object and its accepted localized
 * rendering. The pair is what lets the bible be indexed by subject AND projected
 * into the deterministic gate's approved forms. */
export interface InstalledBibleEntry {
  readonly sourceObject: WikiObject;
  readonly rendering: LocalizedRendering;
}

/** The resolved ground-truth binding for one unit: the exact bible renderings it
 * resolved (feeding the P1/Q role inputs' `bibleRenderingIds`), the recorded
 * fine-grained dependencies (so a bible change finds this unit), and a stable
 * hash of the resolved set (so a reflow can prove an unrelated unit unchanged). */
export interface UnitBibleBinding {
  readonly unitId: string;
  readonly downstreamObjectId: string;
  readonly downstreamVersionId: string;
  readonly downstreamVersion: number;
  /** The resolved bible rendering ids, deduped + sorted — the role input basis. */
  readonly bibleRenderingIds: readonly string[];
  /** The exact installed renderings behind those ids, in the same stable order.
   * This is the model-readable ground for P1 and the reviewer assemblers; an id
   * alone is never substituted for the localized rule it names. */
  readonly renderings: readonly LocalizedRendering[];
  /** The recorded fine-grained dependency edges (one per resolved entry). */
  readonly dependencies: readonly LlmWikiDependency[];
  /** A content address of the resolved bible id + version set. */
  readonly boundHash: string;
}

/** The authority the gate enforces against: the installed canonical forms plus a
 * subject-indexed view of every bible rendering. */
export interface InstalledBible {
  readonly canonicalForms: readonly GlossaryApprovedForm[];
  /** Resolve one required entry to its installed rendering, or `undefined`. */
  lookup(required: RequiredBibleEntry): LocalizedRendering | undefined;
  /** Every installed rendering, in stable rendering-id order. */
  renderings(): readonly LocalizedRendering[];
}

/** A required bible entry that is not installed — drafting BLOCKS. No fallback. */
export class MissingBibleEntryError extends Error {
  constructor(
    readonly unitId: string,
    readonly required: RequiredBibleEntry,
  ) {
    const subject = required.subject ? `${required.subject.kind}:${required.subject.id}` : "*";
    super(
      `unit ${unitId} requires a ${required.category} bible entry (${required.sourceKind} ${subject}) that is not installed: ${required.reason}`,
    );
    this.name = "MissingBibleEntryError";
  }
}

/** Two installed entries collide on one subject/kind/scope — the bible is
 * ambiguous and cannot be an authority. A control-flow defect, never resolved. */
export class AmbiguousBibleEntryError extends Error {
  constructor(key: string) {
    super(`the installed bible has two entries for ${key}`);
    this.name = "AmbiguousBibleEntryError";
  }
}
