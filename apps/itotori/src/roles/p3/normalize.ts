// Normalize a semantic-repair REQUEST into the exact, deterministic shape the
// fresh blinded grounded fork consumes.
//
// The Semantic Repair specialist is a FRESH author thread opened only for
// material MEANING defects. Its input is a defect bundle (the exact failing
// spans, evidence, and repair constraints), the CURRENT candidate for each
// failing unit — presented anonymously, blinded to whoever authored it — and
// the pre-draft grounding (source skeletons plus the localized-bible rendering
// ids). This module derives the FAILED unit set from the bundle and proves the
// request is well formed: the bundle must actually demand a repair, every
// defect must name a unit that has a candidate, and the candidates must be
// EXACTLY the failed units — no passing unit may ride along. A violation is a
// loud, typed refusal, never a silently narrowed job.

import type { DefectBundle } from "../../contracts/index.js";

/** A protected placeholder carried verbatim from the source skeleton. */
export interface RepairPlaceholder {
  readonly placeholderId: string;
  readonly kind: "control-markup" | "variable" | "ruby";
  readonly sourceText: string;
}

/** One failing unit's grounded source plus its anonymous current candidate.
 * There is deliberately NO author-identity field: the fork is blinded to who
 * produced the candidate. */
export interface RepairCandidateUnit {
  readonly unitId: string;
  readonly sourceHash: string;
  readonly sourceSkeleton: string;
  readonly protectedPlaceholders: readonly RepairPlaceholder[];
  /** The source surface is a deterministic fact.  A choice label carries its
   * choice encoding through the repair even though a Draft never authors that
   * topology itself. */
  readonly surfaceKind?: string;
  readonly choiceContext?: {
    readonly choiceId: string;
    readonly optionIndex: number;
    readonly branchTargetSceneId: string | null;
  } | null;
  /** The current target that failed review — presented without attribution. */
  readonly currentTargetSkeleton: string;
}

/** A pinned source record handed to the fresh fork before it drafts.  It is a
 * projection of decode facts, never model-authored context. */
export interface RepairSourceContext {
  readonly unitId: string;
  readonly sourceHash: string;
  readonly sourceSkeleton: string;
  readonly protectedPlaceholders: readonly RepairPlaceholder[];
  readonly surfaceKind: string | null;
  readonly choiceContext: RepairCandidateUnit["choiceContext"];
}

/** A readable source/wiki fact selected before drafting.  The repair receives
 * facts and rendered bible entries, not the earlier repair's private rationale. */
export interface RepairWikiContext {
  readonly factId: string;
  readonly kind: string;
  readonly text: string;
}

export interface RepairBibleContext {
  readonly renderingId: string;
  readonly text: string;
}

/** The complete pre-draft ground for the blind fork. */
export interface RepairPreDraftContext {
  readonly sourceFacts: readonly RepairSourceContext[];
  readonly wikiFacts: readonly RepairWikiContext[];
  readonly bible: readonly RepairBibleContext[];
}

/** The material-meaning defect the fork must repair, distilled from the bundle. */
export interface RepairDefect {
  readonly defectId: string;
  readonly unitId: string;
  readonly severity: "minor" | "major" | "critical";
  readonly span: {
    readonly spanId: string;
    readonly surface: "source" | "target";
    readonly text: string;
  } | null;
  readonly repairConstraint: string;
  readonly evidenceIds: readonly string[];
}

export interface RepairRequest {
  readonly defectBundle: DefectBundle;
  /** The batch id of the candidate under repair — the patch's parent. */
  readonly candidateBatchId: string;
  /** Exactly the failing units, each with its grounded source and candidate. */
  readonly candidates: readonly RepairCandidateUnit[];
  /** Localized-bible rendering ids the patch must cite (the wiki-first ground). */
  readonly bibleRenderingIds: readonly string[];
  /** Pinned pre-draft source, wiki, and rendered-bible context. */
  readonly preDraftContext: RepairPreDraftContext;
  /** Diagnostic tripwires the repair must not trip (e.g. deterministic gates). */
  readonly tripwires: readonly string[];
}

export interface NormalizedRepair {
  readonly defectBundleId: string;
  readonly candidateBatchId: string;
  readonly localizationSnapshotId: string;
  /** The failed units, in candidate order — the ONLY units a patch may touch. */
  readonly failedUnitIds: readonly string[];
  readonly candidatesById: ReadonlyMap<string, RepairCandidateUnit>;
  readonly defects: readonly RepairDefect[];
  readonly defectsByUnit: ReadonlyMap<string, readonly RepairDefect[]>;
  readonly bibleRenderingIds: readonly string[];
  /** The fully materialized, blinded pre-draft source/wiki/bible ground. */
  readonly preDraftContext: RepairPreDraftContext;
  readonly tripwires: readonly string[];
}

export type RepairFailureCode =
  | "not-a-repair-bundle"
  | "no-defects"
  | "duplicate-candidate"
  | "candidate-passing-unit"
  | "defect-without-candidate"
  | "invalid-pre-draft-context"
  | "blinding-leak";

/** A loud, typed refusal from repair normalization. */
export class RepairError extends Error {
  constructor(
    readonly code: RepairFailureCode,
    detail: string,
  ) {
    super(`p3 repair ${code}: ${detail}`);
    this.name = "RepairError";
  }
}

/** Keys whose presence would disclose an author identity or a prior repair's
 * reasoning.  Constraints/evidence are allowed; retrospective rationale is
 * not.  Keep this local to P3 so the role has no dependency on reviewer code. */
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

function assertNoBlindingLeak(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoBlindingLeak(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BLINDED_KEYS.has(key.toLowerCase())) {
      throw new RepairError("blinding-leak", `forbidden blinded field ${path}.${key}`);
    }
    assertNoBlindingLeak(child, `${path}.${key}`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validatePreDraftContext(
  supplied: RepairPreDraftContext,
  candidates: readonly RepairCandidateUnit[],
  bibleRenderingIds: readonly string[],
): RepairPreDraftContext {
  assertNoBlindingLeak(supplied);
  const sourceById = new Map<string, RepairSourceContext>();
  for (const source of supplied.sourceFacts) {
    if (sourceById.has(source.unitId)) {
      throw new RepairError("invalid-pre-draft-context", `duplicate source fact ${source.unitId}`);
    }
    sourceById.set(source.unitId, source);
  }
  if (
    !sameIds(
      supplied.sourceFacts.map((source) => source.unitId),
      candidates.map((c) => c.unitId),
    )
  ) {
    throw new RepairError(
      "invalid-pre-draft-context",
      "pre-draft source facts must be exactly the failed candidates in order",
    );
  }
  for (const candidate of candidates) {
    const source = sourceById.get(candidate.unitId)!;
    if (
      source.sourceHash !== candidate.sourceHash ||
      source.sourceSkeleton !== candidate.sourceSkeleton
    ) {
      throw new RepairError(
        "invalid-pre-draft-context",
        `source context for ${candidate.unitId} disagrees with its candidate`,
      );
    }
  }
  if (supplied.wikiFacts.length === 0) {
    throw new RepairError("invalid-pre-draft-context", "pre-draft wiki context is empty");
  }
  if (
    !sameIds(
      supplied.bible.map((entry) => entry.renderingId),
      bibleRenderingIds,
    )
  ) {
    throw new RepairError(
      "invalid-pre-draft-context",
      "rendered bible entries must exactly match the cited rendering ids",
    );
  }
  if (supplied.bible.some((entry) => entry.text.trim().length === 0)) {
    throw new RepairError("invalid-pre-draft-context", "a rendered bible entry is blank");
  }
  return supplied;
}

/**
 * Normalize a repair request. Fails loud when the bundle does not demand a
 * repair, when it names no defect, when a candidate is duplicated, when a
 * candidate is supplied for a unit with no defect (a PASSING unit — never in
 * scope), or when a defect names a unit that has no candidate.
 */
export function normalizeRepairRequest(request: RepairRequest): NormalizedRepair {
  assertNoBlindingLeak(request);
  const bundle = request.defectBundle;
  if (bundle.resolution !== "repair") {
    throw new RepairError(
      "not-a-repair-bundle",
      `bundle resolution is '${bundle.resolution}', not 'repair'`,
    );
  }
  if (bundle.defects.length === 0) {
    throw new RepairError("no-defects", "a repair bundle must carry at least one defect");
  }

  const candidatesById = new Map<string, RepairCandidateUnit>();
  for (const candidate of request.candidates) {
    if (candidatesById.has(candidate.unitId)) {
      throw new RepairError("duplicate-candidate", `unit ${candidate.unitId} appears twice`);
    }
    candidatesById.set(candidate.unitId, candidate);
  }

  const defects: RepairDefect[] = bundle.defects.map((defect) => ({
    defectId: defect.defectId,
    unitId: defect.unitId,
    severity: defect.severity,
    span: defect.span,
    repairConstraint: defect.repairConstraint,
    evidenceIds: [...defect.evidenceIds],
  }));

  const defectsByUnit = new Map<string, RepairDefect[]>();
  for (const defect of defects) {
    if (!candidatesById.has(defect.unitId)) {
      throw new RepairError(
        "defect-without-candidate",
        `defect ${defect.defectId} names unit ${defect.unitId}, which has no candidate`,
      );
    }
    const list = defectsByUnit.get(defect.unitId) ?? [];
    list.push(defect);
    defectsByUnit.set(defect.unitId, list);
  }

  // Every candidate MUST be a failing unit — a candidate with no defect is a
  // passing unit smuggled into the job and is rejected (failed ids only).
  for (const candidate of request.candidates) {
    if (!defectsByUnit.has(candidate.unitId)) {
      throw new RepairError(
        "candidate-passing-unit",
        `unit ${candidate.unitId} has a candidate but no defect — passing units are out of scope`,
      );
    }
  }

  // Failed unit ids in candidate order — the exact, ordered scope of the patch.
  const failedUnitIds = request.candidates.map((candidate) => candidate.unitId);
  const preDraftContext = validatePreDraftContext(
    request.preDraftContext,
    request.candidates,
    request.bibleRenderingIds,
  );

  return {
    defectBundleId: bundle.bundleId,
    candidateBatchId: request.candidateBatchId,
    localizationSnapshotId: bundle.localizationSnapshotId,
    failedUnitIds,
    candidatesById,
    defects,
    defectsByUnit,
    bibleRenderingIds: [...request.bibleRenderingIds],
    preDraftContext,
    tripwires: [...request.tripwires],
  };
}
