// Bind exactly one accepted, source-hash-matched target to every scoped unit.
//
// This is the strict accepted-output <-> snapshot join the patchback stands on.
// It is the ONLY place the target body is chosen, and it is chosen from the
// accepted-output CAS (`accepted.value.targetSkeleton`), never a prior attempt
// record. A runtime schema check stops an untyped caller from smuggling another
// record shape into this native byte boundary. A missing, duplicate,
// hash-mismatched, or off-snapshot target is fatal — the whole apply fails loud
// rather than splice a partial or fabricated body.

import { AcceptedOutputSchema } from "../contracts/index.js";
import type { FactSnapshot, OrderedUnitFact } from "../prepass/index.js";

import type { AcceptedUnitOutput, BoundScopedTarget, NativePatchbackInput } from "./types.js";
import { PatchbackBindingError } from "./types.js";

/** Index a snapshot's ordered units by their stable fact id. */
function indexUnitsByFactId(snapshot: FactSnapshot): ReadonlyMap<string, OrderedUnitFact> {
  const byId = new Map<string, OrderedUnitFact>();
  for (const unit of snapshot.orderedUnits) {
    byId.set(unit.factId, unit);
  }
  return byId;
}

/** Index accepted outputs by their subject unit id, failing loud on a subject
 * that is absent from the snapshot or claimed by more than one accepted output. */
function indexAcceptedBySubject(
  snapshot: FactSnapshot,
  unitsByFactId: ReadonlyMap<string, OrderedUnitFact>,
  accepted: readonly AcceptedUnitOutput[],
): ReadonlyMap<string, AcceptedUnitOutput> {
  const bySubject = new Map<string, AcceptedUnitOutput>();
  for (const supplied of accepted) {
    const parsed = AcceptedOutputSchema.safeParse(supplied);
    if (!parsed.success || parsed.data.subjectType !== "unit") {
      const record = supplied as unknown as { outputId?: unknown; subjectId?: unknown };
      const suppliedId = typeof record.subjectId === "string" ? record.subjectId : "<unknown>";
      const outputId = typeof record.outputId === "string" ? record.outputId : "<unknown>";
      throw new PatchbackBindingError(
        "invalid-accepted-output",
        [suppliedId],
        `supplied accepted output ${outputId} is not a schema-valid unit accepted output`,
      );
    }
    const output = parsed.data;
    if (!unitsByFactId.has(output.subjectId)) {
      throw new PatchbackBindingError(
        "accepted-subject-not-in-snapshot",
        [output.subjectId],
        `accepted output ${output.outputId} names unit ${output.subjectId}, absent from snapshot ${snapshot.snapshotId}`,
      );
    }
    if (bySubject.has(output.subjectId)) {
      throw new PatchbackBindingError(
        "duplicate-accepted-target",
        [output.subjectId],
        `two accepted outputs claim unit ${output.subjectId} in snapshot ${snapshot.snapshotId}`,
      );
    }
    bySubject.set(output.subjectId, output);
  }
  return bySubject;
}

/**
 * Bind every scoped unit to exactly one accepted, source-hash-matched target.
 *
 * Failure modes (all fatal, never silently skipped):
 *   - empty work scope,
 *   - a scoped fact id absent from the snapshot,
 *   - an accepted output for a subject absent from the snapshot,
 *   - two accepted outputs claiming the same unit,
 *   - a scoped unit with no accepted target (partial coverage),
 *   - an accepted target whose `sourceHash` differs from the snapshot fact's.
 *
 * Returns the bound targets in scoped-fact-id order (deterministic).
 */
export function bindScopedTargets(input: NativePatchbackInput): readonly BoundScopedTarget[] {
  const scopedIds = [...input.workScope.inScopeUnitFactIds];
  if (scopedIds.length === 0) {
    throw new PatchbackBindingError(
      "empty-scope",
      [],
      "work scope declared zero in-scope units; the patchback never applies an empty scope",
    );
  }
  const duplicateScoped = [
    ...new Set(scopedIds.filter((id, index) => scopedIds.indexOf(id) !== index)),
  ];
  if (duplicateScoped.length > 0) {
    throw new PatchbackBindingError(
      "duplicate-scoped-unit",
      duplicateScoped,
      "work scope names a unit more than once; each scoped unit requires exactly one target",
    );
  }
  const unitsByFactId = indexUnitsByFactId(input.snapshot);
  const acceptedBySubject = indexAcceptedBySubject(input.snapshot, unitsByFactId, input.accepted);

  // Reject an unknown scoped id (a scope that names a unit the snapshot does not
  // carry) before any binding, so a stale scope can never silently under-cover.
  const unknownScoped = scopedIds.filter((id) => !unitsByFactId.has(id));
  if (unknownScoped.length > 0) {
    throw new PatchbackBindingError(
      "unknown-scoped-unit",
      unknownScoped,
      `work scope names unit id(s) absent from snapshot ${input.snapshot.snapshotId}`,
    );
  }

  const missing: string[] = [];
  const hashMismatch: string[] = [];
  const bound: BoundScopedTarget[] = [];
  for (const factId of [...scopedIds].sort()) {
    const fact = unitsByFactId.get(factId)!;
    const accepted = acceptedBySubject.get(factId);
    if (accepted === undefined) {
      missing.push(factId);
      continue;
    }
    if (accepted.sourceHash !== fact.sourceHash) {
      hashMismatch.push(factId);
      continue;
    }
    bound.push({ fact, accepted, targetText: accepted.value.targetSkeleton });
  }

  // Partial coverage is a hard reject — no partial-flag apply.
  if (missing.length > 0) {
    throw new PatchbackBindingError(
      "no-accepted-target",
      missing,
      `${missing.length} scoped unit(s) have no accepted target (partial coverage rejected)`,
    );
  }
  if (hashMismatch.length > 0) {
    throw new PatchbackBindingError(
      "source-hash-mismatch",
      hashMismatch,
      `${hashMismatch.length} scoped unit(s) bound an accepted target whose sourceHash differs from the snapshot fact (stale draft)`,
    );
  }
  return bound;
}
