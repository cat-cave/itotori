import { createHash } from "node:crypto";

import {
  type CatalogCrawlerAdapterStep,
  type CatalogCrawlerFactImportContract,
  type CatalogCrawlerFactImportEvidence,
  type CatalogCrawlerFactImportProof,
  catalogCrawlerFactImportStrategyValues,
  catalogCrawlerIdempotentFactImportContractId,
  type CatalogCrawlerIngestContext,
  type CatalogCrawlerSourceAdapter,
  type CatalogCrawlerVerifyFactImportStep,
} from "./catalog-crawler-contract-types.js";
import { createExpectedFactIdentities } from "./catalog-crawler-recorded-fixture.js";
import { requiredFixtureString } from "./catalog-crawler-step-validation.js";

export async function verifyPersistedImportEvidenceForStep<TFact>(
  adapter: CatalogCrawlerSourceAdapter<TFact>,
  step: CatalogCrawlerAdapterStep<TFact>,
  stableImportKey: string,
  ingestContext: CatalogCrawlerIngestContext<TFact>,
  verifyFactImport: CatalogCrawlerVerifyFactImportStep<TFact> | undefined,
  proof?: CatalogCrawlerFactImportProof,
): Promise<void> {
  const contract = adapter.factImportContract;
  if (contract === undefined) {
    return;
  }
  if (verifyFactImport === undefined) {
    throw new Error(
      `${adapter.adapterName} declares CATALOG-065; verifyFactImport must confirm persisted facts or durable marker before commitStepImport`,
    );
  }
  const persistedEvidence = await verifyFactImport({
    ...ingestContext,
    proof:
      proof ??
      expectedFactImportProof(
        contract,
        stableImportKey,
        step.facts.length,
        ingestContext.expectedFactIdentities,
      ),
  });
  validatePersistedFactImportEvidence(adapter, step, stableImportKey, persistedEvidence);
}

export function expectedFactImportProof(
  contract: CatalogCrawlerFactImportContract,
  stableImportKey: string,
  factCount: number,
  factIdentities: readonly string[],
): CatalogCrawlerFactImportProof {
  return {
    stableImportKey,
    strategy: contract.strategy,
    factCount,
    factIdentities,
    ...(contract.strategy === catalogCrawlerFactImportStrategyValues.durableImportMarker
      ? { durableMarkerId: stableImportKey }
      : {}),
  };
}

export function validatePersistedFactImportEvidence<TFact>(
  adapter: CatalogCrawlerSourceAdapter<TFact>,
  step: CatalogCrawlerAdapterStep<TFact>,
  stableImportKey: string,
  evidence: CatalogCrawlerFactImportEvidence | null | undefined,
): asserts evidence is CatalogCrawlerFactImportEvidence {
  const contract = adapter.factImportContract;
  if (contract === undefined) {
    return;
  }
  if (evidence === null || evidence === undefined) {
    throw new Error(
      `${adapter.adapterName} CATALOG-065 verifier did not find persisted import evidence`,
    );
  }
  if (evidence.persisted !== true) {
    throw new Error(`${adapter.adapterName} fact import evidence must be persisted`);
  }
  if (evidence.stableImportKey !== stableImportKey) {
    throw new Error(`${adapter.adapterName} persisted import evidence stableImportKey mismatch`);
  }
  if (evidence.strategy !== contract.strategy) {
    throw new Error(`${adapter.adapterName} persisted import evidence strategy mismatch`);
  }
  if (evidence.factCount !== step.facts.length) {
    throw new Error(`${adapter.adapterName} persisted import evidence factCount mismatch`);
  }
  const expectedFactIdentities = createExpectedFactIdentities(adapter, step);
  if (!Array.isArray(evidence.factIdentities)) {
    throw new Error(
      `${adapter.adapterName} persisted import evidence factIdentities must be an array`,
    );
  }
  if (!sameStringList(evidence.factIdentities, expectedFactIdentities)) {
    throw new Error(`${adapter.adapterName} persisted import evidence factIdentities mismatch`);
  }
  if (
    contract.strategy === catalogCrawlerFactImportStrategyValues.durableImportMarker &&
    evidence.durableMarkerId !== stableImportKey
  ) {
    throw new Error(
      `${adapter.adapterName} persisted durable marker evidence must use stableImportKey as durableMarkerId`,
    );
  }
}

export function identityFieldValue<TFact>(
  adapter: CatalogCrawlerSourceAdapter<TFact>,
  step: CatalogCrawlerAdapterStep<TFact>,
  fact: TFact,
  factIndex: number,
  field: string,
): unknown {
  if (field === "catalogSource") {
    return adapter.catalogSource;
  }
  if (field === "adapterName") {
    return adapter.adapterName;
  }
  if (field === "sourceVersion") {
    return adapter.sourceVersion;
  }
  if (field === "parserVersion") {
    return adapter.parserVersion;
  }
  if (field === "stepKey") {
    return step.stepKey;
  }
  if (field === "sourceId") {
    return objectPath(fact, field) ?? step.sourceId;
  }
  if (field === "factIndex") {
    return factIndex;
  }
  const value = objectPath(fact, field) ?? objectPath(step, field);
  if (value === undefined || value === null || (typeof value === "string" && value.length === 0)) {
    throw new Error(`fact identity field ${field} is missing`);
  }
  return value;
}

export function objectPath(input: unknown, path: string): unknown {
  if (input === null || typeof input !== "object") {
    return undefined;
  }
  let value: unknown = input;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
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

export function validateAdapterReadinessContract<TFact>(
  adapter: Pick<
    CatalogCrawlerSourceAdapter<TFact>,
    "adapterName" | "readiness" | "factImportContract"
  >,
): void {
  if (adapter.readiness !== "alpha_ready" && adapter.readiness !== "production_ready") {
    return;
  }
  const contract = adapter.factImportContract;
  if (contract === undefined) {
    throw new Error(
      `${adapter.adapterName} ${adapter.readiness} adapters must declare the CATALOG-065 idempotent fact import contract`,
    );
  }
  if (contract.contractId !== catalogCrawlerIdempotentFactImportContractId) {
    throw new Error(`${adapter.adapterName} fact import contract must cite CATALOG-065`);
  }
  if (
    contract.strategy !== catalogCrawlerFactImportStrategyValues.upsert &&
    contract.strategy !== catalogCrawlerFactImportStrategyValues.durableImportMarker
  ) {
    throw new Error(
      `${adapter.adapterName} fact import contract must use upsert or durable_import_marker`,
    );
  }
  if (!Array.isArray(contract.factIdentity) || contract.factIdentity.length === 0) {
    throw new Error(`${adapter.adapterName} fact import contract must define factIdentity`);
  }
  for (const field of contract.factIdentity) {
    requiredFixtureString(field, "factImportContract.factIdentity[]");
  }
  const requiredReplayFields = [
    "sourceId",
    "fixtureId",
    "stableImportKey",
    "importTransactionId",
    "factCount",
    "factIdentities",
  ] as const;
  if (!Array.isArray(contract.replayValidation)) {
    throw new Error(`${adapter.adapterName} fact import contract must define replayValidation`);
  }
  for (const field of requiredReplayFields) {
    if (!contract.replayValidation.includes(field)) {
      throw new Error(
        `${adapter.adapterName} fact import contract replayValidation must include ${field}`,
      );
    }
  }
}
