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

describe("RegisteredJobHandlerRegistry — handler binding", () => {
  it("refuses to bind a handler for an unregistered name", () => {
    const registry = new RegisteredJobHandlerRegistry();
    expect(() => registry.register("bogus.thing", async () => {})).toThrow(
      UnregisteredJobNameError,
    );
    expect(registry.hasHandlerFor("bogus.thing")).toBe(false);
  });

  it("binds exactly one handler for the structural redraft job", () => {
    const registry = new RegisteredJobHandlerRegistry();
    const handler = async () => {};
    registry.register(contextCorrectionRedraftJobName, handler);
    expect(registry.hasHandlerFor(contextCorrectionRedraftJobName)).toBe(true);
    expect(registry.boundJobNames()).toEqual([contextCorrectionRedraftJobName]);

    expect(() => registry.register(contextCorrectionRedraftJobName, async () => {})).toThrow(
      DuplicateJobHandlerError,
    );
  });

  it("binds distinct handlers for distinct family names", () => {
    const registry = new RegisteredJobHandlerRegistry();
    registry.register("agent.translation-quality-judge", async () => {});
    registry.register("agent.context-summary", async () => {});
    registry.register("tool.protected-span-check", async () => {});
    expect(registry.boundJobNames().sort()).toEqual([
      "agent.context-summary",
      "agent.translation-quality-judge",
      "tool.protected-span-check",
    ]);
  });

  it("handlerFor throws when a name has no handler", () => {
    const registry = new RegisteredJobHandlerRegistry();
    const job = jobRecord(contextCorrectionRedraftJobName, contextCorrectionPayload());
    expect(() => registry.handlerFor(job)).toThrow(UnregisteredJobHandlerError);
    expect(() => registry.handlerFor(job)).toThrow(
      expect.objectContaining({
        jobName: contextCorrectionRedraftJobName,
        jobId: "job-test",
      }),
    );
  });

  it("handlerFor returns the bound handler", async () => {
    const registry = new RegisteredJobHandlerRegistry();
    let called = false;
    registry.register(contextCorrectionRedraftJobName, async () => {
      called = true;
    });
    const job = jobRecord(contextCorrectionRedraftJobName, contextCorrectionPayload());
    const handler = registry.handlerFor(job);
    await handler(job);
    expect(called).toBe(true);
  });

  it("toJobHandlerByNameMap projects to the loose byName shape", () => {
    const registry = new RegisteredJobHandlerRegistry();
    const handler = async () => {};
    registry.register(contextCorrectionRedraftJobName, handler);
    const map = registry.toJobHandlerByNameMap();
    expect(map[contextCorrectionRedraftJobName]).toBe(handler);
  });
});
