import { describe, expect, it } from "vitest";
import {
  assertRegistrySchemaValue,
  deterministicPreExportQaOutputFixture,
  deterministicPreExportQaOutputSchema,
  type DeterministicPreExportQaOutput,
} from "../src/agents/index.js";
import {
  assertDeterministicPreExportQaFinding,
  assertDeterministicPreExportQaOutput,
  DETERMINISTIC_PRE_EXPORT_QA_CHECK_CODES,
  DeterministicPreExportQaOutputValidationError,
} from "../src/services/deterministic-pre-export-qa.js";

function cloneOutput(): DeterministicPreExportQaOutput {
  return structuredClone(deterministicPreExportQaOutputFixture);
}

function firstFailure(output: DeterministicPreExportQaOutput): Record<string, unknown> {
  const failure = output.failures[0];
  if (failure === undefined) {
    throw new Error("fixture must include at least one failure finding");
  }
  return failure as Record<string, unknown>;
}

describe("deterministic pre-export QA registry output schema (ITOTORI-143)", () => {
  it("no longer accepts arbitrary object array items in the schema definition", () => {
    const jsonSchema = deterministicPreExportQaOutputSchema.jsonSchema as {
      properties: {
        failures: { items: { properties?: Record<string, unknown> } };
        findings: { items: { properties?: Record<string, unknown> } };
      };
    };
    // Previously both were `{ items: { type: "object" } }` (no properties).
    expect(jsonSchema.properties.failures.items.properties).toBeDefined();
    expect(jsonSchema.properties.findings.items.properties).toBeDefined();
    expect(jsonSchema.properties.failures.items.properties).toHaveProperty("checkCode");
    expect(jsonSchema.properties.failures.items.properties).toHaveProperty("unitId");
    expect(jsonSchema.properties.failures.items.properties).toHaveProperty("repairHint");
  });

  it("accepts the valid tool-output fixture at the boundary and via the validator", () => {
    expect(() =>
      assertRegistrySchemaValue(
        deterministicPreExportQaOutputSchema,
        deterministicPreExportQaOutputFixture,
        "tool.deterministic-pre-export-qa output",
      ),
    ).not.toThrow();
    expect(() =>
      assertDeterministicPreExportQaOutput(deterministicPreExportQaOutputFixture),
    ).not.toThrow();
  });

  it("accepts a single valid finding", () => {
    expect(() =>
      assertDeterministicPreExportQaFinding(firstFailure(cloneOutput()), "failures[0]"),
    ).not.toThrow();
  });

  it("rejects an arbitrary object array item with a field-naming diagnostic", () => {
    const output = cloneOutput();
    (output as unknown as { failures: unknown[] }).failures = [{ arbitrary: "shape" }];
    expect(() => assertDeterministicPreExportQaOutput(output)).toThrow(
      DeterministicPreExportQaOutputValidationError,
    );
    expect(() => assertDeterministicPreExportQaOutput(output)).toThrow(/failures\[0\]\.arbitrary/);
    // The registry boundary rejects it too, naming the missing contract field.
    expect(() =>
      assertRegistrySchemaValue(deterministicPreExportQaOutputSchema, output, "output"),
    ).toThrow(/failures\[0\]\.checkCode/);
  });

  it("rejects a non-object array item (not a finding at all)", () => {
    const output = cloneOutput();
    (output as unknown as { failures: unknown[] }).failures = [42];
    expect(() => assertDeterministicPreExportQaOutput(output)).toThrow(
      /failures\[0\].*not an arbitrary array item/,
    );
  });

  it("rejects a finding with a malformed/missing unit reference, naming the field", () => {
    const emptyUnit = cloneOutput();
    firstFailure(emptyUnit).unitId = "";
    expect(() => assertDeterministicPreExportQaOutput(emptyUnit)).toThrow(/failures\[0\]\.unitId/);
    expect(() =>
      assertRegistrySchemaValue(deterministicPreExportQaOutputSchema, emptyUnit, "output"),
    ).toThrow(/failures\[0\]\.unitId/);

    const missingKey = cloneOutput();
    delete firstFailure(missingKey).sourceUnitKey;
    expect(() => assertDeterministicPreExportQaOutput(missingKey)).toThrow(
      /failures\[0\]\.sourceUnitKey/,
    );
  });

  it("rejects an unknown check code, naming the field and the offending value", () => {
    const output = cloneOutput();
    firstFailure(output).checkCode = "totally-unknown-check";
    expect(() => assertDeterministicPreExportQaOutput(output)).toThrow(
      /failures\[0\]\.checkCode.*totally-unknown-check/,
    );
    expect(() =>
      assertRegistrySchemaValue(deterministicPreExportQaOutputSchema, output, "output"),
    ).toThrow(/failures\[0\]\.checkCode/);
  });

  it("rejects an unexpected extra property on a finding", () => {
    const output = cloneOutput();
    (firstFailure(output) as Record<string, unknown>).confidence = 0.9;
    expect(() => assertDeterministicPreExportQaOutput(output)).toThrow(/failures\[0\]\.confidence/);
    expect(() =>
      assertRegistrySchemaValue(deterministicPreExportQaOutputSchema, output, "output"),
    ).toThrow(/failures\[0\]\.confidence/);
  });

  it("rejects an arbitrary object array item in the derived findings array", () => {
    const output = cloneOutput();
    (output as unknown as { findings: unknown[] }).findings = [{ arbitrary: "shape" }];
    expect(() => assertDeterministicPreExportQaOutput(output)).toThrow(/findings\[0\]/);
    expect(() =>
      assertRegistrySchemaValue(deterministicPreExportQaOutputSchema, output, "output"),
    ).toThrow(/findings\[0\]/);
  });

  it("keeps the runtime check-code enum aligned with the schema enum", () => {
    const failuresItem = (
      deterministicPreExportQaOutputSchema.jsonSchema as {
        properties: { failures: { items: { properties: { checkCode: { enum: string[] } } } } };
      }
    ).properties.failures.items.properties.checkCode.enum;
    expect([...failuresItem]).toEqual([...DETERMINISTIC_PRE_EXPORT_QA_CHECK_CODES]);
  });
});
