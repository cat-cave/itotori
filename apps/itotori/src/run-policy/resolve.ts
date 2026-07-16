// Resolve a raw run request into a self-consistent, legal run policy — or refuse
// it. This is THE deterministic boundary that makes production and pilot honest
// and quarantines narrowed / ablation runs. Every rejection is a `RunPolicyError`
// naming the exact rule; there is no flag, alternate constructor, or run-mode
// escape hatch that reaches a forbidden combination, because the ONLY producer of
// a `ResolvedRunPolicy` is this function and it applies every rule below.
//
// It reads the requirements from the `MODE_PROFILES` data table (never branches
// on a mode name to decide one) and COMPOSES the localized-wiki posture rules
// (`mustBuildFullBible`, `bypassBibleForAblation`) — it does not re-implement the
// bible-bypass rule; it enforces it at the run-config boundary.

import {
  ContextScopeValueSchema,
  RunModeValueSchema,
  type ContextScopeValue,
  type RoleId,
  type RunModeValue,
} from "../contracts/index.js";
import {
  bypassBibleForAblation,
  mustBuildFullBible,
  type LocalizationPosture,
} from "../localized-wiki/index.js";
import { BASE_POSTURE_BY_RUN_MODE, profileFor, rosterIsFull } from "./mode-profiles.js";
import {
  OUTPUT_SCOPE_VALUES,
  RunPolicyError,
  type AblationSelector,
  type BibleBasis,
  type ContextProvenance,
  type OutputScope,
  type ResolvedRunPolicy,
  type RunPolicyRequest,
} from "./types.js";

/** True iff the context scope is a `narrowed:…` scope — narrower than whole-game. */
export function isNarrowedContext(scope: ContextScopeValue): boolean {
  return typeof scope === "string" && scope.startsWith("narrowed:");
}

/** True iff the context scope covers the whole game — `whole-game` itself, or
 * `external-augmented` (whole game PLUS external references, strictly more). A
 * `narrowed:…` scope covers less and is never whole-game. */
export function contextCoversWholeGame(scope: ContextScopeValue): boolean {
  return scope === "whole-game" || scope === "external-augmented";
}

/** The VISIBLE provenance of a context scope — recorded on the resolved policy so
 * a narrowing is surfaced, never silent. */
export function contextProvenanceOf(scope: ContextScopeValue): ContextProvenance {
  const narrowed = isNarrowedContext(scope);
  const coversWholeGame = contextCoversWholeGame(scope);
  const note = narrowed
    ? `context is NARROWED ('${scope}') — below whole-game; this run is quarantined to test-dev and cannot ship`
    : `context '${scope}' covers the whole game`;
  return { scope, coversWholeGame, narrowed, note };
}

/** The run mode a context scope FORCES, if any. A narrowed scope forces test-dev
 * — it is the only mode that accepts it; a whole-game-covering scope forces no
 * mode (each mode's own rules apply). */
export function requiredRunModeForContext(scope: ContextScopeValue): RunModeValue | null {
  return isNarrowedContext(scope) ? "test-dev" : null;
}

function normalizeAblation(ablation: AblationSelector | null | undefined): AblationSelector | null {
  if (ablation === null || ablation === undefined) return null;
  if (ablation.kind !== "pure-mtl") {
    throw new RunPolicyError(`unknown ablation selector '${String(ablation.kind)}'`);
  }
  return ablation;
}

function validateRoster(roster: readonly RoleId[]): void {
  if (roster.length === 0) {
    throw new RunPolicyError("roster selection is empty");
  }
}

function validateOutputScope(outputScope: OutputScope): void {
  // Output scope is bounded on its OWN axis, independent of context/roster/bible.
  if (!OUTPUT_SCOPE_VALUES.includes(outputScope)) {
    throw new RunPolicyError(
      `output scope '${String(outputScope)}' is not one of ${OUTPUT_SCOPE_VALUES.join(", ")}`,
    );
  }
}

/**
 * Resolve a raw run request into a legal, self-consistent policy, or throw a
 * `RunPolicyError` naming the rule it broke. This is the sole producer of a
 * `ResolvedRunPolicy`; a rejected request never yields one.
 */
export function resolveRunPolicy(request: RunPolicyRequest): ResolvedRunPolicy {
  const runMode = RunModeValueSchema.parse(request.runMode);
  const contextScope = ContextScopeValueSchema.parse(request.contextScope);
  const outputScope = request.outputScope;
  const roster = request.roster;
  const ablation = normalizeAblation(request.ablation);

  const profile = profileFor(runMode);
  const provenance = contextProvenanceOf(contextScope);

  // Output scope — independent, bounded on its own axis; it relaxes nothing.
  validateOutputScope(outputScope);

  // Roster — production/pilot demand the full house; a partial roster is refused.
  validateRoster(roster);
  if (profile.requiresFullRoster && !rosterIsFull(roster)) {
    throw new RunPolicyError(
      `run mode '${runMode}' requires the full context roster; a partial roster is rejected`,
    );
  }

  // Ablation — the null-Wiki selector is legal ONLY where the profile permits it
  // (test-dev). Under production / pilot it is refused, so the null-Wiki basis is
  // unreachable there.
  if (ablation !== null && !profile.permitsAblation) {
    throw new RunPolicyError(
      `run mode '${runMode}' may not select the pure-MTL ablation; null Wiki / direct translation is reachable only under the explicit ablation (a test-dev run)`,
    );
  }

  // Context — a narrowed scope is legal ONLY where the profile permits it
  // (test-dev). Production / pilot reject it: narrowed context forces test-dev.
  if (provenance.narrowed && !profile.permitsNarrowedContext) {
    throw new RunPolicyError(
      `run mode '${runMode}' requires whole-game context; a narrowed context is rejected and forces test-dev`,
    );
  }
  if (profile.requiresWholeGameContext && !provenance.coversWholeGame) {
    throw new RunPolicyError(
      `run mode '${runMode}' requires whole-game context; scope '${contextScope}' does not cover the whole game`,
    );
  }

  // Bible basis is DERIVED from the ablation selector — never an input. The only
  // path to a null-Wiki basis is the ablation, already gated to test-dev above.
  const bibleBasis: BibleBasis = ablation !== null ? "pure-mtl-ablation" : "wiki-first";
  if (profile.requiresWikiFirstBible && bibleBasis !== "wiki-first") {
    throw new RunPolicyError(
      `run mode '${runMode}' requires the wiki-first bible; a bypassed (null-Wiki) bible is rejected`,
    );
  }

  // Compose the localized-wiki posture rules — do not re-implement them.
  const { localizationPosture, requiresFullBible, ablationBypass } = resolveBiblePosture(
    runMode,
    ablation,
  );

  // The composed posture must agree with the mode profile: a mode that requires
  // the wiki-first bible must also be a full-bible posture. A mismatch is a bug.
  if (profile.requiresWikiFirstBible && !requiresFullBible) {
    throw new RunPolicyError(
      `run mode '${runMode}' requires the full bible but its posture does not build it`,
    );
  }

  // Shippability is DERIVED, never trusted: a run may ship only if its profile
  // permits it AND it stands on whole-game context AND a wiki-first bible.
  const shippable =
    profile.canFinalizeShippable && !provenance.narrowed && bibleBasis === "wiki-first";

  return {
    runMode,
    localizationPosture,
    contextScope,
    contextProvenance: provenance,
    outputScope,
    roster,
    bibleBasis,
    requiresFullBible,
    ablationBypass,
    shippable,
  };
}

interface BiblePosture {
  readonly localizationPosture: LocalizationPosture | null;
  readonly requiresFullBible: boolean;
  readonly ablationBypass: ResolvedRunPolicy["ablationBypass"];
}

/** Map a run mode + ablation selector onto the localized-wiki bible posture,
 * composing `bypassBibleForAblation` and `mustBuildFullBible`. */
function resolveBiblePosture(
  runMode: RunModeValue,
  ablation: AblationSelector | null,
): BiblePosture {
  if (ablation !== null) {
    // The ONE sanctioned bypass — `bypassBibleForAblation` throws for any posture
    // but `ablation`, so this path can only ever be reached by the ablation run.
    const ablationBypass = bypassBibleForAblation("ablation");
    return {
      localizationPosture: "ablation",
      requiresFullBible: mustBuildFullBible("ablation"),
      ablationBypass,
    };
  }
  const basePosture = BASE_POSTURE_BY_RUN_MODE[runMode];
  return {
    localizationPosture: basePosture,
    requiresFullBible: basePosture === null ? false : mustBuildFullBible(basePosture),
    ablationBypass: null,
  };
}

/**
 * Demote a narrowed request to a legal test-dev policy with visible provenance.
 * This is the FORCING of clause 2 made ergonomic: a narrowed context can resolve
 * only under test-dev, so this resolves the request as test-dev. It is a
 * demotion, never a privilege escalation — the result is never shippable — and it
 * refuses a request whose context is not actually narrowed (so it cannot be used
 * to sidestep a whole-game mode's rules).
 */
export function forceTestDevForNarrowedContext(request: RunPolicyRequest): ResolvedRunPolicy {
  const contextScope = ContextScopeValueSchema.parse(request.contextScope);
  if (!isNarrowedContext(contextScope)) {
    throw new RunPolicyError(
      `context '${contextScope}' is not narrowed; only a narrowed context is forced to test-dev`,
    );
  }
  return resolveRunPolicy({ ...request, runMode: "test-dev" });
}
