import type { AuthorizationActor } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import type {
  CatalogCrawlerJobStatus,
  CatalogCrawlerStepStatus,
  CatalogSource,
  CatalogSourceRecordKind,
} from "../schema.js";
import {
  commitStepImport,
  completeCrawlerJob,
  failCrawlerJob,
  markStepFailed,
  markStepImported,
  saveCheckpoint,
  saveRateLimit,
} from "./catalog-crawler-repository-writes.js";
import {
  getCheckpoint,
  recordFetchedStep,
  startCrawlerJob,
} from "./catalog-crawler-repository-reads.js";

export type CatalogCrawlerJsonRecord = Record<string, unknown>;
export type CatalogCrawlerCursor = unknown | null;
export type CatalogCrawlerDateInput = string | Date;

export type CatalogCrawlerKey = {
  catalogSource: CatalogSource;
  adapterName: string;
  partitionKey?: string;
};

export type CatalogCrawlerJobInput = CatalogCrawlerKey & {
  crawlerJobId?: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  checkpointCursor?: CatalogCrawlerCursor;
  leaseSeconds?: number;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerJobRecord = Required<CatalogCrawlerKey> & {
  crawlerJobId: string;
  adapterVersion: string;
  sourceVersion: string;
  parserVersion: string;
  status: CatalogCrawlerJobStatus;
  checkpointCursor: CatalogCrawlerCursor;
  lockedBy: string;
  leaseExpiresAt: Date;
  startedAt: Date;
  completedAt: Date | null;
  lastError: string | null;
  metadata: CatalogCrawlerJsonRecord;
  updatedAt: Date;
};

export type CatalogCrawlerCheckpointInput = Required<CatalogCrawlerKey> & {
  checkpointCursor: CatalogCrawlerCursor;
  sourceVersion: string;
  parserVersion: string;
  lastCrawlerJobId: string;
  lastStepKey?: string;
  workerId: string;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerCheckpointRecord = Required<CatalogCrawlerKey> & {
  checkpointCursor: CatalogCrawlerCursor;
  sourceVersion: string;
  parserVersion: string;
  lastCrawlerJobId: string | null;
  lastStepKey: string | null;
  updatedAt: Date;
  metadata: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerRateLimitInput = Required<CatalogCrawlerKey> & {
  crawlerJobId: string;
  workerId: string;
  nextAvailableAt?: CatalogCrawlerDateInput;
  resetAt?: CatalogCrawlerDateInput;
  remaining?: number;
  limit?: number;
  retryAfterSeconds?: number;
  requestIdentity?: string;
  metadata?: CatalogCrawlerJsonRecord;
};

export type CatalogCrawlerRateLimitRecord = Required<CatalogCrawlerKey> & {
  nextAvailableAt: Date | null;
  resetAt: Date | null;
  remaining: number | null;
  limit: number | null;
  retryAfterSeconds: number | null;
  requestIdentity: string | null;
  metadata: CatalogCrawlerJsonRecord;
  updatedAt: Date;
};

export type CatalogCrawlerStepInput = {
  crawlerJobId: string;
  workerId: string;
  crawlerJobStepId?: string;
  stepKey: string;
  catalogSource: CatalogSource;
  adapterName: string;
  adapterVersion: string;
  partitionKey?: string;
  sourceId: string;
  requestIdentity: string;
  sourceVersion: string;
  parserVersion: string;
  checkpointCursor: CatalogCrawlerCursor;
  fetchedAt: CatalogCrawlerDateInput;
  httpStatus?: number;
  ok?: boolean;
  payload: CatalogCrawlerJsonRecord;
  payloadHash?: string;
  metadata?: CatalogCrawlerJsonRecord;
  /**
   * Provenance kind for the persisted source record. Defaults to `raw_cache`
   * (a live crawl's raw fetched cache). A recorded-fixture REPLAY must pass
   * `recorded_fixture` so the persisted provenance — and every public
   * explanation that reads it — can distinguish replayed fixture evidence from
   * live raw-cache evidence instead of silently masquerading as a live fetch.
   */
  sourceRecordKind?: CatalogSourceRecordKind;
};

export type CatalogCrawlerStepRecord = {
  crawlerJobStepId: string;
  crawlerJobId: string;
  stepKey: string;
  catalogSource: CatalogSource;
  adapterName: string;
  partitionKey: string;
  sourceId: string;
  requestIdentity: string;
  sourceVersion: string;
  parserVersion: string;
  checkpointCursor: CatalogCrawlerCursor;
  fetchedAt: Date;
  httpStatus: number | null;
  ok: boolean;
  payloadHash: string;
  sourceProvenanceId: string;
  status: CatalogCrawlerStepStatus;
  importedAt: Date | null;
  error: string | null;
  metadata: CatalogCrawlerJsonRecord;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogCrawlerStepResult = {
  step: CatalogCrawlerStepRecord;
  alreadyImported: boolean;
};

export type CatalogCrawlerCommitStepInput = {
  crawlerJobId: string;
  workerId: string;
  crawlerJobStepId: string;
  checkpoint: Omit<CatalogCrawlerCheckpointInput, "lastCrawlerJobId" | "workerId"> & {
    lastCrawlerJobId?: string;
  };
  rateLimit?: Omit<CatalogCrawlerRateLimitInput, "crawlerJobId" | "workerId">;
};

export type CatalogCrawlerCommitStepResult = {
  step: CatalogCrawlerStepRecord;
  checkpoint: CatalogCrawlerCheckpointRecord;
  rateLimit: CatalogCrawlerRateLimitRecord | null;
};

export interface ItotoriCatalogCrawlerRepositoryPort {
  getCheckpoint(
    actor: AuthorizationActor,
    key: CatalogCrawlerKey,
  ): Promise<CatalogCrawlerCheckpointRecord | null>;
  startCrawlerJob(
    actor: AuthorizationActor,
    workerId: string,
    input: CatalogCrawlerJobInput,
  ): Promise<CatalogCrawlerJobRecord>;
  recordFetchedStep(
    actor: AuthorizationActor,
    input: CatalogCrawlerStepInput,
  ): Promise<CatalogCrawlerStepResult>;
  commitStepImport(
    actor: AuthorizationActor,
    input: CatalogCrawlerCommitStepInput,
  ): Promise<CatalogCrawlerCommitStepResult>;
  markStepImported(
    actor: AuthorizationActor,
    crawlerJobStepId: string,
    workerId: string,
  ): Promise<CatalogCrawlerStepRecord>;
  markStepFailed(
    actor: AuthorizationActor,
    crawlerJobStepId: string,
    error: unknown,
    workerId: string,
  ): Promise<CatalogCrawlerStepRecord>;
  saveCheckpoint(
    actor: AuthorizationActor,
    input: CatalogCrawlerCheckpointInput,
  ): Promise<CatalogCrawlerCheckpointRecord>;
  saveRateLimit(
    actor: AuthorizationActor,
    input: CatalogCrawlerRateLimitInput,
  ): Promise<CatalogCrawlerRateLimitRecord>;
  completeCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    checkpointCursor: CatalogCrawlerCursor,
  ): Promise<CatalogCrawlerJobRecord>;
  failCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    error: unknown,
  ): Promise<CatalogCrawlerJobRecord>;
}

export class ItotoriCatalogCrawlerRepository implements ItotoriCatalogCrawlerRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  getCheckpoint(actor: AuthorizationActor, key: CatalogCrawlerKey) {
    return getCheckpoint(this.db, actor, key);
  }
  startCrawlerJob(actor: AuthorizationActor, workerId: string, input: CatalogCrawlerJobInput) {
    return startCrawlerJob(this.db, actor, workerId, input);
  }
  recordFetchedStep(actor: AuthorizationActor, input: CatalogCrawlerStepInput) {
    return recordFetchedStep(this.db, actor, input);
  }
  commitStepImport(actor: AuthorizationActor, input: CatalogCrawlerCommitStepInput) {
    return commitStepImport(this.db, actor, input);
  }
  markStepImported(actor: AuthorizationActor, crawlerJobStepId: string, workerId: string) {
    return markStepImported(this.db, actor, crawlerJobStepId, workerId);
  }
  markStepFailed(
    actor: AuthorizationActor,
    crawlerJobStepId: string,
    error: unknown,
    workerId: string,
  ) {
    return markStepFailed(this.db, actor, crawlerJobStepId, error, workerId);
  }
  saveCheckpoint(actor: AuthorizationActor, input: CatalogCrawlerCheckpointInput) {
    return saveCheckpoint(this.db, actor, input);
  }
  saveRateLimit(actor: AuthorizationActor, input: CatalogCrawlerRateLimitInput) {
    return saveRateLimit(this.db, actor, input);
  }
  completeCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    checkpointCursor: CatalogCrawlerCursor,
  ) {
    return completeCrawlerJob(this.db, actor, crawlerJobId, workerId, checkpointCursor);
  }
  failCrawlerJob(
    actor: AuthorizationActor,
    crawlerJobId: string,
    workerId: string,
    error: unknown,
  ) {
    return failCrawlerJob(this.db, actor, crawlerJobId, workerId, error);
  }
}
