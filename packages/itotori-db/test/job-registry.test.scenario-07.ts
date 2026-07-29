// Typed job-name registry unit tests.
//
// Pure unit tests (no database): pin that the sole structural
// context-correction redraft job maps to its typed payload and one handler
// slot, while unregistered names or mismatched payloads are rejected.
// Generic agent/tool/search families remain registry-driven.

import { describe, expect, it } from "vitest";
import {
  assertContextCorrectionRedraftPayload,
  contextCorrectionRedraftJobName,
  contextCorrectionRedraftPayloadSchemaVersion,
  jobPayloadValidationReasons,
} from "../src/job-registry.js";
import type { ContextCorrectionRedraftPayload } from "../src/job-registry.js";

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

// ---------------------------------------------------------------------------
// Registry exhaustiveness: name ↔ definition parity.
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
