import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { InMemoryCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-memory-repository.js";
import { catalogCrawlerStepStatusValues } from "../src/schema.js";
import {
  ItotoriCatalogCrawlerRunner,
  type CatalogCrawlerSourceAdapter,
} from "../src/services/catalog-crawler-runner.js";

// CATALOG-066: Failure-injection coverage for the in-memory catalog crawler
// repository. The in-memory double is a PUBLIC test seam (exported from
// @itotori/db) used by downstream packages to exercise the crawler runner
// without a Postgres dependency. These tests guarantee that the double's
// commitStepImport is transaction-EQUIVALENT to the DB repository: a failure
// in any sub-operation (rate-limit validation, stale lease, mid-step crash)
// leaves the step un-imported and the checkpoint un-advanced — exactly like a
// Postgres transaction rollback. Without this coverage, in-memory tests could
// falsely pass when DB transaction ordering would fail.

const actor: AuthorizationActor = { userId: localUserId };

const sourceKey = {
  catalogSource: "vndb" as const,
  adapterName: "c066-failure-injection",
  partitionKey: "c066",
};

function jobInput(overrides: Partial<{ crawlerJobId: string; leaseSeconds: number }> = {}) {
  return {
    ...sourceKey,
    adapterVersion: "1.0.0",
    sourceVersion: "2024-01-01",
    parserVersion: "1.0.0",
    ...overrides,
  };
}

function stepInput(crawlerJobId: string, workerId: string, stepKey = "step-001") {
  return {
    crawlerJobId,
    workerId,
    stepKey,
    catalogSource: sourceKey.catalogSource,
    adapterName: sourceKey.adapterName,
    adapterVersion: "1.0.0",
    partitionKey: sourceKey.partitionKey,
    sourceId: `source-${stepKey}`,
    requestIdentity: `req-${stepKey}`,
    sourceVersion: "2024-01-01",
    parserVersion: "1.0.0",
    checkpointCursor: { afterStepKey: stepKey },
    fetchedAt: new Date().toISOString(),
    payload: { id: stepKey, data: "fixture-payload" },
  };
}

function checkpointInput(crawlerJobId: string, stepKey = "step-001") {
  return {
    ...sourceKey,
    checkpointCursor: { afterStepKey: stepKey },
    sourceVersion: "2024-01-01",
    parserVersion: "1.0.0",
    lastCrawlerJobId: crawlerJobId,
    lastStepKey: stepKey,
    workerId: "worker-1",
  };
}

function findStepByJobStepId(repo: InMemoryCatalogCrawlerRepository, crawlerJobStepId: string) {
  for (const step of repo.steps.values()) {
    if (step.crawlerJobStepId === crawlerJobStepId) {
      return step;
    }
  }
  throw new Error(`test setup: step ${crawlerJobStepId} not found`);
}

describe("InMemoryCatalogCrawlerRepository commitStepImport transaction-equivalence (CATALOG-066)", () => {
  it("does NOT mark the step imported or advance the checkpoint when rate-limit validation fails", async () => {
    // This mirrors the DB repository test: "does not advance the checkpoint
    // when rate-limit persistence fails in the step commit". Before CATALOG-066
    // the in-memory double would silently accept remaining: -1 and partially
    // commit (step imported, checkpoint advanced) — a false pass.
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput());
    const recorded = await repo.recordFetchedStep(actor, stepInput(job.crawlerJobId, "worker-1"));

    await expect(
      repo.commitStepImport(actor, {
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-1",
        crawlerJobStepId: recorded.step.crawlerJobStepId,
        checkpoint: checkpointInput(job.crawlerJobId),
        rateLimit: {
          ...sourceKey,
          remaining: -1,
        },
      }),
    ).rejects.toThrow(/remaining must be a nonnegative integer/u);

    // Step must remain fetched (NOT imported).
    const step = findStepByJobStepId(repo, recorded.step.crawlerJobStepId);
    expect(step.status).toBe(catalogCrawlerStepStatusValues.fetched);
    expect(step.importedAt).toBeNull();

    // Checkpoint must NOT have advanced.
    await expect(repo.getCheckpoint(actor, sourceKey)).resolves.toBeNull();
  });

  it("does NOT mark the step imported when rate-limit validation fails even if checkpoint input is valid", async () => {
    // Additional atomicity guard: both rateLimit and checkpoint inputs are
    // validated BEFORE any mutation. A valid checkpoint must not survive a
    // rate-limit failure (and vice-versa).
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput());
    const recorded = await repo.recordFetchedStep(actor, stepInput(job.crawlerJobId, "worker-1"));

    await expect(
      repo.commitStepImport(actor, {
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-1",
        crawlerJobStepId: recorded.step.crawlerJobStepId,
        checkpoint: checkpointInput(job.crawlerJobId),
        rateLimit: {
          ...sourceKey,
          retryAfterSeconds: -5,
        },
      }),
    ).rejects.toThrow(/retryAfterSeconds must be a nonnegative integer/u);

    const step = findStepByJobStepId(repo, recorded.step.crawlerJobStepId);
    expect(step.status).toBe(catalogCrawlerStepStatusValues.fetched);
    await expect(repo.getCheckpoint(actor, sourceKey)).resolves.toBeNull();
  });

  it("does NOT advance checkpoint or rate-limit when the step belongs to a different job", async () => {
    // Atomicity guard: a step/job mismatch must reject before any mutation.
    // Uses a distinct partition so both jobs can run concurrently (the
    // in-memory double, like the DB, forbids two running jobs per partition).
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput());
    const otherJob = await repo.startCrawlerJob(actor, "worker-1", {
      ...jobInput(),
      adapterName: "c066-failure-injection-other",
    });
    const recorded = await repo.recordFetchedStep(actor, {
      ...stepInput(otherJob.crawlerJobId, "worker-1"),
      adapterName: "c066-failure-injection-other",
    });

    await expect(
      repo.commitStepImport(actor, {
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-1",
        crawlerJobStepId: recorded.step.crawlerJobStepId,
        checkpoint: checkpointInput(job.crawlerJobId),
      }),
    ).rejects.toThrow(/does not belong to job/u);

    await expect(repo.getCheckpoint(actor, sourceKey)).resolves.toBeNull();
  });
});

describe("InMemoryCatalogCrawlerRepository imported-marker / lease boundary (CATALOG-066)", () => {
  it("rejects commitStepImport when the lease expired before commit (imported-marker boundary)", async () => {
    // Mirrors the DB "stale worker" test: once the lease expires, no write
    // (step import, checkpoint, rate-limit) may succeed. The in-memory double
    // must enforce the same boundary so tests cannot falsely advance a step
    // past the imported marker with a stale lease.
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput({ leaseSeconds: 1 }));
    const recorded = await repo.recordFetchedStep(actor, stepInput(job.crawlerJobId, "worker-1"));

    // Expire the lease by backdating it past now.
    const jobRecord = repo.jobs.get(job.crawlerJobId);
    if (jobRecord === undefined) {
      throw new Error("test setup: job not found");
    }
    repo.jobs.set(job.crawlerJobId, {
      ...jobRecord,
      leaseExpiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      repo.commitStepImport(actor, {
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-1",
        crawlerJobStepId: recorded.step.crawlerJobStepId,
        checkpoint: checkpointInput(job.crawlerJobId),
      }),
    ).rejects.toThrow(/active lease/u);

    const step = findStepByJobStepId(repo, recorded.step.crawlerJobStepId);
    expect(step.status).toBe(catalogCrawlerStepStatusValues.fetched);
    await expect(repo.getCheckpoint(actor, sourceKey)).resolves.toBeNull();
  });

  it("rejects commitStepImport from a worker that does not own the job", async () => {
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput());
    const recorded = await repo.recordFetchedStep(actor, stepInput(job.crawlerJobId, "worker-1"));

    await expect(
      repo.commitStepImport(actor, {
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-impostor",
        crawlerJobStepId: recorded.step.crawlerJobStepId,
        checkpoint: checkpointInput(job.crawlerJobId),
      }),
    ).rejects.toThrow(/active lease/u);

    const step = findStepByJobStepId(repo, recorded.step.crawlerJobStepId);
    expect(step.status).toBe(catalogCrawlerStepStatusValues.fetched);
  });
});

describe("InMemoryCatalogCrawlerRepository standalone saveRateLimit DB-equivalent validation (CATALOG-066)", () => {
  it("rejects negative remaining, limit, and retryAfterSeconds like the DB normalization", async () => {
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput());

    await expect(
      repo.saveRateLimit(actor, {
        ...sourceKey,
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-1",
        remaining: -1,
      }),
    ).rejects.toThrow(/remaining must be a nonnegative integer/u);

    await expect(
      repo.saveRateLimit(actor, {
        ...sourceKey,
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-1",
        limit: -10,
      }),
    ).rejects.toThrow(/limit must be a nonnegative integer/u);

    await expect(
      repo.saveRateLimit(actor, {
        ...sourceKey,
        crawlerJobId: job.crawlerJobId,
        workerId: "worker-1",
        retryAfterSeconds: -3,
      }),
    ).rejects.toThrow(/retryAfterSeconds must be a nonnegative integer/u);

    // No rate-limit record should have been persisted.
    expect(repo.rateLimits.size).toBe(0);
  });

  it("accepts valid nonnegative-integer rate-limit fields", async () => {
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput());

    const rateLimit = await repo.saveRateLimit(actor, {
      ...sourceKey,
      crawlerJobId: job.crawlerJobId,
      workerId: "worker-1",
      remaining: 0,
      limit: 100,
      retryAfterSeconds: 30,
    });

    expect(rateLimit.remaining).toBe(0);
    expect(rateLimit.limit).toBe(100);
    expect(rateLimit.retryAfterSeconds).toBe(30);
  });
});

describe("InMemoryCatalogCrawlerRepository happy-path commit (CATALOG-066 regression guard)", () => {
  it("atomically commits step + checkpoint + rate-limit when all inputs are valid", async () => {
    const repo = new InMemoryCatalogCrawlerRepository();
    const job = await repo.startCrawlerJob(actor, "worker-1", jobInput());
    const recorded = await repo.recordFetchedStep(actor, stepInput(job.crawlerJobId, "worker-1"));

    const result = await repo.commitStepImport(actor, {
      crawlerJobId: job.crawlerJobId,
      workerId: "worker-1",
      crawlerJobStepId: recorded.step.crawlerJobStepId,
      checkpoint: checkpointInput(job.crawlerJobId),
      rateLimit: {
        ...sourceKey,
        remaining: 50,
        limit: 100,
      },
    });

    expect(result.step.status).toBe(catalogCrawlerStepStatusValues.imported);
    expect(result.step.importedAt).not.toBeNull();
    expect(result.checkpoint.lastStepKey).toBe("step-001");
    expect(result.rateLimit?.remaining).toBe(50);

    // All three maps must reflect the commit.
    const checkpoint = await repo.getCheckpoint(actor, sourceKey);
    expect(checkpoint?.lastStepKey).toBe("step-001");
    expect(repo.rateLimits.size).toBe(1);
  });
});

describe("InMemoryCatalogCrawlerRepository crash/mid-step via runner beforeCommitStepImport (CATALOG-066)", () => {
  // Exercises the full runner loop against the in-memory double. A crash in
  // the CATALOG-074 window (after ingest, before commitStepImport) must leave
  // the step fetched (NOT imported) and the checkpoint un-advanced — then a
  // resume run must replay the step. This proves the in-memory double cannot
  // falsely advance past the imported marker when a mid-step crash occurs.

  function buildAdapter(
    steps: readonly { stepKey: string; payload: Record<string, unknown> }[],
  ): CatalogCrawlerSourceAdapter {
    return {
      catalogSource: sourceKey.catalogSource,
      adapterName: sourceKey.adapterName,
      adapterVersion: "1.0.0",
      sourceVersion: "2024-01-01",
      parserVersion: "1.0.0",
      partitionKey: sourceKey.partitionKey,
      *steps(context) {
        if (context.mode !== "live") {
          throw new Error("c066 crash adapter runs in live mode only");
        }
        for (const step of steps) {
          yield {
            stepKey: step.stepKey,
            sourceId: `source-${step.stepKey}`,
            requestIdentity: `req-${step.stepKey}`,
            fetchedAt: new Date().toISOString(),
            checkpointCursor: { afterStepKey: step.stepKey },
            payload: step.payload,
            facts: [],
          };
        }
      },
    };
  }

  it("leaves the step fetched and checkpoint null when beforeCommitStepImport crashes mid-step", async () => {
    const repo = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = buildAdapter([
      { stepKey: "step-001", payload: { id: "s1" } },
      { stepKey: "step-002", payload: { id: "s2" } },
    ]);

    await expect(
      runner.run(adapter, {
        repository: repo,
        actor,
        workerId: "worker-crash",
        mode: "live",
        beforeCommitStepImport: () => {
          throw new Error("c066 injected crash before commit");
        },
      }),
    ).rejects.toThrow(/c066 injected crash before commit/u);

    // The job must be failed.
    const job = [...repo.jobs.values()].find((j) => j.lockedBy === "worker-crash");
    expect(job?.status).toBe("failed");

    // The step must be fetched (NOT imported) — no imported marker.
    const steps = [...repo.steps.values()].filter((s) => s.stepKey === "step-001");
    expect(steps.length).toBe(1);
    expect(steps[0]?.status).toBe(catalogCrawlerStepStatusValues.fetched);
    expect(steps[0]?.importedAt).toBeNull();

    // The checkpoint must NOT have advanced.
    await expect(repo.getCheckpoint(actor, sourceKey)).resolves.toBeNull();
  });

  it("replays the un-committed step on a resume run after a mid-step crash", async () => {
    const repo = new InMemoryCatalogCrawlerRepository();
    const runner = new ItotoriCatalogCrawlerRunner();
    const adapter = buildAdapter([
      { stepKey: "step-001", payload: { id: "s1" } },
      { stepKey: "step-002", payload: { id: "s2" } },
    ]);

    // First run: crash before committing step-001.
    await expect(
      runner.run(adapter, {
        repository: repo,
        actor,
        workerId: "worker-crash",
        mode: "live",
        beforeCommitStepImport: () => {
          throw new Error("c066 injected crash before commit");
        },
      }),
    ).rejects.toThrow(/c066 injected crash before commit/u);

    // The crashed step must still be fetched (no imported marker).
    const crashedStep = [...repo.steps.values()].find((s) => s.stepKey === "step-001");
    expect(crashedStep?.status).toBe(catalogCrawlerStepStatusValues.fetched);

    // Resume run: no crash hook, should replay step-001 and continue to step-002.
    const resumed = await runner.run(adapter, {
      repository: repo,
      actor,
      workerId: "worker-resume",
      mode: "live",
    });

    expect(resumed.fetchedSteps).toBe(2);
    expect(resumed.importedSteps).toBe(2);
    expect(resumed.skippedSteps).toBe(0);
    expect(resumed.checkpoint?.lastStepKey).toBe("step-002");

    // The checkpoint must have advanced to step-002.
    const checkpoint = await repo.getCheckpoint(actor, sourceKey);
    expect(checkpoint?.lastStepKey).toBe("step-002");
  });
});
