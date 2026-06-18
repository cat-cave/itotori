import type { AuthorizationActor } from "../authorization.js";
import type { CatalogSource } from "../schema.js";
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

export type CatalogCrawlerAdapterContext = {
  checkpointCursor: CatalogCrawlerCursor;
  mode: "live" | "recorded_fixture";
};

export type CatalogCrawlerRateLimitMetadata = Omit<
  CatalogCrawlerRateLimitInput,
  "catalogSource" | "adapterName" | "partitionKey"
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
  facts: readonly TFact[];
};

export type CatalogCrawlerIngestStep<TFact = unknown> = (
  context: CatalogCrawlerIngestContext<TFact>,
) => Promise<void> | void;

export type CatalogCrawlerRunnerOptions<TFact = unknown> = {
  repository: ItotoriCatalogCrawlerRepositoryPort;
  actor: AuthorizationActor;
  workerId: string;
  mode?: "live" | "recorded_fixture";
  ingestStep?: CatalogCrawlerIngestStep<TFact>;
  leaseSeconds?: number;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerRunResult = {
  job: CatalogCrawlerJobRecord;
  checkpoint: CatalogCrawlerCheckpointRecord | null;
  fetchedSteps: number;
  importedSteps: number;
  skippedSteps: number;
};

export class ItotoriCatalogCrawlerRunner {
  async run<TFact>(
    adapter: CatalogCrawlerSourceAdapter<TFact>,
    options: CatalogCrawlerRunnerOptions<TFact>,
  ): Promise<CatalogCrawlerRunResult> {
    const partitionKey = adapter.partitionKey ?? "default";
    const checkpoint = await options.repository.getCheckpoint(options.actor, {
      catalogSource: adapter.catalogSource,
      adapterName: adapter.adapterName,
      partitionKey,
    });
    const startingCursor: CatalogCrawlerCursor =
      checkpoint?.checkpointCursor ?? adapter.initialCheckpointCursor ?? null;
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
    let currentCheckpoint = checkpoint;
    let lastCursor: CatalogCrawlerCursor = startingCursor;

    try {
      for await (const adapterStep of adapter.steps({
        checkpointCursor: startingCursor,
        mode: options.mode ?? "live",
      })) {
        fetchedSteps += 1;
        const stepInput = {
          crawlerJobId: job.crawlerJobId,
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
        };
        const recorded = await options.repository.recordFetchedStep(options.actor, {
          ...stepInput,
          ...(adapterStep.httpStatus === undefined ? {} : { httpStatus: adapterStep.httpStatus }),
          ...(adapterStep.ok === undefined ? {} : { ok: adapterStep.ok }),
          ...(adapterStep.payloadHash === undefined ? {} : { payloadHash: adapterStep.payloadHash }),
          ...(adapterStep.metadata === undefined ? {} : { metadata: adapterStep.metadata }),
        });

        if (recorded.alreadyImported) {
          skippedSteps += 1;
        } else {
          try {
            await options.ingestStep?.({
              adapter,
              job,
              step: recorded.step,
              facts: adapterStep.facts,
            });
            await options.repository.markStepImported(options.actor, recorded.step.crawlerJobStepId);
            importedSteps += 1;
          } catch (error) {
            await options.repository.markStepFailed(
              options.actor,
              recorded.step.crawlerJobStepId,
              error,
            );
            throw error;
          }
        }

        lastCursor = adapterStep.checkpointCursor;
        currentCheckpoint = await options.repository.saveCheckpoint(options.actor, {
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
        });
        if (adapterStep.rateLimit !== undefined) {
          await options.repository.saveRateLimit(options.actor, {
            ...adapterStep.rateLimit,
            catalogSource: adapter.catalogSource,
            adapterName: adapter.adapterName,
            partitionKey,
            requestIdentity: adapterStep.rateLimit.requestIdentity ?? adapterStep.requestIdentity,
          });
        }
      }

      job = await options.repository.completeCrawlerJob(
        options.actor,
        job.crawlerJobId,
        options.workerId,
        lastCursor,
      );
      return { job, checkpoint: currentCheckpoint, fetchedSteps, importedSteps, skippedSteps };
    } catch (error) {
      await options.repository.failCrawlerJob(options.actor, job.crawlerJobId, options.workerId, error);
      throw error;
    }
  }
}

export type RecordedCatalogCrawlerFixture<TFact = unknown> = {
  fixtureName: string;
  catalogSource: CatalogCrawlerPublicSource;
  adapterName: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  partitionKey?: string;
  initialCheckpointCursor?: CatalogCrawlerCursor;
  steps: readonly CatalogCrawlerAdapterStep<TFact>[];
};

export function createRecordedCatalogCrawlerAdapter<TFact>(
  fixture: RecordedCatalogCrawlerFixture<TFact>,
): CatalogCrawlerSourceAdapter<TFact> {
  const adapter: CatalogCrawlerSourceAdapter<TFact> = {
    catalogSource: fixture.catalogSource,
    adapterName: fixture.adapterName,
    adapterVersion: fixture.adapterVersion,
    sourceVersion: fixture.sourceVersion,
    parserVersion: fixture.parserVersion,
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
  return adapter;
}

function checkpointAfterStepKey(cursor: CatalogCrawlerCursor): string | null {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    return null;
  }
  const afterStepKey = (cursor as Record<string, unknown>).afterStepKey;
  return typeof afterStepKey === "string" ? afterStepKey : null;
}
