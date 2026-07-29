import type { CatalogJsonRecord } from "../repositories/catalog-repository.js";
import {
  catalogExternalIdKindValues,
  catalogSourceRecordKindValues,
  type CatalogConflictKind,
  type CatalogConflictStatus,
  type CatalogConflictSubjectKind,
} from "../schema.js";

import {
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontFixture,
  type CatalogRecordedStorefrontResponse,
  type ParsedStorefrontFact,
} from "./catalog-recorded-importers-01.js";
import {
  type CatalogRecordedDemandFact,
  type CatalogRecordedExternalIdFact,
  type CatalogRecordedLanguageStatusFact,
  type CatalogRecordedReleaseFact,
  type CatalogRecordedReleaseMappingFact,
  type CatalogRecordedSeedTargetFact,
} from "./catalog-recorded-importers-02.js";
import { normalizeDlsiteStorefrontPayload } from "./catalog-recorded-importers-06.js";
import {
  demandDiagnostics,
  DLSITE_DEMAND_RECORDED_SOURCE_FIELD_BY_FIELD,
  dlsiteDemandFacts,
} from "./catalog-recorded-importers-08.js";
import {
  demandNumber,
  optionalArray,
  optionalRecord,
  optionalString,
  titlesFromPayload,
  yearFromDate,
} from "./catalog-recorded-importers-10.js";
import { compactJson } from "./catalog-recorded-importers-15.js";

export type CatalogRecordedConflictEvidenceFact = {
  subjectKind?: CatalogConflictSubjectKind;
  subjectId?: string;
  evidencePosition?: number;
  /**
   * Per-evidence source provenance. When set, the importer threads this through to
   * the stored conflict-evidence row instead of collapsing every row to the
   * importer-payload provenance, so review/demotion output can name the ORIGINAL
   * evidence source (IGDB/Wikidata/VNDB/EGS/DLsite/local). When omitted, the
   * importer attributes the evidence to the original source's stored provenance for
   * cross-source evidence, and otherwise defaults to the importer-payload provenance.
   */
  sourceProvenanceId?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedConflictFact = {
  conflictId?: string;
  conflictKind?: CatalogConflictKind;
  status?: CatalogConflictStatus;
  summary: string;
  reasonCode?: string;
  severity?: "info" | "warning" | "critical";
  detectedAt?: string;
  metadata?: CatalogJsonRecord;
  evidence?: readonly CatalogRecordedConflictEvidenceFact[];
};

export type CatalogRecordedImporterFact = {
  sourceId: string;
  canonicalTitle: string;
  originalLanguage?: string;
  firstReleaseYear?: number;
  workKind?: string;
  titles?: readonly string[];
  externalIds?: readonly CatalogRecordedExternalIdFact[];
  releases?: readonly CatalogRecordedReleaseFact[];
  releaseMappings?: readonly CatalogRecordedReleaseMappingFact[];
  languageStatuses?: readonly CatalogRecordedLanguageStatusFact[];
  demandFacts?: readonly CatalogRecordedDemandFact[];
  conflicts?: readonly CatalogRecordedConflictFact[];
  seedTarget?: CatalogRecordedSeedTargetFact | false;
  metadata?: CatalogJsonRecord;
};

export function parseDlsiteStorefrontResponse(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): ParsedStorefrontFact {
  const normalized = normalizeDlsiteStorefrontPayload(fixture, response);
  const sourceId = normalized.sourceId;
  const title = normalized.title;
  const releaseDate = normalized.releaseDate;
  const releaseYear = releaseDate === undefined ? undefined : yearFromDate(releaseDate);
  const workType = normalized.workType;
  const makerName = normalized.makerName;
  const translationInfo = normalized.translationInfo;
  const demand = normalized.demand;
  const demandDiags = demandDiagnostics(
    fixture,
    response,
    demand,
    ["dl_count", "rating_summary", "rating_histogram", "wishlist_count", "rank_facts"],
    "DLsite",
    DLSITE_DEMAND_RECORDED_SOURCE_FIELD_BY_FIELD,
  );
  const diagnostics = [...demandDiags, ...normalized.mappingDiagnostics];
  const languages = normalized.languageStatuses;
  const primaryLanguage = languages[0]?.language ?? "ja-JP";
  const demandFacts = dlsiteDemandFacts(sourceId, normalized, response);
  // First-class edition releases carry edition/milestone/package-kind columns.
  // The queried product's own edition additionally retains the full source
  // metadata blob so nothing that used to live only in metadata is lost.
  const releases = normalized.editionReleases.map((release) =>
    release.sourceReleaseId === `${sourceId}:dlsite`
      ? (compactJson({
          ...release,
          releaseTitle: title,
          releaseDate,
          releaseYear,
          metadata: compactJson({
            ...release.metadata,
            makerName,
            workType,
            ageCategory: optionalString(response.payload, "age_category"),
            translationInfo,
          }),
        }) as CatalogRecordedReleaseFact)
      : release,
  );

  return {
    diagnostics,
    fact: {
      sourceId,
      canonicalTitle: title,
      originalLanguage: primaryLanguage,
      titles: titlesFromPayload(response.payload, title),
      ...(releaseYear === undefined ? {} : { firstReleaseYear: releaseYear }),
      ...(workType === undefined ? {} : { workKind: workType }),
      externalIds: [
        {
          sourceId,
          externalIdKind: catalogExternalIdKindValues.storeProduct,
          metadata: compactJson({ workno: sourceId, makerName, workType }),
        },
      ],
      releases,
      releaseMappings: normalized.releaseMappings,
      languageStatuses: languages,
      demandFacts,
      seedTarget: false,
      metadata: compactJson({
        storefront: "dlsite",
        // The recorded storefront parser only ever consumes recorded-fixture
        // responses (its adapter refuses non-recorded_fixture mode), so the
        // persisted fact carries the fixture-mode provenance marker directly.
        // A consumer reading the fact metadata can distinguish replayed
        // fixture evidence from live raw-cache evidence without joining the
        // source provenance row.
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        workno: sourceId,
        releaseMetadata: compactJson({ releaseDate, releaseYear, makerName }),
        workType,
        geoRecovery: optionalRecord(response.metadata ?? {}, "geoRecovery"),
        translationInfo,
        translationTree: translationInfo,
        demand: compactJson({
          dlCount: demandNumber(demand, "dl_count"),
          ratingSummary: optionalRecord(demand, "rating_summary"),
          ratingHistogram: optionalRecord(demand, "rating_histogram"),
          wishlistCount: demandNumber(demand, "wishlist_count"),
          rankFacts: optionalArray(demand, "rank_facts"),
        }),
        diagnostics,
      }),
    },
  };
}

export function mapDlsiteDemandFactsForRecordedResponse(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): {
  facts: readonly CatalogRecordedDemandFact[];
  diagnostics: readonly CatalogRecordedStorefrontDiagnostic[];
} {
  const normalized = normalizeDlsiteStorefrontPayload(fixture, response);
  return {
    facts: dlsiteDemandFacts(normalized.sourceId, normalized, response),
    diagnostics: demandDiagnostics(
      fixture,
      response,
      normalized.demand,
      ["dl_count", "rating_summary", "rating_histogram", "wishlist_count", "rank_facts"],
      "DLsite",
      DLSITE_DEMAND_RECORDED_SOURCE_FIELD_BY_FIELD,
    ),
  };
}

// DB-less surface over the DLsite translation_info -> first-class mapping-fact
// projection. Returns the edition releases (edition/milestone/package-kind), the
// translation parent-child release mappings, and any explicit unsupported-shape
// diagnostics for translation evidence that could not be mapped (rather than
// silently dropping that evidence into a metadata blob).
export function mapDlsiteReleaseMappingsForRecordedResponse(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): {
  releases: readonly CatalogRecordedReleaseFact[];
  releaseMappings: readonly CatalogRecordedReleaseMappingFact[];
  diagnostics: readonly CatalogRecordedStorefrontDiagnostic[];
} {
  const normalized = normalizeDlsiteStorefrontPayload(fixture, response);
  return {
    releases: normalized.editionReleases,
    releaseMappings: normalized.releaseMappings,
    diagnostics: normalized.mappingDiagnostics,
  };
}
