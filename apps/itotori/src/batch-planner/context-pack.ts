import type {
  CharacterMapSnapshot,
  CharacterRef,
  GlossaryRef,
  SceneSummaryRef,
  StyleGuideRuleSnapshot,
  StyleGuideVersionSnapshot,
  StyleRuleRef,
  TerminologyTermSnapshot,
} from "./shapes.js";
import type { PlannerUnit } from "./scene-grouping.js";

const alwaysOnApplicability = "always_on";

/**
 * Glossary hits for a single unit. A term hits when its preferredSourceForm
 * or any alias appears in `unit.sourceText`. Returned in glossary order.
 */
export function glossaryHitsForUnit(
  glossary: ReadonlyArray<TerminologyTermSnapshot>,
  unit: PlannerUnit,
): TerminologyTermSnapshot[] {
  const hits: TerminologyTermSnapshot[] = [];
  for (const term of glossary) {
    if (termMatchesText(term, unit.sourceText)) {
      hits.push(term);
    }
  }
  return hits;
}

function termMatchesText(term: TerminologyTermSnapshot, text: string): boolean {
  const caseSensitive = term.caseSensitive ?? false;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needles: string[] = [term.preferredSourceForm];
  if (term.aliases) {
    for (const alias of term.aliases) {
      if (alias.aliasText && alias.aliasText.length > 0) {
        needles.push(alias.aliasText);
      }
    }
  }
  for (const needle of needles) {
    if (needle.length === 0) {
      continue;
    }
    const candidate = caseSensitive ? needle : needle.toLowerCase();
    if (haystack.includes(candidate)) {
      return true;
    }
  }
  return false;
}

export function termSnapshotToRef(
  term: TerminologyTermSnapshot,
  hitBridgeUnitIds: string[],
): GlossaryRef {
  return {
    termId: term.termId,
    termKey: term.termKey,
    preferredSourceForm: term.preferredSourceForm,
    preferredTargetForm: term.preferredTargetForm,
    hitBridgeUnitIds: [...hitBridgeUnitIds],
  };
}

/**
 * Always-on style rules from the version snapshot.
 */
export function alwaysOnStyleRules(
  styleGuide: StyleGuideVersionSnapshot | undefined,
): StyleRuleRef[] {
  if (!styleGuide) {
    return [];
  }
  return styleGuide.rules
    .filter((rule) => rule.applicability === alwaysOnApplicability)
    .map((rule) => ({
      ruleId: rule.ruleId,
      styleGuideVersionId: styleGuide.styleGuideVersionId,
      rulePath: rule.rulePath,
      inclusionReason: "always_on" as const,
    }));
}

/**
 * Category-tagged style rules whose applicability matches any of the
 * provided categories (textSurface, surfaceKind, or policyAction values).
 * Always-on rules are excluded — those are handled separately to keep the
 * "every batch ships always-on" invariant explicit.
 */
export function categoryMatchedStyleRules(
  styleGuide: StyleGuideVersionSnapshot | undefined,
  categories: ReadonlySet<string>,
): StyleRuleRef[] {
  if (!styleGuide) {
    return [];
  }
  return styleGuide.rules
    .filter(
      (rule) => rule.applicability !== alwaysOnApplicability && categories.has(rule.applicability),
    )
    .map((rule) => ({
      ruleId: rule.ruleId,
      styleGuideVersionId: styleGuide.styleGuideVersionId,
      rulePath: rule.rulePath,
      inclusionReason: "category_match" as const,
    }));
}

/** Token-accountable body for a style rule. */
export function styleRuleBody(
  styleGuide: StyleGuideVersionSnapshot | undefined,
  ruleId: string,
): string {
  if (!styleGuide) {
    return "";
  }
  const rule = styleGuide.rules.find((candidate) => candidate.ruleId === ruleId);
  return rule?.body ?? "";
}

/**
 * Lookup a character map entry by speaker key/displayName. Tolerates case
 * differences and surrounding whitespace.
 */
export function characterForSpeaker(
  characterMap: CharacterMapSnapshot | undefined,
  speaker: string,
): { termId: string; canonicalName: string; relationshipNotes?: string | undefined } | undefined {
  if (!characterMap) {
    return undefined;
  }
  const normalized = speaker.trim().toLowerCase();
  for (const entry of characterMap.entries) {
    for (const key of entry.speakerKeys) {
      if (key.trim().toLowerCase() === normalized) {
        return {
          termId: entry.termId,
          canonicalName: entry.canonicalName,
          relationshipNotes: entry.relationshipNotes,
        };
      }
    }
    if (entry.canonicalName.trim().toLowerCase() === normalized) {
      return {
        termId: entry.termId,
        canonicalName: entry.canonicalName,
        relationshipNotes: entry.relationshipNotes,
      };
    }
  }
  return undefined;
}

/**
 * Build CharacterRef entries from a set of observed speakers. When the
 * character map is unavailable, each unique speaker still becomes an
 * entry with `relationshipNotes` undefined and a synthesized termId.
 */
export function buildCharacterRefs(
  characterMap: CharacterMapSnapshot | undefined,
  speakersToUnits: Map<string, string[]>,
): CharacterRef[] {
  const refs: CharacterRef[] = [];
  for (const [speaker, bridgeUnitIds] of speakersToUnits.entries()) {
    const lookup = characterForSpeaker(characterMap, speaker);
    refs.push({
      termId: lookup?.termId ?? `speaker:${speaker}`,
      canonicalName: lookup?.canonicalName ?? speaker,
      relationshipNotes: lookup?.relationshipNotes,
      appearsInBridgeUnitIds: [...bridgeUnitIds],
    });
  }
  refs.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  return refs;
}

/** Sorted, deduped category set from a group of planner units. */
export function categoriesFor(units: ReadonlyArray<PlannerUnit>): Set<string> {
  const categories = new Set<string>();
  for (const unit of units) {
    if (unit.textSurface) {
      categories.add(unit.textSurface);
    }
    if (unit.surfaceKind) {
      categories.add(unit.surfaceKind);
    }
    if (unit.policyAction) {
      categories.add(unit.policyAction);
    }
  }
  return categories;
}

/**
 * Pick the scene summary to attach to a batch's context pack. Agent-produced
 * `Fresh` summaries (ITOTORI-013) win over curator-authored context artifacts
 * for the same `sceneId`; otherwise we fall back to whatever the caller
 * supplied. This keeps the batch planner's interface unchanged while letting
 * the scene-summary CLI write into the same lookup map.
 */
export function sceneSummaryForGroup(
  sceneSummaries: ReadonlyMap<string, SceneSummaryRef> | undefined,
  sceneId: string | undefined,
  agentSummaries?: ReadonlyMap<string, SceneSummaryRef> | undefined,
): SceneSummaryRef | undefined {
  if (!sceneId) {
    return undefined;
  }
  if (agentSummaries) {
    const fromAgent = agentSummaries.get(sceneId);
    if (fromAgent) {
      return fromAgent;
    }
  }
  if (!sceneSummaries) {
    return undefined;
  }
  return sceneSummaries.get(sceneId);
}

/** Token-accountable serialized form of a glossary term. */
export function glossaryEntryText(term: GlossaryRef): string {
  const parts = [term.termKey, term.preferredSourceForm];
  if (term.preferredTargetForm) {
    parts.push(term.preferredTargetForm);
  }
  return parts.join(" | ");
}

/** Token-accountable serialized form of a character ref. */
export function characterEntryText(ref: CharacterRef): string {
  return ref.relationshipNotes
    ? `${ref.canonicalName}: ${ref.relationshipNotes}`
    : ref.canonicalName;
}

export function _internalAlwaysOnApplicability(): string {
  return alwaysOnApplicability;
}

export function _internalStyleRulesProvided(rule: StyleGuideRuleSnapshot): StyleGuideRuleSnapshot {
  return rule;
}
