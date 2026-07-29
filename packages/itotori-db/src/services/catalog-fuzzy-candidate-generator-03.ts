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

import {
  type AuthoritativeExactExternalId,
  catalogExternalIdKinds,
  type CatalogFuzzyCandidateDiagnostic,
  type CatalogFuzzyCandidateDiagnosticCode,
  catalogFuzzyCandidateDiagnosticCodeValues,
  type CatalogFuzzyCandidateExternalId,
  type CatalogFuzzyCandidateSourceFact,
  catalogSources,
  type ScoredCandidate,
} from "./catalog-fuzzy-candidate-generator-01.js";

export function normalizeExternalId(
  externalId: unknown,
  sourceFactIndex: number,
  externalIndex: number,
  sourceId: string,
  diagnostics: CatalogFuzzyCandidateDiagnostic[],
): CatalogFuzzyCandidateExternalId | null {
  if (!isRecord(externalId)) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `sourceFacts[${sourceFactIndex}].externalIds[${externalIndex}] is not a supported external ID.`,
        "invalid_external_id",
        { sourceId, field: "externalIds" },
      ),
    );
    return null;
  }
  const catalogSource = externalId.catalogSource;
  const externalIdKind = externalId.externalIdKind;
  if (
    !isCatalogSource(catalogSource) ||
    typeof externalId.sourceId !== "string" ||
    externalId.sourceId.trim().length === 0 ||
    (externalIdKind !== undefined && !isCatalogExternalIdKind(externalIdKind))
  ) {
    diagnostics.push(
      diagnostic(
        catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
        "error",
        `sourceFacts[${sourceFactIndex}].externalIds[${externalIndex}] is not a supported external ID.`,
        "invalid_external_id",
        { sourceId, field: "externalIds" },
      ),
    );
    return null;
  }
  return {
    catalogSource,
    sourceId: externalId.sourceId,
    ...(externalIdKind === undefined ? {} : { externalIdKind }),
  };
}

export function authoritativeExactExternalIds(
  sourceFact: CatalogFuzzyCandidateSourceFact,
): AuthoritativeExactExternalId[] {
  const exactIds: AuthoritativeExactExternalId[] = [
    {
      catalogSource: sourceFact.catalogSource,
      sourceId: sourceFact.sourceId,
      externalIdKind: catalogExternalIdKindValues.sourceRecord,
    },
  ];
  for (const externalId of sourceFact.externalIds ?? []) {
    const externalIdKind = externalId.externalIdKind ?? catalogExternalIdKindValues.sourceRecord;
    if (externalIdKind === catalogExternalIdKindValues.localDetection) {
      continue;
    }
    exactIds.push({
      catalogSource: externalId.catalogSource,
      sourceId: externalId.sourceId,
      externalIdKind,
    });
  }
  return uniqueExactExternalIds(exactIds);
}

export function uniqueExactExternalIds(
  exactIds: AuthoritativeExactExternalId[],
): AuthoritativeExactExternalId[] {
  const seen = new Set<string>();
  return exactIds.filter((externalId) => {
    const key = `${externalId.catalogSource}:${externalId.sourceId}:${externalId.externalIdKind}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCatalogSource(value: unknown): value is CatalogSource {
  return catalogSources.includes(value as CatalogSource);
}

export function isCatalogExternalIdKind(value: unknown): value is CatalogExternalIdKind {
  return catalogExternalIdKinds.includes(value as CatalogExternalIdKind);
}

export function scoreTargets(
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

export function titleSimilarityScore(sourceTitle: string, targetTitle: string): number {
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

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['"()[\]{}:;,.!?/_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function compareScoredCandidate(left: ScoredCandidate, right: ScoredCandidate): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return left.target.workId.localeCompare(right.target.workId);
}

export function diagnostic(
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
