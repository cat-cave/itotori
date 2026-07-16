// Build the installed-bible authority the ground truth resolves + enforces
// against.
//
// The bible is authoritative in two ways at once: (1) its L-Term / L-Name
// decisions carry the canonical TARGET FORMS the deterministic glossary-exact
// gate enforces (projected through the same installer the bible orchestration
// uses, so a contradictory line is the SAME defect here as downstream); (2) its
// renderings are indexed by (kind, subject, scope) so a unit's required entry
// resolves to the EXACT rendering it depends on — or, when absent, fails to
// resolve so drafting can block. Two entries for one subject/kind/scope make the
// bible ambiguous and fail loud; nothing is silently reconciled.

import type { LocalizedRendering } from "../../contracts/index.js";
import { installCanonicalForms, type ValidatedDecision } from "../install.js";
import { scopeKey } from "../rendering.js";
import {
  AmbiguousBibleEntryError,
  type InstalledBible,
  type InstalledBibleEntry,
  type RequiredBibleEntry,
} from "./types.js";

function subjectKey(
  sourceKind: string,
  subjectKind: string,
  subjectId: string,
  scope: Parameters<typeof scopeKey>[0],
): string {
  return `${sourceKind}|${subjectKind}:${subjectId}|${scopeKey(scope)}`;
}

function kindScopeKey(sourceKind: string, scope: Parameters<typeof scopeKey>[0]): string {
  return `${sourceKind}|${scopeKey(scope)}`;
}

/** Build the installed bible from every accepted (source object, rendering) pair.
 * The term-ruling entries also install into the deterministic gate's approved
 * forms. Duplicate subject/kind/scope entries fail loud. */
export function buildInstalledBible(entries: readonly InstalledBibleEntry[]): InstalledBible {
  const bySubject = new Map<string, LocalizedRendering>();
  const byKindScope = new Map<string, LocalizedRendering[]>();
  for (const entry of entries) {
    const { subject, kind, scope } = entry.sourceObject;
    const sKey = subjectKey(kind, subject.kind, subject.id, scope);
    if (bySubject.has(sKey)) throw new AmbiguousBibleEntryError(sKey);
    bySubject.set(sKey, entry.rendering);
    const kKey = kindScopeKey(kind, scope);
    const bucket = byKindScope.get(kKey);
    if (bucket) bucket.push(entry.rendering);
    else byKindScope.set(kKey, [entry.rendering]);
  }

  const decisions: ValidatedDecision[] = entries
    .filter((entry) => entry.sourceObject.kind === "term-ruling")
    .map((entry) => ({ sourceObject: entry.sourceObject, rendering: entry.rendering }));
  const canonicalForms = installCanonicalForms(decisions);

  const sortedRenderings = [...entries]
    .map((entry) => entry.rendering)
    .sort((a, b) => (a.renderingId < b.renderingId ? -1 : a.renderingId > b.renderingId ? 1 : 0));

  return {
    canonicalForms,
    renderings: () => sortedRenderings,
    lookup(required: RequiredBibleEntry): LocalizedRendering | undefined {
      if (required.subject !== null) {
        return bySubject.get(
          subjectKey(
            required.sourceKind,
            required.subject.kind,
            required.subject.id,
            required.scope,
          ),
        );
      }
      const bucket = byKindScope.get(kindScopeKey(required.sourceKind, required.scope));
      if (bucket === undefined || bucket.length === 0) return undefined;
      if (bucket.length > 1) {
        throw new AmbiguousBibleEntryError(kindScopeKey(required.sourceKind, required.scope));
      }
      return bucket[0];
    },
  };
}
