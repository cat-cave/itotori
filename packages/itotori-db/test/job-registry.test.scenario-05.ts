// Typed job-name registry unit tests.
//
// Pure unit tests (no database): pin that the sole structural
// context-correction redraft job maps to its typed payload and one handler
// slot, while unregistered names or mismatched payloads are rejected.
// Generic agent/tool/search families remain registry-driven.

import { describe, expect, it } from "vitest";
import {
  COMPILE_TIME_AGENT_PAYLOAD_TYPE,
  COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_NAME_REGISTERED,
  COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_PAYLOAD_TYPE,
  COMPILE_TIME_CROSS_FAMILY_MISMATCH_REJECTED,
  COMPILE_TIME_FAMILY_NAMES_REGISTERED,
  COMPILE_TIME_UNREGISTERED_NAME_REJECTED,
  COMPILE_TIME_WRONG_CONTEXT_CORRECTION_PAYLOAD_REJECTED,
  contextCorrectionRedraftJobName,
  contextCorrectionRedraftPayloadSchemaVersion,
} from "../src/job-registry.js";
import type {
  ContextCorrectionRedraftPayload,
  JobPayloadFor,
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

describe("buildRegisteredJobInput — compile-time enforcement", () => {
  it("rejects an unregistered name at compile time", () => {
    expect(COMPILE_TIME_UNREGISTERED_NAME_REJECTED).toBe(true);
  });

  it("registers the structural context-correction name at compile time", () => {
    expect(COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_NAME_REGISTERED).toBe(true);
  });

  it("registers the agent/tool/search family patterns at compile time", () => {
    expect(COMPILE_TIME_FAMILY_NAMES_REGISTERED).toBe(true);
  });

  it("maps the structural name to the context-correction payload type", () => {
    expect(COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_PAYLOAD_TYPE).toBe(true);
  });

  it("maps an agent name to the agent payload type", () => {
    expect(COMPILE_TIME_AGENT_PAYLOAD_TYPE).toBe(true);
  });

  it("rejects a wrong-shaped payload for the structural name", () => {
    expect(COMPILE_TIME_WRONG_CONTEXT_CORRECTION_PAYLOAD_REJECTED).toBe(true);
  });

  it("rejects a cross-family payload mismatch", () => {
    expect(COMPILE_TIME_CROSS_FAMILY_MISMATCH_REJECTED).toBe(true);
  });

  it("JobPayloadFor resolves the structural name to the context-correction payload", () => {
    const payload: JobPayloadFor<typeof contextCorrectionRedraftJobName> =
      contextCorrectionPayload();
    expect(payload.schemaVersion).toBe(contextCorrectionRedraftPayloadSchemaVersion);
  });

  it("JobPayloadFor resolves agent.* names to the agent payload", () => {
    const payload: JobPayloadFor<"agent.translation-quality-judge"> = {
      jobKind: "agent_job",
      agentName: "agent.translation-quality-judge",
      agentVersion: "1.0.0",
      input: {},
    };
    expect(payload.jobKind).toBe("agent_job");
  });
});
