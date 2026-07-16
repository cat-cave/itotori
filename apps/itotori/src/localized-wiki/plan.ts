// Build the deterministic per-target bible plan.
//
// The plan is a pure function of the source Wiki objects and the target language.
// It partitions the source objects into the two tiers — the canonical-form
// DECISIONS (term-ruling objects) and every DESCRIPTIVE rendering — assigns each
// a target identity, and orders the decision phase strictly before the
// descriptive phase. No model runs here.

import { decisionClassOf, tierOf, assertDecisionTierFirst } from "./ordering.js";
import { renderingKey } from "./rendering.js";
import type {
  BiblePhase,
  BibleStep,
  LocalizationPosture,
  LocalizedTarget,
  LocalizedWikiPlan,
} from "./types.js";
import type { WikiObject } from "../contracts/index.js";

/** A source object appeared twice under the same identity — an ambiguous input. */
export class BiblePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiblePlanError";
  }
}

function targetFor(object: WikiObject, targetLanguage: string): LocalizedTarget {
  const sourceObjectKind = object.kind;
  if (sourceObjectKind === "translation") {
    throw new BiblePlanError(
      `the source Wiki must carry no translation objects; got ${object.objectId}`,
    );
  }
  return {
    sourceObjectKind,
    sourceObjectId: object.objectId,
    sourceObjectVersion: object.version,
    scope: object.scope,
    targetLanguage,
    key: renderingKey(sourceObjectKind, object.objectId, object.scope, targetLanguage),
  };
}

function stepFor(object: WikiObject, targetLanguage: string): BibleStep {
  const tier = tierOf(object);
  const target = targetFor(object, targetLanguage);
  return {
    stepId: `${tier}:${target.key}`,
    tier,
    decisionClass: decisionClassOf(object),
    sourceObject: object,
    target,
  };
}

function sortSteps(steps: readonly BibleStep[]): BibleStep[] {
  return [...steps].sort((a, b) =>
    a.target.key < b.target.key ? -1 : a.target.key > b.target.key ? 1 : 0,
  );
}

/**
 * Build the per-target bible plan for a set of source Wiki objects. The decision
 * phase (level 0) holds every term-ruling; the descriptive phase (level 1) holds
 * everything else. Pure and deterministic; the tier order is asserted.
 */
export function buildLocalizedWikiPlan(
  sourceObjects: readonly WikiObject[],
  targetLanguage: string,
  posture: LocalizationPosture,
): LocalizedWikiPlan {
  const seen = new Set<string>();
  const decisionSteps: BibleStep[] = [];
  const descriptiveSteps: BibleStep[] = [];
  for (const object of sourceObjects) {
    const step = stepFor(object, targetLanguage);
    if (seen.has(step.target.key)) {
      throw new BiblePlanError(`duplicate source identity in bible plan: ${step.target.key}`);
    }
    seen.add(step.target.key);
    if (step.tier === "decision") decisionSteps.push(step);
    else descriptiveSteps.push(step);
  }
  const phases: BiblePhase[] = [
    { level: 0, tier: "decision", steps: sortSteps(decisionSteps) },
    { level: 1, tier: "descriptive", steps: sortSteps(descriptiveSteps) },
  ];
  assertDecisionTierFirst(phases);
  return { targetLanguage, posture, phases };
}
