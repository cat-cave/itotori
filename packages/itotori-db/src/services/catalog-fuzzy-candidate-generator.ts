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

type CatalogFuzzyCandidateRepository = Pick<
  ItotoriCatalogRepositoryPort,
  | "getWorkByExternalId"
  | "listCatalogCandidateTargetWorks"
  | "recordCatalogCandidateMatch"
  | "listCatalogCandidateMatches"
>;

type ScoredCandidate = {
  target: CatalogCandidateTargetWorkRecord;
  score: number;
  matchedFields: Record<string, unknown>;
};

type NormalizedRequest = {
  sourceFacts: CatalogFuzzyCandidateSourceFact[];
  minScore: number;
  maxCandidatesPerSource: number;
  diagnostics: CatalogFuzzyCandidateDiagnostic[];
};

const catalogSources = Object.values(catalogSourceValues) as CatalogSource[];
const catalogExternalIdKinds = Object.values(
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
          generatorVersion: request.generatorVersion ?? catalogFuzzyCandidateGeneratorVersion,
          metadata: {
            autoMerge: false,
            sourceReleaseYear: sourceFact.releaseYear ?? null,
            targetCanonicalTitle: candidate.target.canonicalTitle,
            targetFirstReleaseYear: candidate.target.firstReleaseYear,
          },
        });
        candidates.push(persisted);
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
    const exactIds = sourceFact.externalIds ?? [];
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
}

function normalizeRequest(request: CatalogFuzzyCandidateRequest): NormalizedRequest {
  const diagnostics: CatalogFuzzyCandidateDiagnostic[] = [];
  if (
    request.schemaVersion !== undefined &&
    request.schemaVersion !== catalogFuzzyCandidateSchemaVersion
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `Unsupported fuzzy candidate request schemaVersion ${request.schemaVersion}.`,
        "unsupported_schema_version",
      ),
    );
  }
  if (
    request.generatorVersion !== undefined &&
    request.generatorVersion !== catalogFuzzyCandidateGeneratorVersion
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `Unsupported fuzzy candidate generatorVersion ${request.generatorVersion}.`,
        "unsupported_generator_version",
      ),
    );
  }
  const minScore = request.minScore ?? 650;
  if (!Number.isInteger(minScore) || minScore < 0 || minScore > 1000) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        "minScore must be an integer between 0 and 1000.",
        "invalid_min_score",
      ),
    );
  }
  const maxCandidatesPerSource = request.maxCandidatesPerSource ?? 3;
  if (
    !Number.isInteger(maxCandidatesPerSource) ||
    maxCandidatesPerSource < 1 ||
    maxCandidatesPerSource > 10
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        "maxCandidatesPerSource must be an integer between 1 and 10.",
        "invalid_max_candidates",
      ),
    );
  }
  if (!Array.isArray(request.sourceFacts) || request.sourceFacts.length === 0) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        "Fuzzy candidate generation requires at least one source fact.",
        "missing_source_facts",
      ),
    );
  }

  return {
    sourceFacts: Array.isArray(request.sourceFacts)
      ? request.sourceFacts.filter((sourceFact, index) =>
          isSourceFact(sourceFact, index, diagnostics),
        )
      : [],
    minScore,
    maxCandidatesPerSource,
    diagnostics,
  };
}

function isSourceFact(
  sourceFact: CatalogFuzzyCandidateSourceFact,
  index: number,
  diagnostics: CatalogFuzzyCandidateDiagnostic[],
): boolean {
  const sourceId = typeof sourceFact?.sourceId === "string" ? sourceFact.sourceId : undefined;
  if (
    typeof sourceFact !== "object" ||
    sourceFact === null ||
    !catalogSources.includes(sourceFact.catalogSource) ||
    typeof sourceFact.sourceId !== "string" ||
    sourceFact.sourceId.trim().length === 0 ||
    typeof sourceFact.title !== "string" ||
    sourceFact.title.trim().length === 0
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `sourceFacts[${index}] must include catalogSource, sourceId, and title.`,
        "invalid_source_fact",
        sourceId === undefined ? { field: "sourceFacts" } : { sourceId, field: "sourceFacts" },
      ),
    );
    return false;
  }
  if (
    sourceFact.releaseYear !== undefined &&
    (!Number.isInteger(sourceFact.releaseYear) ||
      sourceFact.releaseYear < 1970 ||
      sourceFact.releaseYear > 2200)
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `sourceFacts[${index}].releaseYear must be an integer between 1970 and 2200.`,
        "invalid_release_year",
        { sourceId: sourceFact.sourceId, field: "releaseYear" },
      ),
    );
    return false;
  }
  for (const [externalIndex, externalId] of (sourceFact.externalIds ?? []).entries()) {
    if (
      !catalogSources.includes(externalId.catalogSource) ||
      typeof externalId.sourceId !== "string" ||
      externalId.sourceId.trim().length === 0 ||
      (externalId.externalIdKind !== undefined &&
        !catalogExternalIdKinds.includes(externalId.externalIdKind))
    ) {
      diagnostics.push(
        diagnostic(
          catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
          "error",
          `sourceFacts[${index}].externalIds[${externalIndex}] is not a supported external ID.`,
          "invalid_external_id",
          { sourceId: sourceFact.sourceId, field: "externalIds" },
        ),
      );
      return false;
    }
  }
  return true;
}

function scoreTargets(
  sourceFact: CatalogFuzzyCandidateSourceFact,
  targets: CatalogCandidateTargetWorkRecord[],
): ScoredCandidate[] {
  return targets.map((target) => {
    const titleScore = titleSimilarityScore(sourceFact.title, target.canonicalTitle);
    const yearScore =
      sourceFact.releaseYear !== undefined &&
      target.firstReleaseYear !== null &&
      sourceFact.releaseYear === target.firstReleaseYear
        ? 100
        : 0;
    return {
      target,
      score: Math.min(1000, titleScore + yearScore),
      matchedFields: {
        title: {
          source: sourceFact.title,
          target: target.canonicalTitle,
          score: titleScore,
          algorithm: "normalized_token_dice",
        },
        releaseYear: {
          source: sourceFact.releaseYear ?? null,
          target: target.firstReleaseYear,
          score: yearScore,
          algorithm: "exact_year_bonus",
        },
      },
    };
  });
}

function titleSimilarityScore(sourceTitle: string, targetTitle: string): number {
  const source = normalizeTitle(sourceTitle);
  const target = normalizeTitle(targetTitle);
  if (source.length === 0 || target.length === 0) {
    return 0;
  }
  if (source === target) {
    return 900;
  }
  if (source.includes(target) || target.includes(source)) {
    return 760;
  }
  const sourceTokens = new Set(source.split(" "));
  const targetTokens = new Set(target.split(" "));
  let common = 0;
  for (const token of sourceTokens) {
    if (targetTokens.has(token)) {
      common += 1;
    }
  }
  return Math.round((2 * common * 900) / (sourceTokens.size + targetTokens.size));
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['"()[\]{}:;,.!?/_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compareScoredCandidate(left: ScoredCandidate, right: ScoredCandidate): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return left.target.workId.localeCompare(right.target.workId);
}

function diagnostic(
  code: CatalogFuzzyCandidateDiagnosticCode,
  severity: CatalogFuzzyCandidateDiagnostic["severity"],
  message: string,
  reasonCode: string,
  options: {
    sourceId?: string;
    candidateId?: string;
    field?: string;
    score?: number;
    metadata?: Record<string, unknown>;
  } = {},
): CatalogFuzzyCandidateDiagnostic {
  return {
    code,
    severity,
    message,
    reasonCode,
    ...options,
  };
}

function result(
  status: CatalogFuzzyCandidateStatus,
  candidates: CatalogCandidateMatchRecord[],
  diagnostics: CatalogFuzzyCandidateDiagnostic[],
): CatalogFuzzyCandidateResult {
  return {
    schemaVersion: catalogFuzzyCandidateSchemaVersion,
    generatorVersion: catalogFuzzyCandidateGeneratorVersion,
    status,
    candidates,
    diagnostics,
  };
}
