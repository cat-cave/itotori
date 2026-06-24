// ITOTORI-075 — Deterministic prompt template for the translation agent.
//
// Byte-stable across calls: same input → same systemText / userText →
// same promptHash. Recorded bundles are keyed by promptHash by default
// (see RecordedModelProvider), so any drift here invalidates every
// recorded fixture.

import { createHash } from "node:crypto";
import {
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  TRANSLATION_DRAFT_CONFIDENCE_FLOORS,
} from "@itotori/localization-bridge-schema";
import type {
  TranslationBridgeUnit,
  TranslationGlossaryEntry,
  TranslationInvocationInput,
  TranslationProtectedSpanInput,
  TranslationStyleGuideRule,
} from "./shapes.js";

export type RenderedTranslationPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are a localization translation agent.",
  "For each source bridge unit, produce a target-language draft that preserves every protected span byte-equal.",
  "Each draft MUST cite a bridgeUnitId from the input units block.",
  "draftText is the target-language rendering; protectedSpanRefs maps every input protected span (by refId) to its (startInDraft, endInDraft) range in draftText.",
  "Every protected span listed for a bridge unit in the input catalog MUST appear in protectedSpanRefs; missing or duplicated refs are rejected by the validator.",
  "citationRefs cites glossary term ids or context-artifact ids you consulted; never raw quotes.",
  "agentRationale explains the translation choices and any policy applications.",
  `confidenceFloor MUST be one of: ${TRANSLATION_DRAFT_CONFIDENCE_FLOORS.join(", ")}.`,
  `Emit ONLY a JSON object that conforms to the schema with schemaVersion '${STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION}'.`,
  "Do NOT emit prose, markdown, or trailing commas. RFC 8259 JSON only.",
].join("\n");

export function buildTranslationPrompt(
  input: TranslationInvocationInput,
): RenderedTranslationPrompt {
  const lines: string[] = [];
  lines.push(`Project source locale: ${input.sourceLocale}`);
  lines.push(`Project target locale: ${input.targetLocale}`);
  lines.push(`Draft job id: ${input.draftJobId}`);
  lines.push(`Draft job attempt id: ${input.draftJobAttemptId}`);
  lines.push(`Prompt-template version: ${input.promptTemplateVersion}`);

  lines.push("");
  if (input.glossary.length === 0) {
    lines.push("Glossary: (empty)");
  } else {
    lines.push("Glossary (apply preferred target forms):");
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
  const contextArtifacts = input.contextArtifactRefs ?? [];
  if (contextArtifacts.length === 0) {
    lines.push("Context artifacts: (empty)");
  } else {
    lines.push("Context artifacts available for citation:");
    for (const ref of [...contextArtifacts].sort()) {
      lines.push(`- ${ref}`);
    }
  }

  lines.push("");
  lines.push("Units (canonical order):");
  const units = canonicalizeUnits(input.sourceBridgeUnits);
  let index = 1;
  for (const unit of units) {
    const speaker = unit.speaker && unit.speaker.trim().length > 0 ? unit.speaker : "narration";
    const protectedSpans = canonicalizeSpans(
      input.protectedSpansBySource.get(unit.bridgeUnitId) ?? [],
    );
    const spansBlock =
      protectedSpans.length === 0
        ? "  protectedSpans: (none)"
        : `  protectedSpans:\n${protectedSpans
            .map(
              (span) => `    - refId=${span.refId} sourceText=${JSON.stringify(span.sourceText)}`,
            )
            .join("\n")}`;
    lines.push(
      `[#${index}] unitId=${unit.bridgeUnitId} speaker=${speaker}\n  source: ${unit.sourceText}\n${spansBlock}`,
    );
    index += 1;
  }

  lines.push("");
  lines.push("Output schema (JSON):");
  lines.push(JSON.stringify(STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA));

  return { systemText: SYSTEM_INSTRUCTIONS, userText: lines.join("\n") };
}

export function translationPromptHash(prompt: RenderedTranslationPrompt): string {
  const canonical = `${prompt.systemText}\n␞\n${prompt.userText}`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function canonicalizeUnits(
  units: ReadonlyArray<TranslationBridgeUnit>,
): ReadonlyArray<TranslationBridgeUnit> {
  return [...units].sort((a, b) => {
    const keyDelta = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return a.bridgeUnitId.localeCompare(b.bridgeUnitId);
  });
}

function canonicalizeGlossary(
  entries: ReadonlyArray<TranslationGlossaryEntry>,
): ReadonlyArray<TranslationGlossaryEntry> {
  return [...entries].sort((a, b) => {
    const sourceDelta = a.preferredSourceForm.localeCompare(b.preferredSourceForm);
    if (sourceDelta !== 0) {
      return sourceDelta;
    }
    return a.termId.localeCompare(b.termId);
  });
}

function canonicalizeStyleGuide(
  rules: ReadonlyArray<TranslationStyleGuideRule>,
): ReadonlyArray<TranslationStyleGuideRule> {
  return [...rules].sort((a, b) => {
    const sectionDelta = a.section.localeCompare(b.section);
    if (sectionDelta !== 0) {
      return sectionDelta;
    }
    return a.ruleId.localeCompare(b.ruleId);
  });
}

function canonicalizeSpans(
  spans: ReadonlyArray<TranslationProtectedSpanInput>,
): ReadonlyArray<TranslationProtectedSpanInput> {
  return [...spans].sort((a, b) => a.refId.localeCompare(b.refId));
}
