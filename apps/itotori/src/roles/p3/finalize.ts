// Deterministic guards for the Semantic Repair fork's input and output.
//
// Two guarantees the schema alone cannot prove live here:
//   - the built call is a FRESH BLINDED GROUNDED FORK — exactly a system turn
//     and one grounded user turn, no author-thread turn, no attribution of who
//     produced the candidate, and real grounding (source + localized bible);
//   - the returned patch touches the FAILED units ONLY and is MINIMAL — the
//     patch scope is exactly the bundle's failed set (a passing id smuggled
//     into the scope is rejected), the patch draft ids equal that set in order,
//     and every draft preserves its source hash and protected placeholders.
// Any violation throws a typed RepairFinalizeError — a mismatch is a failure,
// never a repaired or fabricated result.

import type { Draft, DraftBatch } from "../../contracts/index.js";
import { firstNonSjisCodePoint } from "../../gates/shift-jis.js";
import { REPAIR_MODE, type RepairCall } from "./call.js";
import type { NormalizedRepair } from "./normalize.js";

export type RepairFinalizeCode =
  | "not-fresh-fork"
  | "author-identity-leak"
  | "not-grounded"
  | "scope-kind-mismatch"
  | "repair-mode-mismatch"
  | "parent-mismatch"
  | "bundle-mismatch"
  | "failed-ids-mismatch"
  | "passing-id-patch"
  | "patch-order"
  | "source-hash"
  | "protected-span"
  | "encoding"
  | "choice-encoding"
  | "basis-mismatch"
  | "resolving-evidence";

export class RepairFinalizeError extends Error {
  constructor(
    readonly code: RepairFinalizeCode,
    detail: string,
  ) {
    super(`p3 finalize ${code}: ${detail}`);
    this.name = "RepairFinalizeError";
  }
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Keys that would attribute the candidate to its author or disclose the prior
// repair's reasoning. The fork is blinded to both. Keys are inspected in parsed
// JSON rather than by substring so the P3 instructions may state this policy.
const FORBIDDEN_BLINDED_KEYS = new Set([
  "author",
  "authorid",
  "authoredby",
  "producedby",
  "producingrole",
  "authorrole",
  "authormodel",
  "priormodel",
  "provider",
  "providerid",
  "priorauthor",
  "priorrepairrationale",
  "repairrationale",
  "priorrationale",
]);

function findForbiddenBlindedKey(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenBlindedKey(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BLINDED_KEYS.has(key.toLowerCase())) return `${path}.${key}`;
    const found = findForbiddenBlindedKey(child, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

/** Assert the built call is a fresh, blinded, grounded fork: exactly a system
 * turn and one user turn (no author-thread assistant turn), no author-identity
 * attribution anywhere in the payloads, and real grounding — the seed carries
 * source skeletons and at least one localized-bible rendering id. */
export function assertBlindedGroundedFork(call: RepairCall): void {
  const roles = call.spec.messages.map((message) =>
    message.kind === "text" ? message.role : message.kind,
  );
  if (!idsEqual(roles, ["system", "user"])) {
    throw new RepairFinalizeError(
      "not-fresh-fork",
      `a fresh fork is [system, user], not [${roles.join(", ")}]`,
    );
  }
  const userMessage = call.spec.messages.find(
    (message) => message.kind === "text" && message.role === "user",
  );
  const seedRef =
    userMessage?.kind === "text" ? userMessage.contentEncrypted.storageRef : undefined;
  const seedText = seedRef ? call.payloads.get(seedRef) : undefined;
  let seed: Record<string, unknown> | undefined;
  try {
    seed = seedText ? (JSON.parse(seedText) as Record<string, unknown>) : undefined;
  } catch {
    throw new RepairFinalizeError("not-grounded", "the grounded seed is not valid JSON");
  }
  const leak = findForbiddenBlindedKey(seed);
  if (leak !== null) {
    throw new RepairFinalizeError(
      "author-identity-leak",
      `the fork must be blinded to author identity and prior repair rationale (${leak})`,
    );
  }
  const preDraft = seed?.["preDraftContext"] as
    | {
        sourceFacts?: unknown;
        wikiFacts?: unknown;
        bible?: unknown;
      }
    | undefined;
  const units = seed?.["units"];
  const grounded =
    Array.isArray(preDraft?.sourceFacts) &&
    preDraft.sourceFacts.length > 0 &&
    Array.isArray(preDraft.wikiFacts) &&
    preDraft.wikiFacts.length > 0 &&
    Array.isArray(preDraft.bible) &&
    preDraft.bible.length > 0 &&
    Array.isArray(units) &&
    units.length > 0 &&
    units.every(
      (unit) => typeof (unit as { sourceSkeleton?: unknown }).sourceSkeleton === "string",
    );
  if (!grounded) {
    throw new RepairFinalizeError(
      "not-grounded",
      "the fork must be grounded in pre-draft source, wiki, and localized-bible context",
    );
  }
}

const PLACEHOLDER_TOKEN = /\{\{([^{}]+)\}\}/gu;

function placeholderMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    const id = match[1]!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Assert the returned batch is a MINIMAL repair patch for the FAILED units
 * ONLY, and return its patch drafts. The scope must be a repair-patch fresh
 * fork bound to this candidate batch and defect bundle; its failed set must be
 * EXACTLY the bundle's failed units (a passing id in the scope is rejected);
 * the patch drafts must equal that set in order (no patch to a passing/unknown
 * id); and every draft must preserve its source hash and protected
 * placeholders. */
export function assertRepairPatchBatch(
  normalized: NormalizedRepair,
  batch: DraftBatch,
): readonly Draft[] {
  const scope = batch.scope;
  if (scope.kind !== "repair-patch") {
    throw new RepairFinalizeError(
      "scope-kind-mismatch",
      `expected a repair-patch batch, got ${scope.kind}`,
    );
  }
  if (scope.repairMode !== REPAIR_MODE) {
    throw new RepairFinalizeError(
      "repair-mode-mismatch",
      `repair mode is '${scope.repairMode}', not '${REPAIR_MODE}'`,
    );
  }
  if (scope.parentDraftBatchId !== normalized.candidateBatchId) {
    throw new RepairFinalizeError("parent-mismatch", "patch names another candidate batch");
  }
  if (scope.defectBundleId !== normalized.defectBundleId) {
    throw new RepairFinalizeError("bundle-mismatch", "patch names another defect bundle");
  }
  // FAILED IDS ONLY: the patch scope must be exactly the bundle's failed set,
  // in order. A passing id inflated into the scope is rejected here.
  if (!idsEqual(scope.failedUnitIds, normalized.failedUnitIds)) {
    throw new RepairFinalizeError(
      "failed-ids-mismatch",
      "patch failed set is not exactly the bundle's failed units",
    );
  }
  const failedSet = new Set(normalized.failedUnitIds);
  for (const draft of batch.drafts) {
    if (!failedSet.has(draft.unitId)) {
      throw new RepairFinalizeError(
        "passing-id-patch",
        `unit ${draft.unitId} is not a failed unit — a patch to a passing id is rejected`,
      );
    }
  }
  const draftIds = batch.drafts.map((draft) => draft.unitId);
  if (!idsEqual(draftIds, normalized.failedUnitIds)) {
    throw new RepairFinalizeError(
      "patch-order",
      "patch drafts must be exactly the failed units, in order",
    );
  }
  for (const draft of batch.drafts) {
    const candidate = normalized.candidatesById.get(draft.unitId)!;
    if (draft.sourceHash !== candidate.sourceHash) {
      throw new RepairFinalizeError(
        "source-hash",
        `unit ${draft.unitId} patch hash ${draft.sourceHash} != source ${candidate.sourceHash}`,
      );
    }
    const expected = new Map<string, number>();
    for (const placeholder of candidate.protectedPlaceholders) {
      expected.set(placeholder.placeholderId, (expected.get(placeholder.placeholderId) ?? 0) + 1);
    }
    const actual = placeholderMultiset(draft.targetSkeleton);
    for (const [id, count] of expected) {
      if (actual.get(id) !== count) {
        throw new RepairFinalizeError(
          "protected-span",
          `unit ${draft.unitId} dropped protected placeholder ${id}`,
        );
      }
    }
    for (const id of actual.keys()) {
      if (!expected.has(id)) {
        throw new RepairFinalizeError(
          "protected-span",
          `unit ${draft.unitId} fabricated placeholder ${id}`,
        );
      }
    }
    const offending = firstNonSjisCodePoint(draft.targetSkeleton);
    if (offending !== null) {
      throw new RepairFinalizeError(
        "encoding",
        `unit ${draft.unitId} target contains ${offending.label} (${offending.reason})`,
      );
    }
    if (
      candidate.surfaceKind === "choice_label" &&
      (candidate.choiceContext === undefined || candidate.choiceContext === null)
    ) {
      throw new RepairFinalizeError(
        "choice-encoding",
        `choice-label unit ${draft.unitId} is missing its deterministic choice context`,
      );
    }
    if (candidate.surfaceKind === "choice_label" && /[\r\n]/u.test(draft.targetSkeleton)) {
      throw new RepairFinalizeError(
        "choice-encoding",
        `choice-label unit ${draft.unitId} must remain one encoded choice label`,
      );
    }
    if (
      draft.basis.kind !== "wiki-first" ||
      !idsEqual(draft.basis.bibleRenderingIds, normalized.bibleRenderingIds)
    ) {
      throw new RepairFinalizeError(
        "basis-mismatch",
        `unit ${draft.unitId} patch basis is not the exact localized-bible ground`,
      );
    }
    const resolvingEvidence = new Set(
      (normalized.defectsByUnit.get(draft.unitId) ?? []).flatMap((defect) => defect.evidenceIds),
    );
    if (!draft.evidenceIds.some((evidenceId) => resolvingEvidence.has(evidenceId))) {
      throw new RepairFinalizeError(
        "resolving-evidence",
        `unit ${draft.unitId} patch cites no evidence from its failed finding`,
      );
    }
  }
  return batch.drafts;
}
