import { createHash } from "node:crypto";
import { TERMINOLOGY_CANDIDATE_KINDS, type TerminologyCandidateInput } from "./shapes.js";

export const PROMPT_TEMPLATE_VERSION_V1 = "itotori-terminology-candidate-v1";

export type RenderedPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are a localization context assistant.",
  "Read the supplied units and surface forms that should become glossary entries.",
  "Use the SAME LANGUAGE as the source units for every surface form, rationale, and reading hint.",
  "Each candidate MUST cite the unit ids it appears in.",
  "Each surface form MUST be a verbatim substring of at least one cited unit's source text.",
  `Candidate kind MUST be one of the closed values: ${TERMINOLOGY_CANDIDATE_KINDS.join(", ")}.`,
  "Do NOT propose any surface form that already appears in the existing glossary block.",
  "Output JSON only, conforming to the schema at the bottom of the user message.",
].join("\n");

export function buildPrompt(input: TerminologyCandidateInput): RenderedPrompt {
  const lines: string[] = [];
  lines.push(`Project source locale: ${input.sourceLocale}`);

  lines.push("");
  if (input.existingGlossary.length > 0) {
    lines.push("Existing glossary (do NOT re-propose):");
    const sorted = [...input.existingGlossary].sort((a, b) => {
      const sourceDelta = a.preferredSourceForm.localeCompare(b.preferredSourceForm);
      if (sourceDelta !== 0) return sourceDelta;
      return a.terminologyTermId.localeCompare(b.terminologyTermId);
    });
    for (const entry of sorted) {
      const aliases = entry.aliases.length > 0 ? entry.aliases.join(", ") : "(no aliases)";
      const kind = entry.kind ? ` [${entry.kind}]` : "";
      lines.push(`- ${entry.preferredSourceForm} (aliases: ${aliases})${kind}`);
    }
  } else {
    lines.push("Existing glossary: (empty)");
  }

  if (input.priorCandidates && input.priorCandidates.length > 0) {
    lines.push("");
    lines.push("Prior candidates (extend, do not repeat):");
    const sorted = [...input.priorCandidates].sort((a, b) =>
      a.surfaceForm.localeCompare(b.surfaceForm),
    );
    for (const ref of sorted) {
      lines.push(`- ${ref.surfaceForm} [${ref.kind}]`);
    }
  }

  lines.push("");
  lines.push("Units (canonical order):");
  const units = canonicalizeUnits(input);
  let index = 1;
  for (const unit of units) {
    const speaker = unit.speaker && unit.speaker.trim().length > 0 ? unit.speaker : "narration";
    lines.push(`[#${index}] (unitId=${unit.bridgeUnitId}, speaker=${speaker}) ${unit.sourceText}`);
    index += 1;
  }

  lines.push("");
  lines.push("Schema (JSON):");
  lines.push(
    JSON.stringify({
      candidates: [
        {
          kind: TERMINOLOGY_CANDIDATE_KINDS.join("|"),
          surfaceForm: "string (verbatim from one of the cited units)",
          rationale: "string (in source locale)",
          readingHint: "string? (in source locale)",
          citedUnitIds: ["bridgeUnitId"],
        },
      ],
    }),
  );

  return { systemText: SYSTEM_INSTRUCTIONS, userText: lines.join("\n") };
}

export function promptHash(prompt: RenderedPrompt): string {
  const canonical = `${prompt.systemText}\n␞\n${prompt.userText}`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function canonicalizeUnits(
  input: TerminologyCandidateInput,
): ReadonlyArray<TerminologyCandidateInput["units"][number]> {
  return [...input.units].sort((a, b) => {
    const keyDelta = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return a.bridgeUnitId.localeCompare(b.bridgeUnitId);
  });
}
