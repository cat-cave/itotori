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
  type CatalogRecordedPlatformFixture,
  type CatalogRecordedPlatformResponse,
  catalogRecordedStorefrontDiagnosticCodeValues,
  type CatalogRecordedStorefrontFixture,
  type CatalogRecordedStorefrontResponse,
  type NormalizedDlsiteStorefrontPayload,
} from "./catalog-recorded-importers-01.js";
import {
  type CatalogRecordedExternalIdFact,
  type CatalogRecordedLanguageStatusFact,
} from "./catalog-recorded-importers-02.js";
import {
  dlsiteEdition,
  dlsiteEditionReleasesAndMappings,
  dlsiteLanguageStatusFromEdition,
} from "./catalog-recorded-importers-07.js";
import { optionalDlsiteRankFacts } from "./catalog-recorded-importers-08.js";
import {
  firstString,
  optionalDemandNumber,
  optionalDemandRecord,
  storefrontSemanticError,
} from "./catalog-recorded-importers-09.js";
import {
  catalogRecordedConfidenceForSourceFact,
  confidenceOptions,
  externalGameCatalogSource,
  optionalArray,
  optionalRecord,
  optionalString,
  requiredArray,
  stringField,
} from "./catalog-recorded-importers-10.js";
import { platformArray, platformLabel } from "./catalog-recorded-importers-11.js";
import {
  platformEnumStringField,
  platformRecordFromUnknown,
  platformString,
} from "./catalog-recorded-importers-12.js";
import { compactJson } from "./catalog-recorded-importers-15.js";

export function igdbExternalIds(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
): CatalogRecordedExternalIdFact[] {
  const ids: CatalogRecordedExternalIdFact[] = [
    {
      sourceId: response.sourceId,
      externalIdKind: catalogExternalIdKindValues.sourceRecord,
      confidence: catalogRecordedConfidenceForSourceFact("igdb", "external_id"),
      metadata: { sourceField: "id" },
    },
  ];
  for (const [index, entry] of platformArray(response.payload, "external_games").entries()) {
    const record = platformRecordFromUnknown(entry, `external_games[${index}]`, fixture, response);
    const mapped = externalGameCatalogSource(optionalString(record, "category"));
    const sourceId = firstString(record, ["uid", "id"]);
    if (mapped === null || sourceId === null) {
      continue;
    }
    ids.push({
      catalogSource: mapped.catalogSource,
      sourceId,
      externalIdKind: mapped.externalIdKind,
      confidence: catalogRecordedConfidenceForSourceFact("igdb", "external_id"),
      metadata: compactJson({
        sourceField: `external_games[${index}]`,
        category: optionalString(record, "category"),
        url: optionalString(record, "url"),
      }),
    });
  }
  return ids;
}

export function wikidataLanguageStatusFacts(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
  claims: CatalogJsonRecord,
): CatalogRecordedLanguageStatusFact[] {
  return platformArray(claims, "language_statements").map((entry, index) => {
    const record = platformRecordFromUnknown(
      entry,
      `claims.language_statements[${index}]`,
      fixture,
      response,
    );
    const language = platformString(record, "locale", fixture, response);
    const status = platformEnumStringField(
      record.status,
      Object.values(catalogLanguageStatusValues),
      `claims.language_statements[${index}].status`,
      fixture,
      response,
    );
    const platform = platformLabel(record.platform);
    const qualifiers = optionalRecord(record, "qualifiers");
    const confidence = catalogRecordedConfidenceForSourceFact(
      "wikidata",
      "language_status",
      confidenceOptions(optionalString(qualifiers, "basis")),
    );
    return compactJson({
      language,
      status,
      statusScope:
        platform === undefined
          ? catalogLanguageStatusScopeValues.work
          : catalogLanguageStatusScopeValues.platform,
      platform,
      confidence,
      metadata: compactJson({
        sourceField: `claims.language_statements[${index}]`,
        statementId: optionalString(record, "statement_id"),
        property: optionalString(record, "property"),
        qualifiers,
        references: optionalArray(record, "references"),
      }),
    }) as CatalogRecordedLanguageStatusFact;
  });
}

export function wikidataExternalIds(
  fixture: CatalogRecordedPlatformFixture,
  response: CatalogRecordedPlatformResponse,
  payload: CatalogJsonRecord,
): CatalogRecordedExternalIdFact[] {
  const ids: CatalogRecordedExternalIdFact[] = [
    {
      sourceId: response.sourceId,
      externalIdKind: catalogExternalIdKindValues.sourceRecord,
      confidence: catalogRecordedConfidenceForSourceFact("wikidata", "entity_link"),
      metadata: { sourceField: "id" },
    },
  ];
  const external: CatalogJsonRecord = optionalRecord(payload, "external_ids") ?? {};
  const mapped: Array<{
    key: string;
    catalogSource: CatalogSource;
    externalIdKind: CatalogExternalIdKind;
  }> = [
    {
      key: "igdb",
      catalogSource: "igdb",
      externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
    },
    {
      key: "steam",
      catalogSource: "steam",
      externalIdKind: catalogExternalIdKindValues.storeProduct,
    },
    {
      key: "vndb",
      catalogSource: "vndb",
      externalIdKind: catalogExternalIdKindValues.sourceRecord,
    },
  ];
  for (const entry of mapped) {
    const value = external[entry.key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    ids.push({
      catalogSource: entry.catalogSource,
      sourceId: value,
      externalIdKind: entry.externalIdKind,
      confidence: catalogRecordedConfidenceForSourceFact("wikidata", "external_id", {
        qualifierProvenance: entry.key,
      }),
      metadata: {
        sourceField: `external_ids.${entry.key}`,
        wikidataEntity: response.sourceId,
      },
    });
  }
  return ids;
}

export function normalizeDlsiteStorefrontPayload(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): NormalizedDlsiteStorefrontPayload {
  const payload = response.payload;
  const sourceId = firstString(payload, ["workno", "product_id", "id"]);
  if (sourceId === null) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      "DLsite response is missing workno/product_id identity",
      fixture,
      response,
      "workno",
    );
  }
  if (sourceId !== response.sourceId) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `DLsite response source id ${sourceId} does not match fixture source id ${response.sourceId}`,
      fixture,
      response,
      "workno",
    );
  }

  const translationInfo = optionalRecord(payload, "translation_info");
  if (translationInfo === undefined) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "DLsite recorded fixture must preserve source translation_info tree",
      fixture,
      response,
      "translation_info",
    );
  }
  const languageEditions = requiredArray(
    translationInfo,
    "language_editions",
    fixture,
    response,
    "translation_info.language_editions",
  );
  const maker = optionalRecord(payload, "maker");
  const demand = compactJson({
    dl_count: optionalDemandNumber(payload, "dl_count", fixture, response),
    rating_summary: optionalDemandRecord(payload, "rating_summary", fixture, response),
    rating_histogram: optionalDemandRecord(payload, "rating_histogram", fixture, response),
    wishlist_count: optionalDemandNumber(payload, "wishlist_count", fixture, response),
    rank_facts: optionalDlsiteRankFacts(payload, "rank_facts", fixture, response),
  });

  const title = stringField(payload, "title", fixture, response);
  const editions = languageEditions.map((entry, index) =>
    dlsiteEdition(entry, index, fixture, response),
  );
  const originalWorkno =
    optionalString(translationInfo, "original_workno") ??
    optionalString(optionalRecord(translationInfo, "original") ?? {}, "workno") ??
    editions.find((edition) => edition.translationRole === "original")?.workno ??
    sourceId;
  const projection = dlsiteEditionReleasesAndMappings(
    sourceId,
    title,
    originalWorkno,
    editions,
    fixture,
    response,
  );

  return compactJson({
    sourceId,
    title,
    releaseDate: optionalString(payload, "release_date"),
    workType: optionalString(payload, "work_type"),
    makerName: optionalString(payload, "maker_name") ?? optionalString(maker, "name"),
    translationInfo,
    originalWorkno,
    languageStatuses: editions.map((edition) => dlsiteLanguageStatusFromEdition(edition)),
    editionReleases: projection.releases,
    releaseMappings: projection.mappings,
    mappingDiagnostics: projection.diagnostics,
    demand,
  }) as NormalizedDlsiteStorefrontPayload;
}
