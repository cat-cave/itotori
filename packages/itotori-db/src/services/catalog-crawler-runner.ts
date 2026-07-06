import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import { catalogSourceRecordKindValues, type CatalogSource } from "../schema.js";
import {
  type CatalogCrawlerCheckpointRecord,
  type CatalogCrawlerCursor,
  type CatalogCrawlerJobInput,
  type CatalogCrawlerJobRecord,
  type CatalogCrawlerJsonRecord,
  type CatalogCrawlerRateLimitInput,
  type CatalogCrawlerStepRecord,
  type ItotoriCatalogCrawlerRepositoryPort,
} from "../repositories/catalog-crawler-repository.js";

export const catalogCrawlerPublicSources = [
  "vndb",
  "egs",
  "dlsite",
  "steam",
  "igdb",
  "wikidata",
] as const satisfies readonly CatalogSource[];

export type CatalogCrawlerPublicSource = (typeof catalogCrawlerPublicSources)[number];

export const catalogCrawlerIdempotentFactImportContractId = "CATALOG-065" as const;

export const catalogCrawlerFactImportStrategyValues = {
  upsert: "upsert",
  durableImportMarker: "durable_import_marker",
} as const;

export type CatalogCrawlerFactImportStrategy =
  (typeof catalogCrawlerFactImportStrategyValues)[keyof typeof catalogCrawlerFactImportStrategyValues];

export type CatalogCrawlerAdapterReadiness = "prototype" | "alpha_ready" | "production_ready";

export type CatalogCrawlerFactImportContract = {
  contractId: typeof catalogCrawlerIdempotentFactImportContractId;
  strategy: CatalogCrawlerFactImportStrategy;
  factIdentity: readonly string[];
  replayValidation: readonly (
    | "sourceId"
    | "fixtureId"
    | "stableImportKey"
    | "importTransactionId"
    | "factCount"
    | "factIdentities"
  )[];
};

export type CatalogCrawlerFactImportProof = {
  stableImportKey: string;
  strategy: CatalogCrawlerFactImportStrategy;
  factCount: number;
  factIdentities: readonly string[];
  durableMarkerId?: string;
};

export type CatalogCrawlerFactImportEvidence = CatalogCrawlerFactImportProof & {
  persisted: true;
};

export type CatalogCrawlerAdapterContext = {
  checkpointCursor: CatalogCrawlerCursor;
  mode: "live" | "recorded_fixture";
};

export type CatalogCrawlerRateLimitMetadata = Omit<
  CatalogCrawlerRateLimitInput,
  "catalogSource" | "adapterName" | "partitionKey" | "crawlerJobId" | "workerId"
>;

export type CatalogCrawlerAdapterStep<TFact = unknown> = {
  stepKey: string;
  sourceId: string;
  requestIdentity: string;
  fetchedAt: string | Date;
  checkpointCursor: CatalogCrawlerCursor;
  payload: CatalogCrawlerJsonRecord;
  facts: readonly TFact[];
  httpStatus?: number;
  ok?: boolean;
  payloadHash?: string;
  metadata?: CatalogCrawlerJsonRecord;
  rateLimit?: CatalogCrawlerRateLimitMetadata;
};

export interface CatalogCrawlerSourceAdapter<TFact = unknown> {
  catalogSource: CatalogCrawlerPublicSource;
  adapterName: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  readiness?: CatalogCrawlerAdapterReadiness;
  factImportContract?: CatalogCrawlerFactImportContract;
  fixtureId?: string;
  partitionKey?: string;
  initialCheckpointCursor?: CatalogCrawlerCursor;
  steps(
    context: CatalogCrawlerAdapterContext,
  ): AsyncIterable<CatalogCrawlerAdapterStep<TFact>> | Iterable<CatalogCrawlerAdapterStep<TFact>>;
}

export type CatalogCrawlerIngestContext<TFact = unknown> = {
  adapter: CatalogCrawlerSourceAdapter<TFact>;
  job: CatalogCrawlerJobRecord;
  step: CatalogCrawlerStepRecord;
  stableImportKey: string;
  importTransactionId: string;
  expectedFactIdentities: readonly string[];
  facts: readonly TFact[];
};

export type CatalogCrawlerIngestStep<TFact = unknown> = (
  context: CatalogCrawlerIngestContext<TFact>,
) => Promise<CatalogCrawlerFactImportProof | void> | CatalogCrawlerFactImportProof | void;

export type CatalogCrawlerVerifyFactImportStep<TFact = unknown> = (
  context: CatalogCrawlerIngestContext<TFact> & {
    proof: CatalogCrawlerFactImportProof;
  },
) =>
  | Promise<CatalogCrawlerFactImportEvidence | null | undefined>
  | CatalogCrawlerFactImportEvidence
  | null
  | undefined;

/**
 * Runner extension point that fires in the CATALOG-074 crash window: after the
 * source facts have been ingested and the import proof has been validated and
 * verified against persisted evidence, but strictly BEFORE `commitStepImport`
 * marks the crawler step imported and advances the checkpoint.
 *
 * A `beforeCommitStepImport` hook that throws faithfully models a process crash
 * in that window: the facts are already written, but the step never reaches the
 * imported marker, so a replay must re-ingest idempotently without duplicating
 * facts. It is a real injectable seam for failure-injection harnesses (no manual
 * DB surgery required) and doubles as a clean before-commit extension point.
 */
export type CatalogCrawlerBeforeCommitStepImportContext<TFact = unknown> =
  CatalogCrawlerIngestContext<TFact> & {
    alreadyImported: boolean;
    importProof: CatalogCrawlerFactImportProof | undefined;
  };

export type CatalogCrawlerBeforeCommitStepImportHook<TFact = unknown> = (
  context: CatalogCrawlerBeforeCommitStepImportContext<TFact>,
) => Promise<void> | void;

export type CatalogCrawlerRunnerOptions<TFact = unknown> = {
  repository: ItotoriCatalogCrawlerRepositoryPort;
  actor: AuthorizationActor;
  workerId: string;
  mode?: "live" | "recorded_fixture";
  ingestStep?: CatalogCrawlerIngestStep<TFact>;
  verifyFactImport?: CatalogCrawlerVerifyFactImportStep<TFact>;
  beforeCommitStepImport?: CatalogCrawlerBeforeCommitStepImportHook<TFact>;
  leaseSeconds?: number;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerRunResult = {
  job: CatalogCrawlerJobRecord;
  checkpoint: CatalogCrawlerCheckpointRecord | null;
  fetchedSteps: number;
  importedSteps: number;
  skippedSteps: number;
  replayValidation: CatalogCrawlerReplayValidationRecord[];
};

export type CatalogCrawlerReplayValidationRecord = {
  contractId: typeof catalogCrawlerIdempotentFactImportContractId;
  catalogSource: CatalogCrawlerPublicSource;
  sourceId: string;
  fixtureId: string;
  stableImportKey: string;
  importTransactionId: string;
  stepKey: string;
  factCount: number;
  factIdentities: readonly string[];
  alreadyImported: boolean;
};

export class ItotoriCatalogCrawlerRunner {
  async run<TFact>(
    adapter: CatalogCrawlerSourceAdapter<TFact>,
    options: CatalogCrawlerRunnerOptions<TFact>,
  ): Promise<CatalogCrawlerRunResult> {
    validateAdapterReadinessContract(adapter);
    const partitionKey = adapter.partitionKey ?? "default";
    const checkpoint = await options.repository.getCheckpoint(options.actor, {
      catalogSource: adapter.catalogSource,
      adapterName: adapter.adapterName,
      partitionKey,
    });
    const checkpointMatchesAdapter =
      checkpoint?.sourceVersion === adapter.sourceVersion &&
      checkpoint.parserVersion === adapter.parserVersion;
    const startingCursor: CatalogCrawlerCursor = checkpointMatchesAdapter
      ? checkpoint.checkpointCursor
      : (adapter.initialCheckpointCursor ?? null);
    const jobInput: CatalogCrawlerJobInput = {
      catalogSource: adapter.catalogSource,
      adapterName: adapter.adapterName,
      adapterVersion: adapter.adapterVersion,
      sourceVersion: adapter.sourceVersion,
      parserVersion: adapter.parserVersion,
      partitionKey,
      checkpointCursor: startingCursor,
    };
    if (options.leaseSeconds !== undefined) {
      jobInput.leaseSeconds = options.leaseSeconds;
    }
    if (options.metadata !== undefined) {
      jobInput.metadata = options.metadata;
    }
    let job = await options.repository.startCrawlerJob(options.actor, options.workerId, jobInput);
    let fetchedSteps = 0;
    let importedSteps = 0;
    let skippedSteps = 0;
    const replayValidation: CatalogCrawlerReplayValidationRecord[] = [];
    let currentCheckpoint = checkpoint;
    let lastCursor: CatalogCrawlerCursor = startingCursor;

    try {
      const runMode = options.mode ?? "live";
      // A recorded-fixture replay must persist its source provenance as
      // `recorded_fixture`, NOT `raw_cache`: otherwise replayed fixture facts
      // are indistinguishable from live raw-cache evidence on every public
      // explanation surface that reads the provenance record kind.
      const sourceRecordKind =
        runMode === "recorded_fixture"
          ? catalogSourceRecordKindValues.recordedFixture
          : catalogSourceRecordKindValues.rawCache;
      for await (const adapterStep of adapter.steps({
        checkpointCursor: startingCursor,
        mode: runMode,
      })) {
        fetchedSteps += 1;
        const stepInput = {
          crawlerJobId: job.crawlerJobId,
          workerId: options.workerId,
          stepKey: adapterStep.stepKey,
          catalogSource: adapter.catalogSource,
          adapterName: adapter.adapterName,
          adapterVersion: adapter.adapterVersion,
          partitionKey,
          sourceId: adapterStep.sourceId,
          requestIdentity: adapterStep.requestIdentity,
          sourceVersion: adapter.sourceVersion,
          parserVersion: adapter.parserVersion,
          checkpointCursor: adapterStep.checkpointCursor,
          fetchedAt: adapterStep.fetchedAt,
          payload: adapterStep.payload,
          sourceRecordKind,
        };
        const recorded = await options.repository.recordFetchedStep(options.actor, {
          ...stepInput,
          ...(adapterStep.httpStatus === undefined ? {} : { httpStatus: adapterStep.httpStatus }),
          ...(adapterStep.ok === undefined ? {} : { ok: adapterStep.ok }),
          ...(adapterStep.payloadHash === undefined
            ? {}
            : { payloadHash: adapterStep.payloadHash }),
          ...(adapterStep.metadata === undefined ? {} : { metadata: adapterStep.metadata }),
        });
        const stableImportKey = createStableImportKey(adapter, partitionKey, adapterStep);
        const expectedFactIdentities =
          adapter.factImportContract === undefined
            ? []
            : createExpectedFactIdentities(adapter, adapterStep);
        const ingestContext: CatalogCrawlerIngestContext<TFact> = {
          adapter,
          job,
          step: recorded.step,
          stableImportKey,
          importTransactionId: stableImportKey,
          expectedFactIdentities,
          facts: adapterStep.facts,
        };

        let stepImportProof: CatalogCrawlerFactImportProof | undefined;
        try {
          if (recorded.alreadyImported) {
            if (adapter.factImportContract !== undefined) {
              await verifyPersistedImportEvidenceForStep(
                adapter,
                adapterStep,
                stableImportKey,
                ingestContext,
                options.verifyFactImport,
              );
            }
            skippedSteps += 1;
          } else {
            if (adapter.factImportContract !== undefined && options.ingestStep === undefined) {
              throw new Error(
                `${adapter.adapterName} declares CATALOG-065; ingestStep must write facts or a durable import marker before commitStepImport`,
              );
            }
            const importProof = await options.ingestStep?.(ingestContext);
            if (adapter.factImportContract !== undefined) {
              validateFactImportProof(adapter, adapterStep, stableImportKey, importProof);
              await verifyPersistedImportEvidenceForStep(
                adapter,
                adapterStep,
                stableImportKey,
                ingestContext,
                options.verifyFactImport,
                importProof,
              );
            }
            stepImportProof = importProof ?? undefined;
            importedSteps += 1;
          }
        } catch (error) {
          await options.repository.markStepFailed(
            options.actor,
            recorded.step.crawlerJobStepId,
            error,
            options.workerId,
          );
          throw error;
        }
        const validationRecord = createReplayValidationRecord(
          adapter,
          recorded,
          adapterStep,
          stableImportKey,
          expectedFactIdentities,
        );
        if (validationRecord !== null) {
          replayValidation.push(validationRecord);
        }

        lastCursor = adapterStep.checkpointCursor;
        if (options.beforeCommitStepImport !== undefined) {
          // CATALOG-074 crash window: facts are ingested and the proof is
          // verified, but the step has NOT yet been committed as imported. A
          // hook that throws here models a real crash in that window; the outer
          // catch fails the job and the still-`fetched` step replays idempotently.
          await options.beforeCommitStepImport({
            ...ingestContext,
            alreadyImported: recorded.alreadyImported,
            importProof: stepImportProof,
          });
        }
        const committed = await options.repository.commitStepImport(options.actor, {
          crawlerJobId: job.crawlerJobId,
          workerId: options.workerId,
          crawlerJobStepId: recorded.step.crawlerJobStepId,
          checkpoint: {
            catalogSource: adapter.catalogSource,
            adapterName: adapter.adapterName,
            partitionKey,
            checkpointCursor: adapterStep.checkpointCursor,
            sourceVersion: adapter.sourceVersion,
            parserVersion: adapter.parserVersion,
            lastCrawlerJobId: job.crawlerJobId,
            lastStepKey: adapterStep.stepKey,
            metadata: {
              mode: options.mode ?? "live",
              requestIdentity: adapterStep.requestIdentity,
            },
          },
          ...(adapterStep.rateLimit === undefined
            ? {}
            : {
                rateLimit: {
                  ...adapterStep.rateLimit,
                  catalogSource: adapter.catalogSource,
                  adapterName: adapter.adapterName,
                  partitionKey,
                  requestIdentity:
                    adapterStep.rateLimit.requestIdentity ?? adapterStep.requestIdentity,
                },
              }),
        });
        currentCheckpoint = committed.checkpoint;
      }

      job = await options.repository.completeCrawlerJob(
        options.actor,
        job.crawlerJobId,
        options.workerId,
        lastCursor,
      );
      return {
        job,
        checkpoint: currentCheckpoint,
        fetchedSteps,
        importedSteps,
        skippedSteps,
        replayValidation,
      };
    } catch (error) {
      try {
        await options.repository.failCrawlerJob(
          options.actor,
          job.crawlerJobId,
          options.workerId,
          error,
        );
      } catch {
        // Stale workers should not mask the write that proved they no longer own the job.
      }
      throw error;
    }
  }
}

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

function checkpointAfterStepKey(cursor: CatalogCrawlerCursor): string | null {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    return null;
  }
  const afterStepKey = (cursor as Record<string, unknown>).afterStepKey;
  return typeof afterStepKey === "string" ? afterStepKey : null;
}

function validateRecordedCatalogCrawlerFixture<TFact>(
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

function createReplayValidationRecord<TFact>(
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

function createStableImportKey<TFact>(
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

function createExpectedFactIdentities<TFact>(
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

function validateFactImportProof<TFact>(
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

async function verifyPersistedImportEvidenceForStep<TFact>(
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

function expectedFactImportProof(
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

function validatePersistedFactImportEvidence<TFact>(
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

function identityFieldValue<TFact>(
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

function objectPath(input: unknown, path: string): unknown {
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

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
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

function validateAdapterReadinessContract<TFact>(
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

function validateRecordedCatalogCrawlerStep<TFact>(
  step: CatalogCrawlerAdapterStep<TFact>,
  label: string,
): void {
  if (step === null || typeof step !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  requiredFixtureString(step.stepKey, `${label}.stepKey`);
  requiredFixtureString(step.sourceId, `${label}.sourceId`);
  requiredFixtureString(step.requestIdentity, `${label}.requestIdentity`);
  const fetchedAt = step.fetchedAt instanceof Date ? step.fetchedAt : new Date(step.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) {
    throw new Error(`${label}.fetchedAt must be a valid date`);
  }
  if (step.payload === null || typeof step.payload !== "object" || Array.isArray(step.payload)) {
    throw new Error(`${label}.payload must be a JSON object`);
  }
  if (!Array.isArray(step.facts)) {
    throw new Error(`${label}.facts must be an array`);
  }
  if (
    step.httpStatus !== undefined &&
    (!Number.isInteger(step.httpStatus) || step.httpStatus < 100 || step.httpStatus > 599)
  ) {
    throw new Error(`${label}.httpStatus must be a valid HTTP status code`);
  }
  if (step.payloadHash !== undefined && !step.payloadHash.startsWith("sha256:")) {
    throw new Error(`${label}.payloadHash must start with sha256:`);
  }
  if (step.rateLimit !== undefined) {
    validateRecordedRateLimit(step.rateLimit, `${label}.rateLimit`);
  }
}

function validateRecordedRateLimit(
  rateLimit: CatalogCrawlerRateLimitMetadata,
  label: string,
): void {
  if (rateLimit === null || typeof rateLimit !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  optionalNonnegativeFixtureInteger(rateLimit.remaining, `${label}.remaining`);
  optionalNonnegativeFixtureInteger(rateLimit.limit, `${label}.limit`);
  optionalNonnegativeFixtureInteger(rateLimit.retryAfterSeconds, `${label}.retryAfterSeconds`);
}

function optionalNonnegativeFixtureInteger(input: number | undefined, label: string): void {
  if (input !== undefined && (!Number.isInteger(input) || input < 0)) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
}

function requiredFixtureString(input: string | undefined, label: string): void {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`recorded crawler fixture ${label} is required`);
  }
}
