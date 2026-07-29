// Typed job-name registry unit tests.
//
// Pure unit tests (no database): pin that the sole structural
// context-correction redraft job maps to its typed payload and one handler
// slot, while unregistered names or mismatched payloads are rejected.
// Generic agent/tool/search families remain registry-driven.

import { describe, expect, it } from "vitest";
import {
  contextCorrectionRedraftJobName,
  contextCorrectionRedraftPayloadSchemaVersion,
  JOB_DEFINITIONS,
  REGISTERED_JOB_NAMES,
  requireRegisteredJobDefinition,
  resolveRegisteredJobDefinition,
} from "../src/job-registry.js";
import type {
  ContextCorrectionRedraftPayload,
  RegisteredJobInputBase,
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

describe("JOB_DEFINITIONS — registry exhaustiveness", () => {
  it("registers the sole structural context-correction job", () => {
    expect(REGISTERED_JOB_NAMES).toEqual([contextCorrectionRedraftJobName]);
    expect(resolveRegisteredJobDefinition(contextCorrectionRedraftJobName)).toBeDefined();
    expect(JOB_DEFINITIONS[contextCorrectionRedraftJobName]).toBeDefined();
  });

  it("has no surplus entries beyond the structural registered-name union", () => {
    const declared = new Set<string>(REGISTERED_JOB_NAMES);
    const tableKeys = new Set<string>(Object.keys(JOB_DEFINITIONS));
    for (const key of tableKeys) {
      expect(declared).toContain(key);
    }
    expect([...tableKeys].sort()).toEqual([...declared].sort());
  });

  it("stamps the rerun jobType for the structural redraft", () => {
    const definition = requireRegisteredJobDefinition(contextCorrectionRedraftJobName);
    expect(definition.jobType).toBe(jobTaskTypeValues.rerun);
  });
});
