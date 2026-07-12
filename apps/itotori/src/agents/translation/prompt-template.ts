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
  PriorPassFeedback,
  TranslationBridgeUnit,
  TranslationGlossaryEntry,
  TranslationInvocationInput,
  TranslationProtectedSpanInput,
  TranslationStyleGuideRule,
  TranslationWorkScopeContext,
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
  "draftText MUST contain ONLY the target-language rendering of the source line.",
  "draftText MUST be non-blank and MUST NOT repeat the source text or prefix it with a locale tag such as '[locale] source'.",
  "Do NOT append translator's notes, TL notes, meta-commentary, or any parenthetical annotation intended for the reader of the draft (e.g. '(TL note: ...)', '(translator's note: ...)'). All commentary belongs in `agentRationale`, never in `draftText`.",
  `confidenceFloor MUST be one of: ${TRANSLATION_DRAFT_CONFIDENCE_FLOORS.join(", ")}.`,
  `The schemaVersion field MUST equal EXACTLY the string "${STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION}". Copy it verbatim.`,
  'Emit ONLY the allowed top-level properties: "schemaVersion" and "drafts". Do NOT include a "$schema" property, an "$id", a "title", or ANY other top-level key. The embedded schema below is a SPEC to conform to, NOT a template to echo back.',
  'citationRefs MUST contain ONLY the exact ids shown in the Glossary block (termId=...) or the "Context artifacts available for citation" block. Cite the id VERBATIM. Do NOT prefix an id (e.g. never "terminology-candidate:<term>"), do NOT cite a raw source term, and do NOT cite anything not listed. If you consulted nothing citable, emit an empty citationRefs array.',
  "Emit ONLY a JSON object that conforms to the schema. Do NOT emit prose, markdown, or trailing commas. RFC 8259 JSON only.",
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

  // itotori-structure-informed-context-building — inject the structurally-
  // grounded context (from the Kaifuu/Utsushi decode) when present. STRICTLY
  // ADDITIVE: when `structuredContext` is undefined nothing is emitted, so the
  // no-structure baseline prompt (and every recorded fixture keyed by its
  // hash) is byte-identical to the pre-feature template.
  if (input.structuredContext !== undefined) {
    const ctx = input.structuredContext;
    lines.push("");
    lines.push(
      "Structure-informed context (decoded from the game's real scene graph, " +
        "choice/branch subsystem, and speaker table — authoritative, not guesswork):",
    );
    lines.push(`- Scene summary: ${ctx.sceneSummaryText}`);
    lines.push(`- Route/branch position: ${ctx.routePositionText}`);
    for (const arcLine of ctx.characterArcsText.split("\n")) {
      lines.push(`- ${arcLine}`);
    }
    lines.push(
      "Use this to keep speaker voice consistent, resolve referents from the " +
        "scene, and stay branch-aware. Cite the artifact refs you rely on: " +
        `${[...ctx.artifactRefs].sort().join(", ")}.`,
    );
  }

  // itotori-crosswork-context-injection — inject the resolved effective work
  // scope when the full-project driver supplies it. This is strictly additive:
  // no `workScopeContext` means no emitted block and therefore no prompt drift
  // for single-work / legacy paths.
  if (input.workScopeContext !== undefined) {
    lines.push("");
    lines.push(...renderWorkScopeContext(input.workScopeContext));
  }

  // durable-journal — inject the prior localization pass's feedback for
  // this unit so a pass N+1 draft BUILDS ON pass N's accepted state / flagged
  // units instead of re-running from scratch. STRICTLY ADDITIVE: when
  // `priorPassFeedback` is undefined nothing is emitted, so the no-prior-pass
  // baseline prompt (and every recorded fixture keyed by its hash) is
  // byte-identical to the pre-feature template.
  if (input.priorPassFeedback !== undefined) {
    lines.push("");
    lines.push(...renderPriorPassFeedback(input.priorPassFeedback));
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

function renderWorkScopeContext(context: TranslationWorkScopeContext): string[] {
  const out: string[] = [];
  out.push(
    "Work-scoped continuity context (shared context inherited across works, " +
      "with per-work overrides already applied):",
  );
  out.push(`- Work id: ${context.workId}`);
  if (context.glossary.length === 0) {
    out.push("- Effective glossary: (empty)");
  } else {
    out.push("- Effective glossary provenance:");
    for (const entry of [...context.glossary].sort((a, b) => {
      const sourceDelta = a.sourceForm.localeCompare(b.sourceForm);
      if (sourceDelta !== 0) {
        return sourceDelta;
      }
      return a.termId.localeCompare(b.termId);
    })) {
      const policy = entry.policyAction ? ` [${entry.policyAction}]` : "";
      out.push(
        `  - ${entry.sourceForm} -> ${entry.targetForm}${policy} ` +
          `(termId=${entry.termId}, ${entry.provenance})`,
      );
    }
  }
  if (context.characters.length === 0) {
    out.push("- Character/style continuity: (empty)");
  } else {
    out.push("- Character/style continuity:");
    for (const character of [...context.characters].sort((a, b) =>
      a.characterId.localeCompare(b.characterId),
    )) {
      const voice = character.voiceNote ? `; voice/style=${character.voiceNote}` : "";
      out.push(
        `  - ${character.displayName} (characterId=${character.characterId}, ` +
          `${character.provenance}${voice})`,
      );
    }
    out.push(
      "  Treat character voice/style notes as continuity rules for this draft unless a per-work override says otherwise.",
    );
  }
  return out;
}

/**
 * durable-journal — render the prior-pass feedback block for the
 * translation prompt. Deterministic (fixed key order, no free-text sorting) so
 * two pass N+1 runs over the same prior-pass state emit byte-equal prompts.
 * The block tells the model (a) what the prior pass wrote, (b) its
 * informational quality flags, and (c) the feedback note to address — so the
 * draft iterates rather than re-deriving from a blank slate.
 */
function renderPriorPassFeedback(feedback: PriorPassFeedback): string[] {
  const out: string[] = [];
  out.push(
    `Prior pass feedback (from localization pass ${feedback.passNumber} — ` +
      "iterate on this unit's prior result, do NOT restart from scratch):",
  );
  out.push(`- Prior written draft: ${JSON.stringify(feedback.priorDraftText)}`);
  out.push(
    `- Informational quality flags: ${
      feedback.qualityFlags.length > 0 ? feedback.qualityFlags.join(", ") : "none"
    }`,
  );
  if (feedback.feedbackNote !== undefined) {
    out.push(`- Feedback to address: ${feedback.feedbackNote}`);
  }
  out.push(
    "Produce a NEW draft that addresses the flagged issue and preserves what " +
      "the prior draft got right.",
  );
  return out;
}
