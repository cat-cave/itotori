// UTSUSHI-011 — Runtime-evidence QA agent prompt.
//
// The agent NEVER opens a raw artifact. It is told the managed refs it may
// inspect and the five tools it may call; it requests evidence through those
// tools and returns findings that cite the managed refs the tools surfaced.
// The deterministic checks (deterministic-checks.ts) have already caught the
// unambiguous findings and are handed to the agent as prior context so it
// concentrates on the residual ambiguity a model is actually needed for:
// semantic paraphrase vs. mistranslation, aesthetic-but-in-bounds layout, and
// OCR-hint interpretation.
//
// Byte-stable: same input → same systemText/userText → same promptHash, so a
// recorded provider bundle stays keyed. Tests exercise the tools + the
// deterministic path; this prompt is defined and hash-pinned but no live model
// call is made in tests.

import { createHash } from "node:crypto";
import type { Bcp47Locale } from "@itotori/localization-bridge-schema";
import {
  layoutToolName,
  missingTextToolName,
  mismatchToolName,
  ocrHintsToolName,
  wrongBranchToolName,
} from "./tools.js";
import type { ManagedArtifactRef, RuntimeEvidenceFinding } from "./shapes.js";

export const RUNTIME_EVIDENCE_QA_PROMPT_VERSION = "utsushi-runtime-evidence-qa-v1" as const;

/** The tool surface the agent may call — names + one-line contracts. */
export const RUNTIME_EVIDENCE_QA_TOOL_MANIFEST: ReadonlyArray<{ name: string; contract: string }> =
  [
    {
      name: missingTextToolName,
      contract: "list bridge units that produced no observed runtime text (trace-only).",
    },
    {
      name: wrongBranchToolName,
      contract: "list branches whose selected route violates the expected route map.",
    },
    {
      name: layoutToolName,
      contract: "list rendered elements / OCR regions that overflow the frame (screenshot-backed).",
    },
    {
      name: mismatchToolName,
      contract: "list observed runtime text that differs from the expected translation.",
    },
    {
      name: ocrHintsToolName,
      contract: "read OCR text-region hints lifted from the screenshot captures.",
    },
  ];

export type RuntimeEvidenceQaPromptInput = {
  runtimeReportRef: ManagedArtifactRef;
  runtimeReportId: string;
  evidenceTier: string;
  sourceLocale?: Bcp47Locale;
  targetLocale?: Bcp47Locale;
  /** Findings the deterministic checks already produced, handed to the agent. */
  deterministicFindings: ReadonlyArray<RuntimeEvidenceFinding>;
};

export type RenderedRuntimeEvidenceQaPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are an Utsushi runtime-evidence QA agent.",
  "You inspect launched-runtime evidence (observation events, screenshot captures) ONLY through the provided tools — never a raw file.",
  "Call the tools to gather evidence, then emit findings for the AMBIGUOUS cases the deterministic checks could not settle:",
  "  - mismatch: observed text is a semantic paraphrase vs. a genuine mistranslation.",
  "  - layout: text that fits the frame but is cramped, clipped by a glyph, or wrapped badly.",
  "  - ocr_hint: whether recognised OCR text reads as the intended translation.",
  "Do NOT re-report a finding the deterministic checks already emitted; add only what a model is needed for.",
  "Every finding MUST cite at least one managed artifact ref returned by a tool (trace, screenshot, or both).",
  "Set evidenceBacking to 'trace', 'screenshot', or 'both' to match the refs you cite.",
  "Emit ONLY a JSON object { findings: RuntimeEvidenceFinding[] }; no prose, no markdown.",
].join("\n");

export function buildRuntimeEvidenceQaPrompt(
  input: RuntimeEvidenceQaPromptInput,
): RenderedRuntimeEvidenceQaPrompt {
  const lines: string[] = [];
  lines.push(`Runtime report id: ${input.runtimeReportId}`);
  lines.push(`Evidence tier: ${input.evidenceTier}`);
  lines.push(`Source locale: ${input.sourceLocale ?? "(unspecified)"}`);
  lines.push(`Target locale: ${input.targetLocale ?? "(unspecified)"}`);
  lines.push(
    `Managed runtime report ref: ${input.runtimeReportRef.artifactKind}:${input.runtimeReportRef.artifactId} (${input.runtimeReportRef.uri})`,
  );

  lines.push("");
  lines.push("Tools you may call (request evidence through these — do NOT read files):");
  for (const tool of RUNTIME_EVIDENCE_QA_TOOL_MANIFEST) {
    lines.push(`- ${tool.name}: ${tool.contract}`);
  }

  lines.push("");
  if (input.deterministicFindings.length === 0) {
    lines.push("Deterministic checks emitted no findings.");
  } else {
    lines.push("Deterministic checks already emitted these findings (do NOT duplicate):");
    for (const finding of canonicalizeFindings(input.deterministicFindings)) {
      lines.push(
        `- [${finding.findingKind}/${finding.severity}] ${finding.sourceUnitKey ?? finding.bridgeUnitId ?? "(scene)"}: ${finding.message} (backing=${finding.evidenceBacking})`,
      );
    }
  }

  return { systemText: SYSTEM_INSTRUCTIONS, userText: lines.join("\n") };
}

export function runtimeEvidenceQaPromptHash(prompt: RenderedRuntimeEvidenceQaPrompt): string {
  const canonical = `${prompt.systemText}\n␞\n${prompt.userText}`;
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalizeFindings(
  findings: ReadonlyArray<RuntimeEvidenceFinding>,
): ReadonlyArray<RuntimeEvidenceFinding> {
  return [...findings].sort((a, b) => a.findingId.localeCompare(b.findingId));
}
