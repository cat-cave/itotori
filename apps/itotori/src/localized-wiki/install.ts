// Install the agreed canonical TARGET forms into the deterministic gates.
//
// A validated L-Term / L-Name decision carries the authoritative target form(s)
// for its source term. This module projects those forms into the exact
// `GlossaryApprovedForm` shape the deterministic `glossary-exact` gate enforces:
// the preferred canonical form becomes the `requiredTargetForm`, the forbidden
// forms become `forbiddenTargetForms`, and the term id is the source object's
// subject id (the snapshot term key the gate resolves against). Once installed,
// a later contradictory production line is a DETERMINISTIC DEFECT, not a style
// choice — the enforcement is downstream, but the authoritative value is fixed
// here.

import type { GlossaryApprovedForm } from "../gates/index.js";
import type { LocalizedRendering, WikiObject } from "../contracts/index.js";

/** A decision whose canonical forms cannot install — a control-flow defect. */
export class CanonicalFormInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalFormInstallError";
  }
}

/** A validated decision paired with the source object it localizes. */
export interface ValidatedDecision {
  readonly sourceObject: WikiObject;
  readonly rendering: LocalizedRendering;
}

/** Project one validated term/name decision into the gate's approved form. Fails
 * loud unless the localized body carries EXACTLY ONE preferred canonical form —
 * an ambiguous or absent required form is a defect, never silently resolved. */
export function toGlossaryApprovedForm(decision: ValidatedDecision): GlossaryApprovedForm {
  const source = decision.sourceObject;
  const rendering = decision.rendering;
  if (source.kind !== "term-ruling") {
    throw new CanonicalFormInstallError(
      `source ${source.objectId} is a ${source.kind}, not a term-ruling decision`,
    );
  }
  if (rendering.body.kind !== "term-ruling") {
    throw new CanonicalFormInstallError(
      `rendering ${rendering.renderingId} body ${rendering.body.kind} is not a term-ruling`,
    );
  }
  const preferred = rendering.body.canonicalForms.filter((form) => form.status === "preferred");
  if (preferred.length !== 1) {
    throw new CanonicalFormInstallError(
      `term ${source.subject.id} must have exactly one preferred canonical form, found ${preferred.length}`,
    );
  }
  const forbidden = rendering.body.canonicalForms
    .filter((form) => form.status === "forbidden")
    .map((form) => form.form);
  return {
    termId: source.subject.id,
    sourceForm: source.body.sourceForm,
    requiredTargetForm: preferred[0]!.form,
    forbiddenTargetForms: forbidden,
  };
}

/** Install every validated decision, in stable term-id order, rejecting a
 * duplicate term id (two decisions cannot both rule the same source term). */
export function installCanonicalForms(
  decisions: readonly ValidatedDecision[],
): readonly GlossaryApprovedForm[] {
  const byTerm = new Map<string, GlossaryApprovedForm>();
  for (const decision of decisions) {
    const form = toGlossaryApprovedForm(decision);
    if (byTerm.has(form.termId)) {
      throw new CanonicalFormInstallError(`term ${form.termId} is ruled by two decisions`);
    }
    byTerm.set(form.termId, form);
  }
  return Object.freeze(
    [...byTerm.values()].sort((a, b) => (a.termId < b.termId ? -1 : a.termId > b.termId ? 1 : 0)),
  );
}
