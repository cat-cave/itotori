import { describe, expect, it } from "vitest";
import {
  assertStructuredQaFindingOutput,
  parseStructuredQaFindingOutput,
  QA_FINDING_CATEGORIES,
  QA_FINDING_SEVERITIES,
  QaResponseValidationError,
  STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
} from "../src/qa-finding.js";

function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findingId: "019ed079-0000-7000-8000-100000000001",
    bridgeUnitId: "019ed079-0000-7000-8000-00000000a001",
    severity: "critical",
    category: "protected-span-violation",
    sourceSpan: { start: 6, end: 14 },
    draftSpan: { start: 5, end: 13 },
    evidenceRefs: ["style-guide:protectedSpans"],
    recommendation: "Restore the placeholder.",
    agentRationale: "Source includes {player}; draft drops it.",
    ...overrides,
  };
}

function validOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [validFinding()],
    ...overrides,
  };
}

describe("StructuredQaFindingOutput", () => {
  it("accepts a fully-populated finding", () => {
    expect(() => assertStructuredQaFindingOutput(validOutput())).not.toThrow();
  });

  it("accepts an empty findings array", () => {
    expect(() =>
      assertStructuredQaFindingOutput({
        schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
        findings: [],
      }),
    ).not.toThrow();
  });

  it("rejects an output without schemaVersion", () => {
    expect(() => assertStructuredQaFindingOutput({ findings: [] })).toThrow(
      QaResponseValidationError,
    );
  });

  it("rejects an output with the wrong schemaVersion", () => {
    expect(() => assertStructuredQaFindingOutput({ schemaVersion: "v0", findings: [] })).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects findings missing a required field", () => {
    const value = validOutput({
      findings: [validFinding({ recommendation: undefined })],
    });
    // Remove the explicit undefined so JSON-shape lookup misses the key.
    const finding = (value.findings as Array<Record<string, unknown>>)[0]!;
    delete finding.recommendation;
    expect(() => assertStructuredQaFindingOutput(value)).toThrow(/recommendation/);
  });

  it("rejects unknown top-level properties", () => {
    expect(() =>
      assertStructuredQaFindingOutput({
        schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
        findings: [],
        confidence: 0.5,
      }),
    ).toThrow(/confidence/);
  });

  it("rejects unknown finding-level properties", () => {
    expect(() =>
      assertStructuredQaFindingOutput(
        validOutput({ findings: [validFinding({ confidenceScore: 0.5 })] }),
      ),
    ).toThrow(/confidenceScore/);
  });

  it("rejects every invalid severity", () => {
    expect(() =>
      assertStructuredQaFindingOutput(
        validOutput({ findings: [validFinding({ severity: "blocker" })] }),
      ),
    ).toThrow(/severity/);
  });

  it("rejects every invalid category", () => {
    expect(() =>
      assertStructuredQaFindingOutput(
        validOutput({ findings: [validFinding({ category: "vibes" })] }),
      ),
    ).toThrow(/category/);
  });

  it("rejects spans whose end is before start", () => {
    expect(() =>
      assertStructuredQaFindingOutput(
        validOutput({
          findings: [validFinding({ sourceSpan: { start: 10, end: 5 } })],
        }),
      ),
    ).toThrow(/spanOrder/);
  });

  it("parseStructuredQaFindingOutput surfaces a JSON parse error as QaResponseValidationError", () => {
    expect(() => parseStructuredQaFindingOutput("not-json")).toThrow(QaResponseValidationError);
  });

  it("coerces JSON-schema metadata, the known version typo, and two-integer spans", () => {
    const parsed = parseStructuredQaFindingOutput(
      JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "itotori://fixture",
        title: "StructuredQaFindingOutput",
        schemaVersion: "itotori.structural-qa-finding-output.v1",
        findings: [
          validFinding({
            sourceSpan: [2, 5],
            draftSpan: [0, 0],
          }),
        ],
      }),
    );

    expect(parsed.schemaVersion).toBe(STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION);
    expect(parsed.findings[0]?.sourceSpan).toEqual({ start: 2, end: 5 });
    expect(parsed.findings[0]?.draftSpan).toEqual({ start: 0, end: 0 });
  });

  it("does not coerce unknown keys or ambiguous span values", () => {
    expect(() =>
      parseStructuredQaFindingOutput(JSON.stringify(validOutput({ unexpected: true }))),
    ).toThrow(/unexpected/);

    expect(() =>
      parseStructuredQaFindingOutput(
        JSON.stringify(validOutput({ findings: [validFinding({ sourceSpan: "2,5" })] })),
      ),
    ).toThrow(/sourceSpan/);
  });

  it("severity and category enums match the JSON schema constants", () => {
    const severityEnum = (
      STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA.properties.findings.items.properties.severity as {
        enum: ReadonlyArray<string>;
      }
    ).enum;
    expect([...severityEnum]).toEqual([...QA_FINDING_SEVERITIES]);
    const categoryEnum = (
      STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA.properties.findings.items.properties.category as {
        enum: ReadonlyArray<string>;
      }
    ).enum;
    expect([...categoryEnum]).toEqual([...QA_FINDING_CATEGORIES]);
  });
});
