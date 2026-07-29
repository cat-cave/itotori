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
  type DlsiteEdition,
  dlsiteNonMappingRoles,
  dlsiteTranslationRoles,
} from "./catalog-recorded-importers-01.js";
import {
  type CatalogRecordedLanguageStatusFact,
  type CatalogRecordedReleaseFact,
  type CatalogRecordedReleaseMappingFact,
} from "./catalog-recorded-importers-02.js";
import { storefrontSemanticError } from "./catalog-recorded-importers-09.js";
import { optionalString } from "./catalog-recorded-importers-10.js";
import {
  enumStringField,
  optionalEnumStringField,
  requiredStringFromUnknown,
} from "./catalog-recorded-importers-12.js";
import { compactJson } from "./catalog-recorded-importers-15.js";

export function unwrapSteamAppdetailsEnvelope(
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): { envelopeKey: string; appdetails: CatalogJsonRecord } {
  const keys = Object.keys(response.payload);
  if (keys.length !== 1) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "Steam appdetails recorded fixture must contain exactly one app-id keyed envelope",
      fixture,
      response,
      "appdetails",
    );
  }
  const envelopeKey = keys[0] ?? "";
  if (envelopeKey !== response.sourceId) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `Steam appdetails envelope key ${envelopeKey} does not match fixture source id ${response.sourceId}`,
      fixture,
      response,
      envelopeKey,
    );
  }
  const appdetails = response.payload[envelopeKey];
  if (appdetails === null || typeof appdetails !== "object" || Array.isArray(appdetails)) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      "Steam appdetails envelope value must be an object",
      fixture,
      response,
      envelopeKey,
    );
  }
  return { envelopeKey, appdetails: appdetails as CatalogJsonRecord };
}

export function dlsiteEdition(
  input: unknown,
  index: number,
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): DlsiteEdition {
  const sourceField = `translation_info.language_editions[${index}]`;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw storefrontSemanticError(
      catalogRecordedStorefrontDiagnosticCodeValues.parseDrift,
      `DLsite ${sourceField} must be a JSON object`,
      fixture,
      response,
      sourceField,
    );
  }
  const record = input as CatalogJsonRecord;
  const language = requiredStringFromUnknown(
    record.locale ?? record.language,
    `${sourceField}.locale`,
    fixture,
    response,
  );
  const status = enumStringField(
    record.status,
    Object.values(catalogLanguageStatusValues),
    `${sourceField}.status`,
    fixture,
    response,
  );
  const statusScope = optionalEnumStringField(
    record.status_scope ?? record.scope,
    Object.values(catalogLanguageStatusScopeValues),
    `${sourceField}.status_scope`,
    fixture,
    response,
  );
  const confidence = optionalEnumStringField(
    record.confidence,
    Object.values(catalogConfidenceValues),
    `${sourceField}.confidence`,
    fixture,
    response,
  );
  const rawContentRedactionClass = optionalEnumStringField(
    record.raw_content_redaction_class,
    Object.values(catalogRawContentRedactionClassValues),
    `${sourceField}.raw_content_redaction_class`,
    fixture,
    response,
  );
  const edition: DlsiteEdition = {
    index,
    workno: optionalString(record, "workno") ?? response.sourceId,
    language,
    status,
    statusScope: statusScope ?? catalogLanguageStatusScopeValues.platform,
  };
  const label = optionalString(record, "label");
  if (label !== undefined) {
    edition.label = label;
  }
  const translationRole = optionalString(record, "translation_role");
  if (translationRole !== undefined) {
    edition.translationRole = translationRole;
  }
  if (confidence !== undefined) {
    edition.confidence = confidence;
  }
  if (rawContentRedactionClass !== undefined) {
    edition.rawContentRedactionClass = rawContentRedactionClass;
  }
  return edition;
}

export function dlsiteLanguageStatusFromEdition(
  edition: DlsiteEdition,
): CatalogRecordedLanguageStatusFact {
  const statusFact: CatalogRecordedLanguageStatusFact = {
    language: edition.language,
    status: edition.status,
    statusScope: edition.statusScope,
    platform: "dlsite",
    releaseSourceId: `${edition.workno}:dlsite`,
    metadata: compactJson({
      sourceField: "translation_info.language_editions",
      localeLabel: edition.label,
      translationRole: edition.translationRole,
    }),
  };
  if (edition.confidence !== undefined) {
    statusFact.confidence = edition.confidence;
  }
  if (edition.rawContentRedactionClass !== undefined) {
    statusFact.rawContentRedactionClass = edition.rawContentRedactionClass;
  }
  return statusFact;
}

// Project the DLsite language_editions + original workno into first-class
// releases (edition/milestone/package-kind columns) and first-class translation
// parent-child release mappings. Editions are de-duplicated by workno. A child
// edition whose translation_role is neither a known translation role nor a
// recognized non-mapping role yields an EXPLICIT unsupported-shape diagnostic
// instead of being silently dropped into a metadata blob.
export function dlsiteEditionReleasesAndMappings(
  sourceId: string,
  title: string,
  originalWorkno: string,
  editions: readonly DlsiteEdition[],
  fixture: CatalogRecordedStorefrontFixture,
  response: CatalogRecordedStorefrontResponse,
): {
  releases: CatalogRecordedReleaseFact[];
  mappings: CatalogRecordedReleaseMappingFact[];
  diagnostics: CatalogRecordedStorefrontDiagnostic[];
} {
  const releases: CatalogRecordedReleaseFact[] = [];
  const mappings: CatalogRecordedReleaseMappingFact[] = [];
  const diagnostics: CatalogRecordedStorefrontDiagnostic[] = [];
  const seenWorknos = new Set<string>();

  for (const edition of editions) {
    const isOriginal = edition.workno === originalWorkno || edition.translationRole === "original";
    const sourceReleaseId = `${edition.workno}:dlsite`;

    if (!seenWorknos.has(edition.workno)) {
      seenWorknos.add(edition.workno);
      releases.push(
        compactJson({
          sourceReleaseId,
          releaseTitle: title,
          releaseKind: isOriginal
            ? catalogReleaseKindValues.original
            : catalogReleaseKindValues.officialTranslation,
          editionName: edition.label,
          milestone: originalWorkno,
          packageKind: catalogReleasePackageKindValues.dlsiteProduct,
          platform: "dlsite",
          language: edition.language,
          isOfficial: true,
          metadata: compactJson({
            workno: edition.workno,
            localeLabel: edition.label,
            translationRole: edition.translationRole,
          }),
        }) as CatalogRecordedReleaseFact,
      );
    }

    if (isOriginal || edition.workno === originalWorkno) {
      continue;
    }
    const role = edition.translationRole;
    if (role !== undefined && dlsiteTranslationRoles.has(role)) {
      const mapping: CatalogRecordedReleaseMappingFact = {
        sourceReleaseId,
        targetReleaseId: `${originalWorkno}:dlsite`,
        relationKind: catalogReleaseMappingKindValues.translationOf,
        portability:
          role === "official_translation" // authz-guard:allow domain-role — DLsite translation-source role, not an auth role
            ? catalogTranslationPortabilityValues.likelyPortable
            : catalogTranslationPortabilityValues.needsReview,
        confidence: edition.confidence ?? catalogConfidenceValues.high,
        metadata: compactJson({
          sourceField: `translation_info.language_editions[${edition.index}]`,
          translationRole: role,
          language: edition.language,
        }),
      };
      mappings.push(mapping);
      continue;
    }
    if (role !== undefined && dlsiteNonMappingRoles.has(role)) {
      continue;
    }
    // A foreign-workno edition with an unrecognized (or missing) translation role
    // cannot be mapped to a known relation kind: surface it explicitly.
    diagnostics.push({
      code: catalogRecordedStorefrontDiagnosticCodeValues.unsupportedResponseShape,
      severity: "warning",
      fixtureId: fixture.fixtureId,
      sourceRevision: fixture.sourceVersion,
      stepKey: response.stepKey,
      sourceId,
      sourceField: `translation_info.language_editions[${edition.index}].translation_role`,
      message:
        `DLsite translation_info.language_editions[${edition.index}] references workno ` +
        `${edition.workno} with unmappable translation_role ${role ?? "<missing>"}; ` +
        "no first-class release mapping was emitted",
    });
  }

  return { releases, mappings, diagnostics };
}
