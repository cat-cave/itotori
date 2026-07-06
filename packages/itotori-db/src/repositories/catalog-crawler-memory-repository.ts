import { createHash } from "node:crypto";
import type { AuthorizationActor } from "../authorization.js";
import {
  catalogCrawlerJobStatusValues,
  catalogCrawlerStepStatusValues,
  type CatalogCrawlerJobStatus,
  type CatalogCrawlerStepStatus,
} from "../schema.js";
import {
  type CatalogCrawlerCheckpointInput,
  type CatalogCrawlerCheckpointRecord,
  type CatalogCrawlerCommitStepInput,
  type CatalogCrawlerCommitStepResult,
  type CatalogCrawlerCursor,
  type CatalogCrawlerJobInput,
  type CatalogCrawlerJobRecord,
  type CatalogCrawlerJsonRecord,
  type CatalogCrawlerKey,
  type CatalogCrawlerRateLimitInput,
  type CatalogCrawlerRateLimitRecord,
  type CatalogCrawlerStepInput,
  type CatalogCrawlerStepRecord,
  type CatalogCrawlerStepResult,
  type ItotoriCatalogCrawlerRepositoryPort,
} from "./catalog-crawler-repository.js";

export class InMemoryCatalogCrawlerRepository implements ItotoriCatalogCrawlerRepositoryPort {
  readonly jobs = new Map<string, CatalogCrawlerJobRecord>();
  readonly checkpoints = new Map<string, CatalogCrawlerCheckpointRecord>();
  readonly rateLimits = new Map<string, CatalogCrawlerRateLimitRecord>();
  readonly steps = new Map<string, CatalogCrawlerStepRecord>();
  private sequence = 0;

  async getCheckpoint(
    _actor: AuthorizationActor,
    key: CatalogCrawlerKey,
  ): Promise<CatalogCrawlerCheckpointRecord | null> {
    return this.checkpoints.get(keyString(normalizeKey(key))) ?? null;
  }

  async startCrawlerJob(
    _actor: AuthorizationActor,
    workerId: string,
    input: CatalogCrawlerJobInput,
  ): Promise<CatalogCrawlerJobRecord> {
    const key = normalizeKey(input);
    const active = [...this.jobs.values()].find(
      (job) =>
        job.catalogSource === key.catalogSource &&
        job.adapterName === key.adapterName &&
        job.partitionKey === key.partitionKey &&
        job.status === catalogCrawlerJobStatusValues.running &&
        job.leaseExpiresAt > new Date(),
    );
    if (active !== undefined) {
      throw new Error(
        `crawler job already running for ${key.catalogSource}/${key.adapterName}/${key.partitionKey}`,
      );
    }
    const job: CatalogCrawlerJobRecord = {
      crawlerJobId: input.crawlerJobId ?? this.nextId("crawler-job"),
      catalogSource: key.catalogSource,
      adapterName: key.adapterName,
      adapterVersion: requiredString(input.adapterVersion, "adapterVersion"),
      sourceVersion: requiredString(input.sourceVersion, "sourceVersion"),
      parserVersion: requiredString(input.parserVersion, "parserVersion"),
      partitionKey: key.partitionKey,
      status: catalogCrawlerJobStatusValues.running,
      checkpointCursor: input.checkpointCursor ?? null,
      lockedBy: requiredString(workerId, "workerId"),
      leaseExpiresAt: new Date(Date.now() + (input.leaseSeconds ?? 300) * 1000),
      startedAt: new Date(),
      completedAt: null,
      lastError: null,
      metadata: jsonRecord(input.metadata ?? {}, "metadata"),
      updatedAt: new Date(),
    };
    this.jobs.set(job.crawlerJobId, job);
    return job;
  }

  async recordFetchedStep(
    _actor: AuthorizationActor,
    input: CatalogCrawlerStepInput,
  ): Promise<CatalogCrawlerStepResult> {
    this.assertActiveJob(input.crawlerJobId, input.workerId);
    const stepKey = `${input.crawlerJobId}:${input.stepKey}`;
    const previous = this.steps.get(stepKey);
    const key = normalizeKey(input);
    const payloadHash = input.payloadHash ?? hashJson(input.payload);
    const alreadyImported = [...this.steps.values()].some(
      (step) =>
        step.catalogSource === input.catalogSource &&
        step.adapterName === key.adapterName &&
        step.partitionKey === key.partitionKey &&
        step.stepKey === input.stepKey &&
        step.requestIdentity === input.requestIdentity &&
        step.sourceVersion === input.sourceVersion &&
        step.parserVersion === input.parserVersion &&
        step.payloadHash === payloadHash &&
        (step.status === catalogCrawlerStepStatusValues.imported || step.importedAt !== null),
    );
    const now = new Date();
    const step: CatalogCrawlerStepRecord = {
      crawlerJobStepId: previous?.crawlerJobStepId ?? stableId("crawler-step", stepKey),
      crawlerJobId: requiredString(input.crawlerJobId, "crawlerJobId"),
      stepKey: requiredString(input.stepKey, "stepKey"),
      catalogSource: input.catalogSource,
      adapterName: key.adapterName,
      partitionKey: key.partitionKey,
      sourceId: requiredString(input.sourceId, "sourceId"),
      requestIdentity: requiredString(input.requestIdentity, "requestIdentity"),
      sourceVersion: requiredString(input.sourceVersion, "sourceVersion"),
      parserVersion: requiredString(input.parserVersion, "parserVersion"),
      checkpointCursor: input.checkpointCursor ?? null,
      fetchedAt: dateInput(input.fetchedAt),
      httpStatus: input.httpStatus ?? null,
      ok: input.ok ?? true,
      payloadHash,
      sourceProvenanceId: stableId("crawler-provenance", stepKey),
      status: alreadyImported
        ? catalogCrawlerStepStatusValues.imported
        : catalogCrawlerStepStatusValues.fetched,
      importedAt: previous?.importedAt ?? (alreadyImported ? now : null),
      error: null,
      metadata: jsonRecord(input.metadata ?? {}, "metadata"),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.steps.set(stepKey, step);
    return { step, alreadyImported };
  }

  async commitStepImport(
    _actor: AuthorizationActor,
    input: CatalogCrawlerCommitStepInput,
  ): Promise<CatalogCrawlerCommitStepResult> {
    // CATALOG-066: Mirrors the DB repository's single-transaction semantics.
    // Step-import, rate-limit upsert, and checkpoint advance are validated and
    // built together, then applied atomically. A failure in any one (invalid
    // rate-limit input, missing step, stale lease) leaves all three untouched —
    // exactly like a Postgres transaction rollback. The previous sequential
    // mutation (step → rateLimit → checkpoint) would partially commit when a
    // later sub-step threw, allowing in-memory tests to falsely pass where the
    // DB transaction would have rolled back.
    this.assertActiveJob(input.crawlerJobId, input.workerId);

    const stepEntry = [...this.steps.entries()].find(
      ([, step]) => step.crawlerJobStepId === input.crawlerJobStepId,
    );
    if (stepEntry === undefined) {
      throw new Error(`missing crawler step ${input.crawlerJobStepId}`);
    }
    const [stepMapKey, stepRecord] = stepEntry;
    if (stepRecord.crawlerJobId !== input.crawlerJobId) {
      throw new Error(
        `crawler step ${input.crawlerJobStepId} does not belong to job ${input.crawlerJobId}`,
      );
    }
    const now = new Date();
    const committedStep: CatalogCrawlerStepRecord = {
      ...stepRecord,
      status: catalogCrawlerStepStatusValues.imported,
      importedAt: stepRecord.importedAt ?? now,
      error: null,
      updatedAt: now,
    };

    const rateLimitKey = input.rateLimit === undefined ? null : normalizeKey(input.rateLimit);
    const rateLimit =
      input.rateLimit === undefined
        ? null
        : this.buildRateLimitRecord({
            ...input.rateLimit,
            crawlerJobId: input.crawlerJobId,
            workerId: input.workerId,
          });
    const checkpointKey = normalizeKey(input.checkpoint);
    const checkpoint = this.buildCheckpointRecord({
      ...input.checkpoint,
      lastCrawlerJobId: input.crawlerJobId,
      workerId: input.workerId,
    });

    // Atomic commit: all three maps are written only after every validation
    // passed, matching the DB transaction's all-or-nothing semantics.
    this.steps.set(stepMapKey, committedStep);
    if (rateLimit !== null && rateLimitKey !== null) {
      this.rateLimits.set(keyString(rateLimitKey), rateLimit);
    }
    this.checkpoints.set(keyString(checkpointKey), checkpoint);

    return { step: committedStep, checkpoint, rateLimit };
  }

  async markStepImported(
    _actor: AuthorizationActor,
    crawlerJobStepId: string,
    workerId: string,
  ): Promise<CatalogCrawlerStepRecord> {
    return this.updateStep(
      crawlerJobStepId,
      catalogCrawlerStepStatusValues.imported,
      null,
      undefined,
      workerId,
    );
  }

  async markStepFailed(
    _actor: AuthorizationActor,
    crawlerJobStepId: string,
    error: unknown,
    workerId: string,
  ): Promise<CatalogCrawlerStepRecord> {
    return this.updateStep(
      crawlerJobStepId,
      catalogCrawlerStepStatusValues.failed,
      errorMessage(error),
      undefined,
      workerId,
    );
  }

  async saveCheckpoint(
    _actor: AuthorizationActor,
    input: CatalogCrawlerCheckpointInput,
  ): Promise<CatalogCrawlerCheckpointRecord> {
    this.assertActiveJob(
      requiredString(input.lastCrawlerJobId, "lastCrawlerJobId"),
      requiredString(input.workerId, "workerId"),
    );
    const checkpoint = this.buildCheckpointRecord(input);
    this.checkpoints.set(keyString(normalizeKey(input)), checkpoint);
    return checkpoint;
  }

  async saveRateLimit(
    _actor: AuthorizationActor,
    input: CatalogCrawlerRateLimitInput,
  ): Promise<CatalogCrawlerRateLimitRecord> {
    this.assertActiveJob(
      requiredString(input.crawlerJobId, "crawlerJobId"),
      requiredString(input.workerId, "workerId"),
    );
    const rateLimit = this.buildRateLimitRecord(input);
    this.rateLimits.set(keyString(normalizeKey(input)), rateLimit);
    return rateLimit;
  }

  async completeCrawlerJob(
    _actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    checkpointCursor: CatalogCrawlerCursor,
  ): Promise<CatalogCrawlerJobRecord> {
    return this.updateJob(
      crawlerJobId,
      workerId,
      catalogCrawlerJobStatusValues.succeeded,
      checkpointCursor,
    );
  }

  async failCrawlerJob(
    _actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    error: unknown,
  ): Promise<CatalogCrawlerJobRecord> {
    return this.updateJob(
      crawlerJobId,
      workerId,
      catalogCrawlerJobStatusValues.failed,
      undefined,
      errorMessage(error),
    );
  }

  private updateStep(
    crawlerJobStepId: string,
    status: CatalogCrawlerStepStatus,
    error: string | null = null,
    expectedCrawlerJobId: string | undefined,
    workerId: string,
  ): CatalogCrawlerStepRecord {
    const entry = [...this.steps.entries()].find(
      ([, step]) => step.crawlerJobStepId === crawlerJobStepId,
    );
    if (entry === undefined) {
      throw new Error(`missing crawler step ${crawlerJobStepId}`);
    }
    const [key, step] = entry;
    if (expectedCrawlerJobId !== undefined && step.crawlerJobId !== expectedCrawlerJobId) {
      throw new Error(
        `crawler step ${crawlerJobStepId} does not belong to job ${expectedCrawlerJobId}`,
      );
    }
    this.assertActiveJob(step.crawlerJobId, workerId);
    const updated: CatalogCrawlerStepRecord = {
      ...step,
      status,
      importedAt: status === catalogCrawlerStepStatusValues.imported ? new Date() : step.importedAt,
      error,
      updatedAt: new Date(),
    };
    this.steps.set(key, updated);
    return updated;
  }

  private updateJob(
    crawlerJobId: string,
    workerId: string,
    status: CatalogCrawlerJobStatus,
    checkpointCursor?: CatalogCrawlerCursor,
    lastError: string | null = null,
  ): CatalogCrawlerJobRecord {
    const job = this.jobs.get(crawlerJobId);
    if (job === undefined) {
      throw new Error(`missing crawler job ${crawlerJobId}`);
    }
    if (job.lockedBy !== workerId) {
      throw new Error(`crawler job ${crawlerJobId} is locked by ${job.lockedBy}`);
    }
    if (job.status !== catalogCrawlerJobStatusValues.running || job.leaseExpiresAt <= new Date()) {
      throw new Error(`crawler job ${crawlerJobId} does not have an active lease for this worker`);
    }
    const updated: CatalogCrawlerJobRecord = {
      ...job,
      status,
      checkpointCursor: checkpointCursor === undefined ? job.checkpointCursor : checkpointCursor,
      completedAt: new Date(),
      lastError,
      updatedAt: new Date(),
    };
    this.jobs.set(crawlerJobId, updated);
    return updated;
  }

  private assertActiveJob(crawlerJobId: string, workerId: string): void {
    const job = this.jobs.get(crawlerJobId);
    if (job === undefined) {
      throw new Error(`missing crawler job ${crawlerJobId}`);
    }
    if (
      job.lockedBy !== workerId ||
      job.status !== catalogCrawlerJobStatusValues.running ||
      job.leaseExpiresAt <= new Date()
    ) {
      throw new Error(`crawler job ${crawlerJobId} does not have an active lease for this worker`);
    }
  }

  // CATALOG-066: Pure record builders extracted so commitStepImport can
  // validate every sub-record BEFORE mutating any map (atomic compute-then-
  // commit). These replicate the DB repository's normalize*Input validation
  // (nonnegative-integer guards on rate-limit fields) so the in-memory double
  // rejects the same invalid inputs the DB CHECK constraints / normalization
  // would reject — preventing in-memory tests from falsely passing.
  private buildRateLimitRecord(input: CatalogCrawlerRateLimitInput): CatalogCrawlerRateLimitRecord {
    const key = normalizeKey(input);
    return {
      catalogSource: key.catalogSource,
      adapterName: key.adapterName,
      partitionKey: key.partitionKey,
      nextAvailableAt:
        input.nextAvailableAt === undefined ? null : dateInput(input.nextAvailableAt),
      resetAt: input.resetAt === undefined ? null : dateInput(input.resetAt),
      remaining: optionalNonnegativeInteger(input.remaining, "remaining"),
      limit: optionalNonnegativeInteger(input.limit, "limit"),
      retryAfterSeconds: optionalNonnegativeInteger(input.retryAfterSeconds, "retryAfterSeconds"),
      requestIdentity:
        input.requestIdentity === undefined
          ? null
          : requiredString(input.requestIdentity, "requestIdentity"),
      metadata: jsonRecord(input.metadata ?? {}, "metadata"),
      updatedAt: new Date(),
    };
  }

  private buildCheckpointRecord(
    input: CatalogCrawlerCheckpointInput,
  ): CatalogCrawlerCheckpointRecord {
    const key = normalizeKey(input);
    return {
      catalogSource: key.catalogSource,
      adapterName: key.adapterName,
      partitionKey: key.partitionKey,
      checkpointCursor: input.checkpointCursor ?? null,
      sourceVersion: requiredString(input.sourceVersion, "sourceVersion"),
      parserVersion: requiredString(input.parserVersion, "parserVersion"),
      lastCrawlerJobId: input.lastCrawlerJobId ?? null,
      lastStepKey: input.lastStepKey ?? null,
      updatedAt: new Date(),
      metadata: jsonRecord(input.metadata ?? {}, "metadata"),
    };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

function normalizeKey(key: CatalogCrawlerKey): Required<CatalogCrawlerKey> {
  return {
    catalogSource: key.catalogSource,
    adapterName: requiredString(key.adapterName, "adapterName"),
    partitionKey: key.partitionKey ?? "default",
  };
}

function keyString(key: Required<CatalogCrawlerKey>): string {
  return `${key.catalogSource}:${key.adapterName}:${key.partitionKey}`;
}

function requiredString(input: string | undefined, name: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return input;
}

function dateInput(input: string | Date): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error("date input must be valid");
  }
  return date;
}

function jsonRecord(input: unknown, name: string): CatalogCrawlerJsonRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return input as CatalogCrawlerJsonRecord;
}

function hashJson(input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(input)).digest("hex")}`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJsonStringify(input: unknown): string {
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableJsonStringify(value)).join(",")}]`;
  }
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// CATALOG-066: Mirrors the DB repository's optionalNonnegativeInteger guard
// so the in-memory double rejects the same invalid rate-limit inputs the DB
// normalization would reject.
function optionalNonnegativeInteger(input: number | undefined, name: string): number | null {
  if (input === undefined) {
    return null;
  }
  if (!Number.isInteger(input) || input < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return input;
}
