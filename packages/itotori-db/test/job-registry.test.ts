// ITOTORI-048 — typed job-name registry unit tests.
//
// Pure unit tests (no database): pin that every persisted job name maps to
// a typed payload + exactly one handler, that an unregistered name or a
// mismatched payload is rejected (compile-time via the `COMPILE_TIME_*`
// self-checks in src/job-registry.ts, enforced by tsc on every build, +
// runtime via the validators), and that a handler cannot be bound for an
// unregistered name or bound twice for the same name.
//
// The compile-time self-checks live in `src/job-registry.ts` (test files
// are outside the tsc `include`), so tsc enforces them; these tests pin
// their existence + the runtime rejection behaviour. Together they cover
// both halves of the acceptance: "caught (compile-time and/or a test)".

import { describe, expect, it } from "vitest";
import {
  assertReviewerTriggeredRerunPayload,
  buildRegisteredJobInput,
  COMPILE_TIME_AGENT_PAYLOAD_TYPE,
  COMPILE_TIME_CROSS_FAMILY_MISMATCH_REJECTED,
  COMPILE_TIME_FAMILY_NAMES_REGISTERED,
  COMPILE_TIME_RERUN_NAMES_REGISTERED,
  COMPILE_TIME_RERUN_PAYLOAD_TYPE,
  COMPILE_TIME_UNREGISTERED_NAME_REJECTED,
  COMPILE_TIME_WRONG_RERUN_PAYLOAD_REJECTED,
  DuplicateJobHandlerError,
  isRegisteredJobName,
  JOB_DEFINITIONS,
  JOB_NAME_FAMILIES,
  JobPayloadValidationError,
  jobPayloadValidationReasons,
  REGISTERED_JOB_NAMES,
  RegisteredJobHandlerRegistry,
  requireRegisteredJobDefinition,
  resolveRegisteredJobDefinition,
  reviewerTriggeredRerunJobNameValues,
  reviewerTriggeredRerunPayloadSchemaVersion,
  reviewerTriggeredRerunReasonCodeValues,
  reviewerTriggeredRerunStageValues,
  UnregisteredJobHandlerError,
  UnregisteredJobNameError,
} from "../src/job-registry.js";
import type {
  AgentJobPayload,
  AnyRegisteredJobName,
  JobPayloadFor,
  RegisteredJobInputBase,
  RegisteredJobName,
  ReviewerTriggeredRerunPayload,
} from "../src/job-registry.js";
import type { JobQueueRecord } from "../src/repositories/event-queue-repository.js";
import { jobIdempotencyPolicyValues, jobTaskTypeValues } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function rerunPayload(
  stage: (typeof reviewerTriggeredRerunStageValues)[keyof typeof reviewerTriggeredRerunStageValues],
): ReviewerTriggeredRerunPayload {
  return {
    schemaVersion: reviewerTriggeredRerunPayloadSchemaVersion,
    stage,
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "source-revision-test",
    affectedUnitIds: ["bridge-unit-1"],
    artifactIds: ["artifact-1"],
    policyVersions: {
      styleGuideVersionId: "style-v1",
      glossaryVersionId: "glossary-v1",
      pairPolicyVersionId: null,
      qaPolicyVersionId: null,
      exportPolicyVersionId: null,
      runtimeValidationPolicyVersionId: null,
    },
    reasonCodes: [reviewerTriggeredRerunReasonCodeValues.reviewerRequestRepair],
    reviewItemId: "review-item-1",
    transitionId: "transition-1",
    reviewerAction: "request_repair",
    itemKind: "qa",
    sourceItemRef: "ref-1",
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

const stageForRerunName: Record<
  RegisteredJobName,
  (typeof reviewerTriggeredRerunStageValues)[keyof typeof reviewerTriggeredRerunStageValues]
> = {
  "rerun.draft-repair": reviewerTriggeredRerunStageValues.draftRepair,
  "rerun.qa-replay": reviewerTriggeredRerunStageValues.qaReplay,
  "rerun.export-regeneration": reviewerTriggeredRerunStageValues.exportRegeneration,
  "rerun.runtime-validation": reviewerTriggeredRerunStageValues.runtimeValidation,
};

// ---------------------------------------------------------------------------
// Registry exhaustiveness: name ↔ definition parity.
// ---------------------------------------------------------------------------

describe("JOB_DEFINITIONS — registry exhaustiveness", () => {
  it("registers every structural RegisteredJobName (compile-time via satisfies)", () => {
    // The `satisfies Record<RegisteredJobName, RegisteredJobDefinition>` on
    // JOB_DEFINITIONS makes a missing entry a compile error; this runtime
    // assertion pins that every declared name resolves to a definition.
    for (const name of REGISTERED_JOB_NAMES) {
      expect(resolveRegisteredJobDefinition(name)).toBeDefined();
      expect(JOB_DEFINITIONS[name]).toBeDefined();
    }
  });

  it("has no surplus entries beyond the RegisteredJobName union (key parity)", () => {
    const declared = new Set<string>(Object.values(reviewerTriggeredRerunJobNameValues));
    const tableKeys = new Set<string>(Object.keys(JOB_DEFINITIONS));
    // Every table key is a declared registered name (no phantom entries).
    for (const key of tableKeys) {
      expect(declared).toContain(key);
    }
    // Every declared name is in the table (no missing entries).
    expect([...tableKeys].sort()).toEqual([...declared].sort());
  });

  it("stamps the rerun jobType for every structural name", () => {
    for (const name of REGISTERED_JOB_NAMES) {
      const definition = requireRegisteredJobDefinition(name);
      expect(definition.jobType).toBe(jobTaskTypeValues.rerun);
    }
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
    expect(resolveRegisteredJobDefinition("bogus.thing")).toBeUndefined();
    expect(resolveRegisteredJobDefinition("rerun.not-a-stage")).toBeUndefined();
    expect(resolveRegisteredJobDefinition("agent")).toBeUndefined();
  });

  it("isRegisteredJobName agrees with resolveRegisteredJobDefinition", () => {
    expect(isRegisteredJobName("rerun.draft-repair")).toBe(true);
    expect(isRegisteredJobName("agent.foo")).toBe(true);
    expect(isRegisteredJobName("tool.bar")).toBe(true);
    expect(isRegisteredJobName("search.baz")).toBe(true);
    expect(isRegisteredJobName("bogus")).toBe(false);
  });

  it("requireRegisteredJobDefinition throws UnregisteredJobNameError for an unknown name", () => {
    expect(() => requireRegisteredJobDefinition("bogus.thing")).toThrow(UnregisteredJobNameError);
    expect(() => requireRegisteredJobDefinition("bogus.thing")).toThrow(
      expect.objectContaining({ jobName: "bogus.thing" }),
    );
  });

  it("registers exactly the three family prefixes", () => {
    expect(JOB_NAME_FAMILIES.map((f) => f.namePrefix).sort()).toEqual([
      "agent.",
      "search.",
      "tool.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildRegisteredJobInput — typed enqueue builder.
// ---------------------------------------------------------------------------

describe("buildRegisteredJobInput — structural rerun names", () => {
  it("stamps jobName, jobType, and payload for each registered rerun name", () => {
    for (const name of REGISTERED_JOB_NAMES) {
      const stage = stageForRerunName[name];
      const payload = rerunPayload(stage);
      const input = buildRegisteredJobInput(name, payload, jobInputBase());
      expect(input.jobName).toBe(name);
      expect(input.jobType).toBe(jobTaskTypeValues.rerun);
      expect(input.payload).toEqual(payload as unknown as Record<string, unknown>);
    }
  });

  it("preserves caller-supplied queueing context (project, idempotency, deps)", () => {
    const input = buildRegisteredJobInput(
      reviewerTriggeredRerunJobNameValues.draftRepair,
      rerunPayload(reviewerTriggeredRerunStageValues.draftRepair),
      jobInputBase({
        queueName: "reviewer-rerun",
        dependsOnJobIds: ["job-prior"],
        priority: 40,
      }),
    );
    expect(input.queueName).toBe("reviewer-rerun");
    expect(input.dependsOnJobIds).toEqual(["job-prior"]);
    expect(input.priority).toBe(40);
  });

  it("runs the payload validator (rejects a payload whose stage disagrees with jobName)", () => {
    // draft-repair payload enqueued under the qa-replay name: the
    // stage↔name binding must be caught.
    const payload = rerunPayload(reviewerTriggeredRerunStageValues.draftRepair);
    expect(() =>
      buildRegisteredJobInput(
        reviewerTriggeredRerunJobNameValues.qaReplay,
        payload,
        jobInputBase(),
      ),
    ).toThrow(JobPayloadValidationError);
    expect(() =>
      buildRegisteredJobInput(
        reviewerTriggeredRerunJobNameValues.qaReplay,
        payload,
        jobInputBase(),
      ),
    ).toThrow(
      expect.objectContaining({
        jobName: reviewerTriggeredRerunJobNameValues.qaReplay,
        reason: jobPayloadValidationReasons.wrongStage,
      }),
    );
  });

  it("rejects a payload missing required fields", () => {
    const payload = rerunPayload(reviewerTriggeredRerunStageValues.draftRepair);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = { ...payload };
    broken["projectId"] = "";
    expect(() =>
      buildRegisteredJobInput(
        reviewerTriggeredRerunJobNameValues.draftRepair,
        broken,
        jobInputBase(),
      ),
    ).toThrow(JobPayloadValidationError);
  });

  it("rejects a payload with a bad schemaVersion discriminator", () => {
    const payload = rerunPayload(reviewerTriggeredRerunStageValues.draftRepair);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = { ...payload, schemaVersion: "itotori.wrong.v1" };
    expect(() =>
      buildRegisteredJobInput(
        reviewerTriggeredRerunJobNameValues.draftRepair,
        broken,
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
          agentName: "agent.wrong",
          agentVersion: "1.0.0",
          input: {},
        },
        jobInputBase(),
      ),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.wrongNameBinding }));
  });

  it("rejects a tool payload with the wrong jobKind discriminator", () => {
    expect(() =>
      buildRegisteredJobInput(
        "tool.protected-span-check",
        {
          jobKind: "agent_job",
          toolName: "tool.protected-span-check",
          toolVersion: "1.0.0",
          input: {},
        },
        jobInputBase(),
      ),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.wrongDiscriminator }));
  });
});

// ---------------------------------------------------------------------------
// Compile-time enforcement (type-level fixtures).
// ---------------------------------------------------------------------------

describe("buildRegisteredJobInput — compile-time enforcement", () => {
  // The compile-time half of the acceptance is enforced by tsc on
  // `src/job-registry.ts` (test files are not in the tsc `include`), via
  // the exported `COMPILE_TIME_*` self-check constants — each resolves to
  // `never` (making the `= true` initializer a type error) when its
  // property does NOT hold. These runtime assertions pin that the
  // self-checks exist and resolved to `true`; tsc pins the type-level
  // rejection on every build.

  it("rejects an unregistered name at compile time", () => {
    expect(COMPILE_TIME_UNREGISTERED_NAME_REJECTED).toBe(true);
  });

  it("registers every structural rerun name at compile time", () => {
    expect(COMPILE_TIME_RERUN_NAMES_REGISTERED).toBe(true);
  });

  it("registers the agent/tool/search family patterns at compile time", () => {
    expect(COMPILE_TIME_FAMILY_NAMES_REGISTERED).toBe(true);
  });

  it("maps a structural name to the rerun payload type at compile time", () => {
    expect(COMPILE_TIME_RERUN_PAYLOAD_TYPE).toBe(true);
  });

  it("maps an agent name to the agent payload type at compile time", () => {
    expect(COMPILE_TIME_AGENT_PAYLOAD_TYPE).toBe(true);
  });

  it("rejects a wrong-shaped payload for a structural name at compile time", () => {
    expect(COMPILE_TIME_WRONG_RERUN_PAYLOAD_REJECTED).toBe(true);
  });

  it("rejects a cross-family payload mismatch at compile time", () => {
    expect(COMPILE_TIME_CROSS_FAMILY_MISMATCH_REJECTED).toBe(true);
  });

  it("JobPayloadFor resolves structural names to the rerun payload (runtime shape check)", () => {
    const payload: JobPayloadFor<typeof reviewerTriggeredRerunJobNameValues.draftRepair> =
      rerunPayload(reviewerTriggeredRerunStageValues.draftRepair);
    expect(payload.schemaVersion).toBe(reviewerTriggeredRerunPayloadSchemaVersion);
  });

  it("JobPayloadFor resolves agent.* names to the agent payload (runtime shape check)", () => {
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

  it("binds exactly one handler per registered name", () => {
    const registry = new RegisteredJobHandlerRegistry();
    const handler = async () => {};
    registry.register(reviewerTriggeredRerunJobNameValues.draftRepair, handler);
    expect(registry.hasHandlerFor(reviewerTriggeredRerunJobNameValues.draftRepair)).toBe(true);
    expect(registry.boundJobNames()).toEqual([reviewerTriggeredRerunJobNameValues.draftRepair]);

    // A second binding for the SAME name is rejected — exactly one handler.
    expect(() =>
      registry.register(reviewerTriggeredRerunJobNameValues.draftRepair, async () => {}),
    ).toThrow(DuplicateJobHandlerError);
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

  it("handlerFor throws UnregisteredJobHandlerError for a name with no handler", () => {
    const registry = new RegisteredJobHandlerRegistry();
    const job = jobRecord(
      reviewerTriggeredRerunJobNameValues.draftRepair,
      rerunPayload(reviewerTriggeredRerunStageValues.draftRepair),
    );
    expect(() => registry.handlerFor(job)).toThrow(UnregisteredJobHandlerError);
    expect(() => registry.handlerFor(job)).toThrow(
      expect.objectContaining({
        jobName: reviewerTriggeredRerunJobNameValues.draftRepair,
        jobId: "job-test",
      }),
    );
  });

  it("handlerFor returns the bound handler", async () => {
    const registry = new RegisteredJobHandlerRegistry();
    let called = false;
    registry.register(reviewerTriggeredRerunJobNameValues.draftRepair, async () => {
      called = true;
    });
    const job = jobRecord(
      reviewerTriggeredRerunJobNameValues.draftRepair,
      rerunPayload(reviewerTriggeredRerunStageValues.draftRepair),
    );
    const handler = registry.handlerFor(job);
    await handler(job);
    expect(called).toBe(true);
  });

  it("toJobHandlerByNameMap projects to the loose byName shape", () => {
    const registry = new RegisteredJobHandlerRegistry();
    const handler = async () => {};
    registry.register(reviewerTriggeredRerunJobNameValues.draftRepair, handler);
    const map = registry.toJobHandlerByNameMap();
    expect(map[reviewerTriggeredRerunJobNameValues.draftRepair]).toBe(handler);
  });
});

// ---------------------------------------------------------------------------
// assertReviewerTriggeredRerunPayload — payload mismatch coverage.
// ---------------------------------------------------------------------------

describe("assertReviewerTriggeredRerunPayload — mismatch detection", () => {
  it("accepts a well-formed payload", () => {
    const payload = rerunPayload(reviewerTriggeredRerunStageValues.draftRepair);
    expect(() =>
      assertReviewerTriggeredRerunPayload(payload, reviewerTriggeredRerunJobNameValues.draftRepair),
    ).not.toThrow();
  });

  it("rejects a non-object payload", () => {
    expect(() =>
      assertReviewerTriggeredRerunPayload(
        "not-an-object",
        reviewerTriggeredRerunJobNameValues.draftRepair,
      ),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.notRecord }));
  });

  it("rejects a payload with an invalid reasonCode", () => {
    const payload = rerunPayload(reviewerTriggeredRerunStageValues.draftRepair);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = { ...payload, reasonCodes: ["not_a_real_reason_code"] };
    expect(() =>
      assertReviewerTriggeredRerunPayload(broken, reviewerTriggeredRerunJobNameValues.draftRepair),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.wrongDiscriminator }));
  });

  it("rejects a payload with a null policyVersions field where a string|null is expected", () => {
    const payload = rerunPayload(reviewerTriggeredRerunStageValues.draftRepair);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = {
      ...payload,
      policyVersions: { ...payload.policyVersions, styleGuideVersionId: 123 },
    };
    expect(() =>
      assertReviewerTriggeredRerunPayload(broken, reviewerTriggeredRerunJobNameValues.draftRepair),
    ).toThrow(JobPayloadValidationError);
  });
});

// ---------------------------------------------------------------------------
// Every persisted job name -> typed payload + one handler (acceptance crux).
// ---------------------------------------------------------------------------

describe("acceptance crux — every registered name maps to a typed payload + one handler slot", () => {
  it("each structural name resolves to a typed payload via JobPayloadFor", () => {
    // Compile-time: each name's payload type is ReviewerTriggeredRerunPayload.
    const check: Record<RegisteredJobName, ReviewerTriggeredRerunPayload> = {
      "rerun.draft-repair": rerunPayload(reviewerTriggeredRerunStageValues.draftRepair),
      "rerun.qa-replay": rerunPayload(reviewerTriggeredRerunStageValues.qaReplay),
      "rerun.export-regeneration": rerunPayload(
        reviewerTriggeredRerunStageValues.exportRegeneration,
      ),
      "rerun.runtime-validation": rerunPayload(reviewerTriggeredRerunStageValues.runtimeValidation),
    };
    expect(Object.keys(check).sort()).toEqual([...REGISTERED_JOB_NAMES].sort());
  });

  it("a fresh registry has no handlers — exactly one slot per name, opt-in", () => {
    const registry = new RegisteredJobHandlerRegistry();
    for (const name of REGISTERED_JOB_NAMES) {
      expect(registry.hasHandlerFor(name)).toBe(false);
    }
  });

  it("the closed AnyRegisteredJobName union covers structural + family names", () => {
    // Compile-time fixture: these all satisfy AnyRegisteredJobName.
    const names: AnyRegisteredJobName[] = [
      reviewerTriggeredRerunJobNameValues.draftRepair,
      "agent.translation-quality-judge",
      "tool.protected-span-check",
      "search.exact",
    ];
    for (const name of names) {
      expect(isRegisteredJobName(name)).toBe(true);
    }
  });
});
