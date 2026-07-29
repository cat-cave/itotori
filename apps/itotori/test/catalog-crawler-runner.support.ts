import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  catalogCrawlerIdempotentFactImportContractId,
  catalogCrawlerFactImportStrategyValues,
  createRecordedCatalogCrawlerAdapter,
  type AuthorizationActor,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerSourceAdapter,
  type CatalogCrawlerVerifyFactImportStep,
  type RecordedCatalogCrawlerFixture,
} from "@itotori/db";

export const actor: AuthorizationActor = { userId: "fixture-user" };

export type FixtureFact = {
  sourceId: string;
  normalizedTitle: string;
};

export const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-crawler-vndb/replay.json", import.meta.url),
    "utf8",
  ),
) as RecordedCatalogCrawlerFixture<FixtureFact>;

export type PersistedImport = {
  strategy: CatalogCrawlerFactImportEvidence["strategy"];
  factIdentities: readonly string[];
  durableMarkerId?: string;
};

export function durableMarkerAdapter(): CatalogCrawlerSourceAdapter<FixtureFact> {
  return {
    ...createRecordedCatalogCrawlerAdapter(fixture),
    adapterName: "vndb-durable-marker-fixture",
    factImportContract: {
      contractId: catalogCrawlerIdempotentFactImportContractId,
      strategy: catalogCrawlerFactImportStrategyValues.durableImportMarker,
      factIdentity: ["catalogSource", "sourceId"],
      replayValidation: [
        "sourceId",
        "fixtureId",
        "stableImportKey",
        "importTransactionId",
        "factCount",
        "factIdentities",
      ],
    },
  };
}

export function persistFacts(
  context: CatalogCrawlerIngestContext<FixtureFact>,
  persistedImports: Map<string, PersistedImport>,
) {
  persistedImports.set(context.stableImportKey, {
    strategy: catalogCrawlerFactImportStrategyValues.upsert,
    factIdentities: context.expectedFactIdentities,
  });
  return importProof(context);
}

export function persistDurableMarker(
  context: CatalogCrawlerIngestContext<FixtureFact>,
  persistedImports: Map<string, PersistedImport>,
) {
  persistedImports.set(context.stableImportKey, {
    strategy: catalogCrawlerFactImportStrategyValues.durableImportMarker,
    factIdentities: context.expectedFactIdentities,
    durableMarkerId: context.stableImportKey,
  });
}

export function verifyPersistedImport(
  persistedImports: Map<string, PersistedImport>,
): CatalogCrawlerVerifyFactImportStep<FixtureFact> {
  return ({ proof }) => {
    const persisted = persistedImports.get(proof.stableImportKey);
    if (persisted === undefined) {
      return null;
    }
    return {
      stableImportKey: proof.stableImportKey,
      strategy: persisted.strategy,
      factCount: persisted.factIdentities.length,
      factIdentities: persisted.factIdentities,
      durableMarkerId: persisted.durableMarkerId,
      persisted: true,
    };
  };
}

export function importProof(context: CatalogCrawlerIngestContext<FixtureFact>) {
  return {
    stableImportKey: context.stableImportKey,
    strategy:
      context.adapter.factImportContract?.strategy ?? catalogCrawlerFactImportStrategyValues.upsert,
    factCount: context.facts.length,
    factIdentities: context.expectedFactIdentities,
    durableMarkerId:
      context.adapter.factImportContract?.strategy ===
      catalogCrawlerFactImportStrategyValues.durableImportMarker
        ? context.stableImportKey
        : undefined,
  };
}

export function stableImportKeyForStep(
  adapter: CatalogCrawlerSourceAdapter<FixtureFact>,
  step: RecordedCatalogCrawlerFixture<FixtureFact>["steps"][number],
): string {
  const payloadHash = step.payloadHash ?? `sha256:${sha256(stableJsonStringify(step.payload))}`;
  return `catalog-import:${sha256(
    stableJsonStringify({
      catalogSource: adapter.catalogSource,
      adapterName: adapter.adapterName,
      partitionKey: adapter.partitionKey ?? "default",
      sourceVersion: adapter.sourceVersion,
      parserVersion: adapter.parserVersion,
      stepKey: step.stepKey,
      sourceId: step.sourceId,
      requestIdentity: step.requestIdentity,
      payloadHash,
    }),
  )}`;
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
