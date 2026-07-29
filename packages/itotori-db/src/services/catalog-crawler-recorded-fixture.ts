import {
  type CatalogCrawlerCursor,
  type CatalogCrawlerStepRecord,
} from "../repositories/catalog-crawler-repository.js";

import {
  type CatalogCrawlerAdapterReadiness,
  type CatalogCrawlerAdapterStep,
  type CatalogCrawlerFactImportContract,
  type CatalogCrawlerFactImportProof,
  catalogCrawlerFactImportStrategyValues,
  catalogCrawlerIdempotentFactImportContractId,
  type CatalogCrawlerPublicSource,
  catalogCrawlerPublicSources,
  type CatalogCrawlerReplayValidationRecord,
  type CatalogCrawlerSourceAdapter,
} from "./catalog-crawler-contract-types.js";
import {
  identityFieldValue,
  sameStringList,
  sha256,
  validateAdapterReadinessContract,
} from "./catalog-crawler-proof-validation.js";
import { stableJsonStringify } from "../stable-json.js";
import {
  requiredFixtureString,
  validateRecordedCatalogCrawlerStep,
} from "./catalog-crawler-step-validation.js";

export type RecordedCatalogCrawlerFixture<TFact = unknown> = {
  fixtureId: string;
  fixtureName: string;
  catalogSource: CatalogCrawlerPublicSource;
  adapterName: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  readiness?: CatalogCrawlerAdapterReadiness;
  factImportContract?: CatalogCrawlerFactImportContract;
  partitionKey?: string;
  initialCheckpointCursor?: CatalogCrawlerCursor;
  steps: readonly CatalogCrawlerAdapterStep<TFact>[];
};

export function createRecordedCatalogCrawlerAdapter<TFact>(
  fixture: RecordedCatalogCrawlerFixture<TFact>,
): CatalogCrawlerSourceAdapter<TFact> {
  validateRecordedCatalogCrawlerFixture(fixture);
  const adapter: CatalogCrawlerSourceAdapter<TFact> = {
    catalogSource: fixture.catalogSource,
    adapterName: fixture.adapterName,
    adapterVersion: fixture.adapterVersion,
    sourceVersion: fixture.sourceVersion,
    parserVersion: fixture.parserVersion,
    fixtureId: fixture.fixtureId,
    *steps(context) {
      if (context.mode !== "recorded_fixture") {
        throw new Error("recorded crawler fixtures must run in recorded_fixture mode");
      }
      const resumeAfterStepKey = checkpointAfterStepKey(context.checkpointCursor);
      let skipping = resumeAfterStepKey !== null;
      for (const step of fixture.steps) {
        if (skipping) {
          if (step.stepKey === resumeAfterStepKey) {
            skipping = false;
          }
          continue;
        }
        yield step;
      }
    },
  };
  if (fixture.partitionKey !== undefined) {
    adapter.partitionKey = fixture.partitionKey;
  }
  if (fixture.initialCheckpointCursor !== undefined) {
    adapter.initialCheckpointCursor = fixture.initialCheckpointCursor;
  }
  if (fixture.readiness !== undefined) {
    adapter.readiness = fixture.readiness;
  }
  if (fixture.factImportContract !== undefined) {
    adapter.factImportContract = fixture.factImportContract;
  }
  return adapter;
}

export function checkpointAfterStepKey(cursor: CatalogCrawlerCursor): string | null {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    return null;
  }
  const afterStepKey = (cursor as Record<string, unknown>).afterStepKey;
  return typeof afterStepKey === "string" ? afterStepKey : null;
}

export function validateRecordedCatalogCrawlerFixture<TFact>(
  fixture: RecordedCatalogCrawlerFixture<TFact>,
): void {
  if (fixture === null || typeof fixture !== "object") {
    throw new Error("recorded crawler fixture must be a JSON object");
  }
  requiredFixtureString(fixture.fixtureId, "fixtureId");
  requiredFixtureString(fixture.fixtureName, "fixtureName");
  if (!catalogCrawlerPublicSources.includes(fixture.catalogSource)) {
    throw new Error(
      `recorded crawler fixture has unsupported catalogSource ${String(fixture.catalogSource)}`,
    );
  }
  requiredFixtureString(fixture.adapterName, "adapterName");
  requiredFixtureString(fixture.adapterVersion, "adapterVersion");
  requiredFixtureString(fixture.sourceVersion, "sourceVersion");
  requiredFixtureString(fixture.parserVersion, "parserVersion");
  if (fixture.partitionKey !== undefined) {
    requiredFixtureString(fixture.partitionKey, "partitionKey");
  }
  validateAdapterReadinessContract(fixture);
  if (!Array.isArray(fixture.steps)) {
    throw new Error("recorded crawler fixture steps must be an array");
  }
  for (const [index, step] of fixture.steps.entries()) {
    validateRecordedCatalogCrawlerStep(step, `steps[${index}]`);
  }
}

export function createReplayValidationRecord<TFact>(
  adapter: CatalogCrawlerSourceAdapter<TFact>,
  recorded: { step: CatalogCrawlerStepRecord; alreadyImported: boolean },
  adapterStep: CatalogCrawlerAdapterStep<TFact>,
  stableImportKey: string,
  factIdentities: readonly string[],
): CatalogCrawlerReplayValidationRecord | null {
  if (adapter.fixtureId === undefined || adapter.factImportContract === undefined) {
    return null;
  }
  return {
    contractId: catalogCrawlerIdempotentFactImportContractId,
    catalogSource: adapter.catalogSource,
    sourceId: adapterStep.sourceId,
    fixtureId: adapter.fixtureId,
    stableImportKey,
    importTransactionId: stableImportKey,
    stepKey: adapterStep.stepKey,
    factCount: adapterStep.facts.length,
    factIdentities,
    alreadyImported: recorded.alreadyImported,
  };
}

export function createStableImportKey<TFact>(
  adapter: CatalogCrawlerSourceAdapter<TFact>,
  partitionKey: string,
  step: CatalogCrawlerAdapterStep<TFact>,
): string {
  const payloadHash = step.payloadHash ?? `sha256:${sha256(stableJsonStringify(step.payload))}`;
  return `catalog-import:${sha256(
    stableJsonStringify({
      catalogSource: adapter.catalogSource,
      adapterName: adapter.adapterName,
      partitionKey,
      sourceVersion: adapter.sourceVersion,
      parserVersion: adapter.parserVersion,
      stepKey: step.stepKey,
      sourceId: step.sourceId,
      requestIdentity: step.requestIdentity,
      payloadHash,
    }),
  )}`;
}

export function createExpectedFactIdentities<TFact>(
  adapter: CatalogCrawlerSourceAdapter<TFact>,
  step: CatalogCrawlerAdapterStep<TFact>,
): readonly string[] {
  const contract = adapter.factImportContract;
  if (contract === undefined) {
    return [];
  }
  return step.facts.map((fact, index) =>
    contract.factIdentity
      .map((field) => `${field}=${String(identityFieldValue(adapter, step, fact, index, field))}`)
      .join("|"),
  );
}

export function validateFactImportProof<TFact>(
  adapter: CatalogCrawlerSourceAdapter<TFact>,
  step: CatalogCrawlerAdapterStep<TFact>,
  stableImportKey: string,
  proof: CatalogCrawlerFactImportProof | void,
): asserts proof is CatalogCrawlerFactImportProof {
  const contract = adapter.factImportContract;
  if (contract === undefined) {
    return;
  }
  if (proof === undefined) {
    throw new Error(
      `${adapter.adapterName} CATALOG-065 ingestStep must return a fact import proof before commitStepImport`,
    );
  }
  if (proof.stableImportKey !== stableImportKey) {
    throw new Error(`${adapter.adapterName} fact import proof stableImportKey mismatch`);
  }
  if (proof.strategy !== contract.strategy) {
    throw new Error(`${adapter.adapterName} fact import proof strategy mismatch`);
  }
  if (proof.factCount !== step.facts.length) {
    throw new Error(`${adapter.adapterName} fact import proof factCount mismatch`);
  }
  const expectedFactIdentities = createExpectedFactIdentities(adapter, step);
  if (!Array.isArray(proof.factIdentities)) {
    throw new Error(`${adapter.adapterName} fact import proof factIdentities must be an array`);
  }
  if (!sameStringList(proof.factIdentities, expectedFactIdentities)) {
    throw new Error(`${adapter.adapterName} fact import proof factIdentities mismatch`);
  }
  if (
    contract.strategy === catalogCrawlerFactImportStrategyValues.durableImportMarker &&
    proof.durableMarkerId !== stableImportKey
  ) {
    throw new Error(
      `${adapter.adapterName} durable import marker proof must persist stableImportKey as durableMarkerId`,
    );
  }
}
