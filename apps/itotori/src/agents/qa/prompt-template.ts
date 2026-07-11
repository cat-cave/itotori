// ITOTORI-078 — Deterministic prompt template for the QA agent.
//
// Byte-stable across calls: same input → same systemText / userText →
// same promptHash. Recorded bundles are keyed by promptHash by default
// (see RecordedModelProvider), so any drift here invalidates every
// recorded fixture.

import { createHash } from "node:crypto";
import {
  QA_FINDING_CATEGORIES,
  QA_FINDING_SEVERITIES,
  STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
} from "@itotori/localization-bridge-schema";
import type {
  QaBridgeUnit,
  QaGlossaryEntry,
  QaInvocationInput,
  QaStyleGuideRule,
} from "./shapes.js";

export type RenderedQaPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are a localization QA agent.",
  "Read each bridge unit's source text and draft translation, and emit findings against the supplied glossary and style guide.",
  "Each finding MUST cite a bridgeUnitId from the input units block.",
  `Severity MUST be one of: ${QA_FINDING_SEVERITIES.join(", ")}.`,
  `Category MUST be one of: ${QA_FINDING_CATEGORIES.join(", ")}.`,
  "Optional sourceSpan / draftSpan use character offsets (Unicode code units) into the respective text.",
  "evidenceRefs cites glossary term ids, style guide rule ids, or context-artifact ids; never raw quotes.",
  "recommendation is a free-text remediation suggestion; do NOT include rewritten output.",
  "agentRationale explains why you flagged the finding.",
  "Flag any draft whose `draftText` contains a parenthetical translator-note or meta-commentary intended for the reader of the draft (e.g. '(TL note: ...)', '(translator's note: ...)', '(meta-commentary: ...)'); emit such cases as `category: 'other'` findings with `draftSpan` covering the offending parenthetical, and recommend removing the parenthetical.",
  `The schemaVersion field MUST equal EXACTLY the string "${STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION}" — note it is "structured", NOT "structural". Copy it verbatim.`,
  'Emit ONLY the allowed top-level properties: "schemaVersion" and "findings". Do NOT include a "$schema" property, an "$id", a "title", or ANY other top-level key. The embedded schema below is a SPEC to conform to, NOT a template to echo back.',
  'sourceSpan and draftSpan, when present, MUST each be a JSON OBJECT of the exact shape {"start": <int>, "end": <int>} with integer character offsets. NEVER emit a span as an array, a string, or a number.',
  "If you find no issues, emit an empty findings array. Do NOT emit prose or markdown.",
].join("\n");

export function buildQaPrompt(input: QaInvocationInput): RenderedQaPrompt {
  const lines: string[] = [];
  lines.push(`Project source locale: ${input.sourceLocale}`);
  lines.push(`Project target locale: ${input.targetLocale}`);
  lines.push(`Draft job id: ${input.draftJobId}`);
  lines.push(`Prompt-template version: ${input.qaPromptVersion}`);

  lines.push("");
  if (input.glossary.length === 0) {
    lines.push("Glossary: (empty)");
  } else {
    lines.push("Glossary (do not contradict):");
    const sortedGlossary = canonicalizeGlossary(input.glossary);
    for (const entry of sortedGlossary) {
      const target = entry.preferredTargetForm ? ` -> ${entry.preferredTargetForm}` : "";
      const policy = entry.policyAction ? ` [${entry.policyAction}]` : "";
      lines.push(`- ${entry.preferredSourceForm}${target}${policy} (termId=${entry.termId})`);
    }
  }

  lines.push("");
  if (input.styleGuide.length === 0) {
    lines.push("Style guide: (empty)");
  } else {
    lines.push("Style guide:");
    const sortedRules = canonicalizeStyleGuide(input.styleGuide);
    for (const rule of sortedRules) {
      lines.push(`- [${rule.section}] (${rule.ruleId}) ${rule.guidance}`);
    }
  }

  lines.push("");
  lines.push("Units (canonical order):");
  const units = canonicalizeUnits(input.units);
  let index = 1;
  for (const unit of units) {
    const speaker = unit.speaker && unit.speaker.trim().length > 0 ? unit.speaker : "narration";
    lines.push(
      `[#${index}] unitId=${unit.bridgeUnitId} speaker=${speaker}\n  source: ${unit.sourceText}\n  draft : ${unit.draftText}`,
    );
    index += 1;
  }

  lines.push("");
  lines.push("Output schema (JSON):");
  lines.push(JSON.stringify(STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA));

  return { systemText: SYSTEM_INSTRUCTIONS, userText: lines.join("\n") };
}

export function qaPromptHash(prompt: RenderedQaPrompt): string {
  const canonical = `${prompt.systemText}\n␞\n${prompt.userText}`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function canonicalizeUnits(units: ReadonlyArray<QaBridgeUnit>): ReadonlyArray<QaBridgeUnit> {
  return [...units].sort((a, b) => {
    const keyDelta = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return a.bridgeUnitId.localeCompare(b.bridgeUnitId);
  });
}

function canonicalizeGlossary(
  entries: ReadonlyArray<QaGlossaryEntry>,
): ReadonlyArray<QaGlossaryEntry> {
  return [...entries].sort((a, b) => {
    const sourceDelta = a.preferredSourceForm.localeCompare(b.preferredSourceForm);
    if (sourceDelta !== 0) {
      return sourceDelta;
    }
    return a.termId.localeCompare(b.termId);
  });
}

function canonicalizeStyleGuide(
  rules: ReadonlyArray<QaStyleGuideRule>,
): ReadonlyArray<QaStyleGuideRule> {
  return [...rules].sort((a, b) => {
    const sectionDelta = a.section.localeCompare(b.section);
    if (sectionDelta !== 0) {
      return sectionDelta;
    }
    return a.ruleId.localeCompare(b.ruleId);
  });
}
