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
  /** The current target that failed review — presented without attribution. */
  readonly currentTargetSkeleton: string;
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
  readonly tripwires: readonly string[];
}

export type RepairFailureCode =
  | "not-a-repair-bundle"
  | "no-defects"
  | "duplicate-candidate"
  | "candidate-passing-unit"
  | "defect-without-candidate";

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

/**
 * Normalize a repair request. Fails loud when the bundle does not demand a
 * repair, when it names no defect, when a candidate is duplicated, when a
 * candidate is supplied for a unit with no defect (a PASSING unit — never in
 * scope), or when a defect names a unit that has no candidate.
 */
export function normalizeRepairRequest(request: RepairRequest): NormalizedRepair {
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

  return {
    defectBundleId: bundle.bundleId,
    candidateBatchId: request.candidateBatchId,
    localizationSnapshotId: bundle.localizationSnapshotId,
    failedUnitIds,
    candidatesById,
    defects,
    defectsByUnit,
    bibleRenderingIds: [...request.bibleRenderingIds],
    tripwires: [...request.tripwires],
  };
}
