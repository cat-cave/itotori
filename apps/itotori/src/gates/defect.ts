// Deterministic-gate defect construction + the authoritative category/gate/
// severity tables. Every deterministic gate emits its verdict through the one
// builder here so the emitted {@link Defect} always satisfies the strict
// `DefectSchema` (origin "deterministic") and every category maps to exactly
// one gate. A gate NEVER hand-rolls a defect object.

import { createHash } from "node:crypto";

import type { Defect } from "../contracts/index.js";

import type { DeterministicDefectCategory, DeterministicGate } from "./contract-types.js";

export type { DeterministicDefectCategory } from "./contract-types.js";

export type DefectSeverity = "minor" | "major" | "critical";

/** The single source of truth mapping every deterministic defect category to
 * its owning gate. Facts computed by a gate are authoritative for its
 * categories; nothing else may claim them. */
const CATEGORY_GATE: Readonly<Record<DeterministicDefectCategory, DeterministicGate>> = {
  "protected-span": "protected-spans",
  "unit-cardinality": "cardinality-order-hash",
  "unit-order": "cardinality-order-hash",
  "source-hash": "cardinality-order-hash",
  "glossary-exact": "glossary-exact",
  encoding: "encoding-policy",
  "byte-limit": "byte-box",
  markup: "markup-controls",
  "control-sequence": "markup-controls",
  punctuation: "markup-controls",
  evidence: "evidence-scope",
  scope: "evidence-scope",
  "patch-coverage": "patch-coverage",
  render: "render-ocr",
  ocr: "render-ocr",
};

const CATEGORY_SEVERITY: Readonly<Record<DeterministicDefectCategory, DefectSeverity>> = {
  "protected-span": "critical",
  "unit-cardinality": "critical",
  "unit-order": "critical",
  "source-hash": "critical",
  "glossary-exact": "major",
  encoding: "major",
  "byte-limit": "major",
  markup: "major",
  "control-sequence": "major",
  punctuation: "minor",
  evidence: "major",
  scope: "major",
  "patch-coverage": "critical",
  render: "major",
  ocr: "major",
};

/** The gate that owns a category — used by the facts-dominate join to know
 * which reviewer categories a fired deterministic defect can suppress. */
export function gateForCategory(category: DeterministicDefectCategory): DeterministicGate {
  return CATEGORY_GATE[category];
}

/** Stable hex digest over an ordered tuple — deterministic ids, no clock. */
export function stableDigest(...parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export type DefectDraft = {
  unitId: string;
  category: DeterministicDefectCategory;
  detail: string;
  /** Fact ids the verdict is grounded on; also used as evidence (min 1). */
  basisFactIds: readonly string[];
  /** Optional offending target/source span. */
  span?: { surface: "source" | "target"; text: string } | null;
  /** Optional reviewer lanes this defect informs (join hint). */
  implicatedReviewLanes?: Defect["implicatedReviewLanes"];
};

const MAX_SPAN_TEXT = 1_024;
const MAX_DETAIL = 1_024;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Build a strictly-valid deterministic {@link Defect}. The category fixes the
 * gate and severity; the caller supplies the grounding facts (>=1) and detail.
 * Throws if no basis fact is supplied — a deterministic defect must be able to
 * cite the fact it is grounded on (evidenceIds is min 1). This is how "facts
 * dominate" is made structural: every deterministic verdict carries its fact.
 */
export function buildDefect(draft: DefectDraft): Defect {
  if (draft.basisFactIds.length === 0) {
    throw new GateEvaluationError(
      `deterministic defect for ${draft.unitId} (${draft.category}) has no grounding fact`,
    );
  }
  const gate = CATEGORY_GATE[draft.category];
  const severity = CATEGORY_SEVERITY[draft.category];
  const detail = clamp(draft.detail, MAX_DETAIL);
  const span =
    draft.span == null
      ? null
      : {
          spanId: `span:${stableDigest(draft.unitId, draft.category, draft.span.surface, draft.span.text).slice(0, 24)}`,
          surface: draft.span.surface,
          text: clamp(draft.span.text.length === 0 ? "∅" : draft.span.text, MAX_SPAN_TEXT),
        };
  return {
    origin: "deterministic",
    defectId: `defect:${gate}:${stableDigest(draft.unitId, draft.category, detail).slice(0, 24)}`,
    unitId: draft.unitId,
    severity,
    span,
    evidenceIds: [...draft.basisFactIds],
    basisFactIds: [...draft.basisFactIds],
    repairConstraint: clamp(detail, MAX_SPAN_TEXT),
    implicatedGates: [gate],
    implicatedReviewLanes: [...(draft.implicatedReviewLanes ?? [])],
    category: draft.category,
    gate,
  };
}

/**
 * Thrown when a gate is handed an input it structurally cannot evaluate (an
 * accepted output for a unit absent from the snapshot, a render gate with no
 * render facts for a unit that expects runtime evidence, a source-hash that
 * cannot be compared). A gate NEVER silently skips such an input — it fails
 * loud so an un-gated output can never masquerade as a clean pass.
 */
export class GateEvaluationError extends Error {
  constructor(detail: string) {
    super(`deterministic gate cannot evaluate: ${detail}`);
    this.name = "GateEvaluationError";
  }
}
