// Typed job-name registry unit tests.
//
// Pure unit tests (no database): pin that the sole structural
// context-correction redraft job maps to its typed payload and one handler
// slot, while unregistered names or mismatched payloads are rejected.
// Generic agent/tool/search families remain registry-driven.

import { describe, expect, it } from "vitest";
import { buildRegisteredJobInput, jobPayloadValidationReasons } from "../src/job-registry.js";
import type {
  AgentJobPayload,
  JobPayloadFor,
  RegisteredJobInputBase,
} from "../src/job-registry.js";

import { jobIdempotencyPolicyValues, jobTaskTypeValues } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registry exhaustiveness: name ↔ definition parity.
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
