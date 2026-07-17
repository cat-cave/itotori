// Citation resolution — bind model-selected evidence ids to snapshot facts.
//
// A source-Wiki model may select only an evidence id, supporting role, and
// optional verbatim quote. The snapshot is authoritative for every mechanical
// citation coordinate, so this module overwrites those coordinates before the
// independent claim-validation gate checks them again.

import type { Citation, WikiObject } from "../contracts/index.js";
import type { ReadModel } from "../read-tools/model.js";

import { buildEvidenceIndex } from "./evidence-index.js";

type SourceWikiObject = Exclude<WikiObject, { kind: "translation" }>;

export type CitationResolutionFailureCode = "evidence-unresolvable" | "quoted-span-not-found";

/** Raised when a model-selected citation cannot be bound to the immutable
 * snapshot, including when its optional read-proof is not verbatim source text. */
export class CitationResolutionError extends Error {
  constructor(
    readonly code: CitationResolutionFailureCode,
    readonly claimId: string,
    readonly evidenceId: string,
    detail: string,
  ) {
    super(`citation ${evidenceId} for claim ${claimId} ${code}: ${detail}`);
    this.name = "CitationResolutionError";
  }
}

function sourceTextByFactId(model: ReadModel): ReadonlyMap<string, string> {
  return new Map(
    model.factSnapshot.orderedUnits.map((unit) => [
      unit.factId,
      model.bundleUnits.get(unit.bridgeUnitId)?.sourceText ?? "",
    ]),
  );
}

/**
 * Resolve each model-selected evidence id against the snapshot and return a new
 * source object with the snapshot-owned citation coordinates. The model cites a
 * short LABEL (u1, u2, …) it can copy verbatim; `labelToFactId` maps that label
 * to the real (uuid-based) fact id — a flash model cannot transcribe the fact id
 * itself. The persisted citation carries the real fact id + snapshot-owned hash,
 * subject, and play order; the model keeps its claim prose, support role, and
 * verbatim quoted span. An unknown label or a non-verbatim quote fails loudly.
 */
export function resolveObjectCitations<T extends SourceWikiObject>(
  object: T,
  model: ReadModel,
  labelToFactId: ReadonlyMap<string, string>,
): T {
  const index = buildEvidenceIndex(model);
  const sourceTexts = sourceTextByFactId(model);

  return {
    ...object,
    claims: object.claims.map((claim) => ({
      ...claim,
      citations: claim.citations.map((citation) => {
        const factId = labelToFactId.get(citation.evidenceId);
        const record = factId === undefined ? undefined : index.get(factId);
        if (factId === undefined || record === undefined) {
          throw new CitationResolutionError(
            "evidence-unresolvable",
            claim.claimId,
            citation.evidenceId,
            "citation label does not name a provided unit in this snapshot",
          );
        }

        if (
          citation.quotedSpan != null &&
          !sourceTexts.get(factId)?.includes(citation.quotedSpan)
        ) {
          throw new CitationResolutionError(
            "quoted-span-not-found",
            claim.claimId,
            citation.evidenceId,
            "quotedSpan is not a verbatim substring of the cited unit's source text",
          );
        }

        return {
          ...citation,
          evidenceId: factId,
          evidenceHash: record.hash as Citation["evidenceHash"],
          snapshotId: record.snapshotId as Citation["snapshotId"],
          subject: record.subject,
          playOrderIndex: record.fromPlayOrder,
        };
      }),
    })),
  } as T;
}
