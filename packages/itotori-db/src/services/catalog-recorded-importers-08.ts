import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogConflictEvidenceInput,
  CatalogConflictInput,
  CatalogDemandFactInput,
  CatalogExternalIdInput,
  CatalogExternalIdRecord,
  CatalogJsonRecord,
  CatalogLanguageStatusInput,
  CatalogReleaseInput,
  CatalogReleaseMappingInput,
  CatalogSeedTargetInput,
  CatalogWorkInput,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflictStatusValues,
  catalogConflictSubjectKindValues,
  catalogDemandFactKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleasePackageKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  catalogTranslationPortabilityValues,
  type CatalogConfidence,
  type CatalogConflictKind,
  type CatalogConflictStatus,
  type CatalogConflictSubjectKind,
  type CatalogDemandFactKind,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogRawContentRedactionClass,
  type CatalogReleaseKind,
  type CatalogReleaseMappingKind,
  type CatalogReleasePackageKind,
  type CatalogSource,
  type CatalogTranslationPortability,
} from "../schema.js";
import {
  catalogCrawlerFactImportStrategyValues,
  catalogCrawlerIdempotentFactImportContractId,
  createRecordedCatalogCrawlerAdapter,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerFactImportContract,
  type CatalogCrawlerFactImportProof,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerIngestStep,
  type CatalogCrawlerRateLimitMetadata,
  type CatalogCrawlerSourceAdapter,
  type CatalogCrawlerVerifyFactImportStep,
  type RecordedCatalogCrawlerFixture,
} from "./catalog-crawler-runner.js";
import {
  augmentCatalogPlatformLanguageConflicts,
  catalogPlatformLanguageConflictReasonCode,
  type CatalogPlatformLanguageConflictEvidence,
  type CatalogPlatformLanguageConflictRequest,
} from "./catalog-platform-language-conflicts.js";

import {
  type CatalogRecordedStorefrontDiagnostic,
  catalogRecordedStorefrontDiagnosticCodeValues,
  type CatalogRecordedStorefrontFixture,
  type CatalogRecordedStorefrontResponse,
  type NormalizedDlsiteStorefrontPayload,
  type SteamLanguageStatusParseResult,
} from "./catalog-recorded-importers-01.js";
import { type CatalogRecordedDemandFact } from "./catalog-recorded-importers-02.js";
import {
  optionalDemandArray,
  requireDemandObservedAt,
  requireDemandPositiveInteger,
  requireDemandString,
  storefrontSemanticError,
} from "./catalog-recorded-importers-09.js";
import {
  demandNumber,
  optionalArray,
  optionalRecord,
  optionalString,
  steamLocaleFromLabel,
  stringArray,
} from "./catalog-recorded-importers-10.js";
import { compactJson } from "./catalog-recorded-importers-15.js";

export function steamLanguageStatuses(
  data: CatalogJsonRecord,
  appId: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): SteamLanguageStatusParseResult {
  const raw = data.supported_languages;
  const labels =
    typeof raw === "string"
      ? raw
          .replace(/<[^>]*>/gu, "")
          .split(/[,;]/u)
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : stringArray(data, "supported_language_codes");
  const mapped = labels.map((label) => ({ label, locale: steamLocaleFromLabel(label) }));
  const unknownLocaleLabels = mapped
    .filter((entry) => entry.locale === null)
    .map((entry) => entry.label);
  const diagnostics = unknownLocaleLabels.map((label) => ({
    code: catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
    severity: "warning" as const,
    fixtureId: fixture.fixtureId,
    sourceRevision: fixture.sourceVersion,
    stepKey: response.stepKey,
    sourceId: response.sourceId,
    sourceField: "data.supported_languages",
    message: `Steam supported_languages label ${label} could not be mapped to a catalog locale`,
  }));
  const locales = mapped
    .map((entry) => entry.locale)
    .filter((value): value is string => value !== null);
  const uniqueLocales = [...new Set(locales)];
  return {
    diagnostics,
    unknownLocaleLabels,
    statuses: uniqueLocales.map((language) => ({
      language,
      status: catalogLanguageStatusValues.officialFull,
      statusScope: catalogLanguageStatusScopeValues.platform,
      platform: "steam",
      releaseSourceId: `${appId}:steam`,
      metadata: { sourceField: "supported_languages" },
    })),
  };
}

// DLsite demand fields are normalized into a `demand` subtree, but the recorded
// source response carries them at the payload top level. Missing-demand
// warnings must cite where the datum actually came from in the recorded DLsite
// response, so this map translates each normalized demand field into its
// recorded source response field path.
export const DLSITE_DEMAND_RECORDED_SOURCE_FIELD_BY_FIELD: Readonly<Record<string, string>> = {
  dl_count: "dl_count",
  rating_summary: "rating_summary",
  rating_histogram: "rating_histogram",
  wishlist_count: "wishlist_count",
  rank_facts: "rank_facts",
};

export function demandDiagnostics(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
  demand: CatalogJsonRecord,
  fields: readonly string[],
  sourceLabel: string,
  recordedSourceFieldByField: Readonly<Record<string, string>>,
): CatalogRecordedStorefrontDiagnostic[] {
  return fields
    .filter((field) => demand[field] === undefined)
    .map((field) => {
      const recordedSourceField = recordedSourceFieldByField[field] ?? field;
      return {
        code: catalogRecordedStorefrontDiagnosticCodeValues.missingDemandField,
        severity: "warning",
        fixtureId: fixture.fixtureId,
        sourceRevision: fixture.sourceVersion,
        stepKey: response.stepKey,
        sourceId: response.sourceId,
        sourceField: recordedSourceField,
        message: `${sourceLabel} recorded response did not include ${recordedSourceField}`,
      };
    });
}

export function dlsiteDemandFacts(
  sourceId: string,
  normalized: NormalizedDlsiteStorefrontPayload,
  response: CatalogRecordedStorefrontResponse,
): CatalogRecordedDemandFact[] {
  const demand = normalized.demand;
  const facts: CatalogRecordedDemandFact[] = [];
  const add = (
    factKind: CatalogDemandFactKind,
    sourceField: string,
    factValue: CatalogJsonRecord,
    observedAt?: string,
  ) => {
    facts.push(
      compactJson({
        factKind,
        factValue,
        observedAt,
        metadata: compactJson({
          sourceField,
          storefront: "dlsite",
          workno: sourceId,
          requestIdentity: response.requestIdentity,
        }),
      }) as CatalogRecordedDemandFact,
    );
  };

  const dlCount = demandNumber(demand, "dl_count");
  if (dlCount !== undefined) {
    add(catalogDemandFactKindValues.dlCount, "dl_count", { count: dlCount });
  }
  const ratingSummary = optionalRecord(demand, "rating_summary");
  if (ratingSummary !== undefined) {
    add(catalogDemandFactKindValues.ratingSummary, "rating_summary", ratingSummary);
  }
  const ratingHistogram = optionalRecord(demand, "rating_histogram");
  if (ratingHistogram !== undefined) {
    add(catalogDemandFactKindValues.ratingHistogram, "rating_histogram", ratingHistogram);
  }
  const wishlistCount = demandNumber(demand, "wishlist_count");
  if (wishlistCount !== undefined) {
    add(catalogDemandFactKindValues.wishlistCount, "wishlist_count", { count: wishlistCount });
  }
  for (const [index, rank] of (optionalArray(demand, "rank_facts") ?? []).entries()) {
    const rankRecord = rank as CatalogJsonRecord;
    add(
      catalogDemandFactKindValues.rank,
      `rank_facts[${index}]`,
      rankRecord,
      optionalString(rankRecord, "observed_at"),
    );
  }
  if (normalized.workType !== undefined) {
    add(catalogDemandFactKindValues.workType, "work_type", { workType: normalized.workType });
  }
  add(catalogDemandFactKindValues.translationTree, "translation_info", normalized.translationInfo);
  return facts;
}

export function optionalDlsiteRankFacts(
  record: CatalogJsonRecord,
  field: string,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): CatalogJsonRecord[] | undefined {
  const ranks = optionalDemandArray(record, field, fixture, response);
  if (ranks === undefined) {
    return undefined;
  }
  return ranks.map((rank, index) => {
    const sourceField = `${field}[${index}]`;
    if (rank === null || typeof rank !== "object" || Array.isArray(rank)) {
      throw storefrontSemanticError(
        catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
        `DLsite demand.${sourceField} must be a JSON object`,
        fixture,
        response,
        sourceField,
      );
    }
    const rankRecord = rank as CatalogJsonRecord;
    requireDemandString(rankRecord, "scope", fixture, response, `${sourceField}.scope`);
    requireDemandString(rankRecord, "category", fixture, response, `${sourceField}.category`);
    requireDemandPositiveInteger(rankRecord, "rank", fixture, response, `${sourceField}.rank`);
    requireDemandObservedAt(
      rankRecord,
      "observed_at",
      fixture,
      response,
      `${sourceField}.observed_at`,
    );
    return rankRecord;
  });
}
