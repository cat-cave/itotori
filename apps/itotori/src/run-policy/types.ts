// The run-policy value types — the shape of a run request, the resolved policy,
// and the two error classes. This module holds DATA SHAPES only: no branching,
// no lookups. The deterministic legality decisions live in `resolve.ts`, and the
// unbypassable shippable-finalization gate in `finalize.ts`.
//
// The policy governs four INDEPENDENT axes of one localization run:
//   - run mode        — production | pilot | test-dev (the operational posture);
//   - context scope    — whole-game | external-augmented | narrowed:… ;
//   - output scope     — dialogue-only → +choices → +UI → all (a separate axis);
//   - roster           — which specialist castings run.
// Plus the ablation SELECTOR, the only thing that turns the bible off. A resolved
// policy is a total, self-consistent snapshot of all of them; it is only ever
// produced by `resolveRunPolicy`, which refuses every illegal combination.

import { translationScopeValues } from "../api-enum-values.js";
import type { ContextScopeValue, RoleId, RunModeValue } from "../contracts/index.js";
import type { AblationBypass, LocalizationPosture } from "../localized-wiki/index.js";

/** The output-scope universe — the cumulative translation tiers, as a closed set.
 * Mirrors `translationScopeValues` so output scope is bounded on its OWN axis,
 * independent of context/roster/bible. `dialogue-only` ⊂ `dialogue-and-choices`
 * ⊂ `dialogue-choices-ui` ⊂ `all`. */
export const OUTPUT_SCOPE_VALUES: readonly string[] = Object.freeze(
  Object.values(translationScopeValues),
);

/** One output scope — a member of the cumulative translation tiers. */
export type OutputScope = (typeof translationScopeValues)[keyof typeof translationScopeValues];

/** The context basis a run's drafting stands on. `wiki-first` grounds every line
 * in the localized bible; `pure-mtl-ablation` is the NULL-Wiki / direct-
 * translation posture — reachable only under the explicit ablation selector. */
export type BibleBasis = "wiki-first" | "pure-mtl-ablation";

/** The one sanctioned ablation. Selecting it is the ONLY way to reach a null Wiki
 * / direct translation; it is legal exclusively under a `test-dev` run. */
export interface AblationSelector {
  readonly kind: "pure-mtl";
}

/** The VISIBLE provenance of a run's context scope — recorded on every resolved
 * policy so a narrowing is surfaced, never silent. `coversWholeGame` is true for
 * whole-game and external-augmented; `narrowed` is true for a `narrowed:…` scope. */
export interface ContextProvenance {
  readonly scope: ContextScopeValue;
  readonly coversWholeGame: boolean;
  readonly narrowed: boolean;
  /** A human-readable statement of the scope posture, surfaced in reports. */
  readonly note: string;
}

/** A raw run request — the boundary input. `ablation` defaults to absent (a
 * normal run). Every field is validated by `resolveRunPolicy`; an illegal
 * combination throws a `RunPolicyError` rather than resolving. */
export interface RunPolicyRequest {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly outputScope: OutputScope;
  readonly roster: readonly RoleId[];
  readonly ablation?: AblationSelector | null;
}

/** A resolved, self-consistent run policy. Produced only by `resolveRunPolicy`;
 * every field is derived under the mode-profile requirements, so the object can
 * never encode a forbidden combination. `shippable` is DERIVED (never an input)
 * and is re-proved at finalization — it is not a trusted flag. */
export interface ResolvedRunPolicy {
  readonly runMode: RunModeValue;
  /** The bible posture this run maps to — production / pilot / ablation — or
   * `null` for a normal test-dev run (a wiki-first build over a narrowed scope,
   * which is none of the three canonical bible postures). */
  readonly localizationPosture: LocalizationPosture | null;
  readonly contextScope: ContextScopeValue;
  readonly contextProvenance: ContextProvenance;
  readonly outputScope: OutputScope;
  readonly roster: readonly RoleId[];
  readonly bibleBasis: BibleBasis;
  /** Composed from `mustBuildFullBible` over the mapped posture: production and
   * pilot MUST build the whole bible; test-dev and ablation need not. */
  readonly requiresFullBible: boolean;
  /** The single sanctioned bible bypass, obtained via `bypassBibleForAblation`
   * for an ablation run; `null` for every other run. */
  readonly ablationBypass: AblationBypass | null;
  /** Whether this run may finalize a shippable artifact. False for every
   * test-dev / narrowed run — and re-derived, not trusted, at finalization. */
  readonly shippable: boolean;
}

/** An illegal run configuration — a forbidden combination of mode, context,
 * output scope, roster, or ablation. Thrown by `resolveRunPolicy`; the message
 * names the exact rule that rejected the request. */
export class RunPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunPolicyError";
  }
}

/** An attempt to finalize a shippable artifact from a run that may not ship —
 * any test-dev / narrowed / bible-bypassed run. Thrown by the finalization gate;
 * there is no flag or alternate path around it. */
export class ShippableFinalizationError extends Error {
  constructor(
    readonly runMode: RunModeValue,
    readonly reason: string,
  ) {
    super(`run mode '${runMode}' may not finalize a shippable artifact: ${reason}`);
    this.name = "ShippableFinalizationError";
  }
}

/** A finalized, shippable artifact. The ONLY constructor is `finalizeShippable`,
 * which passes through the finalization gate — so an instance of this type is
 * proof the producing run was permitted to ship. */
export interface ShippableArtifact<T> {
  readonly shippable: true;
  readonly runMode: RunModeValue;
  readonly outputScope: OutputScope;
  readonly artifact: T;
}
