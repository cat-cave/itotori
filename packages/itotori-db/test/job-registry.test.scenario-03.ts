// Typed job-name registry unit tests.
//
// Pure unit tests (no database): pin that the sole structural
// context-correction redraft job maps to its typed payload and one handler
// slot, while unregistered names or mismatched payloads are rejected.
// Generic agent/tool/search families remain registry-driven.

import { describe, expect, it } from "vitest";
import {
  assertContextCorrectionRedraftPayload,
  buildRegisteredJobInput,
  COMPILE_TIME_AGENT_PAYLOAD_TYPE,
  COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_NAME_REGISTERED,
  COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_PAYLOAD_TYPE,
  COMPILE_TIME_CROSS_FAMILY_MISMATCH_REJECTED,
  COMPILE_TIME_FAMILY_NAMES_REGISTERED,
  COMPILE_TIME_UNREGISTERED_NAME_REJECTED,
  COMPILE_TIME_WRONG_CONTEXT_CORRECTION_PAYLOAD_REJECTED,
  contextCorrectionRedraftJobName,
  contextCorrectionRedraftPayloadSchemaVersion,
  DuplicateJobHandlerError,
  isRegisteredJobName,
  JOB_DEFINITIONS,
  JOB_NAME_FAMILIES,
  jobPayloadValidationReasons,
  REGISTERED_JOB_NAMES,
  RegisteredJobHandlerRegistry,
  requireRegisteredJobDefinition,
  resolveRegisteredJobDefinition,
  UnregisteredJobHandlerError,
  UnregisteredJobNameError,
} from "../src/job-registry.js";
import type {
  AgentJobPayload,
  AnyRegisteredJobName,
  ContextCorrectionRedraftPayload,
  JobPayloadFor,
  RegisteredJobInputBase,
  RegisteredJobName,
} from "../src/job-registry.js";
import type { JobQueueRecord } from "../src/repositories/event-queue-repository.js";
import { jobIdempotencyPolicyValues, jobTaskTypeValues } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function contextCorrectionPayload(
  overrides: Partial<ContextCorrectionRedraftPayload> = {},
): ContextCorrectionRedraftPayload {
  return {
    schemaVersion: contextCorrectionRedraftPayloadSchemaVersion,
    correctionId: "correction-1",
    contextArtifactId: "context-artifact-1",
    contextEntryVersionId: "context-entry-version-2",
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "source-revision-test",
    affectedUnitIds: ["bridge-unit-1"],
    ...overrides,
  };
}

function jobInputBase(overrides: Partial<RegisteredJobInputBase> = {}): RegisteredJobInputBase {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    idempotency: {
      policy: jobIdempotencyPolicyValues.idempotent,
      key: "job:test",
    },
    ...overrides,
  };
}

function jobRecord(jobName: string, payload: unknown): JobQueueRecord {
  return {
    jobId: "job-test",
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    sourceEventId: null,
    triggerOutboxEventId: null,
    jobType: jobTaskTypeValues.rerun,
    jobName,
    queueName: "default",
    status: "running",
    idempotencyPolicy: jobIdempotencyPolicyValues.idempotent,
    idempotencyKey: "job:test",
    correlationId: "job-test",
    causationId: null,
    subjectRefs: [],
    dependsOnJobIds: [],
    payload: payload as Record<string, unknown>,
    priority: 0,
    availableAt: new Date(),
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "worker-1",
    lockedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    lastError: null,
    errorHistory: [],
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Registry exhaustiveness: name ↔ definition parity.
// ---------------------------------------------------------------------------

describe("buildRegisteredJobInput — context-correction redraft", () => {
  it("stamps jobName, rerun jobType, and payload", () => {
    const payload = contextCorrectionPayload();
    const input = buildRegisteredJobInput(contextCorrectionRedraftJobName, payload, jobInputBase());
    expect(input.jobName).toBe(contextCorrectionRedraftJobName);
    expect(input.jobType).toBe(jobTaskTypeValues.rerun);
    expect(input.payload).toEqual(payload as unknown as Record<string, unknown>);
  });

  it("preserves caller-supplied queueing context", () => {
    const input = buildRegisteredJobInput(
      contextCorrectionRedraftJobName,
      contextCorrectionPayload(),
      jobInputBase({
        queueName: "context-correction",
        dependsOnJobIds: ["job-prior"],
        priority: 40,
      }),
    );
    expect(input.queueName).toBe("context-correction");
    expect(input.dependsOnJobIds).toEqual(["job-prior"]);
    expect(input.priority).toBe(40);
  });

  it("rejects a payload missing a required identifier", () => {
    const broken: unknown = { ...contextCorrectionPayload(), correctionId: "" };
    expect(() =>
      buildRegisteredJobInput(
        contextCorrectionRedraftJobName,
        broken as ContextCorrectionRedraftPayload,
        jobInputBase(),
      ),
    ).toThrow(
      expect.objectContaining({
        reason: jobPayloadValidationReasons.missingField,
        field: "correctionId",
      }),
    );
  });

  it("rejects a payload with an empty affectedUnitIds list", () => {
    const broken: unknown = { ...contextCorrectionPayload(), affectedUnitIds: [] };
    expect(() =>
      buildRegisteredJobInput(
        contextCorrectionRedraftJobName,
        broken as ContextCorrectionRedraftPayload,
        jobInputBase(),
      ),
    ).toThrow(
      expect.objectContaining({
        reason: jobPayloadValidationReasons.missingField,
        field: "affectedUnitIds",
      }),
    );
  });

  it("rejects a blank affected unit id", () => {
    const broken: unknown = { ...contextCorrectionPayload(), affectedUnitIds: [""] };
    expect(() =>
      buildRegisteredJobInput(
        contextCorrectionRedraftJobName,
        broken as ContextCorrectionRedraftPayload,
        jobInputBase(),
      ),
    ).toThrow(
      expect.objectContaining({
        reason: jobPayloadValidationReasons.missingField,
        field: "affectedUnitIds",
      }),
    );
  });

  it("rejects a payload with a bad schemaVersion discriminator", () => {
    const broken: unknown = {
      ...contextCorrectionPayload(),
      schemaVersion: "itotori.wrong.v1",
    };
    expect(() =>
      buildRegisteredJobInput(
        contextCorrectionRedraftJobName,
        broken as ContextCorrectionRedraftPayload,
        jobInputBase(),
      ),
    ).toThrow(
      expect.objectContaining({
        reason: jobPayloadValidationReasons.wrongDiscriminator,
        field: "schemaVersion",
      }),
    );
  });
});
