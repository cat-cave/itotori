// Terminology / alias / choice-label occurrences + glossary conflicts.
//
// Terminology entries are the bridge's policy records (the glossary). For each
// term key we group its source forms (aliases) and count byte-derived
// occurrences: a unit "hits" a term when its source text contains one of the
// term's source forms. This is a mechanical substring count over decoded bytes,
// NOT semantic attribution. Conflicts are two policy records disagreeing on the
// ruling for one term key, or one source form claimed by two distinct term
// keys — surfaced as explicit facts, never silently reconciled.

import { namespacedFactId } from "@itotori/db";
import type { BridgeBundleV02, PolicyRecordV02 } from "@itotori/localization-bridge-schema";

import { stableSegment } from "./fact-id.js";
import type {
  ChoiceLabelOccurrenceFact,
  GlossaryConflictFact,
  TerminologyOccurrenceFact,
} from "./types.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type TermGroup = {
  termKey: string;
  policyActions: Set<string>;
  sourceForms: Set<string>;
};

function groupByTermKey(records: readonly PolicyRecordV02[]): Map<string, TermGroup> {
  const groups = new Map<string, TermGroup>();
  for (const record of records) {
    let group = groups.get(record.termKey);
    if (group === undefined) {
      group = { termKey: record.termKey, policyActions: new Set(), sourceForms: new Set() };
      groups.set(record.termKey, group);
    }
    group.policyActions.add(record.policyAction);
    if (record.sourceText.length > 0) group.sourceForms.add(record.sourceText);
  }
  return groups;
}

/** Count byte-derived occurrences of a term's source forms across unit texts. */
function occurrenceUnitKeys(sourceForms: readonly string[], bundle: BridgeBundleV02): string[] {
  if (sourceForms.length === 0) return [];
  const keys = new Set<string>();
  for (const unit of bundle.units) {
    if (sourceForms.some((form) => unit.sourceText.includes(form))) {
      keys.add(unit.sourceUnitKey);
    }
  }
  return [...keys].sort(compareCodeUnits);
}

/** Materialize one terminology occurrence fact per glossary term key. */
export function materializeTerminology(bundle: BridgeBundleV02): TerminologyOccurrenceFact[] {
  const groups = groupByTermKey(bundle.policyRecords);
  return [...groups.values()]
    .map((group): TerminologyOccurrenceFact => {
      const aliases = [...group.sourceForms].sort(compareCodeUnits);
      const unitKeys = occurrenceUnitKeys(aliases, bundle);
      // A stable, deterministic ruling label even when a key is (illegally)
      // multi-valued: conflicts are reported separately in glossary conflicts.
      const policyAction = [...group.policyActions].sort(compareCodeUnits).join("+");
      return {
        factId: namespacedFactId("glossary", stableSegment(group.termKey)),
        termKey: group.termKey,
        policyAction,
        aliases,
        occurrenceCount: unitKeys.length,
        occurrenceUnitKeys: unitKeys,
      };
    })
    .sort((a, b) => compareCodeUnits(a.termKey, b.termKey));
}

/** Roll up every choice-label unit (choice_label surface) in stable order. */
export function materializeChoiceLabels(bundle: BridgeBundleV02): ChoiceLabelOccurrenceFact {
  const unitKeys = bundle.units
    .filter((unit) => unit.surfaceKind === "choice_label")
    .map((unit) => unit.sourceUnitKey)
    .sort(compareCodeUnits);
  return { totalCount: unitKeys.length, unitKeys };
}

/** Surface deterministic glossary conflicts (see file note). */
export function materializeGlossaryConflicts(bundle: BridgeBundleV02): GlossaryConflictFact[] {
  const conflicts: GlossaryConflictFact[] = [];
  const groups = groupByTermKey(bundle.policyRecords);

  for (const group of groups.values()) {
    if (group.policyActions.size > 1) {
      const actions = [...group.policyActions].sort(compareCodeUnits).join(", ");
      conflicts.push({
        factId: namespacedFactId("glossary", stableSegment(group.termKey), "policy-conflict"),
        kind: "policy_action_conflict",
        termKey: group.termKey,
        detail: `term key ${group.termKey} has conflicting policy actions: ${actions}`,
      });
    }
  }

  // One source form claimed by two distinct term keys.
  const termKeysByForm = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    for (const form of group.sourceForms) {
      const claimants = termKeysByForm.get(form) ?? new Set<string>();
      claimants.add(group.termKey);
      termKeysByForm.set(form, claimants);
    }
  }
  for (const [form, claimants] of termKeysByForm) {
    if (claimants.size > 1) {
      const keys = [...claimants].sort(compareCodeUnits);
      conflicts.push({
        factId: namespacedFactId("glossary", stableSegment(form), "form-collision"),
        kind: "source_form_collision",
        termKey: keys.join("+"),
        detail: `source form is claimed by distinct term keys: ${keys.join(", ")}`,
      });
    }
  }

  return conflicts.sort((a, b) => compareCodeUnits(a.factId, b.factId));
}
