import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import type { AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriDraftJobRepository,
  draftJobAttemptStatusValues,
  draftJobStatusValues,
  type DraftJobAttemptRecord,
  type DraftJobInput,
  type DraftJobPolicyVersions,
  type DraftJobRecord,
} from "../src/repositories/draft-job-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import type { ItotoriProjectRecord } from "../src/repositories/project-repository.js";

export const draftJobFixtureProjectId = "project-draft-job";
export const draftJobFixtureLocaleBranchId = "locale-draft-job";

export const draftJobFixturePolicyVersions: DraftJobPolicyVersions = {
  promptTemplateVersion: "itotori-draft-v1",
  modelProviderFamily: "fake",
  modelId: "itotori-fake-draft-v0",
};

export function draftJobFixtureProject(): ItotoriProjectRecord {
  const bridge: BridgeBundle = {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-draft-job",
    sourceBundleHash: "hash-draft-job",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "unit-draft-1",
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: "occ-draft-1",
        sourceHash: "hash-draft-1",
        sourceLocale: "ja-JP",
        sourceText: "こんにちは",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "asset.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.001",
        },
      },
      {
        bridgeUnitId: "unit-draft-2",
        sourceUnitKey: "scene.001.line.002",
        occurrenceId: "occ-draft-2",
        sourceHash: "hash-draft-2",
        sourceLocale: "ja-JP",
        sourceText: "さようなら",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "asset.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.002",
        },
      },
    ],
  };
  return {
    projectId: draftJobFixtureProjectId,
    localeBranchId: draftJobFixtureLocaleBranchId,
    targetLocale: "en-US",
    drafts: {},
    bridge,
  };
}

export function draftJobFixtureInput(overrides: Partial<DraftJobInput> = {}): DraftJobInput {
  return {
    projectId: draftJobFixtureProjectId,
    localeBranchId: draftJobFixtureLocaleBranchId,
    sourceUnitIds: ["unit-draft-1", "unit-draft-2"],
    styleGuideVersion: "style-guide-v1",
    glossaryVersion: "glossary-v1",
    policyVersions: draftJobFixturePolicyVersions,
    protectedSpanRefs: [],
    contextRefs: [],
    ...overrides,
  };
}

export async function provisionDraftJobFixtureProject(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
): Promise<void> {
  const projects = new ItotoriProjectRepository(db);
  await projects.importSourceBundle(actor, draftJobFixtureProject());
}

export type DraftJobAttemptFixture = {
  job: DraftJobRecord;
  attempts: DraftJobAttemptRecord[];
};

export async function queuedDraftJobFixture(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  overrides: Partial<DraftJobInput> = {},
): Promise<DraftJobAttemptFixture> {
  const repo = new ItotoriDraftJobRepository(db);
  const job = await repo.createDraftJob(actor, draftJobFixtureInput(overrides));
  if (job.status !== draftJobStatusValues.queued) {
    throw new Error(`expected queued job, got status ${job.status}`);
  }
  return { job, attempts: [] };
}

export async function runningDraftJobFixture(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  overrides: Partial<DraftJobInput> = {},
): Promise<DraftJobAttemptFixture> {
  const repo = new ItotoriDraftJobRepository(db);
  const { job } = await queuedDraftJobFixture(db, actor, overrides);
  const attempt = await repo.recordAttempt(actor, job.draftJobId, {
    attemptIndex: 1,
    providerRunId: "provider-run-running",
    startedAt: new Date("2026-06-23T12:00:00Z"),
  });
  if (attempt.status !== draftJobAttemptStatusValues.running) {
    throw new Error(`expected running attempt, got ${attempt.status}`);
  }
  const reloaded = await repo.loadDraftJob(actor, job.draftJobId);
  if (reloaded === null) {
    throw new Error(`failed to reload draft job ${job.draftJobId}`);
  }
  return { job: reloaded, attempts: [attempt] };
}

export async function succeededDraftJobFixture(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  overrides: Partial<DraftJobInput> = {},
): Promise<DraftJobAttemptFixture> {
  const repo = new ItotoriDraftJobRepository(db);
  const { job: running, attempts } = await runningDraftJobFixture(db, actor, overrides);
  const attempt = attempts[0];
  if (attempt === undefined) {
    throw new Error("running fixture must yield exactly one attempt");
  }
  await repo.markAttemptSucceeded(
    actor,
    attempt.draftJobAttemptId,
    new Date("2026-06-23T12:01:00Z"),
    "provider-run-succeeded",
    "recorded-artifact-success",
  );
  const reloadedJob = await repo.loadDraftJob(actor, running.draftJobId);
  if (reloadedJob === null) {
    throw new Error(`failed to reload succeeded draft job ${running.draftJobId}`);
  }
  const reloadedAttempts = await repo.loadDraftJobAttempts(actor, running.draftJobId);
  return { job: reloadedJob, attempts: reloadedAttempts };
}

export async function failedDraftJobFixture(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  overrides: Partial<DraftJobInput> = {},
): Promise<DraftJobAttemptFixture> {
  const repo = new ItotoriDraftJobRepository(db);
  const { job: running, attempts } = await runningDraftJobFixture(db, actor, overrides);
  const attempt = attempts[0];
  if (attempt === undefined) {
    throw new Error("running fixture must yield exactly one attempt");
  }
  await repo.markAttemptFailed(
    actor,
    attempt.draftJobAttemptId,
    "non-retryable provider error",
    false,
    new Date("2026-06-23T12:02:00Z"),
  );
  const reloadedJob = await repo.loadDraftJob(actor, running.draftJobId);
  if (reloadedJob === null) {
    throw new Error(`failed to reload failed draft job ${running.draftJobId}`);
  }
  const reloadedAttempts = await repo.loadDraftJobAttempts(actor, running.draftJobId);
  return { job: reloadedJob, attempts: reloadedAttempts };
}

export async function retryableDraftJobFixture(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  overrides: Partial<DraftJobInput> = {},
): Promise<DraftJobAttemptFixture> {
  const repo = new ItotoriDraftJobRepository(db);
  const { job: running, attempts } = await runningDraftJobFixture(db, actor, overrides);
  const attempt = attempts[0];
  if (attempt === undefined) {
    throw new Error("running fixture must yield exactly one attempt");
  }
  await repo.markAttemptFailed(
    actor,
    attempt.draftJobAttemptId,
    "transient provider error",
    true,
    new Date("2026-06-23T12:03:00Z"),
  );
  const reloadedJob = await repo.loadDraftJob(actor, running.draftJobId);
  if (reloadedJob === null) {
    throw new Error(`failed to reload retryable draft job ${running.draftJobId}`);
  }
  const reloadedAttempts = await repo.loadDraftJobAttempts(actor, running.draftJobId);
  return { job: reloadedJob, attempts: reloadedAttempts };
}

export async function cancelledDraftJobFixture(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  overrides: Partial<DraftJobInput> = {},
): Promise<DraftJobAttemptFixture> {
  const repo = new ItotoriDraftJobRepository(db);
  const { job: running } = await runningDraftJobFixture(db, actor, overrides);
  await repo.cancelDraftJob(actor, running.draftJobId);
  const reloadedJob = await repo.loadDraftJob(actor, running.draftJobId);
  if (reloadedJob === null) {
    throw new Error(`failed to reload cancelled draft job ${running.draftJobId}`);
  }
  const reloadedAttempts = await repo.loadDraftJobAttempts(actor, running.draftJobId);
  return { job: reloadedJob, attempts: reloadedAttempts };
}
