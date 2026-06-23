import { createHash } from "node:crypto";
import type { SceneSummaryInput } from "./shapes.js";

export const PROMPT_TEMPLATE_VERSION_V1 = "itotori-scene-summary-v1";

export type RenderedPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are a localization context assistant.",
  "Summarize the following scene in the SAME LANGUAGE as the source units.",
  "Do not translate.",
  "Mention every character who appears and the salient narrative facts.",
  "Keep the summary under ~200 source-language characters.",
  "Output the summary text only.",
].join("\n");

export function buildPrompt(input: SceneSummaryInput): RenderedPrompt {
  const lines: string[] = [];
  lines.push(`Project source locale: ${input.sourceLocale}`);
  lines.push(`Scene id: ${input.sceneId}`);

  if (input.priorSummary) {
    lines.push("");
    lines.push("Prior summary (extend, do not repeat):");
    lines.push(input.priorSummary.summaryText);
    lines.push(`Prior summary template: ${input.priorSummary.promptTemplateVersion}`);
  }

  const glossary = [...input.glossaryExcerpt].sort((a, b) => a.termKey.localeCompare(b.termKey));
  if (glossary.length > 0) {
    lines.push("");
    lines.push("Glossary excerpts (canonical names; preserve these):");
    for (const term of glossary) {
      const target = term.preferredTargetForm ? ` -> ${term.preferredTargetForm}` : "";
      lines.push(`- ${term.termKey}: ${term.preferredSourceForm}${target}`);
    }
  }

  lines.push("");
  lines.push("Units (canonical order):");
  const units = canonicalizeUnits(input);
  let index = 1;
  for (const unit of units) {
    const speaker = unit.speaker && unit.speaker.trim().length > 0 ? unit.speaker : "narration";
    lines.push(`[#${index}] (${speaker}) ${unit.sourceText}`);
    index += 1;
  }

  return { systemText: SYSTEM_INSTRUCTIONS, userText: lines.join("\n") };
}

export function promptHash(prompt: RenderedPrompt): string {
  const canonical = `${prompt.systemText}\n␞\n${prompt.userText}`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function canonicalizeUnits(
  input: SceneSummaryInput,
): ReadonlyArray<SceneSummaryInput["units"][number]> {
  return [...input.units].sort((a, b) => {
    const keyDelta = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return (a.occurrenceId ?? "").localeCompare(b.occurrenceId ?? "");
  });
}
