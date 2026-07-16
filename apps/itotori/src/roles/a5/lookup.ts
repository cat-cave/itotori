// The deterministic voice-profile lookup — most-specific wins.
//
// A voice profile is a set of RULES addressing a character at four specificity
// tiers: the per-CHARACTER base register (least specific), a per-ROUTE narrowing,
// and the per-COUNTERPART and per-ARC-RANGE rules (most specific). For ANY real
// dialogue unit — addressed by (speaking character, played route, play order,
// counterpart) — this module resolves the APPLICABLE profile slice deterministically:
// among every rule that applies, the MOST SPECIFIC governs, and the per-character
// base can never overwrite a more-specific route/counterpart/arc rule.
//
// Specificity is ordered CHARACTER < ROUTE < COUNTERPART/ARC-RANGE. A rule's score
// adds 1 for pinning a concrete route and 2 for pinning a counterpart or an arc-
// position range, so the per-character base (0) is always the weakest and a route-
// pinned counterpart/arc rule (3) is the strongest. Ties resolve through a fixed
// total order (score, kind, ordinal), so the winner is a pure function of inputs.

import type { RouteScope, WikiObject } from "../../contracts/index.js";
import type { OrderedUnitFact } from "../../prepass/index.js";

import { arcPositionClaimId, baseRegisterClaimId, counterpartClaimId } from "./ids.js";
import { unitVisibleOnRoute } from "./windows.js";
import { A5RoleError, A5_VOICE_PROFILE_KIND, type A5Confidence } from "./types.js";

/** The four specificity tiers, from least to most specific. */
export type VoiceTier = "character" | "route" | "counterpart" | "arc-range";

/** The canonical specificity order the resolution honors. */
export const SPECIFICITY_ORDER = ["character", "route", "counterpart-or-arc-range"] as const;

/** A rule's addressing, reduced to what its specificity turns on. */
export interface VoiceSpecificityDescriptor {
  readonly pinsRoute: boolean;
  readonly dimension: "none" | "counterpart" | "arc-range";
}

/** The specificity SCORE: character 0 < route 1 < counterpart/arc-range 2, with a
 * route-pinned counterpart/arc rule the strongest (3). Pure and total. */
export function voiceSpecificity(descriptor: VoiceSpecificityDescriptor): number {
  return (descriptor.pinsRoute ? 1 : 0) + (descriptor.dimension === "none" ? 0 : 2);
}

function pinsRoute(scope: RouteScope): boolean {
  return scope.kind !== "global";
}

/** True when a rule under `scope` applies to a unit played on `routeId`: a global
 * rule applies regardless of route context; a route/route-set rule applies only
 * when the concrete played route is one it names. */
function scopeApplies(scope: RouteScope, routeId: string | null): boolean {
  if (scope.kind === "global") return true;
  if (routeId === null) return false;
  const routeIds = scope.kind === "route" ? [scope.routeId] : scope.routeIds;
  return routeIds.includes(routeId);
}

/** The per-character base register — the least-specific slice. */
export interface CompiledBase {
  readonly ruleId: string;
  readonly pronoun: string;
  readonly register: string;
  readonly tics: readonly string[];
  readonly confidence: A5Confidence;
  readonly citationEvidenceIds: readonly string[];
}

interface CompiledCounterpart {
  readonly ruleId: string;
  readonly ordinal: number;
  readonly counterpartId: string;
  readonly addressForm: string;
  readonly registerDelta: string;
  readonly scope: RouteScope;
  readonly specificity: number;
  readonly confidence: A5Confidence;
  readonly citationEvidenceIds: readonly string[];
}

interface CompiledArc {
  readonly ruleId: string;
  readonly ordinal: number;
  readonly scope: RouteScope;
  readonly register: string;
  readonly note: string;
  readonly fromPlayOrder: number;
  readonly toPlayOrder: number;
  readonly specificity: number;
  readonly confidence: A5Confidence;
  readonly citationEvidenceIds: readonly string[];
}

/** A voice profile compiled into resolvable rules, addressable deterministically. */
export interface CompiledVoiceProfile {
  readonly characterId: string;
  readonly base: CompiledBase;
  readonly counterparts: readonly CompiledCounterpart[];
  readonly arcs: readonly CompiledArc[];
}

/** The address of a real dialogue unit the profile is resolved for. */
export interface VoiceLookupAddress {
  readonly characterId: string;
  /** The concrete route the unit is played on; `null` for a route-agnostic unit. */
  readonly routeId: string | null;
  readonly playOrder: number;
  /** The counterpart the character addresses, when known; `null` otherwise. */
  readonly counterpartId: string | null;
}

/** The resolved profile slice for one address: the governing (most-specific)
 * rule's tier plus the effective register/forms/modulation and its citations. */
export interface ResolvedVoice {
  readonly characterId: string;
  readonly tier: VoiceTier;
  readonly specificity: number;
  readonly register: string;
  readonly pronoun: string;
  readonly tics: readonly string[];
  readonly addressForm: string | null;
  readonly modulation: string | null;
  readonly confidence: A5Confidence;
  readonly citations: readonly string[];
  readonly governingRuleId: string;
}

function citationEvidenceIds(object: WikiObject, claimId: string): readonly string[] {
  const claim = object.claims.find((candidate) => candidate.claimId === claimId);
  return claim ? claim.citations.map((citation) => citation.evidenceId) : [];
}

function claimConfidence(object: WikiObject, claimId: string): A5Confidence {
  const claim = object.claims.find((candidate) => candidate.claimId === claimId);
  return claim ? claim.confidence : "medium";
}

/**
 * Compile a sealed `voice-profile` object into resolvable rules, pairing each body
 * rule with its claim's confidence and citations. The compiled form is a pure
 * projection of the object, so resolution is deterministic over the same snapshot.
 */
export function compileVoiceProfile(object: WikiObject): CompiledVoiceProfile {
  if (object.kind !== A5_VOICE_PROFILE_KIND) {
    throw new A5RoleError("dispatch-failed", `expected a ${A5_VOICE_PROFILE_KIND} object`);
  }
  const body = object.body;
  const characterId = body.characterId;
  const baseId = baseRegisterClaimId(characterId);
  const base: CompiledBase = {
    ruleId: baseId,
    pronoun: body.base.pronoun,
    register: body.base.register,
    tics: body.base.tics,
    confidence: claimConfidence(object, baseId),
    citationEvidenceIds: citationEvidenceIds(object, baseId),
  };
  const counterparts = body.perCounterpart.map((rule, ordinal): CompiledCounterpart => {
    const ruleId = counterpartClaimId(characterId, ordinal);
    return {
      ruleId,
      ordinal,
      counterpartId: rule.counterpartId,
      addressForm: rule.addressForm,
      registerDelta: rule.registerDelta,
      scope: rule.scope,
      specificity: voiceSpecificity({ pinsRoute: pinsRoute(rule.scope), dimension: "counterpart" }),
      confidence: claimConfidence(object, ruleId),
      citationEvidenceIds: citationEvidenceIds(object, ruleId),
    };
  });
  const arcs = body.perArcPosition.map((rule, ordinal): CompiledArc => {
    const ruleId = arcPositionClaimId(characterId, ordinal);
    return {
      ruleId,
      ordinal,
      scope: rule.scope,
      register: rule.register,
      note: rule.note,
      fromPlayOrder: rule.fromPlayOrder,
      toPlayOrder: rule.toPlayOrder,
      specificity: voiceSpecificity({ pinsRoute: pinsRoute(rule.scope), dimension: "arc-range" }),
      confidence: claimConfidence(object, ruleId),
      citationEvidenceIds: citationEvidenceIds(object, ruleId),
    };
  });
  return { characterId, base, counterparts, arcs };
}

function applicableArcs(
  profile: CompiledVoiceProfile,
  address: VoiceLookupAddress,
): readonly CompiledArc[] {
  return profile.arcs.filter(
    (arc) =>
      scopeApplies(arc.scope, address.routeId) &&
      address.playOrder >= arc.fromPlayOrder &&
      address.playOrder <= arc.toPlayOrder,
  );
}

function applicableCounterparts(
  profile: CompiledVoiceProfile,
  address: VoiceLookupAddress,
): readonly CompiledCounterpart[] {
  if (address.counterpartId === null) return [];
  return profile.counterparts.filter(
    (rule) =>
      rule.counterpartId === address.counterpartId && scopeApplies(rule.scope, address.routeId),
  );
}

/** One rule reduced to the shape the governing selection ranks. `ruleId` breaks
 * every specificity tie, so the winner is a pure function of the inputs. */
interface GoverningCandidate {
  readonly tier: VoiceTier;
  readonly specificity: number;
  readonly ruleId: string;
  readonly modulation: string | null;
  readonly confidence: A5Confidence;
  readonly citations: readonly string[];
}

/** The more governing of two candidates: higher specificity wins; a tie breaks by
 * the lexically smaller rule id (a fixed total order → deterministic winner). */
function moreGoverning(
  current: GoverningCandidate,
  candidate: GoverningCandidate,
): GoverningCandidate {
  if (candidate.specificity !== current.specificity) {
    return candidate.specificity > current.specificity ? candidate : current;
  }
  return candidate.ruleId < current.ruleId ? candidate : current;
}

/** The most-specific of a set of rules (max score, tie → smallest ordinal), or
 * `null` when the set is empty. */
function mostSpecific<T extends { specificity: number; ordinal: number }>(
  rules: readonly T[],
): T | null {
  let best: T | null = null;
  for (const rule of rules) {
    if (
      best === null ||
      rule.specificity > best.specificity ||
      (rule.specificity === best.specificity && rule.ordinal < best.ordinal)
    ) {
      best = rule;
    }
  }
  return best;
}

/**
 * Resolve the applicable voice slice for a real dialogue unit. Deterministic and
 * total: the base register always applies; a route/counterpart/arc rule that also
 * applies is MORE specific and governs; the per-character base can never overwrite
 * a more-specific rule. The register falls back through register-bearing rules
 * (arc over base); the address form comes from the most-specific counterpart rule.
 */
export function resolveVoice(
  profile: CompiledVoiceProfile,
  address: VoiceLookupAddress,
): ResolvedVoice {
  const arcs = applicableArcs(profile, address);
  const counterparts = applicableCounterparts(profile, address);

  // Effective register: the most-specific register-bearing rule (arc beats base).
  const registerArc = mostSpecific(arcs);
  const register = registerArc ? registerArc.register : profile.base.register;

  // Effective address form: the most-specific applicable counterpart rule.
  const counterpart = mostSpecific(counterparts);

  // Governing rule: the single most-specific applicable rule across all tiers. The
  // base (per-character fallback, specificity 0) is only the winner when NOTHING
  // more specific applies — it can never overwrite a route/counterpart/arc rule.
  let governing: GoverningCandidate = {
    tier: "character",
    specificity: 0,
    ruleId: profile.base.ruleId,
    modulation: null,
    confidence: profile.base.confidence,
    citations: profile.base.citationEvidenceIds,
  };
  for (const arc of arcs) {
    governing = moreGoverning(governing, {
      tier: "arc-range",
      specificity: arc.specificity,
      ruleId: arc.ruleId,
      modulation: arc.note,
      confidence: arc.confidence,
      citations: arc.citationEvidenceIds,
    });
  }
  for (const rule of counterparts) {
    governing = moreGoverning(governing, {
      tier: "counterpart",
      specificity: rule.specificity,
      ruleId: rule.ruleId,
      modulation: rule.registerDelta,
      confidence: rule.confidence,
      citations: rule.citationEvidenceIds,
    });
  }

  return {
    characterId: profile.characterId,
    tier: governing.tier,
    specificity: governing.specificity,
    register,
    pronoun: profile.base.pronoun,
    tics: profile.base.tics,
    addressForm: counterpart ? counterpart.addressForm : null,
    modulation: governing.modulation,
    confidence: governing.confidence,
    citations: governing.citations,
    governingRuleId: governing.ruleId,
  };
}

/**
 * Build the lookup address for a real occurrence unit: the speaking character, the
 * concrete played route (which must be one the unit is visible on), the unit's
 * decoded play order, and an optional counterpart. A played route the unit is not
 * visible on is a forged address and fails loud.
 */
export function addressForUnit(
  unit: OrderedUnitFact,
  input: { characterId: string; playedRouteId: string | null; counterpartId: string | null },
): VoiceLookupAddress {
  if (input.playedRouteId !== null && !unitVisibleOnRoute(unit.routeScope, input.playedRouteId)) {
    throw new A5RoleError(
      "unknown-voice-evidence",
      `unit ${unit.factId} is not visible on played route ${input.playedRouteId}`,
    );
  }
  return {
    characterId: input.characterId,
    routeId: input.playedRouteId,
    playOrder: unit.playReveal.playOrderIndex,
    counterpartId: input.counterpartId,
  };
}
