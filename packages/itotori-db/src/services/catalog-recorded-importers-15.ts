import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogExternalIdRecord,
  CatalogJsonRecord,
  CatalogSeedTargetInput,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceValues,
  type CatalogSource,
} from "../schema.js";
import {
  catalogCrawlerFactImportStrategyValues,
  type CatalogCrawlerFactImportProof,
  type CatalogCrawlerIngestContext,
} from "./catalog-crawler-runner.js";

import { catalogRecordedImporterVersion } from "./catalog-recorded-importers-01.js";
import { type CatalogRecordedImporterFact } from "./catalog-recorded-importers-03.js";
import { optionalString } from "./catalog-recorded-importers-10.js";
import { requiredString } from "./catalog-recorded-importers-16.js";

export type CrossSourceEvidenceAttribution = {
  provenanceId: string | null;
  sourceKey: string | null;
};

// Resolve the original-source attribution for a cross-source conflict-evidence row.
// Platform-language conflict evidence (and any future cross-source conflict) carries
// the original evidence's `catalogSource`/`sourceId` in its metadata; when those cite
// a source OTHER than the importer's own payload, the row is attributed to that
// source — the same attribution the repository-derived conflict service uses — so
// review/demotion output names the original evidence source. The cited source may NOT
// be catalogued locally yet (a forward-reference to a source not yet ingested, e.g.
// an official platform source arriving before the candidate source is crawled); in
// that case `provenanceId` is null and `sourceKey` carries the `<catalogSource>:<sourceId>`
// identity, so the caller preserves the real cited source instead of mis-attributing
// the row to the importer-payload provenance. Own-source evidence and evidence carrying
// no source identity return `{ provenanceId: null, sourceKey: null }` (callers default
// those to the importer-payload provenance).
export async function resolveCrossSourceEvidenceAttribution(
  catalogRepository: ItotoriCatalogRepositoryPort,
  actor: AuthorizationActor,
  importerCatalogSource: CatalogSource,
  importerSourceId: string,
  evidenceMetadata: CatalogJsonRecord | undefined,
  cache: Map<string, CrossSourceEvidenceAttribution>,
): Promise<CrossSourceEvidenceAttribution> {
  const ownSource: CrossSourceEvidenceAttribution = { provenanceId: null, sourceKey: null };
  if (evidenceMetadata === undefined) {
    return ownSource;
  }
  const catalogSourceValue = optionalString(evidenceMetadata, "catalogSource");
  const sourceId = optionalString(evidenceMetadata, "sourceId");
  if (sourceId === undefined) {
    return ownSource;
  }
  if (
    catalogSourceValue === undefined ||
    !(Object.values(catalogSourceValues) as string[]).includes(catalogSourceValue)
  ) {
    return ownSource;
  }
  const catalogSource = catalogSourceValue as CatalogSource;
  if (catalogSource === importerCatalogSource && sourceId === importerSourceId) {
    return ownSource;
  }
  const cacheKey = `${catalogSource}:${sourceId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const snapshot = await catalogRepository.getWorkByExternalId(actor, catalogSource, sourceId);
  const externalId = snapshot?.externalIds.find(
    (row) => row.catalogSource === catalogSource && row.sourceId === sourceId,
  );
  const attribution: CrossSourceEvidenceAttribution = {
    provenanceId: externalId?.sourceProvenanceId ?? null,
    sourceKey: cacheKey,
  };
  cache.set(cacheKey, attribution);
  return attribution;
}

export function seedTargetInput(
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
    // CATALOG-080: a recorded importer only authors an INERT seed HINT. It must
    // never be directly benchmark-selectable; it stays inert (carrying its
    // source-fact provenance) until CATALOG-004 readiness filtering consumes it
    // and produces a readiness explanation. The importer's suggested status and
    // priority are preserved as evidence for that later promotion.
    status: catalogSeedStatusValues.inert,
    priority: seedTarget?.priority ?? 0,
    addedAt: context.step.fetchedAt,
    metadata: compactJson({
      ...seedTarget?.metadata,
      ...importMetadata,
      seedHintState: catalogSeedStatusValues.inert,
      importerRequestedStatus: seedTarget?.status ?? catalogSeedStatusValues.pending,
    }),
  };
}

// Reconstruct a fact identity from a persisted external-id record read back
// from the repository. Mirrors the runner's createExpectedFactIdentities for
// storefrontFactImportContract.factIdentity = ["catalogSource", "sourceId"], so
// the verifier compares persisted data against the expected identities instead
// of comparing the expected identities to a copy of themselves.
export function persistedFactIdentity(record: CatalogExternalIdRecord): string {
  return `catalogSource=${record.catalogSource}|sourceId=${record.sourceId}`;
}

export function factImportProof(
  context: CatalogCrawlerIngestContext<CatalogRecordedImporterFact>,
): CatalogCrawlerFactImportProof {
  return {
    stableImportKey: context.stableImportKey,
    strategy: catalogCrawlerFactImportStrategyValues.upsert,
    factCount: context.facts.length,
    factIdentities: context.expectedFactIdentities,
  };
}

export function importerMetadata(
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

export function stableCatalogId(namespace: string, parts: readonly string[]): string {
  return `${namespace}:${sha256(stableJsonStringify(parts)).slice(0, 32)}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableJsonStringify(input: unknown): string {
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

export function compactJson(input: CatalogJsonRecord): CatalogJsonRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function metadataString(metadata: CatalogJsonRecord, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertFact(fact: CatalogRecordedImporterFact): void {
  requiredString(fact.sourceId, "fact.sourceId");
  requiredString(fact.canonicalTitle, "fact.canonicalTitle");
  for (const externalId of fact.externalIds ?? []) {
    requiredString(externalId.sourceId, "fact.externalIds[].sourceId");
  }
  for (const release of fact.releases ?? []) {
    requiredString(release.releaseTitle, "fact.releases[].releaseTitle");
  }
  for (const mapping of fact.releaseMappings ?? []) {
    requiredString(mapping.sourceReleaseId, "fact.releaseMappings[].sourceReleaseId");
    requiredString(mapping.targetReleaseId, "fact.releaseMappings[].targetReleaseId");
    requiredString(mapping.relationKind, "fact.releaseMappings[].relationKind");
  }
  for (const status of fact.languageStatuses ?? []) {
    requiredString(status.language, "fact.languageStatuses[].language");
  }
  for (const demandFact of fact.demandFacts ?? []) {
    requiredString(demandFact.factKind, "fact.demandFacts[].factKind");
    if (
      demandFact.factValue === null ||
      typeof demandFact.factValue !== "object" ||
      Array.isArray(demandFact.factValue)
    ) {
      throw new Error("fact.demandFacts[].factValue must be a JSON object");
    }
  }
}
