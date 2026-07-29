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
  type CatalogRecordedStorefrontFixture,
  type PlatformParser,
  storefrontFactImportContract,
  type StorefrontParser,
} from "./catalog-recorded-importers-01.js";
import { type CatalogRecordedImporterFact } from "./catalog-recorded-importers-03.js";
import {
  parseIgdbPlatformResponse,
  parseSteamStorefrontResponse,
} from "./catalog-recorded-importers-04.js";
import {
  parseWikidataPlatformResponse,
  validatePlatformFixture,
  validateStorefrontFixture,
} from "./catalog-recorded-importers-05.js";
import { compactJson } from "./catalog-recorded-importers-15.js";

export function createSteamRecordedStorefrontAdapter(
  fixture: CatalogRecordedStorefrontFixture,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  if (fixture.catalogSource !== "steam") {
    throw new Error(`Steam recorded storefront adapter received ${fixture.catalogSource} fixture`);
  }
  return createRecordedStorefrontAdapter(fixture, parseSteamStorefrontResponse);
}

export function createIgdbRecordedPlatformAdapter(
  fixture: CatalogRecordedPlatformFixture,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  if (fixture.catalogSource !== "igdb") {
    throw new Error(`IGDB recorded platform adapter received ${fixture.catalogSource} fixture`);
  }
  return createRecordedPlatformAdapter(fixture, parseIgdbPlatformResponse);
}

export function createWikidataRecordedPlatformAdapter(
  fixture: CatalogRecordedPlatformFixture,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  if (fixture.catalogSource !== "wikidata") {
    throw new Error(`Wikidata recorded platform adapter received ${fixture.catalogSource} fixture`);
  }
  return createRecordedPlatformAdapter(fixture, parseWikidataPlatformResponse);
}

export function createRecordedStorefrontAdapter(
  fixture: CatalogRecordedStorefrontFixture,
  parser: StorefrontParser,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  validateStorefrontFixture(fixture);
  const steps = fixture.responses.map((response) => {
    const parsed = parser(fixture, response);
    return {
      stepKey: response.stepKey,
      sourceId: response.sourceId,
      requestIdentity: response.requestIdentity,
      fetchedAt: response.fetchedAt,
      checkpointCursor: response.checkpointCursor,
      payload: response.payload,
      facts: [parsed.fact],
      ...(response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus }),
      ...(response.ok === undefined ? {} : { ok: response.ok }),
      ...(response.payloadHash === undefined ? {} : { payloadHash: response.payloadHash }),
      metadata: compactJson({
        ...response.metadata,
        fixtureId: fixture.fixtureId,
        sourceRevision: fixture.sourceVersion,
        parserVersion: fixture.parserVersion,
        diagnostics: parsed.diagnostics,
      }),
      ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
    };
  });
  const replay: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> = {
    fixtureId: fixture.fixtureId,
    fixtureName: fixture.fixtureName,
    catalogSource: fixture.catalogSource,
    adapterName: fixture.adapterName,
    adapterVersion: fixture.adapterVersion,
    sourceVersion: fixture.sourceVersion,
    parserVersion: fixture.parserVersion,
    readiness: "alpha_ready",
    factImportContract: storefrontFactImportContract,
    steps,
  };
  if (fixture.partitionKey !== undefined) {
    replay.partitionKey = fixture.partitionKey;
  }
  return createRecordedCatalogCrawlerAdapter(replay);
}

export function createRecordedPlatformAdapter(
  fixture: CatalogRecordedPlatformFixture,
  parser: PlatformParser,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  validatePlatformFixture(fixture);
  const steps = fixture.responses.map((response) => {
    const parsed = parser(fixture, response);
    return {
      stepKey: response.stepKey,
      sourceId: response.sourceId,
      requestIdentity: response.requestIdentity,
      fetchedAt: response.fetchedAt,
      checkpointCursor: response.checkpointCursor,
      payload: response.payload,
      facts: [parsed.fact],
      ...(response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus }),
      ...(response.ok === undefined ? {} : { ok: response.ok }),
      ...(response.payloadHash === undefined ? {} : { payloadHash: response.payloadHash }),
      metadata: compactJson({
        ...response.metadata,
        fixtureId: fixture.fixtureId,
        sourceRevision: fixture.sourceVersion,
        parserVersion: fixture.parserVersion,
        diagnostics: parsed.diagnostics,
      }),
      ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
    };
  });
  const replay: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> = {
    fixtureId: fixture.fixtureId,
    fixtureName: fixture.fixtureName,
    catalogSource: fixture.catalogSource,
    adapterName: fixture.adapterName,
    adapterVersion: fixture.adapterVersion,
    sourceVersion: fixture.sourceVersion,
    parserVersion: fixture.parserVersion,
    readiness: "alpha_ready",
    factImportContract: storefrontFactImportContract,
    steps,
  };
  if (fixture.partitionKey !== undefined) {
    replay.partitionKey = fixture.partitionKey;
  }
  return createRecordedCatalogCrawlerAdapter(replay);
}

export type CatalogRecordedExternalIdFact = {
  catalogSource?: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  confidence?: CatalogConfidence;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedReleaseFact = {
  sourceReleaseId?: string;
  releaseTitle: string;
  releaseKind?: CatalogReleaseKind;
  editionName?: string;
  milestone?: string;
  packageKind?: CatalogReleasePackageKind;
  platform?: string;
  language?: string;
  releaseDate?: string;
  releaseYear?: number;
  isOfficial?: boolean;
  metadata?: CatalogJsonRecord;
};

// A first-class release-to-release mapping fact. Recorded importers emit these
// so edition / milestone / translation parent-child evidence survives as a
// structured relation between two releases (referenced by their sourceReleaseId)
// instead of being buried in a metadata blob. The ingest step resolves each
// sourceReleaseId to the stable catalog release id before persistence.
export type CatalogRecordedReleaseMappingFact = {
  sourceReleaseId: string;
  targetReleaseId: string;
  relationKind: CatalogReleaseMappingKind;
  portability?: CatalogTranslationPortability;
  confidence?: CatalogConfidence;
  observedAt?: string;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedLanguageStatusFact = {
  language: string;
  status: CatalogLanguageStatus;
  statusScope?: CatalogLanguageStatusScope;
  platform?: string;
  releaseSourceId?: string;
  confidence?: CatalogConfidence;
  isCurrent?: boolean;
  observedAt?: string;
  rawContentRedactionClass?: CatalogRawContentRedactionClass;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedSeedTargetFact = {
  originRef?: string;
  status?: CatalogSeedTargetInput["status"];
  priority?: number;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedDemandFact = {
  factKind: CatalogDemandFactKind;
  factValue: CatalogJsonRecord;
  observedAt?: string;
  metadata?: CatalogJsonRecord;
};
