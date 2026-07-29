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
  isRegisteredJobName,
  JOB_NAME_FAMILIES,
  requireRegisteredJobDefinition,
  resolveRegisteredJobDefinition,
  UnregisteredJobNameError,
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

describe("resolveRegisteredJobDefinition — name families", () => {
  it("resolves an agent.* name to the agent_task family", () => {
    const definition = resolveRegisteredJobDefinition("agent.translation-quality-judge");
    expect(definition).toBeDefined();
    expect(definition?.jobType).toBe(jobTaskTypeValues.agentTask);
  });

  it("resolves a tool.* name to the deterministic_tool_task family", () => {
    const definition = resolveRegisteredJobDefinition("tool.protected-span-check");
    expect(definition).toBeDefined();
    expect(definition?.jobType).toBe(jobTaskTypeValues.deterministicToolTask);
  });

  it("resolves a search.* name to the deterministic_tool_task family", () => {
    const definition = resolveRegisteredJobDefinition("search.exact");
    expect(definition).toBeDefined();
    expect(definition?.jobType).toBe(jobTaskTypeValues.deterministicToolTask);
  });

  it("returns undefined for an unregistered name", () => {
    expect(resolveRegisteredJobDefinition("obsolete.refinement")).toBeUndefined();
    expect(resolveRegisteredJobDefinition("agent")).toBeUndefined();
  });

  it("isRegisteredJobName agrees with resolveRegisteredJobDefinition", () => {
    expect(isRegisteredJobName(contextCorrectionRedraftJobName)).toBe(true);
    expect(isRegisteredJobName("agent.foo")).toBe(true);
    expect(isRegisteredJobName("tool.bar")).toBe(true);
    expect(isRegisteredJobName("search.baz")).toBe(true);
    expect(isRegisteredJobName("bogus")).toBe(false);
  });

  it("requireRegisteredJobDefinition throws for an unknown name", () => {
    expect(() => requireRegisteredJobDefinition("obsolete.refinement")).toThrow(
      UnregisteredJobNameError,
    );
    expect(() => requireRegisteredJobDefinition("obsolete.refinement")).toThrow(
      expect.objectContaining({ jobName: "obsolete.refinement" }),
    );
  });

  it("registers exactly the three family prefixes", () => {
    expect(JOB_NAME_FAMILIES.map((family) => family.namePrefix).sort()).toEqual([
      "agent.",
      "search.",
      "tool.",
    ]);
  });
});
