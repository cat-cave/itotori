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

import {
  createExpectedFactIdentities,
  createReplayValidationRecord,
  createStableImportKey,
  validateFactImportProof,
} from "./catalog-crawler-recorded-fixture.js";
import {
  validateAdapterReadinessContract,
  verifyPersistedImportEvidenceForStep,
} from "./catalog-crawler-proof-validation.js";

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
