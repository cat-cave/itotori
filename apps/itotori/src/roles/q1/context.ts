// Build the Meaning Reviewer's blinded record from the strict local read tools.
//
// Q1 never accepts a caller-invented source line or neighbor window as its
// grounding.  It reads the candidate's decoded unit, its source neighbors,
// applicable glossary facts, and already-accepted target neighbors through the
// RB-025 surface.  The localized bible is supplied by the wiki-first resolver
// as exact rendering text because it is a localized artifact rather than a
// decode fact.  This keeps the reviewer blind to the author while making every
// factual datum traceable to a snapshot-pinned result.

import {
  decodeGetNeighbors,
  decodeGetUnits,
  glossaryLookup,
  outputsGetAccepted,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";
import type {
  ContextScopeValue,
  GlossaryFact,
  RouteScope,
  RunModeValue,
  UnitFact,
} from "../../contracts/index.js";

import {
  parseQ1ReviewInput,
  type Q1BackTranslationSignal,
  type Q1LocalizedBibleEntry,
  type Q1ReviewInput,
  type Q1SourceFact,
} from "./inputs.js";

const MAX_ROWS = 100_000;
const MAX_BYTES = 8_388_608;
const Q1_ROLE = "Q1" as const;

/** The run-scoped, non-author identity Q1 needs to call RB-025 tools. */
export interface Q1ReadContext {
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string;
  readonly unitId: string;
  readonly candidateTarget: string;
  /** Exact localized renderings selected by the deterministic bible resolver. */
  readonly localizedBible: readonly Q1LocalizedBibleEntry[];
  /** Deterministically matched source forms. An empty set means no glossary
   * entries apply; it does not trigger an unbounded all-glossary read. */
  readonly sourceForms?: readonly string[];
  readonly neighborBefore?: number;
  readonly neighborAfter?: number;
  readonly backTranslationSignal?: Q1BackTranslationSignal | null;
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
}

/** A malformed or incomplete local context is a loud refusal, never a blind
 * review over substituted caller text. */
export class Q1ReadContextError extends Error {
  constructor(
    readonly code: "missing-localization" | "missing-unit" | "incomplete-page",
    detail: string,
  ) {
    super(`Q1 read context ${code}: ${detail}`);
    this.name = "Q1ReadContextError";
  }
}

/** The fixed RB-025 caller identity for Q1. No author/model/provider metadata
 * is part of the envelope. */
export function q1ReadCaller(context: Q1ReadContext): ReadToolCaller {
  return {
    roleId: Q1_ROLE,
    routeVisibility: context.routeVisibility,
    localeBranchId: context.localeBranchId,
  };
}

function assertComplete(page: { readonly kind: "complete" | "more" }, tool: string): void {
  if (page.kind === "more") {
    throw new Q1ReadContextError(
      "incomplete-page",
      `${tool} exceeded the bounded review read; page it before constructing Q1 input`,
    );
  }
}

function sourceFact(fact: UnitFact): Q1SourceFact {
  return {
    factId: fact.factId,
    field: "decoded-source",
    text: fact.value.sourceSurface,
    evidence: {
      evidenceHash: fact.hash,
      snapshotId: fact.snapshotId,
      subject: { kind: "unit", id: fact.value.unitId },
      playOrderIndex: fact.visibility.fromPlayOrder,
    },
  };
}

function glossaryFact(fact: GlossaryFact): Q1SourceFact {
  const preferred = fact.value.forms
    .filter((form) => form.status === "preferred" || form.status === "allowed")
    .map((form) => `${form.language}: ${form.form}`)
    .join("; ");
  return {
    factId: fact.factId,
    field: `glossary ${fact.value.sourceForm}`,
    text: preferred.length > 0 ? preferred : fact.value.sourceForm,
    evidence: {
      evidenceHash: fact.hash,
      snapshotId: fact.snapshotId,
      subject: { kind: "glossary-term", id: fact.value.termId },
      playOrderIndex: fact.visibility.fromPlayOrder,
    },
  };
}

/**
 * Read and project every piece of Q1's grounded context. This is deliberately
 * a pre-dispatch projection: the prompt contains the exact recorded tool facts,
 * so the reviewer is blinded to production author identity and does not need an
 * ad-hoc live tool turn to discover the candidate's meaning basis.
 */
export function readQ1ReviewInput(model: ReadModel, context: Q1ReadContext): Q1ReviewInput {
  if (!model.localization || model.localization.localeBranchId !== context.localeBranchId) {
    throw new Q1ReadContextError(
      "missing-localization",
      "Q1 requires the bound localized bible and target snapshot",
    );
  }
  const caller = q1ReadCaller(context);
  const current = decodeGetUnits(model, caller, {
    selector: { kind: "unit-ids", unitIds: [context.unitId] },
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assertComplete(current.page, "decode_get_units");
  const unit = current.facts.find((fact) => fact.factId === context.unitId);
  if (!unit) {
    throw new Q1ReadContextError(
      "missing-unit",
      `decode_get_units did not return ${context.unitId}`,
    );
  }

  const neighborResult = decodeGetNeighbors(model, caller, {
    anchorUnitIds: [context.unitId],
    before: context.neighborBefore ?? 2,
    after: context.neighborAfter ?? 2,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assertComplete(neighborResult.page, "decode_get_neighbors");

  const acceptedResult = outputsGetAccepted(model, caller, {
    subjectIds: neighborResult.facts.map((fact) => fact.factId),
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assertComplete(acceptedResult.page, "outputs_get_accepted");

  const sourceForms = context.sourceForms ?? [];
  const glossaryFacts: readonly GlossaryFact[] =
    sourceForms.length === 0
      ? []
      : (() => {
          const result = glossaryLookup(model, caller, {
            selector: { kind: "source-forms", forms: [...sourceForms] },
            maxRows: MAX_ROWS,
            maxBytes: MAX_BYTES,
          });
          assertComplete(result.page, "glossary_lookup");
          return result.facts;
        })();

  const sourceNeighbors = neighborResult.facts.map((fact) => ({
    surface: "source" as const,
    unitId: fact.factId,
    text: fact.value.sourceSurface,
  }));
  const acceptedNeighbors = acceptedResult.outputs
    .filter(
      (
        output,
      ): output is Extract<(typeof acceptedResult.outputs)[number], { subjectType: "unit" }> =>
        output.subjectType === "unit",
    )
    .map((output) => ({
      surface: "accepted-target" as const,
      unitId: output.subjectId,
      text: output.value.targetSkeleton,
    }));

  return parseQ1ReviewInput({
    unitId: unit.factId,
    contextSnapshotId: model.snapshotId,
    localizationSnapshotId: model.localization.localizationSnapshotId,
    targetLanguage: model.localization.targetLocale,
    reviewScope: unit.value.routeScopes[0]!,
    sourceFacts: [sourceFact(unit), ...glossaryFacts.map(glossaryFact)],
    candidateTarget: context.candidateTarget,
    bibleRenderingIds: context.localizedBible.map((entry) => entry.renderingId),
    localizedBible: [...context.localizedBible],
    neighbors: [...sourceNeighbors, ...acceptedNeighbors],
    backTranslationSignal: context.backTranslationSignal ?? null,
  });
}
