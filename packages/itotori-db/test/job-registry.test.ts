// ITOTORI-048 — typed job-name registry unit tests.
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

// ---------------------------------------------------------------------------
// Family resolution: agent.* / tool.* / search.*.
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

// ---------------------------------------------------------------------------
// buildRegisteredJobInput — structural context-correction job.
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

// ---------------------------------------------------------------------------
// buildRegisteredJobInput — agent/tool family names.
// ---------------------------------------------------------------------------

describe("buildRegisteredJobInput — agent/tool family names", () => {
  it("stamps agent_task for an agent.* name with a valid AgentJobPayload", () => {
    const payload: AgentJobPayload = {
      jobKind: "agent_job",
      agentName: "agent.translation-quality-judge",
      agentVersion: "1.0.0",
      input: { source: "hello" },
    };
    const input = buildRegisteredJobInput(
      "agent.translation-quality-judge",
      payload,
      jobInputBase(),
    );
    expect(input.jobName).toBe("agent.translation-quality-judge");
    expect(input.jobType).toBe(jobTaskTypeValues.agentTask);
    expect(input.payload).toEqual(payload as unknown as Record<string, unknown>);
  });

  it("stamps deterministic_tool_task for a tool.* name", () => {
    const input = buildRegisteredJobInput(
      "tool.protected-span-check",
      {
        jobKind: "deterministic_tool_job",
        toolName: "tool.protected-span-check",
        toolVersion: "1.0.0",
        input: {},
      },
      jobInputBase(),
    );
    expect(input.jobType).toBe(jobTaskTypeValues.deterministicToolTask);
  });

  it("stamps deterministic_tool_task for a search.* name", () => {
    const input = buildRegisteredJobInput(
      "search.exact",
      {
        jobKind: "deterministic_tool_job",
        toolName: "search.exact",
        toolVersion: "1.0.0",
        input: {},
      },
      jobInputBase(),
    );
    expect(input.jobType).toBe(jobTaskTypeValues.deterministicToolTask);
  });

  it("rejects an agent payload whose agentName does not match jobName", () => {
    expect(() =>
      buildRegisteredJobInput(
        "agent.translation-quality-judge",
        {
          jobKind: "agent_job",
          agentName: "agent.other",
          agentVersion: "1.0.0",
          input: {},
        },
        jobInputBase(),
      ),
    ).toThrow(
      expect.objectContaining({
        reason: jobPayloadValidationReasons.wrongNameBinding,
        field: "agentName",
      }),
    );
  });

  it("rejects a deterministic tool payload with the wrong discriminator", () => {
    expect(() =>
      buildRegisteredJobInput(
        "tool.protected-span-check",
        {
          jobKind: "agent_job",
          toolName: "tool.protected-span-check",
          toolVersion: "1.0.0",
          input: {},
        } as unknown as JobPayloadFor<"tool.protected-span-check">,
        jobInputBase(),
      ),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.wrongDiscriminator }));
  });
});

// ---------------------------------------------------------------------------
// Compile-time enforcement (type-level fixtures).
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

// ---------------------------------------------------------------------------
// RegisteredJobHandlerRegistry — exactly one handler per name.
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

// ---------------------------------------------------------------------------
// Context-correction payload mismatch coverage.
// ---------------------------------------------------------------------------

describe("assertContextCorrectionRedraftPayload — mismatch detection", () => {
  it("accepts a well-formed payload", () => {
    expect(() =>
      assertContextCorrectionRedraftPayload(
        contextCorrectionPayload(),
        contextCorrectionRedraftJobName,
      ),
    ).not.toThrow();
  });

  it("rejects a non-object payload", () => {
    expect(() =>
      assertContextCorrectionRedraftPayload("not-an-object", contextCorrectionRedraftJobName),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.notRecord }));
  });

  it("rejects another job name for the context-correction payload", () => {
    expect(() =>
      assertContextCorrectionRedraftPayload(contextCorrectionPayload(), "other.redraft"),
    ).toThrow(
      expect.objectContaining({
        reason: jobPayloadValidationReasons.wrongNameBinding,
        field: "jobName",
      }),
    );
  });

  it("rejects a missing context entry version", () => {
    const broken: unknown = { ...contextCorrectionPayload(), contextEntryVersionId: "" };
    expect(() =>
      assertContextCorrectionRedraftPayload(broken, contextCorrectionRedraftJobName),
    ).toThrow(
      expect.objectContaining({
        reason: jobPayloadValidationReasons.missingField,
        field: "contextEntryVersionId",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Every persisted job name -> typed payload + one handler slot.
// ---------------------------------------------------------------------------

describe("acceptance crux — structural job maps to a typed payload + one handler slot", () => {
  it("the structural name resolves to ContextCorrectionRedraftPayload via JobPayloadFor", () => {
    const check: Record<RegisteredJobName, ContextCorrectionRedraftPayload> = {
      [contextCorrectionRedraftJobName]: contextCorrectionPayload(),
    };
    expect(Object.keys(check)).toEqual([...REGISTERED_JOB_NAMES]);
  });

  it("a fresh registry has no handler for the structural job", () => {
    const registry = new RegisteredJobHandlerRegistry();
    for (const name of REGISTERED_JOB_NAMES) {
      expect(registry.hasHandlerFor(name)).toBe(false);
    }
  });

  it("the closed AnyRegisteredJobName union covers structural + family names", () => {
    const names: AnyRegisteredJobName[] = [
      contextCorrectionRedraftJobName,
      "agent.translation-quality-judge",
      "tool.protected-span-check",
      "search.exact",
    ];
    for (const name of names) {
      expect(isRegisteredJobName(name)).toBe(true);
    }
  });
});
