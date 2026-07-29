// Runtime-evidence tool names, schemas, implementation hashes, and typed IO.

import {
  deriveImplementationHash,
  type JsonObject,
  type RegistrySchemaDescriptor,
  type StableJsonHash,
} from "./types.js";
import type {
  ManagedArtifactRef,
  RuntimeBranchExpectation,
  RuntimeEvidenceFinding,
  RuntimeUnitExpectation,
} from "./shapes.js";

export const RUNTIME_EVIDENCE_TOOL_VERSION = "1.0.0" as const;

export const missingTextToolName = "tool.runtime-evidence.missing-text" as const;
export const wrongBranchToolName = "tool.runtime-evidence.wrong-branch" as const;
export const layoutToolName = "tool.runtime-evidence.layout" as const;
export const mismatchToolName = "tool.runtime-evidence.mismatch" as const;
export const ocrHintsToolName = "tool.runtime-evidence.ocr-hints" as const;

const managedRefJsonSchema = {
  type: "object",
  required: ["artifactId", "artifactKind", "uri"],
  additionalProperties: false,
  properties: {
    artifactId: { type: "string", minLength: 1 },
    artifactKind: { type: "string", minLength: 1 },
    uri: { type: "string", minLength: 1 },
    hash: { type: ["string", "null"] },
  },
};

const citationJsonSchema = {
  type: "object",
  required: ["citationKind", "artifactRef", "observationEventId", "detail"],
  additionalProperties: false,
  properties: {
    citationKind: { enum: ["report", "trace", "branch", "screenshot", "ocr"] },
    artifactRef: managedRefJsonSchema,
    observationEventId: { type: ["string", "null"] },
    detail: { type: "string", minLength: 1 },
  },
};

const findingJsonSchema = {
  type: "object",
  required: [
    "findingId",
    "findingKind",
    "severity",
    "detectorKind",
    "bridgeUnitId",
    "sourceUnitKey",
    "message",
    "expected",
    "observed",
    "evidenceBacking",
    "citations",
  ],
  additionalProperties: false,
  properties: {
    findingId: { type: "string", minLength: 1 },
    findingKind: { enum: ["missing_text", "wrong_branch", "layout", "mismatch", "ocr_hint"] },
    severity: { enum: ["critical", "major", "minor", "info"] },
    detectorKind: { enum: ["deterministic_check", "agent"] },
    bridgeUnitId: { type: ["string", "null"] },
    sourceUnitKey: { type: ["string", "null"] },
    message: { type: "string", minLength: 1 },
    expected: { type: ["string", "null"] },
    observed: { type: ["string", "null"] },
    evidenceBacking: { enum: ["trace", "screenshot", "both"] },
    citations: { type: "array", minItems: 1, items: citationJsonSchema },
  },
};

const unitExpectationJsonSchema = {
  type: "object",
  required: ["bridgeUnitId", "sourceUnitKey"],
  additionalProperties: false,
  properties: {
    bridgeUnitId: { type: "string", minLength: 1 },
    sourceUnitKey: { type: "string", minLength: 1 },
    expectedText: { type: "string" },
  },
};

const branchExpectationJsonSchema = {
  type: "object",
  required: ["branchPointKey", "allowedRouteKeys"],
  additionalProperties: false,
  properties: {
    branchPointKey: { type: "string", minLength: 1 },
    allowedRouteKeys: { type: "array", items: { type: "string", minLength: 1 } },
  },
};

function makeInputSchema(
  schemaId: string,
  description: string,
  extra: JsonObject,
  required: string[],
): RegistrySchemaDescriptor {
  return {
    schemaId,
    schemaVersion: "1.0.0",
    description,
    jsonSchema: {
      type: "object",
      required: ["runtimeReportRef", ...required],
      additionalProperties: false,
      properties: {
        runtimeReportRef: managedRefJsonSchema,
        ...extra,
      },
    },
  };
}

function makeOutputSchema(schemaId: string, outputKind: string): RegistrySchemaDescriptor {
  return {
    schemaId,
    schemaVersion: "1.0.0",
    description: `Runtime-evidence findings (${outputKind}) with managed-artifact-ref citations.`,
    jsonSchema: {
      type: "object",
      required: [
        "outputKind",
        "status",
        "toolName",
        "toolVersion",
        "runtimeReportId",
        "evidenceTier",
        "findings",
        "diagnostics",
      ],
      additionalProperties: false,
      properties: {
        outputKind: { const: outputKind },
        status: { enum: ["completed"] },
        toolName: { type: "string", minLength: 1 },
        toolVersion: { const: RUNTIME_EVIDENCE_TOOL_VERSION },
        runtimeReportId: { type: "string", minLength: 1 },
        evidenceTier: { type: "string", minLength: 1 },
        findings: { type: "array", items: findingJsonSchema },
        diagnostics: { type: "array", items: { type: "object" } },
      },
    },
  };
}

export const missingTextToolInputSchema = makeInputSchema(
  "itotori.tool.runtime-evidence.missing-text.input",
  "Missing-text check request: a runtime report ref + the units that must render.",
  { expectedUnits: { type: "array", items: unitExpectationJsonSchema } },
  ["expectedUnits"],
);
export const missingTextToolOutputSchema = makeOutputSchema(
  "itotori.tool.runtime-evidence.missing-text.output",
  "runtime_evidence_missing_text",
);

export const wrongBranchToolInputSchema = makeInputSchema(
  "itotori.tool.runtime-evidence.wrong-branch.input",
  "Wrong-branch check request: a runtime report ref + the allowed route map.",
  { expectedBranches: { type: "array", items: branchExpectationJsonSchema } },
  ["expectedBranches"],
);
export const wrongBranchToolOutputSchema = makeOutputSchema(
  "itotori.tool.runtime-evidence.wrong-branch.output",
  "runtime_evidence_wrong_branch",
);

export const mismatchToolInputSchema = makeInputSchema(
  "itotori.tool.runtime-evidence.mismatch.input",
  "Mismatch check request: a runtime report ref + the expected translated text per unit.",
  { expectedUnits: { type: "array", items: unitExpectationJsonSchema } },
  ["expectedUnits"],
);
export const mismatchToolOutputSchema = makeOutputSchema(
  "itotori.tool.runtime-evidence.mismatch.output",
  "runtime_evidence_mismatch",
);

export const layoutToolInputSchema = makeInputSchema(
  "itotori.tool.runtime-evidence.layout.input",
  "Layout check request: a runtime report ref (captures + OCR regions read via managed refs).",
  {},
  [],
);
export const layoutToolOutputSchema = makeOutputSchema(
  "itotori.tool.runtime-evidence.layout.output",
  "runtime_evidence_layout",
);

export const ocrHintsToolInputSchema = makeInputSchema(
  "itotori.tool.runtime-evidence.ocr-hints.input",
  "OCR-hints request: a runtime report ref (screenshot captures resolved to OCR regions).",
  {},
  [],
);
export const ocrHintsToolOutputSchema = makeOutputSchema(
  "itotori.tool.runtime-evidence.ocr-hints.output",
  "runtime_evidence_ocr_hint",
);

export const missingTextToolImplementationHash = deriveImplementationHash({
  toolName: missingTextToolName,
  toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  algorithmName: missingTextToolName,
  algorithmVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  inputSchema: missingTextToolInputSchema,
  outputSchema: missingTextToolOutputSchema,
}) satisfies StableJsonHash;

export const wrongBranchToolImplementationHash = deriveImplementationHash({
  toolName: wrongBranchToolName,
  toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  algorithmName: wrongBranchToolName,
  algorithmVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  inputSchema: wrongBranchToolInputSchema,
  outputSchema: wrongBranchToolOutputSchema,
}) satisfies StableJsonHash;

export const layoutToolImplementationHash = deriveImplementationHash({
  toolName: layoutToolName,
  toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  algorithmName: layoutToolName,
  algorithmVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  inputSchema: layoutToolInputSchema,
  outputSchema: layoutToolOutputSchema,
}) satisfies StableJsonHash;

export const mismatchToolImplementationHash = deriveImplementationHash({
  toolName: mismatchToolName,
  toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  algorithmName: mismatchToolName,
  algorithmVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  inputSchema: mismatchToolInputSchema,
  outputSchema: mismatchToolOutputSchema,
}) satisfies StableJsonHash;

export const ocrHintsToolImplementationHash = deriveImplementationHash({
  toolName: ocrHintsToolName,
  toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  algorithmName: ocrHintsToolName,
  algorithmVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
  inputSchema: ocrHintsToolInputSchema,
  outputSchema: ocrHintsToolOutputSchema,
}) satisfies StableJsonHash;

export type RuntimeEvidenceToolOutput = JsonObject & {
  outputKind: string;
  status: "completed";
  toolName: string;
  toolVersion: typeof RUNTIME_EVIDENCE_TOOL_VERSION;
  runtimeReportId: string;
  evidenceTier: string;
  findings: RuntimeEvidenceFinding[];
  diagnostics: JsonObject[];
};

export type MissingTextToolInput = JsonObject & {
  runtimeReportRef: ManagedArtifactRef;
  expectedUnits: RuntimeUnitExpectation[];
};
export type WrongBranchToolInput = JsonObject & {
  runtimeReportRef: ManagedArtifactRef;
  expectedBranches: RuntimeBranchExpectation[];
};
export type MismatchToolInput = JsonObject & {
  runtimeReportRef: ManagedArtifactRef;
  expectedUnits: RuntimeUnitExpectation[];
};
export type LayoutToolInput = JsonObject & { runtimeReportRef: ManagedArtifactRef };
export type OcrHintsToolInput = JsonObject & { runtimeReportRef: ManagedArtifactRef };
