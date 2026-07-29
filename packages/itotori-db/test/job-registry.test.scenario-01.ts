// Typed job-name registry unit tests.
//
// Pure unit tests (no database): pin that the sole structural
// context-correction redraft job maps to its typed payload and one handler
// slot, while unregistered names or mismatched payloads are rejected.
// Generic agent/tool/search families remain registry-driven.

import { describe, expect, it } from "vitest";
import {
  contextCorrectionRedraftJobName,
  JOB_DEFINITIONS,
  REGISTERED_JOB_NAMES,
  requireRegisteredJobDefinition,
  resolveRegisteredJobDefinition,
} from "../src/job-registry.js";

import { jobTaskTypeValues } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

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
