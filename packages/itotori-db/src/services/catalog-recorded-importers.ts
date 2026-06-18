import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogExternalIdInput,
  CatalogJsonRecord,
  CatalogLanguageStatusInput,
  CatalogReleaseInput,
  CatalogSeedTargetInput,
  CatalogWorkInput,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogConfidenceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogRawContentRedactionClassValues,
  catalogReleaseKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  type CatalogConfidence,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogRawContentRedactionClass,
  type CatalogReleaseKind,
  type CatalogSource,
} from "../schema.js";
import {
  catalogCrawlerFactImportStrategyValues,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerFactImportProof,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerIngestStep,
  type CatalogCrawlerVerifyFactImportStep,
} from "./catalog-crawler-runner.js";

export const catalogRecordedImporterVersion = "catalog-recorded-importers.v0.1" as const;

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
  platform?: string;
  language?: string;
  releaseDate?: string;
  releaseYear?: number;
  isOfficial?: boolean;
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

export type CatalogRecordedImporterFact = {
  sourceId: string;
  canonicalTitle: string;
  originalLanguage?: string;
  firstReleaseYear?: number;
  workKind?: string;
  titles?: readonly string[];
  externalIds?: readonly CatalogRecordedExternalIdFact[];
  releases?: readonly CatalogRecordedReleaseFact[];
  languageStatuses?: readonly CatalogRecordedLanguageStatusFact[];
  seedTarget?: CatalogRecordedSeedTargetFact | false;
  metadata?: CatalogJsonRecord;
};

export type CatalogRecordedImporterOptions = {
  catalogRepository: ItotoriCatalogRepositoryPort;
  actor: AuthorizationActor;
};

export function createCatalogRecordedImporterIngestStep(
  options: CatalogRecordedImporterOptions,
): CatalogCrawlerIngestStep<CatalogRecordedImporterFact> {
  return async (context) => {
    for (const fact of context.facts) {
      await importRecordedCatalogFact(options.catalogRepository, options.actor, context, fact);
    }
    return factImportProof(context);
  };
}

export function createCatalogRecordedImporterVerifier(
  options: CatalogRecordedImporterOptions,
): CatalogCrawlerVerifyFactImportStep<CatalogRecordedImporterFact> {
  return async (context) => {
    const persistedIdentities: string[] = [];
    for (const [index, fact] of context.facts.entries()) {
      const snapshot = await options.catalogRepository.getWorkByExternalId(
        options.actor,
        context.adapter.catalogSource,
        fact.sourceId,
        catalogExternalIdKindValues.sourceRecord,
      );
      const sourceRecord = snapshot?.externalIds.find(
        (externalId) =>
          externalId.catalogSource === context.adapter.catalogSource &&
          externalId.sourceId === fact.sourceId &&
          externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      if (
        snapshot === null ||
        snapshot === undefined ||
        sourceRecord === undefined ||
        metadataString(sourceRecord.metadata, "stableImportKey") !== context.stableImportKey ||
        metadataString(sourceRecord.metadata, "importTransactionId") !== context.importTransactionId
      ) {
        return null;
      }
      persistedIdentities.push(context.expectedFactIdentities[index] ?? "");
    }

    if (!sameStringList(persistedIdentities, context.expectedFactIdentities)) {
      return null;
    }

    return {
      ...factImportProof(context),
      persisted: true,
    } satisfies CatalogCrawlerFactImportEvidence;
  };
}

async function importRecordedCatalogFact(
  catalogRepository: ItotoriCatalogRepositoryPort,
  actor: AuthorizationActor,
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
): Promise<void> {
  assertFact(fact);
  const sourceProvenanceId = context.step.sourceProvenanceId;
  const importMetadata = importerMetadata(context, fact);
  const releaseIdsBySourceId = new Map<string, string>();
  for (const release of fact.releases ?? []) {
    if (release.sourceReleaseId !== undefined) {
      releaseIdsBySourceId.set(
        release.sourceReleaseId,
        stableCatalogId("catalog-release", [
          context.adapter.catalogSource,
          fact.sourceId,
          release.sourceReleaseId,
        ]),
      );
    }
  }

  const workInput: CatalogWorkInput = {
    workId: stableCatalogId("catalog-work", [context.adapter.catalogSource, fact.sourceId]),
    canonicalTitle: fact.canonicalTitle,
    metadata: compactJson({
      ...fact.metadata,
      ...importMetadata,
      alternateTitles: fact.titles ?? [],
    }),
    externalIds: externalIdInputs(context, fact, importMetadata, sourceProvenanceId),
    releases: releaseInputs(context, fact, importMetadata, sourceProvenanceId),
    languageStatuses: languageStatusInputs(
      context,
      fact,
      importMetadata,
      sourceProvenanceId,
      releaseIdsBySourceId,
    ),
  };
  if (fact.originalLanguage !== undefined) {
    workInput.originalLanguage = fact.originalLanguage;
  }
  if (fact.firstReleaseYear !== undefined) {
    workInput.firstReleaseYear = fact.firstReleaseYear;
  }
  if (fact.workKind !== undefined) {
    workInput.workKind = fact.workKind;
  }

  await catalogRepository.upsertWork(actor, workInput);

  if (fact.seedTarget !== false) {
    await catalogRepository.recordSeedTarget(actor, seedTargetInput(context, fact, importMetadata));
  }
}

function externalIdInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
): CatalogExternalIdInput[] {
  const inputs = new Map<string, CatalogExternalIdInput>();
  const add = (input: CatalogExternalIdInput) => {
    inputs.set(
      `${input.catalogSource}:${input.sourceId}:${input.externalIdKind ?? catalogExternalIdKindValues.sourceRecord}`,
      input,
    );
  };

  add({
    externalIdId: stableCatalogId("catalog-external-id", [
      context.adapter.catalogSource,
      fact.sourceId,
      catalogExternalIdKindValues.sourceRecord,
    ]),
    catalogSource: context.adapter.catalogSource,
    sourceId: fact.sourceId,
    externalIdKind: catalogExternalIdKindValues.sourceRecord,
    sourceProvenanceId,
    discoveredAt: context.step.fetchedAt,
    metadata: importMetadata,
  });

  for (const externalId of fact.externalIds ?? []) {
    const externalIdKind = externalId.externalIdKind ?? catalogExternalIdKindValues.sourceRecord;
    const catalogSource = externalId.catalogSource ?? context.adapter.catalogSource;
    const input: CatalogExternalIdInput = {
      externalIdId: stableCatalogId("catalog-external-id", [
        catalogSource,
        externalId.sourceId,
        externalIdKind,
      ]),
      catalogSource,
      sourceId: externalId.sourceId,
      externalIdKind,
      sourceProvenanceId,
      discoveredAt: context.step.fetchedAt,
      metadata: compactJson({ ...externalId.metadata, ...importMetadata }),
    };
    if (externalId.confidence !== undefined) {
      input.confidence = externalId.confidence;
    }
    add(input);
  }
  return [...inputs.values()];
}

function releaseInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
): CatalogReleaseInput[] {
  return (fact.releases ?? []).map((release, index) => {
    const sourceReleaseId = release.sourceReleaseId ?? `${fact.sourceId}:release:${index}`;
    const input: CatalogReleaseInput = {
      releaseId: stableCatalogId("catalog-release", [
        context.adapter.catalogSource,
        fact.sourceId,
        sourceReleaseId,
      ]),
      catalogSource: context.adapter.catalogSource,
      sourceReleaseId,
      releaseTitle: release.releaseTitle,
      releaseKind: release.releaseKind ?? catalogReleaseKindValues.unknown,
      sourceProvenanceId,
      metadata: compactJson({ ...release.metadata, ...importMetadata }),
    };
    if (release.platform !== undefined) {
      input.platform = release.platform;
    }
    if (release.language !== undefined) {
      input.language = release.language;
    }
    if (release.releaseDate !== undefined) {
      input.releaseDate = release.releaseDate;
    }
    if (release.releaseYear !== undefined) {
      input.releaseYear = release.releaseYear;
    }
    if (release.isOfficial !== undefined) {
      input.isOfficial = release.isOfficial;
    }
    return input;
  });
}

function languageStatusInputs(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
  releaseIdsBySourceId: ReadonlyMap<string, string>,
): CatalogLanguageStatusInput[] {
  return (fact.languageStatuses ?? []).map((status) => {
    const input: CatalogLanguageStatusInput = {
      languageStatusId: stableCatalogId("catalog-language-status", [
        context.adapter.catalogSource,
        fact.sourceId,
        status.language,
        status.statusScope ?? catalogLanguageStatusScopeValues.work,
        status.platform ?? "",
        status.releaseSourceId ?? "",
      ]),
      language: status.language,
      status: status.status,
      statusScope: status.statusScope ?? catalogLanguageStatusScopeValues.work,
      sourceProvenanceId,
      confidence: status.confidence ?? catalogConfidenceValues.high,
      observedAt: status.observedAt ?? context.step.fetchedAt,
      importedAt: context.step.fetchedAt,
      parserVersion: context.adapter.parserVersion,
      rawContentRedactionClass:
        status.rawContentRedactionClass ?? catalogRawContentRedactionClassValues.publicMetadata,
      metadata: compactJson({ ...status.metadata, ...importMetadata }),
    };
    if (status.platform !== undefined) {
      input.platform = status.platform;
    }
    if (status.releaseSourceId !== undefined) {
      const releaseId = releaseIdsBySourceId.get(status.releaseSourceId);
      if (releaseId !== undefined) {
        input.releaseId = releaseId;
      }
    }
    if (status.isCurrent !== undefined) {
      input.isCurrent = status.isCurrent;
    }
    return input;
  });
}

function seedTargetInput(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
): CatalogSeedTargetInput {
  const seedTarget = fact.seedTarget === false ? undefined : fact.seedTarget;
  return {
    seedTargetId: stableCatalogId("catalog-seed-target", [
      context.adapter.catalogSource,
      fact.sourceId,
      catalogSeedOriginValues.importer,
      seedTarget?.originRef ?? context.adapter.fixtureId ?? context.adapter.adapterName,
    ]),
    catalogSource: context.adapter.catalogSource,
    sourceId: fact.sourceId,
    seedOrigin: catalogSeedOriginValues.importer,
    originRef: seedTarget?.originRef ?? context.adapter.fixtureId ?? context.adapter.adapterName,
    sourceProvenanceId: context.step.sourceProvenanceId,
    status: seedTarget?.status ?? catalogSeedStatusValues.pending,
    priority: seedTarget?.priority ?? 0,
    addedAt: context.step.fetchedAt,
    metadata: compactJson({ ...seedTarget?.metadata, ...importMetadata }),
  };
}

function factImportProof(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
): CatalogCrawlerFactImportProof {
  return {
    stableImportKey: context.stableImportKey,
    strategy: catalogCrawlerFactImportStrategyValues.upsert,
    factCount: context.facts.length,
    factIdentities: context.expectedFactIdentities,
  };
}

function importerMetadata(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
): CatalogJsonRecord {
  return compactJson({
    catalogSource: context.adapter.catalogSource,
    sourceId: fact.sourceId,
    sourceVersion: context.adapter.sourceVersion,
    parserVersion: context.adapter.parserVersion,
    importerVersion: catalogRecordedImporterVersion,
    adapterName: context.adapter.adapterName,
    fixtureId: context.adapter.fixtureId,
    stableImportKey: context.stableImportKey,
    importTransactionId: context.importTransactionId,
    requestIdentity: context.step.requestIdentity,
    fetchedAt: context.step.fetchedAt.toISOString(),
    sourceProvenanceId: context.step.sourceProvenanceId,
  });
}

function stableCatalogId(namespace: string, parts: readonly string[]): string {
  return `${namespace}:${sha256(stableJsonStringify(parts)).slice(0, 32)}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableJsonStringify(input: unknown): string {
  if (input === undefined) {
    return "undefined";
  }
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input) ?? "undefined";
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  }
  const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${stableJsonStringify(value)}`)
    .join(",")}}`;
}

function compactJson(input: CatalogJsonRecord): CatalogJsonRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function metadataString(metadata: CatalogJsonRecord, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertFact(fact: CatalogRecordedImporterFact): void {
  requiredString(fact.sourceId, "fact.sourceId");
  requiredString(fact.canonicalTitle, "fact.canonicalTitle");
  for (const externalId of fact.externalIds ?? []) {
    requiredString(externalId.sourceId, "fact.externalIds[].sourceId");
  }
  for (const release of fact.releases ?? []) {
    requiredString(release.releaseTitle, "fact.releases[].releaseTitle");
  }
  for (const status of fact.languageStatuses ?? []) {
    requiredString(status.language, "fact.languageStatuses[].language");
  }
}

function requiredString(value: string | undefined, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}
