// ITOTORI-017 — Deterministic prompt template for the speaker-label agent.
//
// Byte-stable across calls: same input → same systemText / userText →
// same promptHash. Recorded bundles are keyed by promptHash by default
// (see RecordedModelProvider), so any drift here invalidates every
// recorded fixture.

import { createHash } from "node:crypto";
import {
  SPEAKER_IDENTITY_KINDS,
  SPEAKER_LABEL_CONFIDENCES,
  SPEAKER_LABEL_OUTPUT_JSON_SCHEMA,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  SPEAKER_LABEL_UNKNOWN_REASONS,
  type SpeakerLabel,
} from "@itotori/localization-bridge-schema";
import type {
  CharacterBio,
  SpeakerLabelBridgeUnit,
  SpeakerLabelInvocationInput,
} from "./shapes.js";

export type RenderedSpeakerLabelPrompt = {
  systemText: string;
  userText: string;
};

const SYSTEM_INSTRUCTIONS = [
  "You are a localization speaker-labeling agent.",
  "For each bridge unit, decide who is speaking (or whether it is narration).",
  `Each label MUST cite a bridgeUnitId from the input units block, and use exactly one of these identity kinds: ${SPEAKER_IDENTITY_KINDS.join(", ")}.`,
  `Confidence MUST be one of: ${SPEAKER_LABEL_CONFIDENCES.join(", ")}. Use 'low' when conflicting signals exist; do NOT invent certainty.`,
  "CRITICAL: if a character bio carries hiddenFromReader=true, you MUST label any line they speak with kind='unknown_to_reader' citing the bio's maskedCharacterId and maskedDisplayName. NEVER use kind='named' for such characters. The internal identity is for system tracking only.",
  "If you cannot decide between two real candidates, emit kind='unknown_to_parser' with reason='conflicting_signals'. Do NOT guess.",
  `Valid unknown_to_parser reasons: ${SPEAKER_LABEL_UNKNOWN_REASONS.join(", ")}.`,
  "Use kind='narration' for stage directions, scene descriptors, and ambient text with no spoken voice.",
  "evidenceRefs cites prior-line bridgeUnitIds, scene-summary ids, character-bio ids, or 'parser-hint'; never raw quotes.",
  "agentRationale explains the reasoning in one sentence.",
  `Emit ONLY a JSON object that conforms to the schema with schemaVersion '${SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION}'. Do NOT emit prose or markdown.`,
].join("\n");

export function buildSpeakerLabelPrompt(
  input: SpeakerLabelInvocationInput,
): RenderedSpeakerLabelPrompt {
  const lines: string[] = [];
  lines.push(`Project source locale: ${input.sourceLocale}`);
  lines.push(`Project id: ${input.projectId}`);
  lines.push(`Locale branch id: ${input.localeBranchId}`);
  lines.push(`Prompt-template version: ${input.promptTemplateVersion}`);

  lines.push("");
  if (input.knownCharacters.length === 0) {
    lines.push("Character roster: (empty)");
  } else {
    lines.push("Character roster:");
    const sorted = canonicalizeCharacters(input.knownCharacters);
    for (const bio of sorted) {
      if (bio.hiddenFromReader) {
        // Surface BOTH internal + masked identifiers; the system prompt
        // forbids emitting the internal id in `named` labels.
        const maskedId = bio.maskedCharacterId ?? "";
        const maskedName = bio.maskedDisplayName ?? "";
        lines.push(
          `- HIDDEN internalId=${bio.characterId} internalName=${bio.displayName} -> mask: maskedId=${maskedId} maskedName='${maskedName}' (USE MASK)`,
        );
      } else {
        lines.push(
          `- characterId=${bio.characterId} displayName='${bio.displayName}' bio: ${oneLine(bio.bioText)}`,
        );
      }
    }
  }

  lines.push("");
  if (input.existingSpeakerLabels.size === 0) {
    lines.push("Existing labels (context only): (none)");
  } else {
    lines.push("Existing labels (context only — do not overwrite):");
    const sortedExisting = canonicalizeExistingLabels(input.existingSpeakerLabels);
    for (const label of sortedExisting) {
      lines.push(`- ${label.bridgeUnitId}: ${describeIdentity(label)}`);
    }
  }

  lines.push("");
  lines.push("Units (canonical order):");
  const units = canonicalizeUnits(input.bridgeUnits);
  let index = 1;
  for (const unit of units) {
    const hint =
      unit.parserSpeakerHint && unit.parserSpeakerHint.length > 0
        ? unit.parserSpeakerHint
        : "(no parser hint)";
    lines.push(
      `[#${index}] unitId=${unit.bridgeUnitId} parserHint=${hint}\n  source: ${unit.sourceText}`,
    );
    index += 1;
  }

  lines.push("");
  lines.push("Output schema (JSON):");
  lines.push(JSON.stringify(SPEAKER_LABEL_OUTPUT_JSON_SCHEMA));

  return { systemText: SYSTEM_INSTRUCTIONS, userText: lines.join("\n") };
}

export function speakerLabelPromptHash(prompt: RenderedSpeakerLabelPrompt): string {
  const canonical = `${prompt.systemText}\n␞\n${prompt.userText}`;
  return createHash("sha256").update(canonical).digest("hex");
}

export function canonicalizeUnits(
  units: ReadonlyArray<SpeakerLabelBridgeUnit>,
): ReadonlyArray<SpeakerLabelBridgeUnit> {
  return [...units].sort((a, b) => {
    const keyDelta = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return a.bridgeUnitId.localeCompare(b.bridgeUnitId);
  });
}

function canonicalizeCharacters(bios: ReadonlyArray<CharacterBio>): ReadonlyArray<CharacterBio> {
  return [...bios].sort((a, b) => a.characterId.localeCompare(b.characterId));
}

function canonicalizeExistingLabels(
  labels: ReadonlyMap<string, SpeakerLabel>,
): ReadonlyArray<SpeakerLabel> {
  return [...labels.values()].sort((a, b) => a.bridgeUnitId.localeCompare(b.bridgeUnitId));
}

function describeIdentity(label: SpeakerLabel): string {
  const id = label.speakerId;
  switch (id.kind) {
    case "named":
      return `named ${id.characterId} (${id.displayName})`;
    case "unknown_to_reader":
      return `unknown_to_reader mask=${id.maskedCharacterId}`;
    case "unknown_to_parser":
      return `unknown_to_parser (${id.reason})`;
    case "narration":
      return "narration";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
