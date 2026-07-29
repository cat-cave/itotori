import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogExternalIdInput,
  CatalogJsonRecord,
  CatalogReleaseInput,
  CatalogWorkInput,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogConflictKindValues,
  catalogExternalIdKindValues,
  catalogReleaseKindValues,
} from "../schema.js";
import { type CatalogCrawlerIngestContext } from "./catalog-crawler-runner.js";

import {
  type CatalogRecordedConflictFact,
  type CatalogRecordedImporterFact,
} from "./catalog-recorded-importers-03.js";
import {
  conflictInputs,
  demandFactInputs,
  languageStatusInputs,
  releaseMappingInputs,
} from "./catalog-recorded-importers-14.js";
import {
  assertFact,
  compactJson,
  importerMetadata,
  seedTargetInput,
  stableCatalogId,
} from "./catalog-recorded-importers-15.js";

export async function importRecordedCatalogFact(
  catalogRepository: ItotoriCatalogRepositoryPort,
  actor: AuthorizationActor,
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
): Promise<void> {
  assertFact(fact);
  const sourceProvenanceId = context.step.sourceProvenanceId;
  const importMetadata = importerMetadata(context, fact);
  const workId = stableCatalogId("catalog-work", [context.adapter.catalogSource, fact.sourceId]);
  const generatedConflicts: CatalogRecordedConflictFact[] = [];
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
    workId,
    canonicalTitle: fact.canonicalTitle,
    metadata: compactJson({
      ...fact.metadata,
      ...importMetadata,
      alternateTitles: fact.titles ?? [],
    }),
    externalIds: await externalIdInputs(
      catalogRepository,
      actor,
      context,
      fact,
      importMetadata,
      sourceProvenanceId,
      workId,
      generatedConflicts,
    ),
    releases: releaseInputs(context, fact, importMetadata, sourceProvenanceId),
    releaseMappings: releaseMappingInputs(context, fact, importMetadata, sourceProvenanceId),
    languageStatuses: languageStatusInputs(
      context,
      fact,
      importMetadata,
      sourceProvenanceId,
      releaseIdsBySourceId,
    ),
    demandFacts: demandFactInputs(context, fact, importMetadata, sourceProvenanceId),
    conflicts: await conflictInputs(
      catalogRepository,
      actor,
      context,
      {
        ...fact,
        conflicts: [...(fact.conflicts ?? []), ...generatedConflicts],
      },
      importMetadata,
      sourceProvenanceId,
      workId,
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

export async function externalIdInputs(
  catalogRepository: ItotoriCatalogRepositoryPort,
  actor: AuthorizationActor,
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
  fact: CatalogRecordedImporterFact,
  importMetadata: CatalogJsonRecord,
  sourceProvenanceId: string,
  workId: string,
  generatedConflicts: CatalogRecordedConflictFact[],
): Promise<CatalogExternalIdInput[]> {
  const inputs = new Map<string, CatalogExternalIdInput>();
  const add = (input: CatalogExternalIdInput) => {
    inputs.set(
      `${input.catalogSource}:${input.sourceId}:${
        input.externalIdKind ?? catalogExternalIdKindValues.sourceRecord
      }`,
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
    const existing = await catalogRepository.getWorkByExternalId(
      actor,
      catalogSource,
      externalId.sourceId,
      externalIdKind,
    );
    if (existing !== null && existing.workId !== workId) {
      generatedConflicts.push({
        conflictKind: catalogConflictKindValues.externalId,
        summary:
          `${context.adapter.catalogSource} ${fact.sourceId} links ` +
          `${catalogSource} ${externalId.sourceId}, but that external id is already attached ` +
          `to ${existing.canonicalTitle}.`,
        reasonCode: "external_id_already_attached",
        severity: "warning",
        metadata: compactJson({
          linkedCatalogSource: catalogSource,
          linkedSourceId: externalId.sourceId,
          linkedExternalIdKind: externalIdKind,
          existingWorkId: existing.workId,
          existingCanonicalTitle: existing.canonicalTitle,
          sourceField: externalId.metadata?.sourceField,
        }),
      });
      continue;
    }
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

export function releaseInputs(
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
    if (release.editionName !== undefined) {
      input.editionName = release.editionName;
    }
    if (release.milestone !== undefined) {
      input.milestone = release.milestone;
    }
    if (release.packageKind !== undefined) {
      input.packageKind = release.packageKind;
    }
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

// Resolve first-class release-mapping facts into repository inputs. Each mapping
// endpoint's sourceReleaseId is resolved to the same stable catalog release id
// that releaseInputs assigns, so the mapping references a persisted release of
// this same work.
