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
            importedSteps += 1;
          } catch (error) {
            await options.repository.markStepFailed(
              options.actor,
              recorded.step.crawlerJobStepId,
              error,
              options.workerId,
            );
            throw error;
          }
        }

        lastCursor = adapterStep.checkpointCursor;
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
      return { job, checkpoint: currentCheckpoint, fetchedSteps, importedSteps, skippedSteps };
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
  validateRecordedCatalogCrawlerFixture(fixture);
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

function validateRecordedCatalogCrawlerFixture<TFact>(
  fixture: RecordedCatalogCrawlerFixture<TFact>,
): void {
  if (fixture === null || typeof fixture !== "object") {
    throw new Error("recorded crawler fixture must be a JSON object");
  }
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
  if (!Array.isArray(fixture.steps)) {
    throw new Error("recorded crawler fixture steps must be an array");
  }
  for (const [index, step] of fixture.steps.entries()) {
    validateRecordedCatalogCrawlerStep(step, `steps[${index}]`);
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
