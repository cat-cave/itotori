// The rendering acceptance gate — every accepted rendering is on-target,
// target-language, kind-matched, and stamped with the run's localization
// snapshot and run mode.
//
// The orchestrator does not re-prove a rendering's translation CONTENT (that is
// the reviewer's job for decisions, and best-effort for descriptive renderings).
// It proves the cross-cutting invariants a bible rendering must carry before it
// enters the ledger, and that it landed on the TARGET identity the plan assigned
// — a localizer cannot silently write an off-target, wrong-language, or wrong-
// kind rendering. A violation throws: it is a control-flow bug, never a silent
// degradation.

import type { LocalizedRendering, RouteScope } from "../contracts/index.js";
import type { LocalizedTarget, RenderingKey, RenderingStamp } from "./types.js";

/** A canonical string for a route scope, stable across builds. */
export function scopeKey(scope: RouteScope): string {
  if (scope.kind === "route") return `route:${scope.routeId}`;
  if (scope.kind === "route-set") {
    return `route-set:${[...scope.routeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",")}`;
  }
  return "global";
}

/** The rendering key for a (source-kind, source-object, scope, target-language)
 * identity. Plan-expected keys and ledger-existing keys are both built with this
 * one function, so the recovery diff is exact. */
export function renderingKey(
  sourceObjectKind: string,
  sourceObjectId: string,
  scope: RouteScope,
  targetLanguage: string,
): RenderingKey {
  return `${sourceObjectKind} ${sourceObjectId} ${scopeKey(scope)} -> ${targetLanguage}`;
}

/** The rendering key of a produced or persisted rendering. */
export function renderingKeyOf(rendering: LocalizedRendering): RenderingKey {
  return renderingKey(
    rendering.sourceObjectKind,
    rendering.sourceObjectId,
    rendering.scope,
    rendering.targetLanguage,
  );
}

/** A rendering a localizer produced that fails a bible invariant. */
export class RenderingRejectedError extends Error {
  constructor(
    readonly reason:
      | "wrong-target-language"
      | "source-kind-mismatch"
      | "source-object-mismatch"
      | "body-kind-mismatch"
      | "wrong-run-mode"
      | "wrong-localization-snapshot"
      | "off-target",
    detail: string,
  ) {
    super(`bible rendering rejected (${reason}): ${detail}`);
    this.name = "RenderingRejectedError";
  }
}

/**
 * Accept one produced rendering against a step's target and the run stamp, or
 * throw. Each guarantee is independently falsifiable:
 *   1. target-language — `targetLanguage` is the run's target language.
 *   2. kind-matched — the rendering localizes the target's source kind AND its
 *      localized body's kind matches that source kind.
 *   3. on-target — the rendering's source object and scope equal the assigned
 *      target identity.
 *   4. stamped — the rendering carries the run's localization snapshot and run
 *      mode.
 */
export function acceptRendering(
  rendering: LocalizedRendering,
  target: LocalizedTarget,
  stamp: RenderingStamp,
): RenderingKey {
  if (rendering.targetLanguage !== stamp.targetLanguage) {
    throw new RenderingRejectedError(
      "wrong-target-language",
      `rendering ${rendering.renderingId} language ${rendering.targetLanguage} is not the run's target ${stamp.targetLanguage}`,
    );
  }
  if (rendering.sourceObjectKind !== target.sourceObjectKind) {
    throw new RenderingRejectedError(
      "source-kind-mismatch",
      `rendering ${rendering.renderingId} localizes ${rendering.sourceObjectKind}, target expects ${target.sourceObjectKind}`,
    );
  }
  if (rendering.body.kind !== rendering.sourceObjectKind) {
    throw new RenderingRejectedError(
      "body-kind-mismatch",
      `rendering ${rendering.renderingId} body kind ${rendering.body.kind} does not match source kind ${rendering.sourceObjectKind}`,
    );
  }
  if (rendering.sourceObjectId !== target.sourceObjectId) {
    throw new RenderingRejectedError(
      "source-object-mismatch",
      `rendering ${rendering.renderingId} localizes source ${rendering.sourceObjectId}, target expects ${target.sourceObjectId}`,
    );
  }
  if (rendering.provenance.runMode !== stamp.runMode) {
    throw new RenderingRejectedError(
      "wrong-run-mode",
      `rendering ${rendering.renderingId} run mode ${rendering.provenance.runMode} is not ${stamp.runMode}`,
    );
  }
  if (rendering.provenance.localizationSnapshotId !== stamp.localizationSnapshotId) {
    throw new RenderingRejectedError(
      "wrong-localization-snapshot",
      `rendering ${rendering.renderingId} localization snapshot does not match the run`,
    );
  }
  const key = renderingKeyOf(rendering);
  if (key !== target.key) {
    throw new RenderingRejectedError(
      "off-target",
      `rendering ${rendering.renderingId} (${key}) is not the step's assigned target ${target.key}`,
    );
  }
  return key;
}
