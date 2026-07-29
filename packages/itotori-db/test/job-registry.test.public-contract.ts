import { describe, expect, it } from "vitest";

import {
  assertAgentJobPayload,
  assertContextCorrectionRedraftPayload,
  buildRegisteredJobInput,
  contextCorrectionRedraftJobName,
  contextCorrectionRedraftPayloadSchemaVersion,
  isRegisteredJobName,
  jobPayloadValidationReasons,
  requireRegisteredJobDefinition,
  UnregisteredJobNameError,
} from "../src/job-registry.js";
import type {
  ContextCorrectionRedraftPayload,
  RegisteredJobInputBase,
} from "../src/job-registry.js";
import { jobIdempotencyPolicyValues, jobTaskTypeValues } from "../src/schema.js";

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

function jobInputBase(): RegisteredJobInputBase {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    idempotency: {
      policy: jobIdempotencyPolicyValues.idempotent,
      key: "job:test",
    },
  };
}

describe("registered job public contract", () => {
  it("rejects arbitrary persisted job names", () => {
    expect(isRegisteredJobName("bogus.thing")).toBe(false);
    expect(() => requireRegisteredJobDefinition("bogus.thing")).toThrow(UnregisteredJobNameError);
  });

  it("recognizes the structural context-correction name", () => {
    expect(isRegisteredJobName(contextCorrectionRedraftJobName)).toBe(true);
  });

  it("recognizes the agent name family", () => {
    expect(isRegisteredJobName("agent.translation-quality-judge")).toBe(true);
  });

  it("recognizes the deterministic tool name family", () => {
    expect(isRegisteredJobName("tool.protected-span-check")).toBe(true);
  });

  it("recognizes the search name family", () => {
    expect(isRegisteredJobName("search.exact")).toBe(true);
  });

  it("maps a structural payload to a rerun job", () => {
    expect(
      buildRegisteredJobInput(
        contextCorrectionRedraftJobName,
        contextCorrectionPayload(),
        jobInputBase(),
      ).jobType,
    ).toBe(jobTaskTypeValues.rerun);
  });

  it("maps an agent payload to an agent job", () => {
    expect(
      buildRegisteredJobInput(
        "agent.translation-quality-judge",
        {
          jobKind: "agent_job",
          agentName: "agent.translation-quality-judge",
          agentVersion: "1.0.0",
          input: {},
        },
        jobInputBase(),
      ).jobType,
    ).toBe(jobTaskTypeValues.agentTask);
  });

  it("rejects a malformed structural payload", () => {
    expect(() =>
      assertContextCorrectionRedraftPayload({ wrong: "shape" }, contextCorrectionRedraftJobName),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.wrongDiscriminator }));
  });

  it("rejects a structural payload submitted to an agent name", () => {
    expect(() =>
      assertAgentJobPayload(contextCorrectionPayload(), "agent.translation-quality-judge"),
    ).toThrow(expect.objectContaining({ reason: jobPayloadValidationReasons.wrongDiscriminator }));
  });
});
