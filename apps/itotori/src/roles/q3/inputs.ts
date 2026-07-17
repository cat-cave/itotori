// The input the Terminology Auditor is allowed to see, and the precondition that
// it may run at all.
//
// The auditor is a DOWNSTREAM reviewer: the deterministic exact glossary and
// name gate has ALREADY run over this unit. Its whole input is the candidate
// target, the exact-gate outcome, the approved glossary forms in play (each
// carrying the EXACT approved target surface the deterministic gate enforced),
// the A2 ruling references the sense judgment grounds against, and optional
// neighbor windows. It judges the contextual SENSE and REGISTER of those
// already-approved forms — it never re-decides a form.
//
// An exact mismatch is not the auditor's to judge: it is a DETERMINISTIC defect
// owned by the exact gate. `assertExactGateCleared` refuses to let the auditor
// proceed when the gate reports a defect, or when an approved form is not
// present verbatim in the candidate — either is the gate's finding, never a
// terminology verdict.

import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  Sha256Schema,
  ShortTextSchema,
  SubjectIdSchema,
} from "../../contracts/index.js";

/** The deterministic gate that owns exact glossary and name matching. An exact
 * mismatch is this gate's defect; the auditor never turns one into a verdict. */
export const EXACT_GATE = "glossary-exact" as const;

/** One approved glossary form in play in this unit, carrying the EXACT target
 * surface the deterministic gate enforced. The auditor treats it as authoritative
 * and immutable — it judges the form's contextual sense, it does not re-rule it. */
export const Q3ApprovedTermSchema = z
  .object({
    termId: SubjectIdSchema,
    sourceForm: ShortTextSchema,
    approvedTargetForm: ShortTextSchema,
  })
  .strict();

/** The outcome of the deterministic exact glossary and name gate for this unit.
 * `cleared` is the ONLY status under which the auditor may judge; `defect` is an
 * exact mismatch the gate owns. */
export const Q3ExactGateSchema = z
  .object({
    gate: z.literal(EXACT_GATE),
    status: z.enum(["cleared", "defect"]),
  })
  .strict();

/** A neighbor window — source context or an already-accepted target line — that
 * grounds the contextual sense of a term without re-opening its form. */
export const Q3NeighborWindowSchema = z
  .object({
    surface: z.enum(["source", "accepted-target"]),
    unitId: IdentifierSchema,
    text: NonEmptyTextSchema,
  })
  .strict();

/** The complete terminology-audit input for one unit. */
export const Q3ReviewInputSchema = z
  .object({
    unitId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    candidateTarget: NonEmptyTextSchema,
    exactGate: Q3ExactGateSchema,
    approvedTerms: z.array(Q3ApprovedTermSchema).max(1_024),
    termRulingIds: z.array(IdentifierSchema).max(1_024),
    neighbors: z.array(Q3NeighborWindowSchema).max(1_024),
  })
  .strict();

export type Q3ApprovedTerm = z.infer<typeof Q3ApprovedTermSchema>;
export type Q3ExactGate = z.infer<typeof Q3ExactGateSchema>;
export type Q3NeighborWindow = z.infer<typeof Q3NeighborWindowSchema>;
export type Q3ReviewInput = z.infer<typeof Q3ReviewInputSchema>;

/** Thrown when the auditor is asked to run before the exact gate has cleared. The
 * gate — not the auditor — owns the exact mismatch it reports. */
export class Q3PrematureAuditError extends Error {
  constructor(
    readonly owningGate: typeof EXACT_GATE,
    detail: string,
  ) {
    super(`terminology audit is downstream of the ${owningGate} gate: ${detail}`);
    this.name = "Q3PrematureAuditError";
  }
}

/** Whether every approved form is present verbatim in the candidate and the gate
 * reports it cleared. A `false` here is a deterministic exact-gate defect, not a
 * terminology judgement. */
export function exactGateCleared(input: Q3ReviewInput): boolean {
  if (input.exactGate.status !== "cleared") return false;
  return input.approvedTerms.every((term) =>
    input.candidateTarget.includes(term.approvedTargetForm),
  );
}

/** Prove the exact gate has cleared before the auditor may judge. A gate defect,
 * or an approved form absent from the candidate, is an exact mismatch the gate
 * owns; the auditor refuses it rather than issuing a verdict. */
export function assertExactGateCleared(input: Q3ReviewInput): void {
  if (input.exactGate.status !== "cleared") {
    throw new Q3PrematureAuditError(
      EXACT_GATE,
      "the exact gate reports a defect; the mismatch is the gate's, not a terminology verdict",
    );
  }
  for (const term of input.approvedTerms) {
    if (!input.candidateTarget.includes(term.approvedTargetForm)) {
      throw new Q3PrematureAuditError(
        EXACT_GATE,
        `approved form for ${term.termId} is not present verbatim — an exact mismatch the gate owns`,
      );
    }
  }
}

/** Parse the terminology-audit shape. A defect-status input is a valid SHAPE —
 * it is the gate's to route — so parsing does not throw on it; `runQ3Audit` and
 * `buildQ3CallSpec` refuse to produce a verdict for it. */
export function parseQ3ReviewInput(raw: unknown): Q3ReviewInput {
  return Q3ReviewInputSchema.parse(raw);
}
