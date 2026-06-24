import { createHash } from "node:crypto";
import type { CharacterRelationshipInput } from "./shapes.js";

export const PROMPT_TEMPLATE_VERSION_V1 = "itotori-character-relationship-v1";

export type RenderedPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are a localization context assistant.",
  "Read the supplied units and return a JSON object naming every character who appears",
  "and the relationships between them.",
  "Use the SAME LANGUAGE as the source units for every bio sentence and every relationship descriptor.",
  "Each bio MUST cite the unit ids it draws from in citedUnitIds.",
  "Each relationship MUST cite the unit ids that establish it in citedUnitIds.",
  "Do not invent characters or relationships not justified by the supplied units.",
  "Use the closed kind enum: FamilyRelation, Romantic, Friendship, Mentor, Rivalry, Allegiance, Antagonism, Other.",
  "Use the closed direction enum: Symmetric, FromAToB.",
  "Output JSON only, conforming to the schema at the bottom of the user message.",
].join("\n");

export function buildPrompt(input: CharacterRelationshipInput): RenderedPrompt {
  const lines: string[] = [];
  lines.push(`Project source locale: ${input.sourceLocale}`);

  const curated = [...input.curatedCharacters].sort((a, b) =>
    a.characterId.localeCompare(b.characterId),
  );
  lines.push("");
  if (curated.length > 0) {
    lines.push("Curator-promoted characters (preserve these ids; do not invent aliases):");
    for (const ref of curated) {
      const display = ref.displayName ? ` (${ref.displayName})` : "";
      lines.push(`- ${ref.characterId}${display}`);
    }
  } else {
    lines.push("Curator-promoted characters: (none)");
  }

  if (input.priorPack) {
    lines.push("");
    lines.push("Prior pack (extend, do not contradict):");
    lines.push(
      JSON.stringify({
        bios: [...input.priorPack.bios].sort((a, b) => a.characterId.localeCompare(b.characterId)),
        relationships: [...input.priorPack.relationships].sort((a, b) => {
          const fromDelta = a.fromCharacterId.localeCompare(b.fromCharacterId);
          if (fromDelta !== 0) return fromDelta;
          const toDelta = a.toCharacterId.localeCompare(b.toCharacterId);
          if (toDelta !== 0) return toDelta;
          return a.kind.localeCompare(b.kind);
        }),
        promptTemplateVersion: input.priorPack.promptTemplateVersion,
      }),
    );
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
    const addressees =
      unit.addressees && unit.addressees.length > 0
        ? [...unit.addressees].sort((a, b) => a.localeCompare(b)).join(",")
        : "-";
    lines.push(
      `[#${index}] (unitId=${unit.bridgeUnitId}, speaker=${speaker}, addressees=${addressees}) ${unit.sourceText}`,
    );
    index += 1;
  }

  lines.push("");
  lines.push("Schema (JSON):");
  lines.push(
    JSON.stringify({
      bios: [
        {
          characterId: "string",
          bioText: "string (in source locale)",
          citedUnitIds: ["bridgeUnitId"],
        },
      ],
      relationships: [
        {
          fromCharacterId: "string",
          toCharacterId: "string",
          kind: "FamilyRelation|Romantic|Friendship|Mentor|Rivalry|Allegiance|Antagonism|Other",
          direction: "Symmetric|FromAToB",
          descriptor: "string (in source locale)",
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
  input: CharacterRelationshipInput,
): ReadonlyArray<CharacterRelationshipInput["units"][number]> {
  return [...input.units].sort((a, b) => {
    const keyDelta = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return a.bridgeUnitId.localeCompare(b.bridgeUnitId);
  });
}
