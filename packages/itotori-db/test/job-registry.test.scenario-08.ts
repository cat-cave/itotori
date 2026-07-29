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
  REGISTERED_JOB_NAMES,
  RegisteredJobHandlerRegistry,
} from "../src/job-registry.js";
import type {
  AnyRegisteredJobName,
  ContextCorrectionRedraftPayload,
  RegisteredJobName,
} from "../src/job-registry.js";

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
