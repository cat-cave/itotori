import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogCandidateMatchRecord,
  CatalogCandidateTargetWorkRecord,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogCandidateMatchStatusValues,
  catalogExternalIdKindValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogSource,
} from "../schema.js";

import { normalizeRequest } from "./catalog-fuzzy-candidate-request-normalization.js";
import {
  authoritativeExactExternalIds,
  compareScoredCandidate,
  diagnostic,
  scoreTargets,
} from "./catalog-fuzzy-candidate-scoring.js";
import { result } from "./catalog-fuzzy-candidate-result.js";

export const catalogFuzzyCandidateSchemaVersion = "catalog.fuzzy_candidates.v0.1" as const;
export const catalogFuzzyCandidateGeneratorVersion = "deterministic-title-year.v0.1" as const;

export const catalogFuzzyCandidateStatusValues = {
  generated: "generated",
  noCandidates: "no_candidates",
  exactMatchSkipped: "exact_match_skipped",
  conflict: "conflict",
  invalid: "invalid",
} as const;

export type CatalogFuzzyCandidateStatus =
  (typeof catalogFuzzyCandidateStatusValues)[keyof typeof catalogFuzzyCandidateStatusValues];

export const catalogFuzzyCandidateDiagnosticCodeValues = {
  invalidRequest: "catalog.fuzzy_candidate.invalid_request",
  exactExternalIdMatch: "catalog.fuzzy_candidate.exact_external_id_match",
  exactExternalIdConflict: "catalog.fuzzy_candidate.exact_external_id_conflict",
  lowConfidence: "catalog.fuzzy_candidate.low_confidence",
  candidateGenerated: "catalog.fuzzy_candidate.generated",
  duplicateSource: "catalog.fuzzy_candidate.duplicate_source",
  noCandidateTargets: "catalog.fuzzy_candidate.no_candidate_targets",
  provenanceMismatch: "catalog.fuzzy_candidate.provenance_mismatch",
} as const;

export type CatalogFuzzyCandidateDiagnosticCode =
  (typeof catalogFuzzyCandidateDiagnosticCodeValues)[keyof typeof catalogFuzzyCandidateDiagnosticCodeValues];

export type CatalogFuzzyCandidateExternalId = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
};

export type CatalogFuzzyCandidateSourceFact = {
  catalogSource: CatalogSource;
  sourceId: string;
  title: string;
  releaseYear?: number;
  sourceProvenanceId?: string;
  externalIds?: CatalogFuzzyCandidateExternalId[];
};

export type CatalogFuzzyCandidateRequest = {
  schemaVersion?: typeof catalogFuzzyCandidateSchemaVersion;
  generatorVersion?: typeof catalogFuzzyCandidateGeneratorVersion;
  minScore?: number;
  maxCandidatesPerSource?: number;
  sourceFacts: CatalogFuzzyCandidateSourceFact[];
};

export type CatalogFuzzyCandidateDiagnostic = {
  code: CatalogFuzzyCandidateDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  sourceId?: string;
  candidateId?: string;
  field?: string;
  score?: number;
  reasonCode: string;
  metadata?: Record<string, unknown>;
};

export type CatalogFuzzyCandidateResult = {
  schemaVersion: typeof catalogFuzzyCandidateSchemaVersion;
  generatorVersion: typeof catalogFuzzyCandidateGeneratorVersion;
  status: CatalogFuzzyCandidateStatus;
  candidates: CatalogCandidateMatchRecord[];
  diagnostics: CatalogFuzzyCandidateDiagnostic[];
};

export interface ItotoriCatalogFuzzyCandidateGeneratorPort {
  generateFuzzyCandidates(
    request: CatalogFuzzyCandidateRequest,
  ): Promise<CatalogFuzzyCandidateResult>;
  listCatalogCandidateMatches(): Promise<CatalogCandidateMatchRecord[]>;
}

export type CatalogFuzzyCandidateRepository = Pick<
  ItotoriCatalogRepositoryPort,
  | "getWorkByExternalId"
  | "listCatalogCandidateTargetWorks"
  | "recordCatalogCandidateMatch"
  | "listCatalogCandidateMatches"
>;

export type ScoredCandidate = {
  target: CatalogCandidateTargetWorkRecord;
  score: number;
  matchedFields: Record<string, unknown>;
};

export type NormalizedRequest = {
  sourceFacts: CatalogFuzzyCandidateSourceFact[];
  minScore: number;
  maxCandidatesPerSource: number;
  generatorVersion: typeof catalogFuzzyCandidateGeneratorVersion;
  diagnostics: CatalogFuzzyCandidateDiagnostic[];
};

export type AuthoritativeExactExternalId = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
};

export const catalogSources = Object.values(catalogSourceValues) as CatalogSource[];
export const catalogExternalIdKinds = Object.values(
  catalogExternalIdKindValues,
) as CatalogExternalIdKind[];

export class ItotoriCatalogFuzzyCandidateGeneratorService implements ItotoriCatalogFuzzyCandidateGeneratorPort {
  constructor(
    private readonly repository: CatalogFuzzyCandidateRepository,
    private readonly actor: AuthorizationActor,
  ) {}

  async generateFuzzyCandidates(
    request: CatalogFuzzyCandidateRequest,
  ): Promise<CatalogFuzzyCandidateResult> {
    const normalized = normalizeRequest(request);
    if (normalized.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return result(catalogFuzzyCandidateStatusValues.invalid, [], normalized.diagnostics);
    }

    const targets = await this.repository.listCatalogCandidateTargetWorks(this.actor);
    if (targets.length === 0) {
      return result(
        catalogFuzzyCandidateStatusValues.noCandidates,
        [],
        [
          ...normalized.diagnostics,
          diagnostic(
            catalogFuzzyCandidateDiagnosticCodeValues.noCandidateTargets,
            "info",
            "No catalog works are available for fuzzy candidate generation.",
            "no_candidate_targets",
          ),
        ],
      );
    }

    const seenSources = new Set<string>();
    const candidates: CatalogCandidateMatchRecord[] = [];
    const diagnostics: CatalogFuzzyCandidateDiagnostic[] = [...normalized.diagnostics];

    for (const sourceFact of normalized.sourceFacts) {
      const sourceKey = `${sourceFact.catalogSource}:${sourceFact.sourceId}`;
      if (seenSources.has(sourceKey)) {
        diagnostics.push(
          diagnostic(
            catalogFuzzyCandidateDiagnosticCodeValues.duplicateSource,
            "warning",
            "Duplicate source fact skipped; existing fuzzy candidates remain reviewable.",
            "duplicate_source",
            { sourceId: sourceFact.sourceId, field: "sourceId" },
          ),
        );
        continue;
      }
      seenSources.add(sourceKey);

      const exactWorkIds = await this.exactMatchedWorkIds(sourceFact);
      if (exactWorkIds.length > 1) {
        diagnostics.push(
          diagnostic(
            catalogFuzzyCandidateDiagnosticCodeValues.exactExternalIdConflict,
            "error",
            "Exact external IDs point at multiple catalog works; fuzzy candidates were not generated for this source.",
            "exact_external_id_conflict",
            {
              sourceId: sourceFact.sourceId,
              field: "externalIds",
              metadata: { matchedWorkIds: exactWorkIds },
            },
          ),
        );
        continue;
      }
      const exactWorkId = exactWorkIds[0];
      if (exactWorkId !== undefined) {
        diagnostics.push(
          diagnostic(
            catalogFuzzyCandidateDiagnosticCodeValues.exactExternalIdMatch,
            "info",
            "Exact external-id match exists; fuzzy candidate generation skipped for this source.",
            "exact_external_id_match",
            {
              sourceId: sourceFact.sourceId,
              field: "externalIds",
              metadata: { workId: exactWorkId },
            },
          ),
        );
        continue;
      }

      const scored = scoreTargets(sourceFact, targets)
        .filter((candidate) => candidate.score >= normalized.minScore)
        .sort(compareScoredCandidate)
        .slice(0, normalized.maxCandidatesPerSource);

      if (scored.length === 0) {
        const best = scoreTargets(sourceFact, targets).sort(compareScoredCandidate)[0];
        diagnostics.push(
          diagnostic(
            catalogFuzzyCandidateDiagnosticCodeValues.lowConfidence,
            "info",
            "No fuzzy catalog candidate met the deterministic confidence threshold.",
            "low_confidence",
            {
              sourceId: sourceFact.sourceId,
              field: "title",
              score: best?.score ?? 0,
            },
          ),
        );
        continue;
      }

      for (const candidate of scored) {
        const provenanceMismatch = await this.provenanceMismatchDiagnostic(
          sourceFact,
          candidate.target.workId,
          normalized.generatorVersion,
        );
        const persisted = await this.repository.recordCatalogCandidateMatch(this.actor, {
          sourceCatalogSource: sourceFact.catalogSource,
          sourceId: sourceFact.sourceId,
          sourceTitle: sourceFact.title,
          ...(sourceFact.sourceProvenanceId === undefined
            ? {}
            : { sourceProvenanceId: sourceFact.sourceProvenanceId }),
          targetWorkId: candidate.target.workId,
          score: candidate.score,
          matchedFields: candidate.matchedFields,
          status: catalogCandidateMatchStatusValues.reviewPending,
          diagnosticCode: catalogFuzzyCandidateDiagnosticCodeValues.candidateGenerated,
          generatorVersion: normalized.generatorVersion,
          metadata: {
            autoMerge: false,
            sourceReleaseYear: sourceFact.releaseYear ?? null,
            targetCanonicalTitle: candidate.target.canonicalTitle,
            targetFirstReleaseYear: candidate.target.firstReleaseYear,
          },
        });
        candidates.push(persisted);
        if (provenanceMismatch !== null) {
          diagnostics.push(provenanceMismatch);
        }
        diagnostics.push(
          diagnostic(
            catalogFuzzyCandidateDiagnosticCodeValues.candidateGenerated,
            "info",
            "Fuzzy catalog candidate recorded for review; no canonical catalog record was mutated.",
            "review_required_no_auto_merge",
            {
              sourceId: sourceFact.sourceId,
              candidateId: persisted.candidateId,
              field: "title",
              score: persisted.score,
            },
          ),
        );
      }
    }

    if (
      diagnostics.some(
        (entry) => entry.code === catalogFuzzyCandidateDiagnosticCodeValues.exactExternalIdConflict,
      )
    ) {
      return result(catalogFuzzyCandidateStatusValues.conflict, candidates, diagnostics);
    }
    if (candidates.length > 0) {
      return result(catalogFuzzyCandidateStatusValues.generated, candidates, diagnostics);
    }
    if (
      diagnostics.some(
        (entry) => entry.code === catalogFuzzyCandidateDiagnosticCodeValues.exactExternalIdMatch,
      )
    ) {
      return result(catalogFuzzyCandidateStatusValues.exactMatchSkipped, candidates, diagnostics);
    }
    return result(catalogFuzzyCandidateStatusValues.noCandidates, candidates, diagnostics);
  }

  async listCatalogCandidateMatches(): Promise<CatalogCandidateMatchRecord[]> {
    return this.repository.listCatalogCandidateMatches(this.actor);
  }

  private async exactMatchedWorkIds(
    sourceFact: CatalogFuzzyCandidateSourceFact,
  ): Promise<string[]> {
    const exactIds = authoritativeExactExternalIds(sourceFact);
    const workIds = new Set<string>();
    for (const externalId of exactIds) {
      const snapshot = await this.repository.getWorkByExternalId(
        this.actor,
        externalId.catalogSource,
        externalId.sourceId,
        externalId.externalIdKind,
      );
      if (snapshot !== null) {
        workIds.add(snapshot.workId);
      }
    }
    return Array.from(workIds).sort();
  }

  private async provenanceMismatchDiagnostic(
    sourceFact: CatalogFuzzyCandidateSourceFact,
    targetWorkId: string,
    generatorVersion: string,
  ): Promise<CatalogFuzzyCandidateDiagnostic | null> {
    if (sourceFact.sourceProvenanceId === undefined) {
      return null;
    }
    const existing = (await this.repository.listCatalogCandidateMatches(this.actor)).find(
      (candidate) =>
        candidate.sourceCatalogSource === sourceFact.catalogSource &&
        candidate.sourceId === sourceFact.sourceId &&
        candidate.targetWorkId === targetWorkId &&
        candidate.generatorVersion === generatorVersion,
    );
    if (
      existing === undefined ||
      existing.sourceProvenanceId === null ||
      existing.sourceProvenanceId === sourceFact.sourceProvenanceId
    ) {
      return null;
    }
    return diagnostic(
      catalogFuzzyCandidateDiagnosticCodeValues.provenanceMismatch,
      "warning",
      "Existing fuzzy candidate provenance differs from the current source fact; review is still required.",
      "source_provenance_mismatch",
      {
        sourceId: sourceFact.sourceId,
        candidateId: existing.candidateId,
        field: "sourceProvenanceId",
        metadata: {
          existingSourceProvenanceId: existing.sourceProvenanceId,
          sourceProvenanceId: sourceFact.sourceProvenanceId,
          targetWorkId,
        },
      },
    );
  }
}
