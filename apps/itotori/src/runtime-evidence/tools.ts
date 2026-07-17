// UTSUSHI-011 — Runtime-evidence inspection tools.
//
// Five deterministic tools a QA agent calls to INSPECT runtime evidence. Each
// reads MANAGED ARTIFACT REFS through the `RuntimeEvidenceArtifactStore` (never
// a raw file) and emits `RuntimeEvidenceFinding`s that CITE the managed refs
// they read (trace-only, screenshot-backed, or both):
//
//   tool.runtime-evidence.missing-text  — expected unit produced no runtime text
//   tool.runtime-evidence.wrong-branch  — branch took a route the map forbids
//   tool.runtime-evidence.layout        — rendered element / OCR region overflow
//   tool.runtime-evidence.mismatch      — observed text != expected translation
//   tool.runtime-evidence.ocr-hints     — OCR text-region hints from screenshots
//
// The unambiguous kinds (missing-text, wrong-branch, exact mismatch, geometric
// overflow) are fully deterministic and run WITHOUT the LLM (see
// deterministic-checks.ts). `ocr-hints` is informational for the agent.

import { createHash } from "node:crypto";
import type {
  RuntimeBranchPointEventV02,
  RuntimeCaptureV02,
  RuntimeEvidenceReportV02,
} from "@itotori/localization-bridge-schema";
import {
  deriveImplementationHash,
  type DeterministicToolDefinition,
  type JsonObject,
  type RegistrySchemaDescriptor,
  type StableJsonHash,
} from "./types.js";
import type { RuntimeEvidenceArtifactStore } from "./artifact-store.js";
import {
  RuntimeEvidenceArtifactUnresolvedError,
  type ManagedArtifactRef,
  type RuntimeBranchExpectation,
  type RuntimeEvidenceBacking,
  type RuntimeEvidenceCitation,
  type RuntimeEvidenceFinding,
  type RuntimeEvidenceFindingKind,
  type RuntimeEvidenceSeverity,
  type RuntimeUnitExpectation,
  type ScreenshotOcrArtifact,
} from "./shapes.js";

export const RUNTIME_EVIDENCE_TOOL_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const missingTextToolName = "tool.runtime-evidence.missing-text" as const;
export const wrongBranchToolName = "tool.runtime-evidence.wrong-branch" as const;
export const layoutToolName = "tool.runtime-evidence.layout" as const;
export const mismatchToolName = "tool.runtime-evidence.mismatch" as const;
export const ocrHintsToolName = "tool.runtime-evidence.ocr-hints" as const;

// ---------------------------------------------------------------------------
// Shared JSON Schemas
// ---------------------------------------------------------------------------

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

// Exported schemas (per tool).
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

// ---------------------------------------------------------------------------
// Implementation hashes — derived from canonical versioned artifacts
// (tool name/version, algorithm name/version, input/output schemas) so the
// hash is grounded in the implementation contract, not asserted metadata.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Typed IO
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveReport(
  store: RuntimeEvidenceArtifactStore,
  ref: ManagedArtifactRef,
): RuntimeEvidenceReportV02 {
  const report = store.resolveRuntimeReport(ref);
  if (report === null) {
    throw new RuntimeEvidenceArtifactUnresolvedError(ref.artifactId, ref.artifactKind);
  }
  return report;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function findingId(kind: string, reportId: string, key: string): string {
  const suffix = createHash("sha256")
    .update(`${kind}:${reportId}:${key}`)
    .digest("hex")
    .slice(0, 12);
  return `019ed0aa-0000-7000-8000-${suffix}`;
}

/** The runtime report is itself a managed artifact; cite it as trace/branch. */
function reportCitation(
  reportRef: ManagedArtifactRef,
  citationKind: "report" | "trace" | "branch",
  observationEventId: string | null,
  detail: string,
): RuntimeEvidenceCitation {
  return { citationKind, artifactRef: reportRef, observationEventId, detail };
}

function screenshotCitation(capture: RuntimeCaptureV02, detail: string): RuntimeEvidenceCitation {
  return {
    citationKind: "screenshot",
    artifactRef: {
      artifactId: capture.artifactRef.artifactId,
      artifactKind: capture.artifactRef.artifactKind,
      uri: capture.artifactRef.uri,
      hash: capture.artifactRef.hash ?? null,
    },
    observationEventId: capture.captureId,
    detail,
  };
}

function ocrCitation(
  ocr: ScreenshotOcrArtifact,
  regionId: string,
  detail: string,
): RuntimeEvidenceCitation {
  return {
    citationKind: "ocr",
    artifactRef: {
      artifactId: ocr.artifactId,
      artifactKind: "capture_metadata",
      uri: `artifacts/utsushi/ocr/${ocr.artifactId}.json`,
      hash: null,
    },
    observationEventId: regionId,
    detail,
  };
}

/** Observed text (with the trace event id) for a unit, from trace + hook streams. */
function observedTextForUnit(
  report: RuntimeEvidenceReportV02,
  bridgeUnitId: string,
): { text: string; traceEventId: string } | null {
  for (const event of report.traceEvents) {
    if (
      event.eventKind === "text_observed" &&
      event.bridgeUnitRef.bridgeUnitId === bridgeUnitId &&
      typeof event.observedText === "string" &&
      event.observedText.length > 0
    ) {
      return { text: event.observedText, traceEventId: event.traceEventId };
    }
  }
  for (const hook of report.observationHookEvents ?? []) {
    if (hook.payload.payloadKind !== "text") {
      continue;
    }
    const cites = (hook.bridgeRefs ?? []).some((ref) => ref.bridgeUnitId === bridgeUnitId);
    if (cites && hook.payload.text.length > 0) {
      return { text: hook.payload.text, traceEventId: hook.eventId };
    }
  }
  return null;
}

function captureForUnit(
  report: RuntimeEvidenceReportV02,
  bridgeUnitId: string,
): RuntimeCaptureV02 | null {
  return (
    report.captures.find((capture) => capture.bridgeUnitRef.bridgeUnitId === bridgeUnitId) ?? null
  );
}

function branchSelectedRouteKey(branch: RuntimeBranchPointEventV02): string | null {
  if (branch.selectedOptionId === undefined) {
    return null;
  }
  const option = branch.options.find((opt) => opt.optionId === branch.selectedOptionId);
  return option?.targetRouteKey ?? null;
}

function makeOutput(
  toolName: string,
  outputKind: string,
  report: RuntimeEvidenceReportV02,
  findings: RuntimeEvidenceFinding[],
  diagnostics: JsonObject[],
): RuntimeEvidenceToolOutput {
  return {
    outputKind,
    status: "completed",
    toolName,
    toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
    runtimeReportId: report.runtimeReportId,
    evidenceTier: report.evidenceTier,
    findings,
    diagnostics,
  };
}

function severityToJson(severity: RuntimeEvidenceSeverity): RuntimeEvidenceSeverity {
  return severity;
}

// ---------------------------------------------------------------------------
// Detectors (pure — the deterministic core the tools and checks share)
// ---------------------------------------------------------------------------

export function detectMissingText(
  report: RuntimeEvidenceReportV02,
  reportRef: ManagedArtifactRef,
  expectedUnits: ReadonlyArray<RuntimeUnitExpectation>,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const unit of expectedUnits) {
    const observed = observedTextForUnit(report, unit.bridgeUnitId);
    if (observed !== null) {
      continue;
    }
    findings.push({
      findingId: findingId("missing_text", report.runtimeReportId, unit.bridgeUnitId),
      findingKind: "missing_text" satisfies RuntimeEvidenceFindingKind,
      severity: severityToJson("major"),
      detectorKind: "deterministic_check",
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      message: `Bridge unit ${unit.sourceUnitKey} was expected to render but produced no observed runtime text.`,
      expected: "observed runtime text for this unit",
      observed: null,
      evidenceBacking: "trace" satisfies RuntimeEvidenceBacking,
      citations: [
        reportCitation(
          reportRef,
          "trace",
          null,
          `no text_observed trace event or text observation hook references bridge unit ${unit.bridgeUnitId} in report ${report.runtimeReportId}`,
        ),
      ],
    });
  }
  return findings;
}

export function detectWrongBranch(
  report: RuntimeEvidenceReportV02,
  reportRef: ManagedArtifactRef,
  expectedBranches: ReadonlyArray<RuntimeBranchExpectation>,
): RuntimeEvidenceFinding[] {
  const byKey = new Map<string, RuntimeBranchExpectation>();
  for (const branch of expectedBranches) {
    byKey.set(branch.branchPointKey, branch);
  }
  const findings: RuntimeEvidenceFinding[] = [];
  for (const branch of report.branchEvents) {
    const key = branch.branchPointKey;
    if (key === undefined) {
      continue;
    }
    const expectation = byKey.get(key);
    if (expectation === undefined) {
      continue;
    }
    const selectedRoute = branchSelectedRouteKey(branch);
    if (selectedRoute === null || expectation.allowedRouteKeys.includes(selectedRoute)) {
      continue;
    }
    const capture = captureForUnit(report, branch.bridgeUnitRef.bridgeUnitId);
    const citations: RuntimeEvidenceCitation[] = [
      reportCitation(
        reportRef,
        "branch",
        branch.branchEventId,
        `branch ${key} selected option resolved to route '${selectedRoute}', not in allowed [${expectation.allowedRouteKeys.join(", ")}]`,
      ),
    ];
    let backing: RuntimeEvidenceBacking = "trace";
    if (capture !== null) {
      citations.push(
        screenshotCitation(capture, `frame ${capture.frame} captured at branch ${key}`),
      );
      backing = "both";
    }
    findings.push({
      findingId: findingId("wrong_branch", report.runtimeReportId, key),
      findingKind: "wrong_branch",
      severity: severityToJson("major"),
      detectorKind: "deterministic_check",
      bridgeUnitId: branch.bridgeUnitRef.bridgeUnitId,
      sourceUnitKey: branch.bridgeUnitRef.sourceUnitKey ?? null,
      message: `Branch ${key} took route '${selectedRoute}', which the expected route map forbids.`,
      expected: `one of [${expectation.allowedRouteKeys.join(", ")}]`,
      observed: selectedRoute,
      evidenceBacking: backing,
      citations,
    });
  }
  return findings;
}

export function detectMismatch(
  report: RuntimeEvidenceReportV02,
  reportRef: ManagedArtifactRef,
  expectedUnits: ReadonlyArray<RuntimeUnitExpectation>,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const unit of expectedUnits) {
    if (unit.expectedText === undefined) {
      continue;
    }
    const observed = observedTextForUnit(report, unit.bridgeUnitId);
    if (observed === null) {
      // Absence is the missing-text tool's concern, not a mismatch.
      continue;
    }
    if (normalizeText(observed.text) === normalizeText(unit.expectedText)) {
      continue;
    }
    const capture = captureForUnit(report, unit.bridgeUnitId);
    const citations: RuntimeEvidenceCitation[] = [
      reportCitation(
        reportRef,
        "trace",
        observed.traceEventId,
        `observed runtime text for ${unit.sourceUnitKey} differs from the expected translation`,
      ),
    ];
    let backing: RuntimeEvidenceBacking = "trace";
    if (capture !== null) {
      citations.push(
        screenshotCitation(
          capture,
          `screenshot of ${unit.sourceUnitKey} at frame ${capture.frame}`,
        ),
      );
      backing = "both";
    }
    findings.push({
      findingId: findingId("mismatch", report.runtimeReportId, unit.bridgeUnitId),
      findingKind: "mismatch",
      severity: severityToJson("major"),
      detectorKind: "deterministic_check",
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      message: `Observed runtime text for ${unit.sourceUnitKey} does not match the expected translation.`,
      expected: unit.expectedText,
      observed: observed.text,
      evidenceBacking: backing,
      citations,
    });
  }
  return findings;
}

export function detectLayout(
  report: RuntimeEvidenceReportV02,
  store: RuntimeEvidenceArtifactStore,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const capture of report.captures) {
    const captureRef = managedRefFromCapture(capture);
    // 1) Capture region overflow (element rendered past frame bounds).
    if (capture.region !== undefined) {
      const r = capture.region;
      if (r.x + r.width > capture.width || r.y + r.height > capture.height) {
        findings.push({
          findingId: findingId("layout_region", report.runtimeReportId, capture.captureId),
          findingKind: "layout",
          severity: severityToJson("major"),
          detectorKind: "deterministic_check",
          bridgeUnitId: capture.bridgeUnitRef.bridgeUnitId,
          sourceUnitKey: capture.bridgeUnitRef.sourceUnitKey ?? null,
          message: `Rendered region for ${capture.bridgeUnitRef.sourceUnitKey ?? capture.bridgeUnitRef.bridgeUnitId} overflows the ${capture.width}x${capture.height} frame.`,
          expected: `region within ${capture.width}x${capture.height}`,
          observed: `region ${r.x},${r.y} ${r.width}x${r.height}`,
          evidenceBacking: "screenshot",
          citations: [screenshotCitation(capture, `overflowing region on frame ${capture.frame}`)],
        });
      }
    }
    // 2) OCR region overflow (recognised text extends past the frame).
    const ocr = store.resolveScreenshotOcr(captureRef);
    if (ocr === null) {
      continue;
    }
    for (const region of ocr.regions) {
      if (
        region.x + region.width <= ocr.frameWidth &&
        region.y + region.height <= ocr.frameHeight
      ) {
        continue;
      }
      findings.push({
        findingId: findingId(
          "layout_ocr",
          report.runtimeReportId,
          `${capture.captureId}:${region.regionId}`,
        ),
        findingKind: "layout",
        severity: severityToJson("minor"),
        detectorKind: "deterministic_check",
        bridgeUnitId: region.bridgeUnitId,
        sourceUnitKey: capture.bridgeUnitRef.sourceUnitKey ?? null,
        message: `OCR text region "${region.recognizedText}" overflows the ${ocr.frameWidth}x${ocr.frameHeight} frame.`,
        expected: `text region within ${ocr.frameWidth}x${ocr.frameHeight}`,
        observed: `region ${region.x},${region.y} ${region.width}x${region.height}`,
        evidenceBacking: "screenshot",
        citations: [
          screenshotCitation(capture, `screenshot backing OCR region ${region.regionId}`),
          ocrCitation(ocr, region.regionId, `OCR region overflows frame`),
        ],
      });
    }
  }
  return findings;
}

export function collectOcrHints(
  report: RuntimeEvidenceReportV02,
  store: RuntimeEvidenceArtifactStore,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const capture of report.captures) {
    const ocr = store.resolveScreenshotOcr(managedRefFromCapture(capture));
    if (ocr === null) {
      continue;
    }
    for (const region of ocr.regions) {
      findings.push({
        findingId: findingId(
          "ocr_hint",
          report.runtimeReportId,
          `${capture.captureId}:${region.regionId}`,
        ),
        findingKind: "ocr_hint",
        severity: severityToJson("info"),
        detectorKind: "deterministic_check",
        bridgeUnitId: region.bridgeUnitId,
        sourceUnitKey: capture.bridgeUnitRef.sourceUnitKey ?? null,
        message: `OCR recognised "${region.recognizedText}" in region ${region.x},${region.y} ${region.width}x${region.height}.`,
        expected: null,
        observed: region.recognizedText,
        evidenceBacking: "screenshot",
        citations: [
          screenshotCitation(capture, `screenshot the OCR hint was lifted from`),
          ocrCitation(ocr, region.regionId, `OCR text-region hint`),
        ],
      });
    }
  }
  return findings;
}

function managedRefFromCapture(capture: RuntimeCaptureV02): ManagedArtifactRef {
  return {
    artifactId: capture.artifactRef.artifactId,
    artifactKind: capture.artifactRef.artifactKind,
    uri: capture.artifactRef.uri,
    hash: capture.artifactRef.hash ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function reproducibility(algorithmName: string, implementationHash: StableJsonHash) {
  return {
    algorithmName,
    algorithmVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
    implementationHash,
    inputHashAlgorithm: "sha256-stable-json-v1" as const,
    outputHashAlgorithm: "sha256-stable-json-v1" as const,
    sideEffectFree: true as const,
  };
}

export function missingTextTool(
  store: RuntimeEvidenceArtifactStore,
): DeterministicToolDefinition<MissingTextToolInput, RuntimeEvidenceToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: missingTextToolName,
    toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
    description: "Flags expected bridge units that produced no observed runtime text (trace-only).",
    taskKind: "runtime_verify",
    capabilityKey: missingTextToolName,
    inputSchema: missingTextToolInputSchema,
    outputSchema: missingTextToolOutputSchema,
    reproducibility: reproducibility(missingTextToolName, missingTextToolImplementationHash),
    run: (input) => {
      const report = resolveReport(store, input.runtimeReportRef);
      const findings = detectMissingText(report, input.runtimeReportRef, input.expectedUnits);
      return makeOutput(missingTextToolName, "runtime_evidence_missing_text", report, findings, []);
    },
  };
}

export function wrongBranchTool(
  store: RuntimeEvidenceArtifactStore,
): DeterministicToolDefinition<WrongBranchToolInput, RuntimeEvidenceToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: wrongBranchToolName,
    toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
    description:
      "Flags branches whose selected route violates the expected route map (trace/both).",
    taskKind: "runtime_verify",
    capabilityKey: wrongBranchToolName,
    inputSchema: wrongBranchToolInputSchema,
    outputSchema: wrongBranchToolOutputSchema,
    reproducibility: reproducibility(wrongBranchToolName, wrongBranchToolImplementationHash),
    run: (input) => {
      const report = resolveReport(store, input.runtimeReportRef);
      const findings = detectWrongBranch(report, input.runtimeReportRef, input.expectedBranches);
      return makeOutput(wrongBranchToolName, "runtime_evidence_wrong_branch", report, findings, []);
    },
  };
}

export function mismatchTool(
  store: RuntimeEvidenceArtifactStore,
): DeterministicToolDefinition<MismatchToolInput, RuntimeEvidenceToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: mismatchToolName,
    toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
    description:
      "Flags observed runtime text that differs from the expected translation (trace/both).",
    taskKind: "runtime_verify",
    capabilityKey: mismatchToolName,
    inputSchema: mismatchToolInputSchema,
    outputSchema: mismatchToolOutputSchema,
    reproducibility: reproducibility(mismatchToolName, mismatchToolImplementationHash),
    run: (input) => {
      const report = resolveReport(store, input.runtimeReportRef);
      const findings = detectMismatch(report, input.runtimeReportRef, input.expectedUnits);
      return makeOutput(mismatchToolName, "runtime_evidence_mismatch", report, findings, []);
    },
  };
}

export function layoutTool(
  store: RuntimeEvidenceArtifactStore,
): DeterministicToolDefinition<LayoutToolInput, RuntimeEvidenceToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: layoutToolName,
    toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
    description: "Flags rendered elements / OCR regions overflowing the frame (screenshot-backed).",
    taskKind: "runtime_verify",
    capabilityKey: layoutToolName,
    inputSchema: layoutToolInputSchema,
    outputSchema: layoutToolOutputSchema,
    reproducibility: reproducibility(layoutToolName, layoutToolImplementationHash),
    run: (input) => {
      const report = resolveReport(store, input.runtimeReportRef);
      const findings = detectLayout(report, store);
      return makeOutput(layoutToolName, "runtime_evidence_layout", report, findings, []);
    },
  };
}

export function ocrHintsTool(
  store: RuntimeEvidenceArtifactStore,
): DeterministicToolDefinition<OcrHintsToolInput, RuntimeEvidenceToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: ocrHintsToolName,
    toolVersion: RUNTIME_EVIDENCE_TOOL_VERSION,
    description:
      "Returns OCR text-region hints lifted from screenshot captures (screenshot-backed).",
    taskKind: "runtime_verify",
    capabilityKey: ocrHintsToolName,
    inputSchema: ocrHintsToolInputSchema,
    outputSchema: ocrHintsToolOutputSchema,
    reproducibility: reproducibility(ocrHintsToolName, ocrHintsToolImplementationHash),
    run: (input) => {
      const report = resolveReport(store, input.runtimeReportRef);
      const findings = collectOcrHints(report, store);
      return makeOutput(ocrHintsToolName, "runtime_evidence_ocr_hint", report, findings, []);
    },
  };
}

/** Build all five runtime-evidence tools bound to one managed store. */
export function makeRuntimeEvidenceTools(store: RuntimeEvidenceArtifactStore) {
  return {
    missingText: missingTextTool(store),
    wrongBranch: wrongBranchTool(store),
    mismatch: mismatchTool(store),
    layout: layoutTool(store),
    ocrHints: ocrHintsTool(store),
  };
}
