// Runtime-evidence inspection-tool façade.
//
// This stable entrypoint exports the public contracts and pure detectors while
// binding the five deterministic tools to a managed artifact store.

import type { RuntimeEvidenceReportV02 } from "@itotori/localization-bridge-schema";
import type { RuntimeEvidenceArtifactStore } from "./artifact-store.js";
import {
  layoutToolImplementationHash,
  layoutToolInputSchema,
  layoutToolName,
  layoutToolOutputSchema,
  mismatchToolImplementationHash,
  mismatchToolInputSchema,
  mismatchToolName,
  mismatchToolOutputSchema,
  missingTextToolImplementationHash,
  missingTextToolInputSchema,
  missingTextToolName,
  missingTextToolOutputSchema,
  ocrHintsToolImplementationHash,
  ocrHintsToolInputSchema,
  ocrHintsToolName,
  ocrHintsToolOutputSchema,
  RUNTIME_EVIDENCE_TOOL_VERSION,
  wrongBranchToolImplementationHash,
  wrongBranchToolInputSchema,
  wrongBranchToolName,
  wrongBranchToolOutputSchema,
  type LayoutToolInput,
  type MismatchToolInput,
  type MissingTextToolInput,
  type OcrHintsToolInput,
  type RuntimeEvidenceToolOutput,
  type WrongBranchToolInput,
} from "./tools-contract.js";
import {
  collectOcrHints,
  detectLayout,
  detectMismatch,
  detectMissingText,
  detectWrongBranch,
} from "./tools-detectors.js";
import {
  RuntimeEvidenceArtifactUnresolvedError,
  type ManagedArtifactRef,
  type RuntimeEvidenceFinding,
} from "./shapes.js";
import type { DeterministicToolDefinition, StableJsonHash } from "./types.js";

export {
  layoutToolImplementationHash,
  layoutToolInputSchema,
  layoutToolName,
  layoutToolOutputSchema,
  mismatchToolImplementationHash,
  mismatchToolInputSchema,
  mismatchToolName,
  mismatchToolOutputSchema,
  missingTextToolImplementationHash,
  missingTextToolInputSchema,
  missingTextToolName,
  missingTextToolOutputSchema,
  ocrHintsToolImplementationHash,
  ocrHintsToolInputSchema,
  ocrHintsToolName,
  ocrHintsToolOutputSchema,
  RUNTIME_EVIDENCE_TOOL_VERSION,
  wrongBranchToolImplementationHash,
  wrongBranchToolInputSchema,
  wrongBranchToolName,
  wrongBranchToolOutputSchema,
};
export type {
  LayoutToolInput,
  MismatchToolInput,
  MissingTextToolInput,
  OcrHintsToolInput,
  RuntimeEvidenceToolOutput,
  WrongBranchToolInput,
};
export {
  collectOcrHints,
  detectLayout,
  detectMismatch,
  detectMissingText,
  detectWrongBranch,
};

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

function makeOutput(
  toolName: string,
  outputKind: string,
  report: RuntimeEvidenceReportV02,
  findings: RuntimeEvidenceFinding[],
  diagnostics: RuntimeEvidenceToolOutput["diagnostics"],
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
