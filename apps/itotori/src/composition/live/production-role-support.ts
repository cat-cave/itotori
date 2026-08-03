import type { LocalizedRendering, RouteScope } from "../../contracts/index.js";
import {
  arcPositionClaimId,
  baseRegisterClaimId,
  counterpartClaimId,
} from "../../roles/a5/index.js";
import type { VoiceBibleRule } from "../../roles/q2/index.js";
import type { DraftedUnit } from "../../workflow/index.js";
import type { LiveWorkflowRoleBindingInput } from "./factory.js";

/** A missing or contradictory run-scoped datum is a composition fault. */
export class ProductionRoleBindingError extends Error {
  constructor(detail: string) {
    super(`production role binding refused: ${detail}`);
    this.name = "ProductionRoleBindingError";
  }
}

type ScopedVoiceRule = Omit<VoiceBibleRule, "routeId"> & { readonly routeScope: RouteScope };

export function voiceRulesFor(
  drafted: DraftedUnit,
  speakerId: string,
  input: LiveWorkflowRoleBindingInput,
): readonly VoiceBibleRule[] {
  const selected = new Set(drafted.bibleRenderingIds);
  const rules = input.bibleEntries.flatMap((entry) => {
    if (!selected.has(entry.rendering.renderingId)) return [];
    if (
      entry.sourceObject.kind !== "voice-profile" ||
      entry.rendering.body.kind !== "voice-profile"
    ) {
      return [];
    }
    if (
      entry.sourceObject.body.characterId !== speakerId ||
      entry.rendering.body.characterId !== speakerId
    )
      return [];
    return voiceRulesForEntry(entry.sourceObject.body, entry.sourceObject.scope, entry.rendering);
  });
  if (rules.length === 0) {
    throw new ProductionRoleBindingError(`Q2 unit ${drafted.unitId} has no installed voice rule`);
  }
  return rules;
}

function voiceRulesForEntry(
  source: Extract<
    LiveWorkflowRoleBindingInput["bibleEntries"][number]["sourceObject"],
    { readonly kind: "voice-profile" }
  >["body"],
  sourceScope: RouteScope,
  rendering: LocalizedRendering,
): readonly VoiceBibleRule[] {
  if (rendering.body.kind !== "voice-profile") {
    throw new ProductionRoleBindingError(
      `voice source ${rendering.sourceObjectId} has a non-voice rendering`,
    );
  }
  const base = routeScopedVoiceRules({
    ruleId: rendering.renderingId,
    scope: "character",
    counterpartId: null,
    fromPlayOrder: null,
    toPlayOrder: null,
    register: localizedClaimText(
      rendering,
      baseRegisterClaimId(source.characterId),
      rendering.body.baseRegisterGuidance,
    ),
    routeScope: sourceScope,
  });
  const counterparts = source.perCounterpart.flatMap((rule, ordinal) =>
    routeScopedVoiceRules({
      ruleId: rendering.renderingId,
      scope: "counterpart",
      counterpartId: rule.counterpartId,
      fromPlayOrder: null,
      toPlayOrder: null,
      register: localizedClaimText(rendering, counterpartClaimId(source.characterId, ordinal)),
      routeScope: rule.scope,
    }),
  );
  const arcs = source.perArcPosition.flatMap((rule, ordinal) =>
    routeScopedVoiceRules({
      ruleId: rendering.renderingId,
      scope: "arc",
      counterpartId: null,
      fromPlayOrder: rule.fromPlayOrder,
      toPlayOrder: rule.toPlayOrder,
      register: localizedClaimText(rendering, arcPositionClaimId(source.characterId, ordinal)),
      routeScope: rule.scope,
    }),
  );
  return [...base, ...counterparts, ...arcs];
}

function routeScopedVoiceRules({
  routeScope,
  ...rule
}: ScopedVoiceRule): readonly VoiceBibleRule[] {
  return routeIds(routeScope).map((routeId) => ({ ...rule, routeId }));
}

function routeIds(scope: RouteScope): readonly (string | null)[] {
  if (scope.kind === "global") return [null];
  if (scope.kind === "route") return [scope.routeId];
  return [...scope.routeIds];
}

function localizedClaimText(
  rendering: LocalizedRendering,
  claimId: string,
  fallback?: string,
): string {
  const rendered = rendering.claimRenderings.find((claim) => claim.claimId === claimId);
  if (rendered !== undefined) return rendered.text;
  if (fallback !== undefined) return fallback;
  throw new ProductionRoleBindingError(
    `rendering ${rendering.renderingId} has no localized text for source claim ${claimId}`,
  );
}
